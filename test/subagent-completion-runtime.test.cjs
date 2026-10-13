'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SubagentCompletionTracker, inspectNativeCompletion, inspectMessages } = require('../lib/subagent/completion-runtime');
const { SubagentEventBridge } = require('../lib/subagent/event-bridge');
const { OpenCodeSidecar } = require('../lib/opencode-sidecar');
const { readCompletionDatabase } = require('../lib/subagent/completion-disk-worker.cjs');

const identity = { parentRunId: 'run', zSessionId: 'chat', conversationRevision: 2, parentSessionID: 'parent',
  childSessionID: 'child', callId: 'call', startedAt: 1100, directory: process.cwd() };
const assistant = (id, created, completed, parts = [], extra = {}) => ({ info: { id, sessionID: 'parent', role: 'assistant',
  time: { created, ...(completed ? { completed } : {}) }, ...(completed ? { finish: 'stop' } : {}), ...extra }, parts });
function task({ callId = 'call', child = 'child', start = 1100, end, status = 'running', output = '', error, messageID = 'task-message' } = {}) {
  return { type: 'message.part.updated', data: { part: { type: 'tool', tool: 'task', callID: callId, messageID,
    state: { input: { subagent_type: 'reviewer', description: 'Review fresh changes' }, metadata: { sessionID: child },
      status, output, ...(error ? { error } : {}), time: { start, ...(end ? { end } : {}) } } } } };
}
function tracker(events = [], overrides = {}) {
  return new SubagentCompletionTracker({ runId: 'run', zSessionId: 'chat', conversationRevision: 2,
    sessionID: 'parent', directory: process.cwd(), startedAt: 1000, onEvent: event => events.push(event), ...overrides });
}
function nativeClient(parent, child, statuses = {}) {
  return { session: { messages: async ({ sessionID }) => ({ data: sessionID === 'parent' ? parent : child }),
    status: async () => ({ data: statuses }) } };
}

test('only fresh task calls create lifecycle records; baseline and unproven session replays are rejected', () => {
  const events = [];
  const old = assistant('old-message', 100, 900, [task({ callId: 'old-call', start: 200, end: 900, status: 'completed' }).data.part]);
  const bridge = new SubagentEventBridge({ runId: 'run', sessionID: 'parent', directory: '.', startedAt: 1000,
    baselineIDs: new Set(['old-message']), baselineMessages: [old], childSessions: new Map(), onEvent: event => events.push(event) });
  assert.equal(bridge.register('old-child', { parentID: 'parent', role: 'reviewer' }), null);
  assert.equal(bridge.accepts(task({ callId: 'old-call', start: 200, end: 900, status: 'completed', messageID: 'old-message' })), false);
  assert.equal(bridge.observe(task({ callId: 'replayed', start: 400, status: 'completed', end: 900 })), false);
  bridge.observe(task());
  assert.equal(bridge.state.subagents.length, 1);
  assert.equal(events.filter(event => event.type === 'z.subagent.lifecycle').length, 1);
  assert.equal(bridge.children.size, 1);
});

test('task completion does not prove consumption until a later parent assistant generation', () => {
  const events = [], state = tracker(events);
  state.observe(task());
  state.observe(task({ status: 'completed', end: 1500, output: 'Fresh review' }));
  state.observe({ type: 'message.updated', data: { info: assistant('task-message', 1200, 1600).info } });
  state.observe({ type: 'message.updated', data: { info: assistant('parallel', 1450, 1700).info } });
  assert.equal(state.find(identity).consumed, false);
  state.observe({ type: 'message.updated', data: { info: assistant('follow-up', 1501).info } });
  assert.equal(state.find(identity).consumed, false, 'parent wrapper alone cannot hide a failed child');
  state.applyInspection(state.find(identity), { status: 'completed', completedAt: 1500, consumed: true });
  const receipt = events.at(-1).data;
  assert.equal(receipt.consumed, true);
  assert.equal(receipt.parentRunId, 'run');
  assert.equal(receipt.zSessionId, 'chat');
  assert.equal(receipt.conversationRevision, 2);
  assert.equal(receipt.result, 'Fresh review');
  const count = events.length;
  state.observe(task({ status: 'completed', end: 1500, output: 'Fresh review' }));
  assert.equal(events.length, count, 'completion replay does not notify twice');
});

