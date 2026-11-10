import {execFile} from 'node:child_process';
import {readPanelUsageAsync} from './panel-usage-extra.js';
import {join} from 'node:path';

export function createUsageHandler({python, serverRoot, dataRoot, panelRoot=null, readExtra=readPanelUsageAsync, run = execFile}) {
  let pending;
  return async function handleUsage(req, path) {
    if (path !== '/api/usage' || req.method !== 'GET') return null;
    if (!pending) {
      pending = new Promise((resolve) => {
        run(python, ['-B', join(serverRoot, 'panel-usage.py'), join(dataRoot, 'state.db')],
          {timeout: 15000, maxBuffer: 4 * 1024 * 1024}, async (error, stdout) => {
            try {
              const result = JSON.parse(stdout);
              if (!result.ok || error) throw new Error(result.error || '用量读取进程未完成');
              if(panelRoot)result.usage.panel_requests=await readExtra(panelRoot);
              resolve({body: result, status: 200});
            } catch (failure) {
              resolve({body: {ok: false, error: error?.killed ? '读取用量超时，请重试' : failure.message}, status: 503});
            }
          });
      }).finally(() => { pending = null; });
    }
    const result = await pending;
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
    });
  };
}
