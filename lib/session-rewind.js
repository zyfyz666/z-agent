'use strict';

const crypto = require('node:crypto');
const { forkBoundary, detachedHistoryMessage } = require('./session-fork');
const { inferSessionModelSelection, sessionModelSnapshot } = require('./session-model');

function rewindError(message, code = 'SESSION_REWIND_FAILED') {
  return Object.assign(new Error(message), { code });
}

function sessionConversationRevision(session) {
  return Number.isSafeInteger(session?.conversationRevision) && session.conversationRevision >= 0
    ? session.conversationRevision : 0;
}

function assertConversationRevision(stored, requested) {
  const expected = requested === undefined ? 0 : requested;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== sessionConversationRevision(stored)) {
    throw rewindError('对话已回退或恢复，请重新打开后再操作。', 'SESSION_REVISION_CHANGED');
  }
}

function rewindBoundary(source, boundary) {
  try {
    const prefix = forkBoundary(source, boundary);
    if (boundary.includeSelected === false) {
      if (prefix.at(-1)?.role !== 'user') throw rewindError('只可撤回已保存的用户消息。', 'SESSION_REWIND_INVALID_BOUNDARY');
      return prefix.slice(0, -1);
    }
    return prefix;
  }
  catch (error) {
    if (error.code === 'SESSION_GUIDANCE_BOUNDARY_UNAVAILABLE') throw error;
    throw rewindError(error.code === 'SESSION_FORK_MESSAGE_IN_PROGRESS'
      ? '当前消息仍在生成，请结束后再回退。' : '回退起点已变化，请重新打开该消息后重试。',
    error.code === 'SESSION_FORK_MESSAGE_IN_PROGRESS' ? 'SESSION_REWIND_BUSY' : 'SESSION_REWIND_INVALID_BOUNDARY');
  }
}

function rewindHistory(messages, sourceId) {
  return messages.map((message, index) => {
    const copy = detachedHistoryMessage(message, sourceId, index);
    function detach(value) {
      if (!value || typeof value !== 'object') return;
      for (const key of Object.keys(value)) {
        if (/^(?:openCodeSessionId|nativeSessionId|kernelSessionId|sessionID|runId|parentRunId|rootRunId|requestId|permissionId|questionId|intentId|approvalId|rollback.*)$/i.test(key)) delete value[key];
        else detach(value[key]);
      }
    }
    detach(copy);
    removeTerminalBookkeeping(copy);
    return copy;
  });
}

// Keep this list aligned with main.js's read/save migration. These are only
// terminal subagent de-duplication/stream buffers, never Observer or tool logs.
function removeTerminalBookkeeping(message) {
  for (const record of Array.isArray(message?.agentRun?.subagents) ? message.agentRun.subagents : []) {
    if (!['completed', 'error', 'interrupted', 'incomplete'].includes(record?.status)) continue;
    for (const key of ['seenEvents', 'milestones', 'pendingDeltas', 'nextStreams', 'partKinds', 'messages']) delete record[key];
  }
}

function historyDigest(messages) {
  const canonical = JSON.parse(JSON.stringify(messages));
  for (const message of canonical) {
    // Review badges are derived from workspace visibility on each read/list.
    // Their migration may change count/summary even though history is intact.
    // Text, attachments, model snapshots, Observer and tool evidence stay hashed.
    if (message?.agentRun) {
      delete message.agentRun.changeSummary;
      delete message.agentRun.changeCount;
    }
    removeTerminalBookkeeping(message);
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function createRewindBackup(source, { id, now = Date.now() } = {}) {
  if (!/^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || ''))) throw rewindError('备份对话 ID 无效。');
  const messages = rewindHistory(Array.isArray(source.messages) ? source.messages : [], source.id);
  const modelSelection = inferSessionModelSelection(source, source.modelSelection);
  return {
    id, title: `${String(source.title || '对话').slice(0, 70)} · 回退前`,
    messages, modelSelection, observerEnabled: source.observerEnabled !== false, pinned: false,
    workspace: source.workspace, workspaceKind: 'selected', createdAt: now, updatedAt: now,
    conversationRevision: 0,
    contextReset: { kind: 'rewind-backup', sourceSessionId: source.id,
      messageCount: messages.length, messageIndex: messages.length - 1, createdAt: now },
    rewindBackupOf: { sessionId: source.id, messageCount: messages.length,
      historyDigest: historyDigest(messages), modelSelection, createdAt: now }
  };
}

function restoreRewindSnapshot(source, backup) {
  const snapshot = backup?.rewindBackupOf;
  const count = snapshot?.messageCount;
  if (!backup || backup.id !== source.rewindState?.backupSessionId || snapshot?.sessionId !== source.id
    || !Number.isInteger(count) || count < 0 || !Array.isArray(backup.messages) || backup.messages.length < count) {
    throw rewindError('回退前的备份对话不存在或已损坏，无法恢复。', 'SESSION_REWIND_BACKUP_NOT_FOUND');
  }
  const messages = backup.messages.slice(0, count);
  if (historyDigest(messages) !== snapshot.historyDigest) {
    throw rewindError('备份中的原始消息已经改变，无法恢复该快照。', 'SESSION_REWIND_BACKUP_CHANGED');
  }
  return { messages, modelSelection: sessionModelSnapshot(snapshot.modelSelection) };
}

function createRewoundSession(source, messages, { backupSessionId, action = 'rewind', now = Date.now(),
  modelSelection, candidates = [], defaultSelection } = {}) {
  const revision = sessionConversationRevision(source);
  if (revision >= Number.MAX_SAFE_INTEGER) throw rewindError('对话版本已超出范围。');
  const next = {};
  for (const key of ['id', 'title', 'pinned', 'workspace', 'workspaceKind', 'createdAt', 'forkedFrom', 'rewindBackupOf', 'browserState']) {
    if (source[key] !== undefined) next[key] = JSON.parse(JSON.stringify(source[key]));
  }
  next.messages = rewindHistory(messages, source.id);
  next.observerEnabled = source.observerEnabled !== false;
  next.modelSelection = sessionModelSnapshot(modelSelection)
    || inferSessionModelSelection({ messages }, source.modelSelection || defaultSelection, candidates);
  next.conversationRevision = revision + 1;
  next.updatedAt = now;
  next.contextReset = { kind: action, sourceSessionId: source.id, messageCount: messages.length,
    messageIndex: messages.length - 1, createdAt: now };
  next.rewindState = { backupSessionId, createdAt: now, action };
  return next;
}

module.exports = { sessionConversationRevision, assertConversationRevision, rewindBoundary,
  createRewindBackup, restoreRewindSnapshot, createRewoundSession };
