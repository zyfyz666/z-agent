'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSessionWriteQueue } = require('../lib/session-model');
const { messageForkAnchor, createSessionForkRecord, preserveForkAuthority } = require('../lib/session-fork');
const { assertConversationRevision, sessionConversationRevision, createRewindBackup, createRewoundSession } = require('../lib/session-rewind');
const { sessionObserverEnabled, cancelSessionObserverCompletion } = require('../lib/session-observer-settings');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function section(start, end) {
  const offset = source.indexOf(start), finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { review, runtime } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-observer-session-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const handlers = new Map(), runs = new Map(), notifications = [], runtimeCalls = [];
  let nextRead = null, nextIndexWrite = null;
  const sessionPath = id => path.join(dataDir, `${id}.json`);
  const context = vm.createContext({
    fs, fsp: fs.promises, path, dataDir, console, AbortController, setTimeout, clearTimeout,
    sessionObserverEnabled, cancelSessionObserverCompletion, assertConversationRevision, sessionConversationRevision,
    preserveForkAuthority, withSessionWrite: createSessionWriteQueue(), openCodeActiveRuns: runs,
    openCodeSidecar: { async setObserverEnabled(runId, enabled) {
      runtimeCalls.push({ runId, enabled });
      return runtime ? runtime(runId, enabled) : { ok: true, enabled };
    } },
    isSafeSessionId: value => /^sess_[a-z0-9_]+$/.test(String(value || '')),
    sessionPath,
    async readSessionRecord(id) {
      let result;
      try { result = JSON.parse(await fs.promises.readFile(sessionPath(id), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (nextRead) { const gate = nextRead; nextRead = null; gate.entered.resolve(); await gate.proceed.promise; }
      return result;
    },
    async writeSessionFileAtomic(file, content) { await fs.promises.writeFile(file, content); },
    async writeAtomic(file, value) {
      if (nextIndexWrite) { const gate = nextIndexWrite; nextIndexWrite = null; gate.entered.resolve(); await gate.proceed.promise; }
      await fs.promises.writeFile(file, JSON.stringify(value));
    },
    refreshSessionSummaryCache: async () => {},
    notifyDesktopSessionUpdate: detail => notifications.push(clone(detail)),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    loadConfig: () => ({ observer: {} }), normalizeObserverSettings: value => value,
    completionSettings: () => ({ enabled: true, maxWakes: 3 }),
    observerConnectionForRun: () => ({ name: 'Fixture observer', modelId: 'fixture' }),
    completionInput: value => value,
    reviewCompletion: review || (async () => ({ verdict: 'achieved', reason: 'Fixture' })),
    ensureDirs() {}, initialSessionModelSelection: () => ({ modelId: 'fixture' }),
    ensureTaskWorkspace: async () => ({}), sanitizeSessionReviewSummaries() {}, pruneSessionRuntimeBookkeeping() {},
    touchSessionRecordCache() {}, invalidateSessionRecordCache() {}, defaultTasksRoot: dataDir,
    isSafePathSegment: () => true
  });
  vm.runInContext(section('const completionReviews =', "\nipcMain.handle('models:quick-list'"), context);
  vm.runInContext(section("ipcMain.handle('session:save'", '\n// 会话级工作区'), context);
  const invoke = (name, ...args) => handlers.get(name)({}, ...args);
  // Isolate the synchronous Observer setting gate, before the independent
  // asynchronous subagent-wake admission that now precedes provider startup.
  const runtimeObserverSetting = vm.runInContext('(function (request, zSessionId) {'
    + section('    const effectiveObserverEnabled =', '    if (request.subagentWake) {')
    + 'return effectiveObserverEnabled; })', context);
  const seed = (id, extra = {}) => {
    const value = { id, title: id, messages: [], conversationRevision: 0, updatedAt: 123, ...extra };
    fs.writeFileSync(sessionPath(id), JSON.stringify(value));
    return value;
  };
  return { context, runs, notifications, runtimeCalls, seed, runtimeObserverSetting,
    disk: id => JSON.parse(fs.readFileSync(sessionPath(id), 'utf8')),
    index: () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'observer-wakes.json'), 'utf8')); } catch { return {}; } },
    seedIndex: value => fs.writeFileSync(path.join(dataDir, 'observer-wakes.json'), JSON.stringify(value)),
    set: (id, enabled) => invoke('session:observer-enabled-set', id, enabled),
    save: value => invoke('session:save', value),
    complete: (id, record) => invoke('observer:set-completion', id, record),
    review: id => invoke('observer:review-completion', { sessionId: id, goal: 'Test' }),
    wakes: () => invoke('observer:list-wakes'),
    holdRead() { nextRead = { entered: deferred(), proceed: deferred() }; return nextRead; },
    holdIndex() { nextIndexWrite = { entered: deferred(), proceed: deferred() }; return nextIndexWrite; }
  };
}

