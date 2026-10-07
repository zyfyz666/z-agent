'use strict';

const Workflow = require('./workflow-state');

const terminal = status => ['completed', 'error', 'interrupted'].includes(status);
const infoOf = message => message?.info || message?.properties?.info || message?.data?.info || {};
const partsOf = message => message?.parts || message?.properties?.parts || message?.data?.parts || [];
const taskPart = part => part?.type === 'subtask' || (part?.type === 'tool' && part.tool === 'task');
const messageIdOf = event => {
  const data = Workflow.dataOf(event);
  return String(data.part?.messageID || data.messageID || data.assistantMessageID || data.info?.id || '');
};

function partOfEvent(event, known = false) {
  const data = Workflow.dataOf(event);
  if (taskPart(data.part)) return data.part;
  if (event?.type === 'session.next.tool.called' && data.tool === 'task') {
    return { type: 'tool', tool: 'task', callID: data.callID, state: { input: data.input, status: 'running' } };
  }
  if (known && /^session\.next\.tool\.(success|failed)$/.test(event?.type || '')) {
    return { type: 'tool', tool: 'task', callID: data.callID, state: {
      output: data.result ?? data.content, metadata: data.structured,
      error: data.error, status: event.type.endsWith('.success') ? 'completed' : 'error'
    } };
  }
  return null;
}

// One ledger per parent turn. Native child sessions may be reused: task-call
// identity, rather than a session ID or role, determines a completion receipt.
class SubagentCompletionTracker {
  constructor({ runId, sessionID, directory, startedAt = 0, zSessionId = '', conversationRevision = 0,
    baselineIDs = new Set(), baselineMessages = [], onEvent = () => {} } = {}) {
    this.context = { parentRunId: runId, parentSessionID: sessionID, directory, zSessionId, conversationRevision };
    this.startedAt = Number(startedAt) || 0;
    this.baselineIDs = baselineIDs;
    this.baselineCalls = baselineMessages.flatMap(message => partsOf(message).filter(taskPart)
      .map(part => Workflow.taskInfo(part))).filter(task => task.callId);
    this.records = new Map();
    this.assistants = new Map();
    this.onEvent = onEvent;
    this.sealed = false;
  }

  find({ callId, startedAt } = {}) {
    const records = [...this.records.values()].filter(record => record.callId === String(callId || ''));
    return records.find(record => Number(record.startedAt) === Number(startedAt))
      || (records.length === 1 ? records[0] : null);
  }

  accepts(event, { trusted = false } = {}) {
    if (this.baselineIDs.has(messageIdOf(event))) return false;
    const data = Workflow.dataOf(event);
    const callId = String(data.part?.callID || data.part?.callId || data.callID || data.part?.id || '');
    const known = [...this.records.values()].some(record => record.callId === callId);
    const part = partOfEvent(event, known);
    if (!part) return true;
    const info = Workflow.taskInfo(part);
    if (!info.callId || this.baselineCalls.some(task => task.callId === info.callId
      && (!info.startedAt || !task.startedAt || task.startedAt === info.startedAt))) return false;
    if (info.startedAt && this.startedAt && info.startedAt < this.startedAt) return false;
    if (known) return true;
    if (this.sealed) return false;
    return trusted || !this.startedAt || !!messageIdOf(event) || !!info.startedAt;
  }

  observe(event, options = {}) {
    if (!this.accepts(event, options)) return null;
    const data = Workflow.dataOf(event);
    if (event?.type === 'message.updated' && data.info?.role === 'assistant') {
      this.assistants.set(String(data.info.id || ''), data.info);
      for (const record of this.records.values()) this.updateConsumed(record);
      return null;
    }
    const callId = String(data.part?.callID || data.part?.callId || data.callID || data.part?.id || '');
    const known = [...this.records.values()].some(record => record.callId === callId);
    const part = partOfEvent(event, known);
    if (!part) return null;
    const info = Workflow.taskInfo(part);
    let record = this.find(info);
    // Pending task input arrives before native time.start. It may be enriched
    // once before its first lifecycle event makes the identity persistent.
    if (!record) record = [...this.records.values()].find(item => item.callId === info.callId && !item.emitted);
    if (!record) {
      record = { ...this.context, callId: info.callId, startedAt: info.startedAt || Date.now(),
        childSessionID: '', completedAt: 0, status: 'running', role: '', title: '', result: '', consumed: false };
      this.records.set(`${record.callId}:${record.startedAt}`, record);
    } else if (!record.emitted && info.startedAt && record.startedAt !== info.startedAt) {
      this.records.delete(`${record.callId}:${record.startedAt}`);
      record.startedAt = info.startedAt;
      this.records.set(`${record.callId}:${record.startedAt}`, record);
    }
    for (const field of ['childSessionID', 'role', 'title']) if (info[field]) record[field] = info[field];
    record.parentMessageID ||= messageIdOf(event);
    if (terminal(info.status)) {
      record.status = info.status;
      record.result = info.result || info.error || record.result;
      record.completedAt = info.completedAt || record.completedAt || Date.now();
      record.parentTaskCompleted = true;
      if (info.error) record.error = info.error;
    }
    this.updateConsumed(record);
    this.emit(record);
    return record;
  }

  updateConsumed(record) {
    if (record.consumed || !record.parentTaskCompleted || !record.completedAt) return;
    // A tool result exists before the model sees it. Only a subsequent parent
    // assistant generation proves it was included in a later model request.
    record.consumed = [...this.assistants.values()].some(info => !info.error
      && info.id !== record.parentMessageID && Number(info.time?.created) > record.completedAt);
    if (record.consumed) this.emit(record);
  }

