import {TERMINAL} from './panel-queue.js';
import {safeId, stateError} from './panel-state.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {status,
  headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});

export function queueEvents(queue, id, signal) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  return new ReadableStream({
    start(controller) {
      let unsubscribe, timer, closed = false;
      cleanup = () => {
        if (closed) return;
        closed = true; clearInterval(timer); unsubscribe?.();
        signal?.removeEventListener('abort', cleanup);
        try { controller.close(); } catch {}
      };
      const send = event => {
        if (closed) return;
        try { controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n')); }
        catch { cleanup(); return; }
        if (event.storage_error || event.done || (event.snapshot && TERMINAL.has(event.snapshot.status))) cleanup();
      };
      unsubscribe = queue.subscribe(id, send);
      // A completed snapshot can close synchronously during subscribe().
      if (closed) { unsubscribe(); return; }
      timer = setInterval(() => send({keepalive: true}), 15000);
      signal?.addEventListener('abort', cleanup, {once: true});
      if (signal?.aborted) cleanup();
    },
    cancel() { cleanup(); },
  });
}

export function createQueueHandler({queue, checkToken, sessionExists, capture = () => ({}), guard = () => null}) {
  return async (req, path = new URL(req.url).pathname) => {
    if (!path.startsWith('/api/chat/queue')) return null;
    if (!checkToken(req)) return json({error: '请重新连接面板', code: 'unauthorized'}, 401);
    try {
      const url = new URL(req.url);
      if (path === '/api/chat/queue' && req.method === 'POST') {
        const body = await req.json();
        safeId(body.session_id); safeId(body.request_id);
        if (!sessionExists(body.session_id)) throw stateError('会话不存在', 404);
        const blocked = guard(body.message); if (blocked) return blocked;
        const result = queue.enqueue(body, capture(body));
        return json({ok: true, ...result}, result.duplicate ? 200 : 202);
      }
      if (path === '/api/chat/queue' && req.method === 'GET') {
        return json({jobs: queue.list(url.searchParams.get('session_id'), {
          all: url.searchParams.get('all') === '1',
          limit: Math.max(1, Number(url.searchParams.get('limit')) || 50),
          before: Number(url.searchParams.get('before')) || Infinity,
        }), storage_ok: !queue.fault});
      }
      const match = path.match(/^\/api\/chat\/queue\/([a-zA-Z0-9_-]+)(?:\/(events|cancel|resolve))?$/);
      if (!match) throw stateError('没有这个队列操作', 404);
      const [, id, action] = match;
      if (!action && req.method === 'GET') return json(queue.get(id, true));
      if (action === 'events' && req.method === 'GET') {
        queue.get(id);
        return new Response(queueEvents(queue, id, req.signal), {headers: {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no', 'Connection': 'keep-alive',
        }});
      }
      if (action === 'cancel' && req.method === 'POST') return json({ok: true, job: queue.cancel(id)});
      if (action === 'resolve' && req.method === 'POST') return json({ok: true, job: queue.resolve(id)});
      throw stateError('不支持这个操作', 405);
    } catch (e) {
      return json({error: e.message || '队列操作失败', code: e.code}, e.status || 500);
    }
  };
}
