import * as fs from 'node:fs';
import {join} from 'node:path';
import {StateFile, clone, digest, safeId, stateError} from './panel-state.js';

export const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const live = job => job.status === 'pending' || job.status === 'running';
const emptyResult = () => ({reply: '', reasoning: '', tools: [], info: '', error: '', usage: null});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// One Monitor owns this queue. Execution is independent of any HTTP/WS connection.
// Every acknowledgement/event follows a disk commit. Browser reconnects never run work.
export class ChatQueue {
  constructor({root, execute, available = () => true, reconcile = () => null, onInterrupted = () => null, io = fs, flushMs = 100, onFault = () => {}}) {
    Object.assign(this, {root, execute, available, reconcile, onInterrupted, io, flushMs, onFault});
    this.jobs = new Map(); this.subscribers = new Map(); this.workers = new Map();
    this.running = false; this.fault = null; this.wakeTimer = null; this.lastOrder = 0;
  }
  store(id) {
    return new StateFile(join(this.root, safeId(id) + '.json'), () => null,
      {io: this.io, validate: j => !!j && j.version === 1 && j.id === id && typeof j.session_id === 'string' && j.result && Number.isInteger(j.seq)});
  }
  load() {
    this.io.mkdirSync(this.root, {recursive: true, mode: 0o700});
    for (const name of this.io.readdirSync(this.root).filter(n => n.endsWith('.json')).sort()) {
      const id = name.slice(0, -5), job = this.store(id).read();
      safeId(job.session_id);
      if (job.status === 'running') {
        // A committed final chat message can reconcile a crash between final save and queue ack.
        // Otherwise pause this session. Never replay possibly completed external side effects.
        const completed = this.reconcile(job);
        job.status = job.cancel_requested_at ? 'cancelled' : completed ? completed.status || 'done' : 'interrupted';
        if (completed) Object.assign(job.result, completed.result || {});
        else {
          try {
            const saved = this.onInterrupted(job);
            if (saved) Object.assign(job.result, saved);
          } catch (error) {
            job.result.error = '服务重启中断了这一轮；执行记录已保留，但会话正文收尾失败，请检查存储。';
            job.result.transcript_error = String(error?.message || error).slice(0, 500);
          }
          if (!job.result.error) job.result.error = '服务重启中断了这一轮。已保留回复和工具记录，请查看现场后继续。';
        }
        job.finished_at = Date.now(); job.updated_at = Date.now(); job.seq++;
        this.store(id).write(job);
      }
      this.jobs.set(id, job);
      this.lastOrder = Math.max(this.lastOrder, job.order || job.created_at);
    }
    return this;
  }
  public(job, withPayload = false) {
    const {payload, snapshot, input_hash, ...view} = job;
    if (withPayload) { view.message = payload.message; view.model = payload.model; view.provider = payload.provider; }
    view.identity = snapshot.identity || null;
    view.user_identity = snapshot.user_identity || null;
    return clone(view);
  }
  get(id, withPayload = false) {
    const job = this.jobs.get(safeId(id));
    if (!job) throw stateError('执行记录不存在', 404);
    return this.public(job, withPayload);
  }
  list(sid, {all = false, limit = 50, before = Infinity} = {}) {
    if (sid) safeId(sid);
    return [...this.jobs.values()].filter(j => (!sid || j.session_id === sid) && (all || live(j) || (j.status === 'interrupted' && !j.resolved_at)) && j.created_at < before)
      .sort((a,b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).slice(0, Math.min(limit,200)).map(j => this.public(j, true));
  }
  enqueue(payload, snapshot = {}) {
    if (this.fault) throw stateError('队列存储异常，消息尚未接收：' + this.fault.message, 503, 'queue_storage');
    const id = safeId(payload.request_id), sid = safeId(payload.session_id);
    if (!payload.message || (typeof payload.message === 'string' && !payload.message.trim())) throw stateError('请输入消息');
    if (Buffer.byteLength(JSON.stringify(payload)) > 2 * 1024 * 1024) throw stateError('消息过大，请改用附件', 413);
    const input_hash = digest(payload), old = this.jobs.get(id);
    if (old) {
      if (old.input_hash !== input_hash) throw stateError('同一个发送编号对应了不同消息，请使用新的编号', 409, 'idempotency_conflict');
      return {job: this.public(old, true), duplicate: true};
    }
    const active = [...this.jobs.values()].filter(live);
    if (active.filter(j => j.session_id === sid).length >= 50 || active.length >= 200) throw stateError('待处理消息较多，请等待或取消部分消息后再发送', 429);
    const now = Date.now();
    const job = {version: 1, id, session_id: sid, input_hash, payload: clone(payload), snapshot: clone(snapshot), status: 'pending', seq: 1,
      created_at: now, order: ++this.lastOrder, updated_at: now, result: emptyResult()};
    this.store(id).write(job);
    this.jobs.set(id, job);
    this.wake();
    return {job: this.public(job, true), duplicate: false};
  }
  notify(id, event) {
    for (const callback of this.subscribers.get(id) || []) {
      try { callback(event); } catch { /* An observer cannot stop execution. */ }
    }
  }
  subscribe(id, callback) {
    const job = this.get(id, true);
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id).add(callback);
    callback({snapshot: job, seq: job.seq});
    return () => { const set = this.subscribers.get(id); set?.delete(callback); if (!set?.size) this.subscribers.delete(id); };
  }
  commit(job, packet = {}) {
    // Cancellation is concurrent with runner events; do not lose the saved intent.
    const saved = this.jobs.get(job.id);
    if (saved?.cancel_requested_at) job.cancel_requested_at = saved.cancel_requested_at;
    if (saved?.resolved_at) job.resolved_at = saved.resolved_at;
    job.seq = Math.max(job.seq, saved?.seq || 0);
    const next = {...job, seq: job.seq + 1, updated_at: Date.now()};
    this.store(job.id).write(next);
    this.jobs.set(job.id, clone(next));
    Object.assign(job, next);
    this.notify(job.id, {...packet, seq: job.seq, status: job.status});
  }
  recordFault(error) {
    this.fault = error; this.running = false;
    for (const worker of this.workers.values()) worker.controller.abort(error);
    this.onFault(error);
    for (const id of this.subscribers.keys()) this.notify(id, {storage_error: '进度保存失败，执行已暂停。请检查存储后恢复。'});
  }
  start() { this.running = true; this.wake(); return this; }
  wake() {
    if (!this.running || this.fault) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      try { this.pump(); } catch (e) { this.recordFault(e); }
    }, 0);
  }
  pump() {
    if (!this.running || this.fault) return;
    const pending = [...this.jobs.values()].filter(j => j.status === 'pending').sort((a,b) => a.order - b.order);
    for (const job of pending) {
      if (this.workers.has(job.session_id)) continue;
      const blocked = [...this.jobs.values()].some(j => j.session_id === job.session_id && j.status === 'interrupted' && !j.resolved_at);
      if (blocked || !this.available(job)) continue;
      const worker = {controller: new AbortController(), promise: null};
      this.workers.set(job.session_id, worker);
      worker.promise = this.run(clone(job), worker).finally(() => {
        this.workers.delete(job.session_id);
        this.wake();
      });
    }
    // Gateway readiness and legacy internal streams can change without a queue event.
    if (pending.length && !this.wakeTimer) {
      this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.wake(); }, 1000);
      this.wakeTimer.unref?.();
    }
  }
  async run(job, worker) {
    let timer, packets = [], emissionError;
    const flush = () => {
      clearTimeout(timer); timer = null;
      if (!packets.length) return;
      const out = packets; packets = [];
      try { this.commit(job, {events: out}); }
      catch (e) { emissionError = e; this.recordFault(e); throw e; }
    };
    const emit = packet => {
      if (emissionError) throw emissionError;
      if (packet.keepalive || packet.done) return;
      const r = job.result;
      if (packet.delta) r.reply += packet.delta;
      if (packet.reasoning) r.reasoning += packet.reasoning;
      if (packet.info) r.info = packet.info;
      if (packet.error) r.error = String(packet.error);
      if (packet.usage) r.usage = packet.usage;
      if (packet.tool_progress) {
        const t = packet.tool_progress, key = t.toolCallId || t.tool;
        const index = r.tools.findIndex(x => (x.toolCallId || x.tool) === key);
        if (index < 0) r.tools.push({...t}); else r.tools[index] = {...r.tools[index], ...t};
      }
      packets.push(clone(packet));
      if (packet.tool_progress || packet.error) flush();
      else if (!timer) timer = setTimeout(() => { try { flush(); } catch {} }, this.flushMs);
    };
    try {
      job.status = 'running'; job.started_at = Date.now();
      this.commit(job);
      const result = await this.execute(clone(job), {signal: worker.controller.signal, emit});
      flush();
      if (emissionError) throw emissionError;
      if (result?.result) Object.assign(job.result, result.result);
      job.status = worker.stopping ? 'interrupted' : worker.cancelled ? 'cancelled' : (result?.status || (job.result.error ? 'failed' : 'done'));
      if (job.status === 'interrupted') job.result.error = '服务重启中断了这一轮。已保留回复和工具记录，请查看现场后继续。';
      job.finished_at = Date.now();
      this.commit(job, {done: true, error: job.result.error || undefined});
    } catch (e) {
      clearTimeout(timer);
      if (this.fault) return;
      job.status = worker.stopping ? 'interrupted' : worker.cancelled ? 'cancelled' : 'failed';
      job.result.error = worker.stopping ? '服务关闭时中断了这一轮，请查看现场后继续。' : worker.cancelled ? '' : String(e.message || e);
      job.finished_at = Date.now();
      try { this.commit(job, {done: true, error: job.result.error || undefined}); }
      catch (writeError) { this.recordFault(writeError); }
    } finally { clearTimeout(timer); }
  }
  cancel(id) {
    const job = clone(this.jobs.get(safeId(id)) || null);
    if (!job) throw stateError('执行记录不存在', 404);
    if (!live(job)) return this.get(id, true);
    if (job.status === 'pending') {
      job.status = 'cancelled'; job.finished_at = Date.now(); this.commit(job, {done: true});
    } else {
      const worker = this.workers.get(job.session_id);
      // Record intent before abort so an acknowledgement survives a process crash.
      job.cancel_requested_at = Date.now(); this.commit(job, {cancelling: true});
      if (worker) { worker.cancelled = true; worker.controller.abort(); }
    }
    this.wake(); return this.get(id, true);
  }
  resolve(id) {
    const job = clone(this.jobs.get(safeId(id)) || null);
    if (!job || job.status !== 'interrupted') throw stateError('这一轮无需恢复确认', 409);
    job.resolved_at = Date.now(); this.commit(job, {resolved: true}); this.wake();
    return this.get(id, true);
  }
  async stop() {
    this.running = false; clearTimeout(this.wakeTimer); this.wakeTimer = null;
    for (const worker of this.workers.values()) { worker.stopping = true; worker.controller.abort(); }
    await Promise.all([...this.workers.values()].map(w => w.promise));
  }
  async idle(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.workers.size || [...this.jobs.values()].some(j => j.status === 'pending')) {
      if (Date.now() > deadline) throw Error('queue idle timeout');
      await delay(10);
    }
  }
}
