'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readLegacyDesktopCheckpoint } = require('../lib/legacy-context-checkpoint-worker.cjs');
const { recoverLegacyDesktopCheckpoint } = require('../lib/legacy-context-checkpoint');
const { restoreDesktopContextCheckpoint } = require('../lib/desktop-context-checkpoint');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-legacy-context-test-'));
  t.after(() => {
    if (path.dirname(dataDir) === path.resolve(os.tmpdir()) && path.basename(dataDir).startsWith('z-legacy-context-test-')) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const directory = path.join(dataDir, 'workspace');
  const dbPath = path.join(dataDir, 'opencode-runtime', 'data', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?,NULL,?)').run('native_original', directory);
  function append(id, role, parts, { summary = false, parentID } = {}) {
    const at = 1000 + db.prepare('SELECT count(*) AS n FROM message').get().n * 100;
    const info = { role, time: { created: at }, ...(parentID ? { parentID } : {}) };
    if (role === 'assistant') Object.assign(info, { finish: 'stop', time: { created: at, completed: at + 1 }, ...(summary ? { summary: true } : {}) });
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, 'native_original', at, JSON.stringify(info));
    parts.forEach((part, index) => {
      const { id: partId, ...body } = part;
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(partId, id, 'native_original', at + index, JSON.stringify(body));
    });
  }
  const user = text => `${text}\n\n<z-turn-context task_id="fixture" session_id="sess_fixture">Runtime context</z-turn-context>`;
  append('msg_u0', 'user', [{ id: 'prt_u0', type: 'text', text: user('Original goal') }]);
  append('msg_a0', 'assistant', [{ id: 'prt_a0', type: 'text', text: 'First result' }], { parentID: 'msg_u0' });
  append('msg_u1', 'user', [{ id: 'prt_u1', type: 'text', text: user('Continue the requested work') }]);
  append('msg_compact', 'user', [{ id: 'prt_compact', type: 'compaction', auto: true, tail_start_id: 'msg_u1' }]);
  append('msg_summary', 'assistant', [{ id: 'prt_summary', type: 'text', text: 'Verified earlier goal and first result.' }],
    { summary: true, parentID: 'msg_compact' });
  append('msg_a1', 'assistant', [{ id: 'prt_a1', type: 'text', text: 'Completed retained work' }], { parentID: 'msg_u1' });
  const assistant = (text, id, compacted = false) => ({ role: 'assistant', content: text,
    agentRun: { status: 'done', timeline: [{ type: 'text', openCodeKey: `text:${id}`, content: text }],
      ...(compacted ? { contextCompressionCount: 1, contextCompression: { afterTokens: 100 } } : {}) } });
  const messages = [{ role: 'user', content: 'Original goal' }, assistant('First result', 'prt_a0'),
    { role: 'user', content: 'Continue the requested work' }, assistant('Completed retained work', 'prt_a1', true)];
  const request = { zSessionId: 'sess_fixture', conversationRevision: 8, workMode: 'normal' };
  return { dbPath, dataDir, directory, messages, request, db, append,
    close: () => db.close(),
    read: (overrides = {}) => readLegacyDesktopCheckpoint({ dbPath, directory, messages, request, ...overrides }) };
}

test('legacy rewind recovers a verified compacted prefix without modifying its database or desktop archive', t => {
  const f = fixture(t); f.close();
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(f.dbPath)).digest('hex');
  const before = digest(), desktop = JSON.stringify(f.messages);
  const result = f.read();
  assert.ok(result.checkpoint, result.reason);
  assert.equal(result.checkpoint.desktopPrefix.messageCount, 4);
  assert.equal(result.checkpoint.context.summary, 'Verified earlier goal and first result.');
  assert.equal(result.checkpoint.context.nativeTail.length, 2);
  assert.equal(restoreDesktopContextCheckpoint(result.checkpoint, { messages: f.messages, request: f.request }).ok, true);
  assert.equal(digest(), before);
  assert.equal(JSON.stringify(f.messages), desktop);
});

test('a later native summary and discarded user turn cannot enter a legacy rewind snapshot', t => {
  const f = fixture(t);
  f.append('msg_future_user', 'user', [{ id: 'prt_future_user', type: 'text', text: 'DISCARDED_FUTURE_REQUEST' }]);
  f.append('msg_future_compact', 'user', [{ id: 'prt_future_compact', type: 'compaction', tail_start_id: 'msg_future_user' }]);
  f.append('msg_future_summary', 'assistant', [{ id: 'prt_future_summary', type: 'text', text: 'DISCARDED_FUTURE_SUMMARY' }],
    { summary: true, parentID: 'msg_future_compact' });
  f.close();
  const result = f.read();
  assert.ok(result.checkpoint, result.reason);
  assert.doesNotMatch(JSON.stringify(result.checkpoint), /DISCARDED_FUTURE/);
  assert.equal(f.read({ messages: f.messages.slice(0, 2) }).checkpoint, null, 'a rewind before compaction cannot use its future summary');
});

test('changed historical requests, mismatched part contents and unrelated directories fail closed', t => {
  const f = fixture(t); f.close();
  const changed = structuredClone(f.messages);
  changed[0].content = 'A different goal';
  assert.equal(f.read({ messages: changed }).checkpoint, null);
  const changedPart = structuredClone(f.messages);
  changedPart[3].agentRun.timeline[0].content = 'Altered result';
  assert.equal(f.read({ messages: changedPart }).checkpoint, null);
  assert.equal(f.read({ directory: path.join(f.dataDir, 'different-workspace') }).checkpoint, null);
  assert.equal(f.read({ dbPath: path.join(f.dataDir, 'missing.db') }).checkpoint, null);
});

test('the desktop-compatible worker reads an existing archive without starting a provider or native kernel', async t => {
  const f = fixture(t); f.close();
  const checkpoint = await recoverLegacyDesktopCheckpoint({ appRoot: path.resolve(__dirname, '..'),
    dataDir: f.dataDir, directory: f.directory, request: { ...f.request,
      forkHistory: { kind: 'rewind', messages: f.messages } } });
  assert.ok(checkpoint);
  assert.equal(checkpoint.desktopPrefix.messageCount, 4);
  assert.equal(checkpoint.conversationRevision, 8);
});

test('cancelling legacy recovery stops a worker waiting on the database without changing the archive', async t => {
  const f = fixture(t);
  f.db.exec('BEGIN EXCLUSIVE');
  const controller = new AbortController();
  let timer;
  try {
    const before = Date.now();
    const pending = recoverLegacyDesktopCheckpoint({ appRoot: path.resolve(__dirname, '..'),
      dataDir: f.dataDir, directory: f.directory, signal: controller.signal,
      request: { ...f.request, forkHistory: { kind: 'rewind', messages: f.messages } } });
    timer = setTimeout(() => controller.abort(), 30);
    assert.equal(await pending, null);
    assert.ok(Date.now() - before < 3000, 'cancellation must not wait for the 15-second worker deadline');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM message').get().n, 6);
  } finally {
    clearTimeout(timer);
    f.db.exec('ROLLBACK');
    f.close();
  }
});
