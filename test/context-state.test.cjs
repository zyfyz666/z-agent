'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ContextStore } = require('../lib/context-store');
const { activeNativeMessages, snapshotMessages, contextContentDigest } = require('../lib/context-state');
const { importSnapshot } = require('../lib/context-native-worker.cjs');
const { DatabaseSync } = require('node:sqlite');
const { boundaryKey, inheritedContextState, clipNativeBoundary } = require('../lib/context-state');
const { resolveContextBoundary } = require('../lib/context-runtime');
const user = (id, text) => ({ info: { id, role: 'user', sessionID: 'old', time: { created: 1 } }, parts: [{ id: `p_${id}`, type: 'text', text }] });
const assistant = (id, parentID, text) => ({ info: { id, role: 'assistant', sessionID: 'old', parentID, finish: 'stop',
  time: { created: 2, completed: 3 } }, parts: [{ id: `p_${id}`, type: 'text', text }] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-context-state-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('z-context-state-'));
    fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
test('a completed compaction replaces its prefix and retains the tail exactly once', () => {
  const messages = [user('01', 'discarded'), assistant('02', '01', 'old reply'), user('03', 'retained'),
    assistant('04', '03', 'tail reply'), user('05', ''), assistant('06', '05', 'summary'), user('07', 'current')];
  messages[4].parts = [{ type: 'compaction', auto: true, tail_start_id: '03' }];
  messages[5].info.summary = true;
  assert.deepEqual(activeNativeMessages(messages).map(m => m.info.id), ['03', '04', '05', '06', '07']);
  assert.deepEqual(activeNativeMessages(activeNativeMessages(messages)), activeNativeMessages(messages));
  messages[5].info.error = { message: 'failed summarization' };
  assert.equal(activeNativeMessages(messages).length, 7);
});
test('snapshots permanently keep pruned tools pruned and seal in-flight tools without replay', () => {
  const m = assistant('02', '01', 'partial');
  m.parts.push({ type: 'tool', tool: 'read', callID: 'a', state: { status: 'completed', input: {},
    output: 'ARCHIVE_ONLY'.repeat(1000), time: { compacted: 1 }, attachments: [{ url: 'private' }] } });
  m.parts.push({ type: 'tool', tool: 'bash', callID: 'b', state: { status: 'running', input: { command: 'write' } } });
  const output = snapshotMessages([user('01', 'task'), m], { seal: true });
  assert.doesNotMatch(JSON.stringify(output), /ARCHIVE_ONLY|private/);
  assert.equal(output[1].parts[2].state.status, 'error');
  assert.equal(m.parts[2].state.status, 'running', 'source is immutable');
});
test('saving and restoring a context repeatedly does not append history or duplicate storage', t => {
  const root = fixture(t), store = new ContextStore(root), scope = { zSessionId: 'chat', directory: root };
  const messages = [user('01', 'request'), assistant('02', '01', 'reply')];
  const ref = store.capture(messages, scope);
  for (let i = 0; i < 30; i++) assert.equal(store.capture(store.read(ref).messages, scope), ref);
  const countFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, f) => n + (f.isDirectory() ? countFiles(path.join(dir, f.name)) : 1), 0);
  assert.equal(countFiles(store.root), 3);
  fs.writeFileSync(store.file('snapshots', ref), '{}');
  assert.throws(() => store.read(ref), /损坏/);
});
test('native import is transactional and restricted to its own empty session', t => {
  const root = fixture(t), store = new ContextStore(root), dbPath = path.join(root, 'fixture.db');
  const ref = store.capture([user('01', 'request'), assistant('02', '01', 'reply')], { directory: root });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,metadata TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);');
  db.prepare('INSERT INTO session VALUES(?,?,?)').run('target', root, JSON.stringify({ zContextImport: { nonce: 'owned', ref } }));
  const input = { dbPath, dataDir: root, directory: root, sessionId: 'target', ref, nonce: 'wrong' };
  assert.throws(() => importSnapshot(input), /拒绝覆盖/);
  assert.equal(db.prepare('SELECT count(*) n FROM message').get().n, 0);
  const result = importSnapshot({ ...input, nonce: 'owned' });
  assert.equal(result.messageCount, 2);
  assert.throws(() => importSnapshot({ ...input, nonce: 'owned' }), /拒绝覆盖/);
  assert.equal(db.prepare('SELECT count(*) n FROM message').get().n, 2);
  const restored = require('../lib/context-native-worker.cjs').readMessages(db, 'target');
  assert.equal(contextContentDigest(restored), store.read(ref).manifest.contentDigest);
  db.close();
});

