import {spawn} from 'node:child_process';
import {join} from 'node:path';

export function createEchoHandler({python, serverRoot, queueFile, backupRoot, draftFile, checkToken, start = spawn}) {
  return async (req, path) => {
    if (path !== '/api/echo') return null;
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {status,
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
    if (!checkToken(req)) return reply({ok: false, error: '请重新登录后查看回声站'}, 401);
    if (!['GET', 'POST'].includes(req.method)) return reply({ok: false, error: '不支持此操作'}, 405);
    try {
      const url = new URL(req.url);
      const body = req.method === 'GET' ? {action: 'list'} : await req.json();
      if (req.method === 'GET') {
        for (const key of ['limit', 'offset', 'before_id']) {
          if (url.searchParams.has(key)) {
            const raw = url.searchParams.get(key);
            if (!/^[0-9]+$/.test(raw)) return reply({ok: false, error: '任务分页参数无效'}, 422);
            body[key] = Number(raw);
          }
        }
        for (const key of ['query', 'status']) {
          if (url.searchParams.has(key)) body[key] = url.searchParams.get(key);
        }
      }
      const payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > 256 * 1024) return reply({ok: false, error: '任务内容过长'}, 413);
      return await new Promise(resolve => {
        const child = start(python, ['-B', join(serverRoot, 'panel-echo.py'), queueFile, backupRoot, draftFile || join(backupRoot, 'echo-drafts.json')],
          {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
        let output = '', settled = false;
        const finish = (body, status) => { if (settled) return; settled = true; clearTimeout(timer); resolve(reply(body, status)); };
        const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ok: false, error: '队列操作超时，请刷新核对任务状态'}, 504); }, 15000);
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.length > 32 * 1024 * 1024) { child.kill('SIGTERM'); finish({ok: false, error: '队列记录过大，无法一次读取'}, 503); }
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => finish({ok: false, error: '无法启动队列管理进程'}, 503));
        child.on('close', code => {
          try { const result = JSON.parse(output); finish(result, code === 0 && result.ok ? 200 : /已被.*更新/.test(result.error || '') ? 409 : 422); }
          catch (_) { finish({ok: false, error: '队列返回异常，请刷新核对'}, 502); }
        });
        child.stdin.end(payload);
      });
    } catch (error) { return reply({ok: false, error: error.message}, 400); }
  };
}
