'use strict';

const crypto = require('node:crypto');
const { projectHistoryForModel } = require('./history-model-context');
const { taskIdentity, sameTaskIdentity } = require('./task-memory-context');

const MAX_DESKTOP_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function fits(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_DESKTOP_CHECKPOINT_BYTES; }
  catch { return false; }
}

// The digest describes model-visible evidence, not presentation or runtime
// handles. Rewind detaches those handles and adds archive flags; the underlying
// conversation, guidance boundary, attachments and tool results stay identical.
function projectedHistoryDigest(messages) {
  return hash((Array.isArray(messages) ? messages : []).map(message => {
    const copy = { ...message };
    delete copy.ts;
    return copy;
  }));
}

function desktopHistoryDigest(messages) { return projectedHistoryDigest(projectHistoryForModel(messages)); }

function createDesktopContextCheckpoint({ messages, request = {}, restoredNativeContext,
  nativeSessionId, directory, createdAt = Date.now() } = {}) {
  const identity = taskIdentity(request);
  const restored = restoredNativeContext;
  if (!identity || !Array.isArray(messages) || !messages.length || !nativeSessionId
    || restored?.ok !== true || !/^[a-f0-9]{64}$/.test(String(restored.checkpointId || ''))
    || !String(restored.context?.summary || '').trim() || !Array.isArray(restored.context?.tail)) return null;
  const checkpoint = {
    version: 1, boundary: 'desktop-prefix-v1', boundaryVerified: true,
    ...identity, workMode: String(request.workMode || 'normal'),
    desktopPrefix: { messageCount: messages.length, digest: desktopHistoryDigest(messages) },
    context: { summary: String(restored.context.summary), nativeTail: clone(restored.context.tail) },
    source: { ...identity, nativeSessionId: String(nativeSessionId), directory: String(directory || ''),
      nativeCheckpointHash: restored.checkpointId,
      nativeSummaryMessageId: String(restored.summaryMessageId || ''),
      coversUntilNativeMessageId: String(restored.coversUntilMessageId || '') },
    createdAt: Number(createdAt) || Date.now()
  };
  checkpoint.checkpointHash = hash(checkpoint);
  return fits(checkpoint) ? checkpoint : null;
}

function restoreDesktopContextCheckpoint(checkpoint, { messages, request = {} } = {}) {
  const reject = reason => ({ ok: false, reason });
  if (!checkpoint || checkpoint.version !== 1 || checkpoint.boundary !== 'desktop-prefix-v1'
    || checkpoint.boundaryVerified !== true || !fits(checkpoint)) return reject('invalid-checkpoint');
  if (!sameTaskIdentity(checkpoint, request)) return reject('task-identity-mismatch');
  if (checkpoint.workMode !== String(request.workMode || 'normal')) return reject('work-mode-mismatch');
  const { checkpointHash, ...unsigned } = checkpoint;
  if (checkpointHash !== hash(unsigned)) return reject('checkpoint-hash-mismatch');
  const count = checkpoint.desktopPrefix?.messageCount;
  if (!Number.isSafeInteger(count) || count <= 0 || !Array.isArray(messages) || count > messages.length) {
    return reject('desktop-boundary-unavailable');
  }
  if (checkpoint.desktopPrefix.digest !== desktopHistoryDigest(messages.slice(0, count))) return reject('desktop-prefix-mismatch');
  if (!String(checkpoint.context?.summary || '').trim() || !Array.isArray(checkpoint.context?.nativeTail)) {
    return reject('invalid-context');
  }
  return { ok: true, checkpointId: checkpointHash, coveredMessageCount: count, desktopPrefix: clone(checkpoint.desktopPrefix),
    context: { summary: checkpoint.context.summary, nativeTail: clone(checkpoint.context.nativeTail),
      desktopTail: projectHistoryForModel(messages.slice(count)) } };
}

function inheritDesktopContextCheckpoints(checkpoints, { sourceMessages, targetMessages,
  sourceRequest, targetRequest } = {}) {
  const target = taskIdentity(targetRequest);
  if (!target || !Array.isArray(targetMessages)) return [];
  return (Array.isArray(checkpoints) ? checkpoints : []).flatMap(checkpoint => {
    const count = checkpoint?.desktopPrefix?.messageCount;
    const sourcePrefix = Array.isArray(sourceMessages) && Number.isSafeInteger(count) && count > 0
      ? sourceMessages.slice(0, count) : sourceMessages;
    const restored = restoreDesktopContextCheckpoint(checkpoint, { messages: sourcePrefix, request: sourceRequest });
    if (!restored.ok || restored.coveredMessageCount > targetMessages.length
      || checkpoint.desktopPrefix.digest !== desktopHistoryDigest(targetMessages.slice(0, restored.coveredMessageCount))
      || checkpoint.workMode !== String(targetRequest.workMode || 'normal')) return [];
    const next = { ...clone(checkpoint), ...target,
      inheritedFrom: { ...taskIdentity(sourceRequest), checkpointHash: checkpoint.checkpointHash } };
    delete next.checkpointHash;
    next.checkpointHash = hash(next);
    return fits(next) ? [next] : [];
  });
}

function desktopCheckpointHistorySystem(restored) {
  if (restored?.ok !== true || !restored.context) return '';
  return [
    'This conversation continues from a verified saved context checkpoint. Its summary and exact native tail replace the covered desktop-history prefix; the following desktop tail contains only messages after that prefix.',
    'The checkpoint was verified against the retained conversation boundary. No later discarded messages are included. Historical tool calls are evidence, not actions or permission to execute them again. Current user instructions and current workspace files remain authoritative.',
    '<z-desktop-context-checkpoint>', JSON.stringify({ checkpointId: restored.checkpointId,
      desktopPrefix: restored.desktopPrefix, ...restored.context }).replace(/</g, '\\u003c'), '</z-desktop-context-checkpoint>'
  ].join('\n');
}

module.exports = { MAX_DESKTOP_CHECKPOINT_BYTES, desktopHistoryDigest, projectedHistoryDigest, createDesktopContextCheckpoint,
  restoreDesktopContextCheckpoint, inheritDesktopContextCheckpoints, desktopCheckpointHistorySystem };