test('missing task setting defaults on and only open completion work is cancelled', () => {
  assert.equal(sessionObserverEnabled({}), true);
  assert.equal(sessionObserverEnabled({ observerEnabled: false }), false);
  const record = { status: 'scheduled', dueAt: 10, reason: 'unfinished' };
  assert.deepEqual(cancelSessionObserverCompletion(record, 20), { ...record, status: 'cancelled', endedAt: 20, cancelReason: 'observer-disabled' });
  assert.equal(cancelSessionObserverCompletion({ status: 'achieved' }).status, 'achieved');
});

test('task switch persists independently, cancels its wake, and stops only its live runtime', async t => {
  const f = fixture(t);
  f.seed('sess_a', { observerCompletion: { status: 'pending', runId: 'run-a', dueAt: 1000 } });
  f.seed('sess_b');
  f.seedIndex({ sess_a: { status: 'pending' }, sess_b: { status: 'scheduled' } });
  f.runs.set('run-a', { zSessionId: 'sess_a', task: {} });
  f.runs.set('run-b', { zSessionId: 'sess_b', task: {} });
  const result = await f.set('sess_a', false);
  assert.equal(result.ok, true);
  assert.equal(result.runtimeApplied, true);
  assert.equal(f.disk('sess_a').observerEnabled, false);
  assert.equal(f.disk('sess_a').updatedAt, 123);
  assert.equal(f.disk('sess_a').observerCompletion.status, 'cancelled');
  assert.equal(f.index().sess_a, undefined);
  assert.ok(f.index().sess_b);
  assert.deepEqual(f.runtimeCalls, [{ runId: 'run-a', enabled: false }]);
  assert.equal(f.disk('sess_b').observerEnabled, undefined);
  assert.equal(f.notifications[0].reason, 'observer-enabled-changed');
  assert.equal((await f.set('sess_a', true)).observerEnabled, true);
  assert.equal(f.index().sess_a, undefined, 'Enabling does not resurrect a cancelled wake');
});

test('a stale full session save cannot re-enable a task or restore its cancelled completion', async t => {
  const f = fixture(t);
  const stale = f.seed('sess_a', { observerEnabled: true, observerCompletion: { status: 'scheduled' } });
  await f.set('sess_a', false);
  await f.save({ ...stale, messages: [{ role: 'user', content: 'More work' }] });
  assert.equal(f.disk('sess_a').observerEnabled, false);
  assert.equal(f.disk('sess_a').observerCompletion.status, 'cancelled');
  assert.equal(f.disk('sess_a').messages.length, 1);
  assert.equal((await f.complete('sess_a', { status: 'pending' })).code, 'OBSERVER_DISABLED');
  assert.equal(f.disk('sess_a').observerCompletion.status, 'cancelled');
});

test('disabled tasks cannot start completion review or appear in restored wake inventory', async t => {
  let reviews = 0;
  const f = fixture(t, { review: async () => { reviews++; return {}; } });
  f.seed('sess_a', { observerEnabled: false, observerCompletion: { status: 'scheduled', runId: 'a' } });
  f.seed('sess_b', { observerCompletion: { status: 'pending', runId: 'b' } });
  f.seedIndex({ sess_a: { status: 'scheduled' }, sess_b: { status: 'pending' }, sess_missing: { status: 'pending' } });
  assert.equal((await f.review('sess_a')).skipped, 'disabled');
  assert.equal(reviews, 0);
  assert.deepEqual(Array.from(await f.wakes(), item => item.sessionId), ['sess_b']);
});

test('disabling cancels in-flight completion and ignores a late verdict even if its transport ignores abort', async t => {
  const entered = deferred(), pending = deferred();
  let signal;
  const f = fixture(t, { review: (_connection, _payload, options) => {
    signal = options.signal; entered.resolve(); return pending.promise;
  } });
  f.seed('sess_a');
  const review = f.review('sess_a');
  await entered.promise;
  await f.set('sess_a', false);
  assert.equal(signal.aborted, true);
  pending.resolve({ verdict: 'continue', reason: 'Late response' });
  assert.equal((await review).cancelled, true);
});

