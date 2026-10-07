'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectMessages } = require('./completion-runtime');

const unknown = error => ({ status: 'unknown', result: '', completedAt: 0, consumed: false, ...(error ? { error } : {}) });
const sameDirectory = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

function readCompletionDatabase({ dbPath, record = {} } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return unknown();
  if (!record.parentSessionID || !record.childSessionID || !record.directory || !record.callId || !Number(record.startedAt)) return unknown();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    // This is the pinned OpenCode 1.18.11 schema. Query only the two known
    // sessions and fail closed on incompatible future schemas.
    const session = db.prepare('SELECT id, parent_id, directory FROM session WHERE id = ?');
    const parent = session.get(record.parentSessionID);
    const child = session.get(record.childSessionID);
    if (!parent || !child || child.parent_id !== parent.id
      || !sameDirectory(parent.directory, record.directory) || !sameDirectory(child.directory, record.directory)) return unknown();
    const readMessages = sessionID => {
      const rows = db.prepare(`SELECT id, session_id, data FROM message WHERE session_id = ?
        AND (time_created >= ? OR id IN (SELECT message_id FROM part WHERE session_id = ? AND json_extract(data, '$.callID') = ?))
        ORDER BY time_created ASC LIMIT 2001`).all(sessionID, record.startedAt, sessionID, record.callId);
      if (rows.length > 2000) throw new Error('子代理记录超过只读恢复范围');
      const parts = db.prepare('SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC');
      return rows.map(row => ({ info: { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id },
        parts: parts.all(row.id).map(part => ({ ...JSON.parse(part.data), id: part.id, messageID: row.id, sessionID })) }));
    };
    return inspectMessages(record, readMessages(parent.id), readMessages(child.id), { disk: true });
  } catch (error) { return unknown(error?.message || String(error)); }
  finally { db.close(); }
}

if (require.main === module) {
  try {
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(readCompletionDatabase(request)));
  } catch (error) { process.stdout.write(JSON.stringify(unknown(error?.message || String(error)))); }
}

module.exports = { readCompletionDatabase };
