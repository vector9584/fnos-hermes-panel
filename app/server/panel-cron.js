import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const editable = ['name', 'prompt', 'schedule', 'deliver', 'skills', 'repeat', 'script', 'workdir', 'model', 'provider', 'base_url', 'no_agent', 'context_from', 'enabled_toolsets', 'attach_to_session'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function cronRevision(job) {
  const configuration = Object.fromEntries(editable.map(key => [key, job[key] ?? null]));
  if (configuration.repeat && typeof configuration.repeat === 'object') configuration.repeat = configuration.repeat.times ?? null;
  return createHash('sha256').update(JSON.stringify(canonical(configuration))).digest('hex');
}

export function createCronUpdateHandler({python, serverRoot, nativeRoot, backupRoot, getHome, checkToken, start = spawn}) {
  return async function updateCron(req, path) {
    const match = path.match(/^\/api\/cron-jobs\/([^/]+)$/);
    const actionMatch = path.match(/^\/api\/cron-jobs\/([^/]+)\/action$/);
    const acting = !!actionMatch && req.method === 'POST';
    const creating = path === '/api/cron-jobs' && req.method === 'POST';
    if (!creating && !acting && (!match || req.method !== 'PATCH')) return null;
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
    });
    if (!checkToken(req)) return reply({ok: false, error: '请重新登录后保存'}, 401);
    try {
      const jobId = creating ? null : decodeURIComponent((acting ? actionMatch : match)[1]);
      if (!creating && !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return reply({ok: false, error: '无效的任务标识'}, 400);
      const body = await req.json();
      if (!creating && !acting && (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision))) return reply({ok: false, error: '请重新打开任务后编辑'}, 409);
      if (acting && !['pause', 'resume', 'run', 'archive', 'restore'].includes(body.action)) return reply({ok: false, error: '不支持此操作，请使用归档保留任务与执行记录'}, 400);
      if (creating && (typeof body.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.request_id))) return reply({ok: false, error: '缺少创建标识，请重新打开表单'}, 400);
      const payload = acting ? {} : Object.fromEntries(editable.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
      if (!acting && !Object.keys(payload).length) return reply({ok: false, error: '没有要保存的修改'}, 400);
      Object.assign(payload, creating ? {action: 'create', request_id: body.request_id} : acting ? {action: body.action, job_id: jobId} : {action: 'update', job_id: jobId, revision: body.revision});
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized) > 256 * 1024) return reply({ok: false, error: '任务设定超过 256 KB'}, 413);
      return await new Promise(resolve => {
        const child = start(python, ['-B', join(serverRoot, 'panel-cron.py'), getHome(), nativeRoot, backupRoot],
          {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
        let output = '', settled = false;
        const finish = (body, status) => { if (settled) return; settled = true; clearTimeout(timer); resolve(reply(body, status)); };
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          finish({ok: false, error: '保存超时；请刷新核对任务状态后再操作'}, 504);
        }, 20000);
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.length > 1024 * 1024) { child.kill('SIGTERM'); finish({ok: false, error: '任务返回内容过大，请刷新核对'}, 502); }
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => finish({ok: false, error: '无法启动任务管理进程'}, 503));
        child.on('close', code => {
          try {
            const result = JSON.parse(output);
            finish(result, code === 0 && result.ok ? 200 : /其他页面修改/.test(result.error || '') ? 409 : 422);
          } catch { finish({ok: false, error: '未收到保存结果，请刷新核对任务状态'}, 502); }
        });
        child.stdin.end(serialized);
      });
    } catch (error) { return reply({ok: false, error: error.message}, 400); }
  };
}
