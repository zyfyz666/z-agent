'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ZCore } = require('../lib/z-core');
const { createSessionWriteQueue } = require('../lib/session-model');
const { assertConversationRevision } = require('../lib/session-rewind');
const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-queue-guidance-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('z-queue-guidance-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const core = new ZCore({ rootDir: root });
  core.startTurn({ threadId: 'sess_test', turnId: 'run-test' });
  core.enqueueIntent({ threadId: 'sess_test', intentId: 'queue-test', intent: {
    conversationRevision: 2, prompt: 'Include the attachment',
    attachments: [{ name: 'evidence.png', path: 'C:/synthetic/evidence.png', mimeType: 'image/png', size: 10 }]
  } });
  const sessions = new Map([['sess_test', { id: 'sess_test', conversationRevision: 2 }]]);
  const active = new Map([['run-test', { zSessionId: 'sess_test' }]]);
  const handlers = new Map(), remembered = [];
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    isSafeSessionId: id => id === 'sess_test' || id === 'sess_other',
    sessionRewindOperations: new Map(), withSessionWrite: createSessionWriteQueue(),
    readSessionRecord: async id => sessions.get(id), assertConversationRevision,
    openCodeActiveRuns: active, zCore: core,
    rememberOpenCodeGuidanceRun: (...args) => remembered.push(args)
  });
  const start = main.indexOf("ipcMain.handle('z:core-prepare-guidance-intent',");
  const end = main.indexOf("ipcMain.handle('z:core-consume-intent',", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(main.slice(start, end), context);
  const request = { intentId: 'queue-test', sessionId: 'sess_test', runId: 'run-test',
    requestId: 'guidance-queue-test', conversationRevision: 2 };
  return { core, root, sessions, active, remembered, context, request,
    prepare: overrides => handlers.get('z:core-prepare-guidance-intent')(null, { ...request, ...overrides }) };
}

test('queue promotion atomically persists guidance identity and attachments through restart', async t => {
  const f = fixture(t);
  const result = await f.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.intent.status, 'consumed');
  assert.equal(result.intent.intent.attachments[0].name, 'evidence.png');
  assert.deepEqual(f.remembered[0], ['run-test', 'sess_test']);
  const resumed = new ZCore({ rootDir: f.root });
  const stored = resumed.state.intents['queue-test'];
  assert.equal(stored.status, 'consumed');
  assert.deepEqual(stored.intent.guidanceContinuation, { runId: 'run-test', requestId: 'guidance-queue-test' });
  resumed.requeueIntent(stored.id);
  assert.equal(resumed.listQueuedIntents('sess_test')[0].intent.guidanceContinuation.requestId, 'guidance-queue-test');
});

test('concurrent repeated clicks keep one claim and never retarget a consumed message', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.prepare(), f.prepare()]);
  assert.ok(results.every(result => result.ok));
  assert.equal(f.core.store.readEvents().filter(event => event.type === 'turn.dequeued').length, 1);
  assert.equal((await f.prepare({ requestId: 'different-request' })).ok, false);
  f.core.ackIntent('queue-test');
  assert.equal((await f.prepare()).ok, false);
});

test('stale revision and cross-task targets leave queued content untouched', async t => {
  const f = fixture(t);
  assert.equal((await f.prepare({ conversationRevision: 1 })).code, 'SESSION_REVISION_CHANGED');
  f.active.set('run-test', { zSessionId: 'sess_other' });
  assert.equal((await f.prepare()).ok, false);
  f.active.set('run-test', { zSessionId: 'sess_test' });
  f.core.state.intents['queue-test'].threadId = 'sess_other';
  assert.equal((await f.prepare()).ok, false);
  assert.equal(f.core.state.intents['queue-test'].status, 'queued');
});

test('a run ending while preparation waits on the session lock cannot consume its queued message', async t => {
  const f = fixture(t);
  let unlock;
  const blocked = f.context.withSessionWrite('sess_test', () => new Promise(resolve => { unlock = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const prepared = f.prepare();
  f.active.delete('run-test');
  unlock(); await blocked;
  assert.equal((await prepared).ok, false);
  assert.equal(f.core.state.intents['queue-test'].status, 'queued');
});
