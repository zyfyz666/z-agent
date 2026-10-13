'use strict';

const crypto = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const validRef = ref => typeof ref === 'string' && /^[a-f0-9]{64}$/.test(ref);
function contextError(message, code = 'CONTEXT_STATE_UNAVAILABLE') {
  return Object.assign(new Error(message), { code });
}

// The persisted context is the native conversation, never a UI projection.
// Select exactly the completed compaction's summary and retained tail. Keep
// chronological storage order; the native model adapter orders the summary
// before that tail. Failed/in-flight compactions cannot discard any history.
function activeNativeMessages(messages = []) {
  const list = messages.slice().sort((a, b) => a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0);
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const summary = list[i];
    if (summary.info.role !== 'assistant' || !summary.info.summary || !summary.info.finish || summary.info.error
      || !summary.info.time?.completed || ['error', 'tool-calls', 'unknown'].includes(summary.info.finish)
      || !summary.parts?.some(p => p.type === 'text' && p.text?.trim())) continue;
    const markerIndex = list.findIndex(m => m.info.id === summary.info.parentID && m.info.role === 'user');
    const marker = list[markerIndex]?.parts.find(p => p.type === 'compaction');
    if (!marker || markerIndex >= i) continue;
    if (marker.tail_start_id) {
      const tailIndex = list.findIndex(m => m.info.id === marker.tail_start_id);
      if (tailIndex < 0 || tailIndex > markerIndex) throw contextError('压缩摘要的保留边界缺失，不能恢复此上下文。');
      start = tailIndex;
    } else start = markerIndex;
    break;
  }
  return list.slice(start);
}

function snapshotMessages(messages, { seal = false } = {}) {
  return activeNativeMessages(messages).map(message => {
    const next = clone(message);
    if (next.info.role === 'assistant') {
      // Historical billing belongs to the archive. It describes the original
      // (possibly much larger) request, not this restored context's occupancy.
      next.info.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      next.info.cost = 0;
    }
    next.parts = (next.parts || []).filter(p => p.type !== 'patch' && p.type !== 'snapshot').map(part => {
      if (part.type === 'tool' && part.state?.status === 'error') delete part.state.title;
      if (part.type === 'tool' && part.state?.time?.compacted) {
        part.state.output = '[Old tool result content cleared]';
        delete part.state.attachments;
      }
      // A branch records an interrupted operation as historical evidence;
      // it must never resume a half-finished tool or perform a file rollback.
      if (seal && part.type === 'tool' && !['completed', 'error'].includes(part.state?.status)) {
        part.state = { status: 'error', input: part.state?.input || {},
          error: 'Operation was still in progress at this conversation boundary. Its later result is not part of this branch.',
          time: { start: part.state?.time?.start || 0, end: part.state?.time?.start || 0 } };
      }
      return part;
    });
    if (seal && next.info.role === 'assistant' && !next.info.time?.completed) {
      next.info.time = { ...next.info.time, completed: next.info.time?.created || 1 };
      next.info.finish = 'stop';
    }
    return next;
  });
}

function contextContentDigest(messages) {
  const ids = new Map(messages.map((m, i) => [m.info.id, `m${i}`]));
  return digest(messages.map(m => {
    const info = { ...m.info }; delete info.id; delete info.sessionID;
    if (info.parentID) info.parentID = ids.get(info.parentID) || 'outside-context';
    return { info, parts: m.parts.map(p => {
      const part = { ...p }; delete part.id; delete part.messageID; delete part.sessionID;
      if (part.tail_start_id) part.tail_start_id = ids.get(part.tail_start_id) || 'outside-context';
      return part;
    }) };
  }));
}

function portableSnapshotMessages(messages) {
  const ids = new Map(messages.map((message, index) => [message.info.id, `msg_${String(index + 1).padStart(12, '0')}`]));
  let partIndex = 0;
  return messages.map(message => {
    const info = { ...message.info, id: ids.get(message.info.id), sessionID: 'snapshot' };
    if (info.parentID) info.parentID = ids.get(info.parentID) || 'outside-context';
    return { info, parts: message.parts.map(original => {
      const part = { ...original, id: `prt_${String(++partIndex).padStart(12, '0')}`,
        messageID: info.id, sessionID: 'snapshot' };
      if (part.tail_start_id) part.tail_start_id = ids.get(part.tail_start_id) || 'outside-context';
      return part;
    }) };
  });
}

