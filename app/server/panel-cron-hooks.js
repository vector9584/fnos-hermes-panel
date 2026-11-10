import {existsSync, readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {StateFile, digest, safeId, stateError} from './panel-state.js';

const configuration = hooks => hooks.map(hook => ({id: hook.id, url: hook.url, label: hook.label || '', message: hook.message || ''}));
export class CronHooks {
  constructor(file, legacy) {
    this.store = new StateFile(file, () => ({jobs: {}}), {
      validate: state => state && state.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs),
    });
    this.legacy = legacy;
  }
  readAll() {
    const legacy = existsSync(this.legacy) ? JSON.parse(readFileSync(this.legacy, 'utf8')) : {};
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw stateError('投递配置格式损坏', 500);
    const result = {...legacy, ...this.store.read().jobs};
    for (const [job, hooks] of Object.entries(result)) {
      if (!Array.isArray(hooks)) throw stateError('任务投递配置格式损坏', 500);
      result[job] = hooks.map((hook, index) => ({...hook, id: hook.id || 'legacy-' + digest({job, index, url: hook.url}).slice(0, 24)}));
    }
    return result;
  }
  get(job) {
    safeId(job);
    const hooks = this.readAll()[job] || [];
    return {hooks, revision: digest(configuration(hooks))};
  }
  put(job, body) {
    const current = this.get(job);
    if (body.revision !== current.revision) throw stateError('投递配置已被其他页面修改，请重新打开', 409);
    if (!Array.isArray(body.hooks) || body.hooks.length > 12) throw stateError('最多设置 12 个投递目标');
    const ids = new Set();
    const hooks = body.hooks.map(input => {
      if (!input || typeof input.url !== 'string') throw stateError('请填写 Webhook 地址');
      let url;
      try { url = new URL(input.url.trim()); } catch { throw stateError('Webhook 地址无效'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw stateError('Webhook 需为 HTTP(S) 地址且不能包含用户密码或片段');
      if (url.href.length > 4096) throw stateError('Webhook 地址过长');
      const id = input.id ? safeId(input.id) : randomUUID();
      if (ids.has(id)) throw stateError('投递目标重复');
      ids.add(id);
      const previous = current.hooks.find(hook => hook.id === id);
      const label = String(input.label || '').trim().slice(0, 120);
      const message = String(input.message || '').trim();
      if (message.length > 10000) throw stateError('投递消息模板超过 10000 字');
      const unchanged = previous && previous.url === url.href && previous.message === message;
      return {...(unchanged ? previous : {}), id, url: url.href, label, message};
    });
    this.store.update(state => { state.jobs[job] = hooks; });
    return this.get(job);
  }
  record(job, attempted, result) {
    const current = this.get(job);
    const hook = current.hooks.find(item => item.id === attempted.id);
    if (!hook || digest(configuration([hook])) !== digest(configuration([attempted]))) return false;
    Object.assign(hook, result);
    this.store.update(state => { state.jobs[job] = current.hooks; });
    return true;
  }
}

export function webhookText(template, output) {
  const text = String(template || '').trim();
  const result = output || '(无输出)';
  if (!text) return result;
  return text.includes('{output}') ? text.split('{output}').join(result) : text + '\n\n' + result;
}

export function createCronHookHandler({hooks, checkToken, jobExists}) {
  return async (req, path) => {
    const match = path.match(/^\/api\/cron-jobs\/([^/]+)\/webhooks$/);
    if (!match) return null;
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
    if (!checkToken(req)) return reply({ok: false, error: '请重新登录后操作'}, 401);
    try {
      const job = safeId(decodeURIComponent(match[1]));
      if (!jobExists(job)) return reply({ok: false, error: '任务不存在'}, 404);
      if (req.method === 'GET') return reply({ok: true, ...hooks.get(job)});
      if (req.method === 'PUT') return reply({ok: true, ...hooks.put(job, await req.json())});
      return reply({ok: false, error: '不支持此操作'}, 405);
    } catch (error) { return reply({ok: false, error: error.message}, error.status || 500); }
  };
}