test('transport ID remapping does not duplicate immutable message storage', t => {
  const store = new ContextStore(fixture(t));
  const original = [user('01', 'request'), assistant('02', '01', 'reply')];
  const remapped = [user('11', 'request'), assistant('12', '11', 'reply')];
  remapped.forEach(m => { m.info.sessionID = 'another-native-session'; m.parts.forEach(p => p.id += '_new'); });
  assert.equal(store.capture(original), store.capture(remapped));
});

test('user-inclusive and user-exclusive boundaries survive detached guidance and backups', async t => {
  const root = fixture(t), store = new ContextStore(root);
  const before = store.capture([user('01', 'old')]), after = store.capture([user('01', 'old'), user('02', 'guide')]);
  const message = { role: 'user', content: 'guide', ts: 15, liveGuidance: { requestId: 'guidance-id' } };
  const source = { id: 'sess_source', messages: [message], contextState: { version: 2, points: {
    [boundaryKey(message)]: before, [`after-user:${boundaryKey(message)}`]: after } } };
  const target = { id: 'sess_branch', messages: [{ ...message, liveGuidance: {} }] };
  target.contextState = inheritedContextState(source, target, after);
  const selected = target.messages[0];
  assert.equal(await resolveContextBoundary({ dataDir: root, source: target, prefix: [], selected, includeSelected: false }), before);
  assert.equal(await resolveContextBoundary({ dataDir: root, source: target, prefix: target.messages }), after);
  assert.equal(target.contextState.points[`after-user:${boundaryKey(selected)}`], after);
  target.contextState.head = before;
  assert.equal(await resolveContextBoundary({ dataDir: root, source: target, prefix: target.messages }), before, 'latest completed compaction head wins at full boundary');
});

test('guidance clipping freezes streamed text and pending tools, excluding later messages', () => {
  const a = assistant('02', '01', 'BEFORE AFTER');
  a.info.time = { created: 10, completed: 30 };
  a.parts[0].id = 'prt_text';
  a.parts.push({ type: 'tool', callID: 'late', tool: 'bash', state: { status: 'completed', input: { command: 'write' },
    output: 'AFTER_TOOL', time: { start: 11, end: 30 } } });
  const later = assistant('04', '03', 'AFTER_REPLY'); later.info.time = { created: 31, completed: 32 };
  const laterUser = user('03', 'AFTER_USER'); laterUser.info.time.created = 25;
  const context = [user('01', 'request'), a, laterUser, later];
  const cut = clipNativeBoundary(context, { startedAt: 10, historyBoundaryAt: 20, timeline: [
    { type: 'text', openCodeKey: 'text:prt_text', content: 'BEFORE' }, { type: 'tool_call', callId: 'late' }
  ] }, new Set(['01']));
  const saved = snapshotMessages(cut, { seal: true });
  assert.equal(saved.length, 2);
  assert.match(JSON.stringify(saved), /BEFORE/); assert.doesNotMatch(JSON.stringify(saved), /AFTER/);
  assert.equal(saved[1].parts[1].state.status, 'error');
  assert.equal(context[1].parts[0].text, 'BEFORE AFTER');
});

test('a failed newer compaction does not resurrect a discarded prefix', () => {
  const marker = user('03', ''); marker.parts = [{ type: 'compaction', auto: true }];
  const summary = assistant('04', '03', 'summary'); summary.info.summary = true;
  const failed = assistant('06', '05', 'failed'); failed.info.summary = true; failed.info.error = { message: 'upstream failed' };
  const next = user('05', ''); next.parts = [{ type: 'compaction', auto: true }];
  assert.deepEqual(activeNativeMessages([user('01', 'old'), assistant('02', '01', 'discarded'), marker, summary, next, failed])
    .map(m => m.info.id), ['03', '04', '05', '06']);
});

test('historical request accounting is not restored as current context occupancy', () => {
  const message = assistant('02', '01', 'short reply');
  message.info.tokens = { input: 750000, output: 100, cache: { read: 100000, write: 0 } };
  const output = snapshotMessages([user('01', 'short request'), message]);
  assert.equal(output[1].info.tokens.input, 0);
  assert.equal(message.info.tokens.input, 750000);
});
