'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ContextStore } = require('./context-store');
const { snapshotMessages, contextError, clipNativeBoundary } = require('./context-state');
const { stripProtocolBlocks } = require('./delivery-contract');
const { splitTaggedThinkingText } = require('./thinking-text');
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const visibleText = value => splitTaggedThinkingText(stripProtocolBlocks(String(value || ''))).text.trim();

function readMessages(db, sessionId, through) {
  const rows = db.prepare('SELECT id,data FROM message WHERE session_id=? AND id<=? ORDER BY id').all(sessionId, through || '\uffff');
  const parts = db.prepare('SELECT id,data FROM part WHERE message_id=? ORDER BY id');
  return rows.map(row => ({ info: { ...JSON.parse(row.data), id: row.id, sessionID: sessionId },
    parts: parts.all(row.id).map(p => ({ ...JSON.parse(p.data), id: p.id, messageID: row.id, sessionID: sessionId })) }));
}

// One-time migration of legacy archives. An exact native part ID and its
// owning conversation establish provenance; there is no UI-log replay and
// no second attempt to reconstruct what an old seed/summary might mean.
function migrateBoundary(input) {
  const { dbPath, directory, source, prefix } = input;
  const store = new ContextStore(input.dataDir);
  if (!prefix.length) return { ref: store.capture([], { directory, zSessionId: source.id }) };
  const last = prefix.at(-1);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN');
    const lookup = db.prepare('SELECT p.message_id,p.session_id,p.data,s.metadata,s.directory FROM part p JOIN session s ON s.id=p.session_id WHERE p.id=?');
    const identities = new Set([source.id, source.contextReset?.sourceSessionId, source.forkedFrom?.sessionId,
      source.rewindBackupOf?.sessionId, ...source.messages.map(m => m.agentRun?.forkedFrom?.sessionId)].filter(Boolean));
    const owns = row => row && key(row.directory) === key(directory) && identities.has(JSON.parse(row.metadata || '{}').zSessionID);
    const anchorFor = message => [...(message?.agentRun?.timeline || [])].reverse()
      .find(p => /^(?:text|reasoning):prt_/.test(p.openCodeKey || ''));
    // User-inclusive forks use their following native assistant's parent,
    // never the desktop's serialized prompt. New turns already have this ref.
    if (last.role === 'user') {
      const directId = last.liveGuidance?.nativeMessageId;
      let nativeId = directId, nativeSessionId = last.liveGuidance?.nativeSessionId;
      if (!nativeId) {
        const index = source.messages.indexOf(last);
        const next = index >= 0 && source.messages.slice(index + 1).find(m => m.role === 'assistant');
        const nextAnchor = anchorFor(next), nextRow = nextAnchor && lookup.get(nextAnchor.openCodeKey.split(':')[1]);
        if (!owns(nextRow)) throw contextError('用户消息缺少可验证的内核边界。原对话未改动。');
        nativeId = JSON.parse(db.prepare('SELECT data FROM message WHERE id=?').get(nextRow.message_id).data).parentID;
        nativeSessionId = nextRow.session_id;
      }
      const row = db.prepare('SELECT m.data,s.metadata,s.directory FROM message m JOIN session s ON s.id=m.session_id WHERE m.id=? AND m.session_id=?').get(nativeId, nativeSessionId);
      if (!owns(row) || JSON.parse(row.data).role !== 'user') throw contextError('用户消息与内核上下文归属不一致。');
      const messages = readMessages(db, nativeSessionId, nativeId), user = messages.at(-1);
      if (last.content && !user.parts.some(p => p.type === 'text' && p.text?.includes(last.content))) throw contextError('用户消息的内核原文不匹配。');
      return { ref: store.capture(messages, { directory, zSessionId: source.id }), sourceNativeSessionId: nativeSessionId };
    }
    const timeline = last.agentRun?.timeline || [], anchor = anchorFor(last);
    let row = anchor && lookup.get(anchor.openCodeKey.split(':')[1]);
    // A tool-only boundary has a native call identity even without final text.
    if (!row) {
      const call = [...timeline].reverse().find(p => p.type === 'tool_call' && p.callId);
      const candidates = call ? db.prepare("SELECT p.message_id,p.session_id,p.data,s.metadata,s.directory FROM part p JOIN session s ON s.id=p.session_id WHERE json_extract(p.data,'$.callID')=?").all(call.callId) : [];
      const owned = candidates.filter(owns);
      if (owned.length === 1) row = owned[0];
    }
    if (last.role !== 'assistant' || !owns(row)) {
      throw contextError('历史消息与内核上下文的归属不一致，未修改对话。');
    }
    const part = JSON.parse(row.data);
    const partial = !!last.agentRun?.historyBoundaryAt;
    if (anchor && (partial ? !visibleText(part.text).startsWith(String(anchor.content || '').trim())
      : visibleText(part.text) !== String(anchor.content || '').trim())) throw contextError('历史消息的原始上下文发生变化，不能猜测恢复。');
    let through = row.message_id;
    // Text may precede another assistant containing only tools. Include all
    // explicitly recorded parts/calls, never a later unobserved message.
    for (const item of timeline) {
      const candidate = /^(?:text|reasoning):prt_/.test(item.openCodeKey || '') ? lookup.get(item.openCodeKey.split(':')[1]) : null;
      if (candidate?.session_id === row.session_id && candidate.message_id > through) through = candidate.message_id;
      if (item.type === 'tool_call' && item.callId) {
        const call = db.prepare("SELECT message_id FROM part WHERE session_id=? AND json_extract(data,'$.callID')=?").get(row.session_id, item.callId);
        if (call?.message_id > through) through = call.message_id;
      }
    }
    let messages = readMessages(db, row.session_id, through);
    if (partial) messages = clipNativeBoundary(messages, last.agentRun);
    return { ref: store.capture(messages, { directory, zSessionId: source.id, workMode: source.workMode || 'normal' }),
      sourceNativeSessionId: row.session_id, nativeMessageCount: messages.length };
  } finally { db.close(); }
}