test('a completion request still reading its session is cancelled before reaching the model', async t => {
  let calls = 0;
  const f = fixture(t, { review: async () => { calls++; return {}; } });
  f.seed('sess_a');
  const gate = f.holdRead();
  const review = f.review('sess_a');
  await gate.entered.promise;
  await f.set('sess_a', false);
  gate.proceed.resolve();
  assert.equal((await review).cancelled, true);
  assert.equal(calls, 0);
});

test('pending completion index writes cannot overtake the off switch', async t => {
  const f = fixture(t);
  f.seed('sess_a');
  const gate = f.holdIndex();
  const completion = f.complete('sess_a', { status: 'pending' });
  await gate.entered.promise;
  const disabled = f.set('sess_a', false);
  gate.proceed.resolve();
  assert.equal((await completion).ok, true);
  assert.equal((await disabled).ok, true);
  assert.equal(f.disk('sess_a').observerCompletion.status, 'cancelled');
  assert.equal(f.index().sess_a, undefined);
});

test('failed runtime application is reported truthfully while the task preference remains saved', async t => {
  const f = fixture(t, { runtime: () => ({ ok: false, error: 'Fixture runtime failed' }) });
  f.seed('sess_a');
  f.runs.set('run-a', { zSessionId: 'sess_a', task: {} });
  const result = await f.set('sess_a', false);
  assert.equal(result.ok, true);
  assert.equal(result.runtimeApplied, false);
  assert.match(result.runtimeError, /Fixture runtime failed/);
  assert.equal(f.disk('sess_a').observerEnabled, false);
  assert.equal(f.notifications.at(-1).runtimeApplied, false);
});

test('a run still preparing receives the updated flag without starting a second runtime', async t => {
  const f = fixture(t);
  f.seed('sess_a');
  const run = { zSessionId: 'sess_a', task: null };
  f.runs.set('preparing', run);
  await f.set('sess_a', false);
  assert.equal(run.observerEnabled, false);
  assert.equal(vm.runInContext("sessionObserverOverrides.get('sess_a')", f.context), false);
  assert.equal(f.runtimeCalls.length, 0);
  assert.equal(f.runtimeObserverSetting({ observerEnabled: true }, 'sess_a'), false,
    'the final start boundary replaces a snapshot taken before the off switch');
  assert.throws(() => f.runtimeObserverSetting({ observerEnabled: true, observerWake: { reviewId: 'late' } }, 'sess_a'),
    { code: 'OBSERVER_DISABLED' });
  assert.equal(f.runtimeObserverSetting({ observerEnabled: true, observerWake: { reviewId: 'other' } }, 'sess_b'), true);
});

test('invalid switch values are rejected without writing settings or touching a runtime', async t => {
  const f = fixture(t);
  f.seed('sess_a');
  assert.equal((await f.set('sess_a', 'false')).ok, false);
  assert.equal((await f.set('missing', false)).ok, false);
  assert.equal(f.disk('sess_a').observerEnabled, undefined);
  assert.equal(f.runtimeCalls.length, 0);
});

test('forks and rewind backups inherit the task switch; rewinding preserves its current value', () => {
  const sourceSession = { id: 'sess_source', title: 'Task', observerEnabled: false, workspace: 'C:\\workspace',
    messages: [{ role: 'user', content: 'Goal', ts: 1 }], modelSelection: { modelId: 'fixture' } };
  const fork = createSessionForkRecord(sourceSession, { sessionId: sourceSession.id, messageIndex: 0,
    messageAnchor: messageForkAnchor(sourceSession.messages[0]) }, { id: 'sess_fork', workspace: sourceSession.workspace });
  assert.equal(fork.observerEnabled, false);
  const backup = createRewindBackup(sourceSession, { id: 'sess_backup' });
  assert.equal(backup.observerEnabled, false);
  assert.equal(createRewoundSession(sourceSession, [], { backupSessionId: backup.id }).observerEnabled, false);
  assert.equal(createRewoundSession({ ...sourceSession, observerEnabled: true }, backup.messages,
    { backupSessionId: backup.id, action: 'restore' }).observerEnabled, true);
});
