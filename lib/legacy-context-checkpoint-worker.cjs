'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { captureNativeCheckpoint, restoreNativeCheckpoint } = require('./task-memory-context');
const { createDesktopContextCheckpoint } = require('./desktop-context-checkpoint');
const { verifyNativeDesktopCoverage } = require('./native-desktop-coverage');

function directoryKey(directory) {
  const value = path.resolve(String(directory || ''));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function recoveryCandidates(messages) {
  const candidates = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant' || message.agentRun?.status !== 'done') continue;
    const lastText = (message.agentRun.timeline || []).findLast(item => item?.type === 'text' && String(item.content || '').trim());
    const id = /^text:(prt_[A-Za-z0-9_-]+)$/.exec(String(lastText?.openCodeKey || ''))?.[1];
    if (!id) continue;
    candidates.push({ index, partId: id, text: String(lastText.content),
      compacted: !!message.agentRun.contextCompression || Number(message.agentRun.contextCompressionCount) > 0 });
  }
  // The first complete turn after compaction usually has the smallest exact
  // retained tail. Telemetry only orders candidates; it never proves coverage.
  return [...candidates.filter(item => item.compacted).slice(0, 8),
    ...candidates.filter(item => !item.compacted).slice(0, 4)];
}

function readLegacyDesktopCheckpoint({ dbPath, messages, request = {}, directory } = {}) {
  const reject = reason => ({ checkpoint: null, reason });
  if (!dbPath || !fs.existsSync(dbPath) || !directory || !Array.isArray(messages) || !messages.length) {
    return reject('source-unavailable');
  }
  const candidates = recoveryCandidates(messages);
  if (!candidates.length) return reject('native-boundary-unavailable');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let lastReason = 'native-boundary-unavailable';
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const anchorQuery = db.prepare(`SELECT p.message_id, p.session_id, p.data AS part_data,
      m.data AS message_data, m.time_created FROM part p JOIN message m ON m.id=p.message_id WHERE p.id=?`);
    const sessionQuery = db.prepare('SELECT id, directory, parent_id FROM session WHERE id=?');
    const messageQuery = db.prepare(`SELECT id, data FROM message WHERE session_id=?
      AND (time_created < ? OR (time_created = ? AND id <= ?)) ORDER BY time_created ASC, id ASC LIMIT 12001`);
    const partQuery = db.prepare('SELECT id, data FROM part WHERE message_id=? ORDER BY time_created ASC, id ASC');
    for (const candidate of candidates) {
      const anchor = anchorQuery.get(candidate.partId);
      if (!anchor) continue;
      const session = sessionQuery.get(anchor.session_id);
      if (!session || session.parent_id || directoryKey(session.directory) !== directoryKey(directory)) continue;
      const anchorPart = JSON.parse(anchor.part_data);
      const anchorInfo = JSON.parse(anchor.message_data);
      if (anchorPart.type !== 'text' || anchorPart.text !== candidate.text || anchorInfo.role !== 'assistant'
        || anchorInfo.summary === true || anchorInfo.error || !anchorInfo.time?.completed
        || !anchorInfo.finish || ['tool-calls', 'unknown'].includes(anchorInfo.finish)) continue;
      const rows = messageQuery.all(session.id, anchor.time_created, anchor.time_created, anchor.message_id);
      if (rows.length > 12000 || rows.at(-1)?.id !== anchor.message_id) continue;
      const nativeMessages = rows.map(row => ({ info: { ...JSON.parse(row.data), id: row.id, sessionID: session.id },
        parts: partQuery.all(row.id).map(part => ({ ...JSON.parse(part.data), id: part.id,
          messageID: row.id, sessionID: session.id })) }));
      const prefix = messages.slice(0, candidate.index + 1);
      const coverage = verifyNativeDesktopCoverage(nativeMessages, prefix, { request });
      if (!coverage.ok) { lastReason = coverage.reason; continue; }
      const nativeCheckpoint = captureNativeCheckpoint({ messages: nativeMessages, request,
        nativeSessionId: session.id, directory });
      if (!nativeCheckpoint) { lastReason = 'verified-summary-unavailable'; continue; }
      const restoredNativeContext = restoreNativeCheckpoint(nativeCheckpoint, { messages: nativeMessages,
        request, nativeSessionId: session.id, directory });
      const checkpoint = createDesktopContextCheckpoint({ messages: prefix, request, restoredNativeContext,
        nativeSessionId: session.id, directory, createdAt: nativeCheckpoint.createdAt });
      if (checkpoint) return { checkpoint, reason: 'restored' };
      lastReason = 'checkpoint-unavailable';
    }
    return reject(lastReason);
  } catch (error) {
    return reject(`source-read-failed: ${error?.message || String(error)}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(readLegacyDesktopCheckpoint(JSON.parse(fs.readFileSync(0, 'utf8'))))); }
  catch (error) { process.stdout.write(JSON.stringify({ checkpoint: null, reason: error?.message || String(error) })); }
}

module.exports = { recoveryCandidates, readLegacyDesktopCheckpoint };