  reconcile(messages) {
    const fresh = (Array.isArray(messages) ? messages : []).filter(message => !this.baselineIDs.has(infoOf(message).id));
    for (const message of fresh) for (const part of partsOf(message).filter(taskPart)) {
      this.observe({ type: 'message.part.updated', data: { part: { ...part, messageID: infoOf(message).id } } }, { trusted: true });
    }
    for (const message of fresh) this.observe({ type: 'message.updated', data: { info: infoOf(message) } });
  }

  snapshot(record) {
    const { emitted, parentTaskCompleted, parentMessageID, ...publicRecord } = record;
    return publicRecord;
  }

  emit(record) {
    if (!record.childSessionID || !record.callId || this.sealed) return;
    const data = this.snapshot(record);
    const signature = JSON.stringify(data);
    if (record.emitted === signature) return;
    record.emitted = signature;
    this.onEvent({ type: 'z.subagent.lifecycle', data });
  }

  applyInspection(record, inspected) {
    if (!record || inspected.status === 'unknown') return;
    record.status = inspected.status;
    record.result = inspected.result || record.result;
    record.completedAt = inspected.completedAt || record.completedAt;
    record.consumed ||= inspected.consumed === true;
    if (inspected.error) record.error = inspected.error;
  }

  backgroundRecords() {
    return [...this.records.values()].filter(record => record.childSessionID && !terminal(record.status));
  }
}

function messagesOf(response) {
  if (response?.error) throw new Error(response.error?.data?.message || response.error?.message || '读取子代理记录失败');
  const messages = response?.data?.messages || response?.data || response?.messages;
  if (!Array.isArray(messages)) throw new Error('子代理消息记录不可用');
  return messages;
}

function inspectMessages(record, parentMessages, childMessages, { idle = false, disk = false } = {}) {
  const start = Number(record.startedAt) || 0;
  if (!record.callId || !start || !record.parentSessionID || !record.childSessionID) return { status: 'unknown', result: '', completedAt: 0, consumed: false };
  const tasks = parentMessages.flatMap(message => partsOf(message).filter(taskPart)
    .map(part => ({ ...Workflow.taskInfo(part), parentMessageID: infoOf(message).id })));
  const matches = tasks.filter(task => task.callId === record.callId && (!task.startedAt || Math.abs(task.startedAt - start) <= 1000)
    && (!task.childSessionID || task.childSessionID === record.childSessionID));
  const task = matches.at(-1);
  // Exact task timestamps prevent a second invocation of a reusable child
  // session from reading the previous invocation's completed assistant.
  const nextStart = Math.min(...tasks.filter(item => item.childSessionID === record.childSessionID
    && item.callId !== record.callId && item.startedAt > start).map(item => item.startedAt), Infinity);
  const fresh = childMessages.filter(message => {
    const info = infoOf(message);
    const created = Number(info.time?.created);
    return info.role === 'assistant' && created >= start && created < nextStart;
  }).sort((a, b) => Number(infoOf(a).time?.created) - Number(infoOf(b).time?.created));
  const last = fresh.at(-1);
  const info = infoOf(last);
  const finish = String(info.finish || '');
  const childFinished = !!info.time?.completed && (!!info.error || (!!finish && !['tool-calls', 'unknown'].includes(finish)))
    && partsOf(last).filter(part => part.type === 'tool').every(part => ['completed', 'error'].includes(part.state?.status));
  const parentTerminal = task && terminal(task.status) && task.completedAt;
  let status = 'running', result = '', completedAt = 0, error = '';
  if (parentTerminal) {
    status = task.status === 'completed' ? 'completed' : 'error';
    result = task.result || task.error || '';
    completedAt = task.completedAt;
    error = task.error || '';
  } else if ((idle || disk) && childFinished) {
    status = info.error ? 'error' : 'completed';
    completedAt = Number(info.time.completed);
    result = partsOf(last).filter(part => part.type === 'text' && !part.ignored).map(part => String(part.text || '')).join('\n').trim();
    error = info.error?.data?.message || info.error?.message || '';
  } else if (disk || !task) status = 'unknown';
  const consumed = !!parentTerminal && parentMessages.some(message => {
    const assistant = infoOf(message);
    return assistant.role === 'assistant' && !assistant.error && assistant.id !== task.parentMessageID
      && Number(assistant.time?.created) > completedAt;
  });
  return { status, result, completedAt, consumed, ...(error ? { error } : {}) };
}

async function inspectNativeCompletion(client, record, { signal } = {}) {
  if (!client?.session?.messages || !client?.session?.status) return { status: 'unknown', result: '', completedAt: 0, consumed: false };
  try {
    const [parent, child, statuses] = await Promise.all([
      client.session.messages({ sessionID: record.parentSessionID, directory: record.directory }, { signal }),
      client.session.messages({ sessionID: record.childSessionID, directory: record.directory }, { signal }),
      client.session.status({ directory: record.directory }, { signal })
    ]);
    if (statuses?.error) throw new Error('子代理运行状态读取失败');
    const statusMap = statuses?.data;
    const idle = !!statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap)
      && (!statusMap[record.childSessionID] || statusMap[record.childSessionID]?.type === 'idle');
    return inspectMessages(record, messagesOf(parent), messagesOf(child), { idle });
  } catch (error) {
    return { status: 'unknown', result: '', completedAt: 0, consumed: false, error: error?.message || String(error) };
  }
}

module.exports = { SubagentCompletionTracker, inspectNativeCompletion, inspectMessages, messageIdOf, partOfEvent };