function clipAtGuidance(messages, run) {
  messages.splice(0, messages.length, ...clipNativeBoundary(messages, run));
}

function importSnapshot(input) {
  const { messages, manifest } = new ContextStore(input.dataDir).read(input.ref);
  if (key(manifest.scope.directory) !== key(input.directory)) throw contextError('上下文快照不属于当前项目目录。');
  const db = new DatabaseSync(input.dbPath);
  try {
    db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const target = db.prepare('SELECT metadata,directory FROM session WHERE id=?').get(input.sessionId);
    const meta = JSON.parse(target?.metadata || '{}');
    if (!target || key(target.directory) !== key(input.directory) || meta.zContextImport?.nonce !== input.nonce
      || meta.zContextImport.ref !== input.ref || db.prepare('SELECT count(*) AS n FROM message WHERE session_id=?').get(input.sessionId).n) {
      throw contextError('上下文只能导入本次创建的空会话，已拒绝覆盖已有记录。');
    }
    const nonce = crypto.randomBytes(10).toString('hex');
    const ids = new Map(messages.map((m, i) => [m.info.id, `msg_${(i + 1).toString(16).padStart(12, '0')}${nonce}`]));
    const insertMessage = db.prepare('INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)');
    const insertPart = db.prepare('INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)');
    let partIndex = 0;
    for (const message of snapshotMessages(messages, { seal: true })) {
      const id = ids.get(message.info.id), info = { ...message.info };
      delete info.id; delete info.sessionID;
      if (ids.has(info.parentID)) info.parentID = ids.get(info.parentID);
      insertMessage.run(id, input.sessionId, info.time?.created || 1, info.time?.completed || info.time?.created || 1, JSON.stringify(info));
      for (const original of message.parts) {
        const part = { ...original }; delete part.id; delete part.sessionID; delete part.messageID;
        if (ids.has(part.tail_start_id)) part.tail_start_id = ids.get(part.tail_start_id);
        const partId = `prt_${(++partIndex).toString(16).padStart(12, '0')}${nonce}`;
        insertPart.run(partId, id, input.sessionId, info.time?.created || 1, info.time?.completed || 1, JSON.stringify(part));
      }
    }
    meta.zContextImport = { ref: input.ref, ready: true };
    db.prepare('UPDATE session SET metadata=? WHERE id=?').run(JSON.stringify(meta), input.sessionId);
    db.exec('COMMIT');
    return { ok: true, messageCount: messages.length, contentDigest: manifest.contentDigest };
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

function execute(input) { return input.operation === 'import' ? importSnapshot(input) : migrateBoundary(input); }
if (require.main === module) {
  try { process.stdout.write(JSON.stringify({ ok: true, ...execute(JSON.parse(fs.readFileSync(0, 'utf8'))) })); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code, error: error.message })); }
}
module.exports = { migrateBoundary, importSnapshot, clipAtGuidance, readMessages };
