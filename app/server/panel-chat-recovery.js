const TERMINAL_TOOL_STATES = new Set([
  'done', 'completed', 'finish', 'finished', 'error', 'failed',
  'interrupted', 'cancelled', 'canceled',
]);

/**
 * Finish a persisted assistant turn after its stream is interrupted.
 * Tool history is retained; only calls without a terminal state are marked
 * interrupted so a reload can show exactly what happened.
 */
function mergeTools(existing, incoming) {
  const merged = Array.isArray(existing) ? existing.map(tool => tool && {...tool}) : [];
  for (const tool of Array.isArray(incoming) ? incoming : []) {
    if (!tool) continue;
    const key = tool.toolCallId || tool.tool;
    const index = key ? merged.findIndex(item => item && (item.toolCallId || item.tool) === key) : -1;
    if (index < 0) merged.push({...tool});
    else {
      const previous = merged[index];
      // A queue checkpoint can be older than the transcript checkpoint. Never
      // downgrade a terminal transcript result back to a live tool, and do not
      // erase an existing result when the older checkpoint has no result.
      if (TERMINAL_TOOL_STATES.has(previous?.status) && !TERMINAL_TOOL_STATES.has(tool.status)) continue;
      const next = {...previous, ...tool};
      if (previous?.result && !tool.result) next.result = previous.result;
      merged[index] = next;
    }
  }
  return merged;
}

export function interruptAssistantMessage(message, {now = Date.now, phrase = '（这条回复在生成过程中被打断，内容不完整）', tools} = {}) {
  if (!message || message.role !== 'assistant') return false;
  if (Array.isArray(tools) && tools.length) message.tools = mergeTools(message.tools, tools);
  if (Array.isArray(message.tools)) {
    message.tools = message.tools.map(tool => {
      if (!tool || TERMINAL_TOOL_STATES.has(tool.status)) return tool;
      return {...tool, status: 'interrupted', running: false};
    });
  }
  delete message._streaming;
  delete message._streamId;
  message.queue_status = 'interrupted';
  message.ts = now();
  const text = String(message.content || '').trim();
  if (!text || text === '开始处理…' || text === '开始处理...') {
    message.content = phrase;
  } else if (!/被打断|已中断/.test(text)) {
    message.content = text + '\n\n> *' + phrase + '*';
  }
  return true;
}

export function recoverInterruptedAssistantMessage(session, job, {now = Date.now} = {}) {
  if (!session || !Array.isArray(session.messages) || !job?.id) return null;
  let message = session.messages.find(item => item.role === 'assistant' && item.request_id === job.id);
  if (!message) {
    const userIndex = session.messages.findIndex(item => item.role === 'user' && item.request_id === job.id);
    if (userIndex < 0) return null;
    message = {role:'assistant', request_id:job.id, content:job.result?.reply || '', ts:now()};
    session.messages.splice(userIndex + 1, 0, message);
  } else if (job.result?.reply && (!message.content || message.content === '开始处理…' || message.content === '开始处理...')) {
    message.content = job.result.reply;
  }
  interruptAssistantMessage(message, {now, tools:job.result?.tools});
  return message;
}
