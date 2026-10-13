'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { desktopHistoryDigest } = require('./desktop-context-checkpoint');
const { taskIdentity } = require('./task-memory-context');
const { nativePrefixDigest, nativePrefixContentDigest, verifiedLegacySeed } = require('./native-prefix-recovery');
const { verifyNativeDesktopCoverage } = require('./native-desktop-coverage');
const { stripProtocolBlocks } = require('./delivery-contract');
const { splitTaggedThinkingText } = require('./thinking-text');

function directoryKey(directory) {
  const value = path.resolve(String(directory || ''));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function inheritedNativePrefix(metadata, nativeMessages, desktop) {
  const receipt = metadata?.zNativePrefix;
  if (!receipt) return null;
  const nativeCount = receipt.messageCount, desktopCount = receipt.desktopPrefix?.messageCount;
  if (receipt.version !== 1 || !Number.isSafeInteger(nativeCount) || nativeCount < 1 || nativeCount > nativeMessages.length
    || !Number.isSafeInteger(desktopCount) || desktopCount < 1 || desktopCount > desktop.length
    || !/^[a-f0-9]{64}$/.test(String(receipt.contentHash || ''))
    || !/^[a-f0-9]{64}$/.test(String(receipt.desktopPrefix?.digest || ''))
    || desktopHistoryDigest(desktop.slice(0, desktopCount)) !== receipt.desktopPrefix.digest
    || nativePrefixContentDigest(nativeMessages.slice(0, nativeCount)) !== receipt.contentHash) {
    return { ok: false, reason: 'inherited-native-prefix-mismatch' };
  }
  if (desktop[desktopCount - 1]?.role !== 'assistant'
    || !['done', 'completed'].includes(desktop[desktopCount - 1].agentRun?.status)
    || nativeMessages[nativeCount - 1]?.info?.role !== 'assistant'
    || !nativeMessages[nativeCount - 1].info.time?.completed || nativeMessages[nativeCount - 1].info.error) {
    return { ok: false, reason: 'inherited-native-boundary-unfinished' };
  }
  return { ok: true, nativeCount, desktopCount };
}

function readNativePrefix({ dbPath, directory, messages, request = {} } = {}) {
  const reject = reason => ({ prefix: null, reason });
  if (!taskIdentity(request) || !dbPath || !fs.existsSync(dbPath) || !directory || !Array.isArray(messages) || !messages.length) {
    return reject('source-unavailable');
  }
  const sourceIds = new Set([request.zSessionId, request.forkHistory?.sourceSessionId].filter(Boolean));
  const candidates = [];
  for (let index = messages.length - 1; index >= 0 && candidates.length < 12; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !['done', 'completed'].includes(message.agentRun?.status)) continue;
    const last = (message.agentRun.timeline || []).findLast(item => item?.type === 'text' && String(item.content || '').trim());
    const id = /^text:(prt_[A-Za-z0-9_-]+)$/.exec(String(last?.openCodeKey || ''))?.[1];
    if (id) candidates.push({ index, partId: id, text: String(last.content) });
  }
  if (!candidates.length) return reject('native-boundary-unavailable');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let lastReason = 'native-boundary-unavailable';
  const rejections = [];
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const anchorQuery = db.prepare(`SELECT p.message_id, p.session_id, p.data AS part_data,
      m.data AS message_data FROM part p JOIN message m ON m.id=p.message_id WHERE p.id=?`);
    const sessionQuery = db.prepare('SELECT id, directory, parent_id, metadata FROM session WHERE id=?');
    const messageQuery = db.prepare(`SELECT id, data FROM message WHERE session_id=? AND id<=? ORDER BY id ASC LIMIT 12001`);
    const nextQuery = db.prepare('SELECT id FROM message WHERE session_id=? AND id>? ORDER BY id ASC LIMIT 1');
    const partQuery = db.prepare('SELECT id, data FROM part WHERE message_id=? ORDER BY id ASC');
    for (const candidate of candidates) {
      const anchor = anchorQuery.get(candidate.partId);
      if (!anchor) continue;
      const session = sessionQuery.get(anchor.session_id);
      if (!session || session.parent_id || directoryKey(session.directory) !== directoryKey(directory)) continue;
      const metadata = JSON.parse(session.metadata || '{}');
      if (!sourceIds.has(metadata.zSessionID) || metadata.zWorkMode !== String(request.workMode || 'normal')) {
        lastReason = 'source-provenance-mismatch'; continue;
      }
      const anchorPart = JSON.parse(anchor.part_data), anchorInfo = JSON.parse(anchor.message_data);
      if (anchorPart.type !== 'text' || splitTaggedThinkingText(stripProtocolBlocks(anchorPart.text)).text.trim() !== candidate.text.trim()
        || anchorInfo.role !== 'assistant'
        || anchorInfo.summary === true || anchorInfo.error || !anchorInfo.time?.completed
        || !anchorInfo.finish || ['tool-calls', 'unknown'].includes(anchorInfo.finish)) continue;
      const rows = messageQuery.all(session.id, anchor.message_id);
      if (rows.length > 12000 || rows.at(-1)?.id !== anchor.message_id) continue;
      const nativeMessages = rows.map(row => ({ info: { ...JSON.parse(row.data), id: row.id, sessionID: session.id },
        parts: partQuery.all(row.id).map(part => ({ ...JSON.parse(part.data), id: part.id,
          messageID: row.id, sessionID: session.id })) }));
      const desktop = messages.slice(0, candidate.index + 1);
      if (desktop.some(message => message?.attachments?.length || message?.mediaAssets?.length || message?.media)) {
        lastReason = 'unverified-attachment'; continue;
      }
      if (nativeMessages.some(message => (message.parts || []).some(part =>
        (part.type === 'tool' && !['completed', 'error'].includes(part.state?.status))
        || (message.info.id !== anchor.message_id && part.id > candidate.partId)
        || Number(part.state?.time?.end || part.time?.end || part.time?.start || 0) > Number(anchorInfo.time.completed)))) {
        lastReason = 'native-part-after-boundary'; continue;
      }
      const inherited = inheritedNativePrefix(metadata, nativeMessages, desktop);
      if (inherited && !inherited.ok) { lastReason = inherited.reason; continue; }
      const nativeSuffix = inherited ? nativeMessages.slice(inherited.nativeCount) : nativeMessages;
      const desktopSuffix = inherited ? desktop.slice(inherited.desktopCount) : desktop;
      const coverage = !nativeSuffix.length && !desktopSuffix.length ? { ok: true, seedMessageCount: 0 }
        : verifyNativeDesktopCoverage(nativeSuffix, desktopSuffix, { request,
          trustedNativePrefix: true, legacySeed: verifiedLegacySeed(nativeSuffix, desktopSuffix) });
      if (!coverage.ok) { lastReason = coverage.reason; rejections.push({ candidateIndex: candidate.index, ...coverage }); continue; }
      // The pinned native fork is exclusive. Appending an ID character also
      // excludes any later concurrently inserted IDs when this was the last
      // source message at the read transaction boundary.
      const messageID = nextQuery.get(session.id, anchor.message_id)?.id || `${anchor.message_id}0`;
      return { reason: 'restored', rejections, prefix: {
        version: 1, ...taskIdentity(request), sourceSessionId: session.id, messageID,
        boundaryMessageId: anchor.message_id, sourceMessageCount: nativeMessages.length,
        sourceHash: nativePrefixDigest(nativeMessages), contentHash: nativePrefixContentDigest(nativeMessages), directory: directoryKey(directory),
        workMode: String(request.workMode || 'normal'),
        provenance: { zSessionID: metadata.zSessionID, zWorkMode: metadata.zWorkMode,
          seedMessageCount: (inherited?.desktopCount || 0) + coverage.seedMessageCount,
          ...(inherited ? { inheritedNativeMessageCount: inherited.nativeCount } : {}) },
        desktopPrefix: { messageCount: desktop.length, digest: desktopHistoryDigest(desktop) },
        desktopTail: messages.slice(desktop.length)
      } };
    }
    return { ...reject(lastReason), rejections };
  } catch (error) { return reject(`source-read-failed: ${error?.message || String(error)}`); }
  finally { db.close(); }
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(readNativePrefix(JSON.parse(fs.readFileSync(0, 'utf8'))))); }
  catch (error) { process.stdout.write(JSON.stringify({ prefix: null, reason: error?.message || String(error) })); }
}

module.exports = { readNativePrefix };