test('reordered assistant evidence is reconciled and reused child sessions keep separate calls', () => {
  const state = tracker();
  state.observe(task());
  state.observe({ type: 'message.updated', data: { info: assistant('later', 1600).info } });
  state.observe(task({ status: 'completed', end: 1500, output: 'First result' }));
  state.observe(task({ callId: 'second-call', start: 2000 }));
  state.applyInspection(state.find(identity), { status: 'completed', completedAt: 1500, consumed: true });
  assert.equal(state.records.size, 2);
  assert.equal(state.find(identity).consumed, true);
  assert.equal(state.find({ callId: 'second-call', startedAt: 2000 }).status, 'running');
});

test('native start timestamp enrichment cannot create a second receipt or leak the old pin', async () => {
  const events = [], state = tracker(events);
  state.observe(task({ start: 1100 }));
  state.observe(task({ start: 1221, end: 1700, status: 'completed', output: 'Result' }));
  assert.equal(state.records.size, 1);
  assert.equal(events.at(-1).data.startedAt, 1100);
  assert.equal(state.backgroundRecords().length, 1, 'the terminal wrapper remains pinned until inspection');
  const result = await inspectNativeCompletion(nativeClient([
    assistant('task-message', 1000, 1700, [task({ start: 1221, end: 1700, status: 'completed', output: 'Result' }).data.part])
  ], []), identity);
  assert.equal(result.status, 'completed');
  state.applyInspection(state.find(identity), result);
  assert.equal(state.backgroundRecords().length, 0);
});

test('read-only inspection distinguishes a running tool wrapper, a tool step, and a final result', async () => {
  const parent = [assistant('task-message', 1000, 1400, [task({ end: 1400, status: 'completed',
    output: '<task id="child" state="running">Working in background</task>' }).data.part])];
  const step = assistant('step', 1200, 1400, [{ type: 'text', text: 'I will inspect a file' }], { finish: 'tool-calls' });
  assert.equal((await inspectNativeCompletion(nativeClient(parent, [step]), identity)).status, 'running');
  const final = assistant('final', 1600, 1800, [{ type: 'text', text: 'The child has finished' }]);
  assert.equal((await inspectNativeCompletion(nativeClient(parent, [step, final], { child: { type: 'busy' } }), identity)).status, 'running');
  const result = await inspectNativeCompletion(nativeClient(parent, [step, final]), identity);
  assert.deepEqual(result, { status: 'completed', result: 'The child has finished', completedAt: 1800, consumed: false });
  const unreachable = await inspectNativeCompletion({ session: { messages: async () => { throw new Error('offline'); }, status: async () => ({ data: {} }) } }, identity);
  assert.equal(unreachable.status, 'unknown');
});

test('inspection never adopts old output from a reused child and observes consumption in a new user turn', async () => {
  const first = task({ status: 'completed', end: 1500, output: 'Old result' }).data.part;
  const second = task({ callId: 'next-call', start: 2000 }).data.part;
  const parent = [assistant('task-message', 1000, 1600, [first]), assistant('second-task', 1900, 2300, [second])];
  const old = assistant('old-child-result', 1200, 1500, [{ type: 'text', text: 'Old result' }]);
  const next = { ...identity, callId: 'next-call', startedAt: 2000 };
  assert.equal((await inspectNativeCompletion(nativeClient(parent, [old]), next)).status, 'running');
  assert.equal((await inspectNativeCompletion(nativeClient(parent, [old]), identity)).consumed, true);
});

