'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SubagentCompletionQueue } = require('../lib/subagent-completion-queue');
const { createSessionWriteQueue } = require('../lib/session-model');
const { sessionConversationRevision, assertConversationRevision } = require('../lib/session-rewind');

const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
const helpersStart = main.indexOf('function getSubagentCompletionQueue()');
const helpersEnd = main.indexOf('async function createFreshSessionRecord(', helpersStart);
const acceptanceStart = main.indexOf('    if (request.subagentWake) {\n      // Session identity,');
const acceptanceEnd = main.indexOf('    } else if (!request.utility && !request.observerWake)', acceptanceStart);
assert.ok(helpersStart > 0 && helpersEnd > helpersStart && acceptanceStart > 0 && acceptanceEnd > acceptanceStart);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-subagent-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map(), notifications = [], cleanup = [];
  const sessions = new Map([
    ['sess_alpha', { id: 'sess_alpha', conversationRevision: 0, observerEnabled: false }],
    ['sess_beta', { id: 'sess_beta', conversationRevision: 0 }]
  ]);
  let inspect = async () => ({ status: 'completed', consumed: false });
  const sidecar = { inspectSubagentCompletion: record => inspect(record),
    forgetSubagentCompletion: record => cleanup.push(['forget', record.id]),
    cancelSubagentCompletionTracking: async id => { cleanup.push(['cancel', id]); } };
  const context = vm.createContext({
    path, console, setTimeout, clearTimeout, SubagentCompletionQueue,
    STABLE_DATA_DIR: root, subagentCompletionQueue: null,
    subagentCompletionPollTimer: null, subagentCompletionPolling: false,
    subagentTrackingCancellations: new Map(), isQuiting: true,
    openCodeSidecar: sidecar, getOpenCodeSidecar: () => sidecar,
    sessionRewindOperations: new Set(), manualContextCompressions: new Set(),
    openCodeActiveRuns: new Map(), openCodeRunAdmissions: new Map(),
    zCore: { state: { intents: {} } },
    isSafeSessionId: id => /^sess_\w+$/.test(id),
    readSessionRecord: async id => sessions.get(id),
    withSessionWrite: createSessionWriteQueue(), sessionConversationRevision, assertConversationRevision,
    notifyDesktopSessionUpdate: detail => notifications.push(detail), scheduleOpenCodeIdleRelease() {},
    ipcMain: { handle: (id, handler) => handlers.set(id, handler) }, providerStarts: 0
  });
  vm.runInContext(main.slice(helpersStart, helpersEnd), context);
  // Execute the exact production final admission block; replacing only the
  // subsequent provider invocation keeps these tests entirely model-free.
  vm.runInContext(`async function acceptAndStart(request) {
    const zSessionId = request.zSessionId, runId = request.runId;
    ${main.slice(acceptanceStart, acceptanceEnd)} }
    providerStarts += 1; return { ok: true };
  }`, context);
  const queue = context.getSubagentCompletionQueue();
  function seed(sessionId = 'sess_alpha', parentRunId = 'parent-alpha') {
    queue.authorizeParent({ parentRunId, zSessionId: sessionId, conversationRevision: 0, startedAt: 1_000 });
    queue.recordLifecycle({ parentRunId, zSessionId: sessionId, conversationRevision: 0, startedAt: 1_100,
      parentSessionID: `native-${sessionId}`, childSessionID: `child-${sessionId}`, callId: `call-${parentRunId}`,
      status: 'completed', completedAt: 2_000, result: 'Child result' });
    queue.settleParent(parentRunId, { status: 'done' });
    return queue.list({ sessionId }).wakes[0];
  }
  return { context, queue, sessions, notifications, cleanup, seed,
    inspect: operation => { inspect = operation; },
    invoke: (name, payload = {}) => handlers.get(`subagent:${name}`)(null, payload) };
}

const claimInput = wake => ({ id: wake.id, sessionId: wake.sessionId, conversationRevision: wake.conversationRevision });

test('production IPC lists Observer-off sessions, waits for user work and isolates other conversations', async t => {
  const f = fixture(t);
  f.seed(); f.seed('sess_beta', 'parent-beta');
  assert.equal((await f.invoke('list-wakes')).wakes.length, 2);
  f.context.openCodeActiveRuns.set('user-run', { zSessionId: 'sess_alpha' });
  assert.deepEqual(Array.from((await f.invoke('list-wakes')).wakes, record => record.sessionId), ['sess_beta']);
  f.context.openCodeActiveRuns.clear();
  f.context.zCore.state.intents.user = { id: 'user', threadId: 'sess_alpha', status: 'queued' };
  assert.equal((await f.invoke('list-wakes', { sessionId: 'sess_alpha' })).wakes.length, 0);
  delete f.context.zCore.state.intents.user;
  f.sessions.get('sess_alpha').conversationRevision = 1;
  assert.equal((await f.invoke('list-wakes', { sessionId: 'sess_alpha' })).wakes.length, 0);
  f.sessions.delete('sess_beta');
  assert.equal((await f.invoke('list-wakes')).wakes.length, 0);
});

