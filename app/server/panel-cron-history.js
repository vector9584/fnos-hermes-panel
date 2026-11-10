import * as fs from 'node:fs';
import {join, resolve, relative, sep} from 'node:path';
import {safeId, stateError} from './panel-state.js';

function within(root, candidate) {
  const part = relative(root, candidate);
  return part !== '..' && !part.startsWith('..' + sep) && !part.startsWith(sep);
}
export function createCronHistoryHandler({getHome, checkToken}) {
  return async function history(req, path) {
    const match = path.match(/^\/api\/cron-jobs\/([^/]+)\/history(?:\/([^/]+))?$/);
    if (!match) return null;
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {status,
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
    if (!checkToken(req)) return reply({ok: false, error: '请重新登录后查看执行记录'}, 401);
    if (req.method !== 'GET') return reply({ok: false, error: '执行记录仅支持读取'}, 405);
    try {
      const id = safeId(decodeURIComponent(match[1]));
      const home = fs.realpathSync(getHome());
      const store = JSON.parse(fs.readFileSync(join(home, 'cron/jobs.json'), 'utf8').replace(/^\uFEFF/, ''));
      const job = (Array.isArray(store) ? store : store.jobs).find(item => item.id === id);
      if (!job) return reply({ok: false, error: '任务不存在'}, 404);
      const directories = [join(home, 'cron/output', id), join(home, 'cron', id, 'outputs')];
      const files = [];
      directories.forEach((directory, source) => {
        if (!fs.existsSync(directory)) return;
        const actual = fs.realpathSync(directory);
        if (!within(home, actual) || actual !== resolve(directory)) throw stateError('执行记录目录超出允许范围或使用了链接', 403);
        for (const item of fs.readdirSync(actual, {withFileTypes: true})) {
          if (!item.isFile() || !item.name.endsWith('.md')) continue;
          const file = join(actual, item.name);
          const stat = fs.statSync(file);
          files.push({id: Buffer.from(JSON.stringify([source, item.name])).toString('base64url'),
            name: item.name, size: stat.size, modified_at: stat.mtimeMs, file});
        }
      });
      files.sort((left, right) => right.modified_at - left.modified_at || left.id.localeCompare(right.id));
      if (match[2]) {
        const selected = files.find(item => item.id === match[2]);
        if (!selected) return reply({ok: false, error: '执行记录已不在磁盘上，请刷新列表'}, 404);
        const actual = fs.realpathSync(selected.file);
        if (!within(home, actual) || actual !== resolve(selected.file)) throw stateError('不允许读取链接文件', 403);
        const descriptor = fs.openSync(actual, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = fs.fstatSync(descriptor);
          if (!stat.isFile()) throw stateError('执行记录不是普通文件', 403);
          if (stat.size > 8 * 1024 * 1024) throw stateError('执行记录超过 8 MB，无法在面板中加载', 413);
          return reply({ok: true, name: selected.name, content: fs.readFileSync(descriptor, 'utf8')});
        } finally { fs.closeSync(descriptor); }
      }
      const url = new URL(req.url);
      const after = url.searchParams.get('after');
      const position = after ? files.findIndex(item => item.id === after) : -1;
      if (after && position < 0) return reply({ok: false, error: '记录列表已变化，请刷新后继续'}, 409);
      const page = files.slice(position + 1, position + 31);
      return reply({ok: true, job: {id: job.id, name: job.name, last_run_at: job.last_run_at,
        last_status: job.last_status, last_error: job.last_error, last_delivery_error: job.last_delivery_error},
        records: page.map(({file, ...item}) => item), total: files.length,
        next: position + 1 + page.length < files.length ? page.at(-1).id : null});
    } catch (error) { return reply({ok: false, error: error.message}, error.status || 500); }
  };
}