test('a fresh terminal child error overrides a successful wrapper and retains partial output before waking', async () => {
  const events = [], state = tracker(events);
  const completed = task({ status: 'completed', end: 1800, output: 'Partial analysis' });
  const parent = [assistant('task-message', 1000, 1800, [completed.data.part]), assistant('parent-final', 1900, 2000)];
  const child = assistant('child-error', 1200, 1700, [
    { type: 'text', text: 'Partial analysis' },
    { type: 'tool', tool: 'bash', state: { status: 'running' } }
  ], { sessionID: 'child', error: { name: 'APIError', data: { message: 'Retry budget exhausted' } } });
  state.observe(completed);
  state.observe({ type: 'message.updated', data: { info: parent[1].info } });
  assert.equal(state.find(identity).consumed, false);
  assert.equal(state.backgroundRecords().length, 1);
  const inspected = await inspectNativeCompletion(nativeClient(parent, [child], { child: { type: 'busy' } }), identity);
  assert.deepEqual(inspected, { status: 'error', result: 'Partial analysis', completedAt: 1700,
    error: 'Retry budget exhausted', consumed: false, parentResultMismatch: true });
  state.applyInspection(state.find(identity), inspected);
  assert.equal(events.at(-1).data.status, 'error');
  assert.equal(state.backgroundRecords().length, 0);
  const count = events.length;
  state.observe(completed);
  state.applyInspection(state.find(identity), inspected);
  assert.equal(events.length, count, 'replayed native success cannot replace the verified error or notify twice');
  assert.equal(state.find(identity).consumed, false, 'the later parent saw partial text, not the failure');
});

test('a parent that actually received the child failure suppresses a redundant wake', () => {
  const child = assistant('child-error', 1200, 1500, [{ type: 'text', text: 'Partial' }],
    { error: { name: 'APIError', data: { message: 'Provider unavailable' } } });
  const part = task({ status: 'error', end: 1600, error: '[Z_SUBAGENT_FAILED] Provider unavailable\nPartial output:\nPartial' }).data.part;
  const parent = [assistant('task-message', 1000, 1600, [part]), assistant('parent-followup', 1700, 1800)];
  const inspected = inspectMessages(identity, parent, [child], { idle: true });
  assert.equal(inspected.status, 'error');
  assert.equal(inspected.result, 'Partial');
  assert.equal(inspected.error, 'Provider unavailable');
  assert.equal(inspected.consumed, true);
});

test('reused child errors are bounded by the exact native invocation start and next call', () => {
  const oldError = assistant('previous-child-error', 1150, 1200, [],
    { error: { name: 'APIError', message: 'Old failure' } });
  const laterError = assistant('next-child-error', 2100, 2200, [],
    { error: { name: 'APIError', message: 'Later failure' } });
  const parent = [assistant('task-message', 1000, 1600, [
    task({ start: 1221, status: 'completed', end: 1500, output: 'Current result' }).data.part
  ]), assistant('next-task', 1900, 2300, [task({ callId: 'next-call', start: 2000 }).data.part])];
  const result = inspectMessages(identity, parent, [oldError, laterError], { idle: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'Current result');
  assert.equal(result.error, undefined);
});

test('a cancelled child or parent task remains interrupted and cannot become an error wake', () => {
  const child = assistant('cancelled-child', 1200, 1500, [{ type: 'text', text: 'Partial' }],
    { error: { name: 'MessageAbortedError', data: { message: 'The user cancelled' } } });
  const parent = [assistant('task-message', 1000, 1600, [task({ status: 'completed', end: 1600 }).data.part])];
  assert.equal(inspectMessages(identity, parent, [child], { idle: true }).status, 'interrupted');
  const interrupted = [assistant('task-message', 1000, 1600, [task({ status: 'interrupted', end: 1600 }).data.part])];
  const failure = assistant('child-error', 1200, 1500, [], { error: { name: 'APIError', message: 'Provider failure' } });
  const result = inspectMessages(identity, interrupted, [failure], { idle: true });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.consumed, false);
});

test('completed-run inspection releases background pins and reads from the owning pooled kernel', async () => {
  const sidecar = new OpenCodeSidecar();
  const state = tracker();
  state.observe(task());
  state.sealed = true;
  sidecar.subagentCompletionRuns.set('run', state);
  sidecar.backgroundSubagentRuns.add('run');
  assert.equal(sidecar.hasBackgroundSubagents(), true);
  sidecar.client = nativeClient([assistant('task-message', 1000, 1800, [task({ status: 'completed', end: 1700, output: 'Done' }).data.part])], []);
  const pool = new OpenCodeSidecar({ maxKernels: 2 });
  pool.kernels.set('config', sidecar);
  pool.completedRunKernels.set('run', sidecar);
  assert.equal(pool.hasRun('run'), false);
  assert.equal((await pool.inspectSubagentCompletion(identity)).status, 'completed');
  assert.equal(pool.hasBackgroundSubagents(), false);
});