test('production claim IPC rejects foreign/revised claims and atomically grants one claim to concurrent windows', async t => {
  const f = fixture(t), wake = f.seed(), input = claimInput(wake);
  assert.equal((await f.invoke('claim-wake', { ...input, sessionId: 'sess_beta' })).ok, false);
  assert.equal((await f.invoke('claim-wake', { ...input, conversationRevision: 1 })).ok, false);
  const results = await Promise.all([f.invoke('claim-wake', input), f.invoke('claim-wake', input)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.ok(f.notifications.some(item => item.reason === 'subagent-wake-changed' && item.id === wake.sessionId));
});

test('claim rechecks native consumption and user admission after asynchronous inspection', async t => {
  const f = fixture(t), wake = f.seed(), input = claimInput(wake);
  f.inspect(async () => {
    f.context.openCodeRunAdmissions.set('new-user-run', wake.sessionId);
    return { status: 'completed' };
  });
  assert.equal((await f.invoke('claim-wake', input)).code, 'SUBAGENT_WAKE_BUSY');
  f.context.openCodeRunAdmissions.clear();
  f.inspect(async () => ({ status: 'running', consumed: false }));
  assert.equal((await f.invoke('claim-wake', input)).ok, false);
  assert.equal(f.queue.state.records[wake.id].status, 'running', 'fresh native running state supersedes a saved completion');
  f.inspect(async () => ({ status: 'completed', consumed: true }));
  assert.equal((await f.invoke('claim-wake', input)).ok, false);
  assert.equal(f.queue.list().wakes.length, 0);
});

test('unknown native consumption cannot claim an old completion and repeated renderer requests respect backoff', async t => {
  const f = fixture(t), wake = f.seed(), input = claimInput(wake);
  let reads = 0;
  f.inspect(async () => { reads += 1; throw new Error('Native history unavailable'); });
  const first = await f.invoke('claim-wake', input);
  assert.equal(first.code, 'SUBAGENT_WAKE_BUSY');
  assert.ok(first.retryAt > Date.now());
  assert.equal((await f.invoke('list-wakes')).wakes.length, 0);
  assert.equal((await f.invoke('claim-wake', input)).code, 'SUBAGENT_WAKE_BUSY');
  assert.equal(reads, 1, 'renderer polling cannot retry native inspection before background backoff');
  assert.equal(f.context.providerStarts, 0);
  f.queue.applyInspection(wake, { status: 'completed', consumed: true });
  assert.equal((await f.invoke('claim-wake', input)).ok, false);
});

test('production provider admission durably accepts only once and rechecks queued user priority', async t => {
  const f = fixture(t), wake = f.seed(), input = claimInput(wake);
  const claimed = await f.invoke('claim-wake', input);
  const request = { runId: 'wake-run', zSessionId: wake.sessionId, conversationRevision: 0,
    intentId: wake.intentId, subagentWake: { id: wake.id, claimToken: claimed.claimToken } };
  f.context.zCore.state.intents.user = { id: 'user', threadId: wake.sessionId, status: 'queued' };
  await assert.rejects(f.context.acceptAndStart(request), { code: 'SUBAGENT_WAKE_BUSY' });
  assert.equal(f.context.providerStarts, 0);
  delete f.context.zCore.state.intents.user;
  const attempts = await Promise.allSettled([f.context.acceptAndStart(request), f.context.acceptAndStart(request)]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(f.context.providerStarts, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.queue.file, 'utf8')).records[wake.id].acceptedRunId, 'wake-run');
  assert.equal((await f.invoke('release-wake', { id: wake.id, claimToken: claimed.claimToken })).ok, false);
});

test('explicit stop aborts background tracking before forgetting it; ordinary user input only defers', async t => {
  const f = fixture(t), wake = f.seed();
  await f.invoke('cancel-wakes', { sessionId: wake.sessionId, reason: 'user_message' });
  assert.equal(f.cleanup.length, 0);
  assert.equal(f.queue.list().wakes.length, 1);
  await f.invoke('cancel-wakes', { sessionId: wake.sessionId, reason: 'user_cancelled' });
  await Promise.all(f.context.subagentTrackingCancellations.values());
  assert.deepEqual(f.cleanup.map(item => item[0]), ['cancel', 'forget']);
  assert.equal(f.queue.list().wakes.length, 0);
});
