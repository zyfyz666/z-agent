'use strict';

const crypto = require('node:crypto');
const { inferSessionModelSelection } = require('./session-model');

function forkError(message, code = 'SESSION_FORK_INVALID_BOUNDARY') {
  return Object.assign(new Error(message), { code });
}

// Keep this small, fixed-order payload identical to the renderer's Web Crypto
// implementation. The renderer supplies an identity, never the copied data.
function messageForkAnchor(message = {}) {
  return crypto.createHash('sha256').update(JSON.stringify([
    message.role ?? null, message.ts ?? null, message.id ?? null,
    message.content ?? '', message.attachments ?? [], message.agentRun?.runId ?? null
  ])).digest('hex');
}

function matchesForkAnchor(message, anchor) {
  return typeof anchor === 'string' && /^[a-f0-9]{64}$/i.test(anchor)
    && crypto.timingSafeEqual(Buffer.from(messageForkAnchor(message), 'hex'), Buffer.from(anchor, 'hex'));
}

function forkBoundary(source, { sessionId, messageIndex, messageAnchor } = {}) {
  if (String(source?.id || '') !== String(sessionId || '')) throw forkError('来源对话不存在。', 'SESSION_FORK_SOURCE_NOT_FOUND');
  const messages = Array.isArray(source.messages) ? source.messages : [];
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= messages.length) {
    throw forkError('分支起点已变化，请重新打开该消息后重试。');
  }
  const selected = messages[messageIndex];
  if (!['user', 'assistant'].includes(selected?.role) || !matchesForkAnchor(selected, messageAnchor)) {
    throw forkError('分支起点已变化，请重新打开该消息后重试。');
  }
  if (selected.streaming === true || selected.pending === true
    || ['running', 'working', 'pending', 'waiting', 'queued', 'thinking'].includes(selected.agentRun?.status)) {
    throw forkError('请选择已保存的消息创建分支，当前回复仍在生成。', 'SESSION_FORK_MESSAGE_IN_PROGRESS');
  }
  return messages.slice(0, messageIndex + 1);
}

function detachedHistoryMessage(message, sourceSessionId, messageIndex) {
  const copy = JSON.parse(JSON.stringify(message));
  const originalRunId = String(copy.agentRun?.runId || '');
  // Text, tool results, media, model snapshots, and Observer history remain.
  // Runtime handles cannot be reused to cancel or roll back the source task.
  function detach(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (/^(?:openCodeSessionId|runId|parentRunId|rootRunId|requestId|requestID|permissionId|permissionID|questionId|questionID|intentId|approvalId|rollback.*)$/i.test(key)) {
        delete value[key];
      } else detach(value[key]);
    }
  }
  detach(copy);
  copy.forkedHistory = true;
  if (copy.agentRun) {
    copy.agentRun.forkedHistory = true;
    copy.agentRun.forkedFrom = { sessionId: sourceSessionId, messageIndex, ...(originalRunId ? { runId: originalRunId } : {}) };
  }
  return copy;
}

function createSessionForkRecord(source, boundary, { id, workspace, now = Date.now(), defaultSelection, candidates = [] } = {}) {
  const prefix = forkBoundary(source, boundary);
  if (!/^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || ''))) throw forkError('新分支 ID 无效。');
  if (!String(workspace || '').trim()) throw forkError('来源任务文件夹不可用。', 'SESSION_FORK_WORKSPACE_UNAVAILABLE');
  const modelSelection = inferSessionModelSelection({ messages: prefix }, source.modelSelection || defaultSelection, candidates);
  return {
    id,
    title: `${String(source.title || '对话').slice(0, 74)} · 分支`,
    messages: prefix.map((message, index) => detachedHistoryMessage(message, source.id, index)),
    modelSelection, pinned: false, workspace, workspaceKind: 'selected',
    createdAt: now, updatedAt: now,
    forkedFrom: {
      sessionId: source.id, messageIndex: boundary.messageIndex, messageCount: prefix.length,
      messageAnchor: boundary.messageAnchor, title: String(source.title || '对话'),
      workspaceShared: true, sourceWorkspaceKind: source.workspaceKind || (source.workspace ? 'selected' : 'default'), createdAt: now
    }
  };
}

function isForkSession(session) {
  return !!session?.forkedFrom?.sessionId && Number.isInteger(session.forkedFrom.messageCount)
    && session.forkedFrom.messageCount > 0;
}

function preserveForkAuthority(stored, incoming) {
  if (!isForkSession(stored)) {
    // Provenance and kernel authority can only originate from session:fork.
    const clean = { ...incoming };
    delete clean.forkedFrom;
    return clean;
  }
  const prefixCount = stored.forkedFrom.messageCount;
  const incomingMessages = Array.isArray(incoming.messages) ? incoming.messages : [];
  const result = { ...incoming, forkedFrom: stored.forkedFrom,
    messages: [...stored.messages.slice(0, prefixCount), ...incomingMessages.slice(prefixCount)] };
  for (const key of ['handoff', 'parentSessionId', 'openCodeSessionId']) delete result[key];
  if (stored.openCodeSessionId) result.openCodeSessionId = stored.openCodeSessionId;
  return result;
}

function forkRunContext(session, request = {}) {
  if (!isForkSession(session)) return null;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  let end = messages.length;
  const hasIndex = Object.prototype.hasOwnProperty.call(request, 'requestMessageIndex');
  const hasAnchor = Object.prototype.hasOwnProperty.call(request, 'requestMessageAnchor');
  if (hasIndex || hasAnchor) {
    const index = request.requestMessageIndex;
    const message = Number.isInteger(index) ? messages[index] : null;
    if (!hasIndex || !hasAnchor || !message || message.role !== 'user' || message.forkedHistory
      || index < session.forkedFrom.messageCount || !matchesForkAnchor(message, request.requestMessageAnchor)
      || String(message.content || '').trim() !== String(request.prompt || '').trim()) {
      throw forkError('本轮消息边界已变化，请重新发送。', 'SESSION_FORK_RUN_BOUNDARY_CHANGED');
    }
    end = index;
  } else {
    // Older callers may not have saved their new prompt yet. Never remove an
    // inherited user message just because the new prompt has the same text.
    for (let index = messages.length - 1; index >= session.forkedFrom.messageCount; index--) {
      if (messages[index]?.role === 'user' && !messages[index].forkedHistory
        && String(messages[index].content || '').trim() === String(request.prompt || '').trim()) {
        end = index;
        break;
      }
    }
  }
  const history = JSON.parse(JSON.stringify(messages.slice(0, end)));
  return {
    openCodeSessionId: String(session.openCodeSessionId || ''), history,
    forkHistory: { sourceSessionId: session.forkedFrom.sessionId, messageIndex: session.forkedFrom.messageIndex, messages: history }
  };
}

module.exports = { messageForkAnchor, forkBoundary, detachedHistoryMessage, createSessionForkRecord,
  isForkSession, preserveForkAuthority, forkRunContext };
