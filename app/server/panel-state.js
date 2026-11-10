// Panel-owned state lives in VAR. Nothing in this module writes to HERMES_HOME.
import * as fs from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';

export const clone = value => JSON.parse(JSON.stringify(value));
export function stableJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + stableJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stableJSON(value)).digest('hex');
export function stateError(message, status = 400, code = 'invalid_state') {
  return Object.assign(new Error(message), {status, code});
}
export function safeId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw stateError('无效的记录标识');
  }
  return id;
}

// Rename is the commit point. A failed pre-commit write leaves the old file intact.
// No "repair to empty" fallback: corrupt data must remain available for recovery.
export function atomicWriteJSON(file, value, io = fs) {
  return atomicWrite(file, JSON.stringify(value) + '\n', io);
}
export function atomicWrite(file, contents, io = fs) {
  const dir = dirname(file);
  io.mkdirSync(dir, {recursive: true, mode: 0o700});
  const temp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = io.openSync(temp, 'wx', 0o600);
    io.writeFileSync(fd, contents);
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(temp, file);
    // Persist the directory entry on Linux. macOS also supports directory fsync.
    fd = io.openSync(dir, 'r');
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (io.existsSync(temp)) io.unlinkSync(temp);
  }
}

export class StateFile {
  constructor(file, initial, {io = fs, validate = () => true} = {}) {
    this.file = file;
    this.io = io;
    this.initial = initial;
    this.validate = validate;
  }
  read() {
    if (!this.io.existsSync(this.file)) return clone(this.initial());
    let value;
    try { value = JSON.parse(this.io.readFileSync(this.file, 'utf8')); }
    catch (e) { throw stateError('状态文件无法读取，原文件已保留：' + e.message, 503, 'state_unreadable'); }
    if (!this.validate(value)) throw stateError('状态文件结构不完整，原文件已保留', 503, 'state_invalid');
    return value;
  }
  write(value) {
    if (!this.validate(value)) throw stateError('拒绝保存不完整的状态', 500, 'state_invalid');
    atomicWriteJSON(this.file, value, this.io);
    return clone(value);
  }
  update(fn) {
    const next = this.read();
    const result = fn(next);
    if (result && typeof result.then === 'function') throw Error('StateFile.update must be synchronous');
    this.write(next);
    return result;
  }
}

export class SessionDrafts {
  constructor(root, options = {}) { this.root = root; this.options = options; }
  file(id) {
    return new StateFile(join(this.root, 'drafts', safeId(id) + '.json'),
      () => ({revision: 0, text: '', attachments: [], options: {}, conflicts: []}),
      {...this.options, validate: d => Number.isInteger(d.revision) && typeof d.text === 'string' && Array.isArray(d.conflicts)});
  }
  get(id) { return this.file(id).read(); }
  put(id, body) {
    if (!Number.isInteger(body.revision) || body.revision < 0) throw stateError('缺少草稿版本，请重新读取草稿');
    if (typeof body.text !== 'string') throw stateError('草稿内容必须是文本');
    if (this.options.maxTextBytes ? Buffer.byteLength(body.text) > this.options.maxTextBytes : body.text.length > 200000) throw stateError(this.options.maxTextBytes ? '资料草稿超过8MB' : '草稿超过 200000 字');
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachments.length > 30 || JSON.stringify(attachments).length > 64000) throw stateError('草稿附件过多');
    const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {};
    if (JSON.stringify(options).length > (this.options.maxOptionsLength || 64000)) throw stateError('会话选项过大');
    const incoming = {text: body.text, attachments: clone(attachments), options: clone(options)};
    const store = this.file(id), current = store.read();
    const same = digest(incoming) === digest({text: current.text, attachments: current.attachments, options: current.options});
    if (same && !body.resolve_key) return {ok: true, draft: current};
    if (body.revision !== current.revision) {
      // Store the second version rather than silently overwriting another device.
      const key = digest(incoming);
      if (!current.conflicts.some(c => c.key === key)) {
        current.conflicts.push({...incoming, key, saved_at: Date.now(), client_id: String(body.client_id || '').slice(0,80)});
        store.write(current);
      }
      return {ok: false, conflict: true, draft: current};
    }
    const next = {...current, ...incoming, revision: current.revision + 1, updated_at: Date.now()};
    // Resolving a conflict consumes only the explicitly chosen copy.
    if (body.resolve_key) next.conflicts = next.conflicts.filter(c => c.key !== body.resolve_key);
    store.write(next);
    return {ok: true, draft: next};
  }
}