test('unreadable native history cannot turn a cached completion into evidence that it is still unconsumed', async () => {
  const sidecar = new OpenCodeSidecar();
  const state = tracker();
  state.observe(task({ status: 'completed', end: 1700, output: 'Previously completed result' }));
  state.sealed = true;
  sidecar.subagentCompletionRuns.set('run', state);
  sidecar.client = { session: {
    messages: async () => { throw new Error('History unavailable after another user turn'); },
    status: async () => ({ data: {} })
  } };
  assert.equal(state.find(identity).status, 'completed');
  assert.equal(state.find(identity).consumed, false);
  const inspected = await sidecar.inspectSubagentCompletion(identity);
  assert.equal(inspected.status, 'unknown');
  assert.equal(inspected.result, '');
  assert.match(inspected.error, /History unavailable/);
});

test('background pins prohibit kernel reconfiguration and pool recycling until explicitly forgotten', async () => {
  const sidecar = new OpenCodeSidecar();
  const state = tracker(); state.observe(task());
  sidecar.subagentCompletionRuns.set('run', state); sidecar.backgroundSubagentRuns.add('run');
  sidecar.server = {}; sidecar.client = {};
  sidecar.activeConfigSignature = 'original';
  await assert.rejects(sidecar.start({ model: 'other-model' }), /configuration changed/);
  const pool = new OpenCodeSidecar({ maxKernels: 2 });
  const second = { status: () => ({ activeRuns: 1 }), hasBackgroundSubagents: () => false };
  pool.kernels.set('first', sidecar); pool.kernels.set('second', second);
  await assert.rejects(pool.start({ model: 'third-model' }), /at most 2/);
  sidecar.forgetSubagentCompletion(identity);
  assert.equal(sidecar.hasBackgroundSubagents(), false);
});

test('explicit conversation stop aborts orphaned background children without killing an active owner', async () => {
  const sidecar = new OpenCodeSidecar(), calls = [];
  const state = tracker(); state.observe(task()); state.observe(task({ callId: 'other', child: 'active-child', start: 1200 }));
  sidecar.subagentCompletionRuns.set('run', state); sidecar.backgroundSubagentRuns.add('run');
  sidecar.client = { session: { abort: async args => { calls.push(args.sessionID); return { data: true }; } } };
  sidecar.activeRuns.set('new-run', { childSessions: new Map([['active-child', {}]]) });
  await sidecar.cancelSubagentCompletionTracking('chat');
  assert.deepEqual(calls, ['child']);
  assert.equal(sidecar.hasBackgroundSubagents(), false);
});

test('disk recovery reads completed evidence without mutating the native SQLite database', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-child-completion-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(directory, 'opencode-runtime', 'data', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);');
  for (const [id, parent] of [['parent', null], ['child', 'parent']]) db.prepare('INSERT INTO session VALUES (?, ?, ?)').run(id, parent, directory);
  const parent = assistant('task-message', 1000, 1400, [task({ status: 'completed', end: 1400,
    output: '<task id="child" state="running">Background</task>' }).data.part]);
  const child = assistant('final-child', 1600, 1800, [{ type: 'text', text: 'Recovered child result' }]);
  for (const [session, message] of [['parent', parent], ['child', child]]) {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(message.info.id, session, message.info.time.created, JSON.stringify(message.info));
    message.parts.forEach((part, index) => db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(`${session}-${index}`, session, message.info.id, message.info.time.created, JSON.stringify(part)));
  }
  db.close();
  const before = fs.readFileSync(dbPath);
  const record = { ...identity, directory };
  assert.deepEqual(readCompletionDatabase({ dbPath, record }), { status: 'completed', result: 'Recovered child result', completedAt: 1800, consumed: false });
  const restored = new OpenCodeSidecar({ appRoot: path.resolve(__dirname, '..'), dataDir: directory, maxKernels: 2 });
  assert.deepEqual(await restored.inspectSubagentCompletion(record), {
    status: 'completed', result: 'Recovered child result', completedAt: 1800, consumed: false
  }, 'a restored pool with no live kernel uses the bundled Node read-only worker');
  assert.equal(restored.kernels.size, 0, 'recovery never starts a kernel or a model');
  assert.equal(readCompletionDatabase({ dbPath, record: { ...record, childSessionID: 'unrelated' } }).status, 'unknown');
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.equal(inspectMessages(record, [parent], [assistant('tool-step', 1500, 1550, [], { finish: 'tool-calls' })], { disk: true }).status, 'unknown');
});