function boundaryKey(message) {
  if (message?.liveGuidance?.requestId) return `guidance:${message.liveGuidance.requestId}`;
  if (message?.role === 'assistant') {
    const run = message.agentRun?.runId || message.agentRun?.forkedFrom?.runId;
    if (run) return `after:${run}`;
  }
  return `before:${digest([message?.role, message?.ts, message?.id, message?.content || '', message?.attachments || []])}`;
}

function pointReference(session, message) {
  if (validRef(message?.contextSnapshot)) return message.contextSnapshot;
  const key = boundaryKey(message);
  return session?.contextState?.points?.[key] || '';
}

function inheritedContextState(source, target, head) {
  const points = {}, used = new Set();
  for (const message of target.messages) {
    if (message.agentRun?.historyBoundaryAt) continue;
    const index = source.messages.findIndex((m, i) => !used.has(i) && m.role === message.role
      && m.ts === message.ts && m.content === message.content);
    if (index < 0) continue;
    used.add(index);
    const original = source.messages[index], ref = pointReference(source, original);
    if (validRef(ref)) { message.contextSnapshot = ref; points[boundaryKey(message)] = ref; }
    const afterUser = source.contextState?.points?.[`after-user:${boundaryKey(original)}`];
    if (validRef(afterUser)) points[`after-user:${boundaryKey(message)}`] = afterUser;
  }
  return { version: 2, head, points, needsRestore: true };
}

function estimateSnapshotTokens(messages) {
  let size = 0;
  for (const message of messages) for (const part of message.parts || []) {
    const value = part.type === 'tool' ? JSON.stringify([part.state?.input, part.state?.output, part.state?.error])
      : ['text', 'reasoning'].includes(part.type) ? part.text || '' : '';
    for (const char of value) size += char.codePointAt(0) >= 0x2e80 ? 1 : 0.28;
    size += 8;
  }
  return Math.ceil(size);
}

function clipNativeBoundary(messages, run, baselineIDs) {
  const timeline = run.timeline || [], at = Number(run.historyBoundaryAt);
  const text = new Map(timeline.filter(p => /^(?:text|reasoning):prt_/.test(p.openCodeKey || ''))
    .map(p => [p.openCodeKey.split(':')[1], String(p.content || '')]));
  const calls = new Map(timeline.filter(p => p.type === 'tool_call' && p.callId).map(p => [p.callId, p]));
  const results = new Set(timeline.filter(p => p.type === 'tool_result' && p.callId).map(p => p.callId));
  const copied = clone(messages);
  return copied.filter(message => {
    if (baselineIDs?.has(message.info.id) || (!baselineIDs && Number(message.info.time?.created) < Number(run.startedAt))) return true;
    if (message.info.role === 'user') return Number(message.info.time?.created) <= at;
    message.parts = message.parts.filter(part => {
      if (part.type === 'text' || part.type === 'reasoning') {
        if (!text.has(part.id)) return false;
        part.text = text.get(part.id); return true;
      }
      if (part.type !== 'tool' || !calls.has(part.callID)) return false;
      if (!results.has(part.callID) || Number(part.state?.time?.end) > at) {
        part.state = { status: 'running', input: calls.get(part.callID).args || {}, time: { start: at } };
      }
      return true;
    });
    if (Number(message.info.time?.completed) > at || !message.info.time?.completed) {
      delete message.info.error;
      message.info.time = { ...message.info.time, completed: at };
      message.info.finish = 'stop';
    }
    return message.parts.length > 0;
  });
}

module.exports = { canonical, digest, validRef, contextError, activeNativeMessages, snapshotMessages,
  contextContentDigest, boundaryKey, pointReference, inheritedContextState, clipNativeBoundary, estimateSnapshotTokens, portableSnapshotMessages };