for (const outcome of ['done', 'error']) test(`actual sidecar ${outcome} finalization preserves only eligible background work and filters old Review SSE`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-child-run-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const events = [];
  const oldTask = task({ callId: 'old-review', child: 'old-child', start: Date.now() - 10000,
    end: Date.now() - 9000, status: 'completed', output: 'Old Review', messageID: 'old-message' });
  const oldMessage = assistant('old-message', Date.now() - 11000, Date.now() - 9000, [oldTask.data.part]);
  let parentMessages = [oldMessage], childMessages = [], base, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const sidecar = new OpenCodeSidecar({ appRoot: path.resolve(__dirname, '..'), dataDir: directory, log: { info() {}, warn() {} } });
  sidecar.start = async () => ({ ok: true });
  sidecar.client = { session: {
    create: async () => ({ data: { id: 'parent', directory } }),
    messages: async ({ sessionID }) => ({ data: sessionID === 'parent' ? parentMessages : childMessages }),
    promptAsync: async () => {
      base = Date.now() + 10;
      const part = task({ start: base + 1, status: 'completed', end: base + 2,
        output: '<task id="child" state="running">Background task launched</task>' }).data.part;
      parentMessages = [oldMessage, assistant('task-message', base, base + 2, [part]),
        assistant('parent-final', base + 3, base + 4, [{ type: 'text', text: 'The requested parent analysis is complete.' }],
          outcome === 'error' ? { error: { message: 'Parent failed' } } : {})];
      ready();
      return { data: true };
    },
    status: async () => ({ data: childMessages.length ? {} : { child: { type: 'busy' } } }),
    todo: async () => ({ data: [] }), diff: async () => ({ data: [] }), abort: async () => ({ data: true })
  }, event: { subscribe: async (_query, { signal }) => ({ stream: (async function* () {
    await started;
    yield { ...oldTask, data: { ...oldTask.data, sessionID: 'parent' } };
    yield { type: 'session.created', data: { info: { id: 'old-child', parentID: 'parent', agent: 'reviewer' } } };
    const active = task({ start: base + 1 });
    yield { ...active, data: { ...active.data, sessionID: 'parent' } };
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  })() }) } };
  const result = await sidecar.run({ runId: 'run', zSessionId: 'chat', conversationRevision: 2,
    workspace: directory, hasUserWorkspace: true, prompt: 'Inspect the fixture', providerId: 'fixture', modelId: 'fixture',
    workMode: 'normal', observerEnabled: false }, event => events.push(event)).catch(error => {
      if (outcome !== 'error') throw error;
      assert.match(error.message, /Parent failed/);
      return { status: 'error' };
    });
  assert.equal(result.status, outcome);
  assert.equal(sidecar.hasRun('run'), false);
  assert.equal(events.some(event => event.data?.part?.callID === 'old-review'), false);
  if (outcome === 'done') assert.deepEqual(result.subagents.map(record => record.callId), ['call']);
  const receipt = events.find(event => event.type === 'z.subagent.lifecycle')?.data;
  assert.ok(receipt, 'real sidecar emitted a persistent lifecycle identity');
  assert.equal(receipt.zSessionId, 'chat');
  assert.equal(sidecar.hasBackgroundSubagents(), outcome === 'done');
  if (outcome === 'done') {
    childMessages = [assistant('child-final', base + 5, base + 6, [{ type: 'text', text: 'Late result after parent completion' }])];
    const inspected = await sidecar.inspectSubagentCompletion(receipt);
    assert.deepEqual(inspected, { status: 'completed', result: 'Late result after parent completion', completedAt: base + 6, consumed: false });
    assert.equal(sidecar.hasBackgroundSubagents(), false);
  }
});
