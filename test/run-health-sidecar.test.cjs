'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeSidecar } = require('../lib/opencode-sidecar');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-health-'));
  t.after(() => {
    assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const events = [];
  const calls = { prompt: 0, abort: 0, messages: 0 };
  const state = { messages: [], started: false };
  const sidecar = new OpenCodeSidecar({ appRoot: path.resolve(__dirname, '..'), dataDir: directory,
    healthOptions: { intervalMs: 10, graceMs: 0, readTimeoutMs: 50 }, log: { info() {}, warn() {} } });
  sidecar.start = async () => ({ ok: true });
  sidecar.client = { session: {
    create: async () => ({ data: { id: 'session', directory } }),
    messages: async () => { calls.messages++; return options.messages?.(state) || { data: state.messages }; },
    promptAsync: async request => { calls.prompt++; state.started = true; return options.prompt?.(state, request) || { data: true }; },
    status: async () => options.status?.(state) || { data: { session: { type: 'idle' } } },
    abort: async () => { calls.abort++; return { data: true }; },
    todo: async () => ({ data: [] }), diff: async () => ({ data: [] })
  }, event: { subscribe: async (_query, { signal }) => ({ stream: (async function* () {
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  })() }) } };
  return { directory, events, state, calls, sidecar, run: () => sidecar.run({
    runId: 'run', workspace: directory, hasUserWorkspace: true, prompt: 'Inspect a fixture',
    providerId: 'fixture', modelId: 'fixture', workMode: 'normal', ...options.request
  }, event => { events.push(event); options.onEvent?.(event, state); }) };
}
async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), 'expected fixture condition before deadline');
}
function assistant(parts) {
  return { info: { id: 'answer', role: 'assistant', sessionID: 'session', time: { created: Date.now() } }, parts };
}

test('real sidecar health reports an overdue tool while the main status poll is blocked and preserves it on cancel', async t => {
  let releaseStatus;
  const f = fixture(t, {
    prompt: state => {
      state.messages = [assistant([{ type: 'tool', tool: 'bash', callID: 'background-start',
        state: { status: 'running', time: { start: Date.now() }, input: { timeout: 10 }, metadata: { output: 'PID: 29812' } } }])];
      return { data: true };
    },
    status: () => new Promise(resolve => { releaseStatus = resolve; })
  });
  const pending = f.run();
  await until(() => f.events.some(event => event.data?.health?.state === 'overdue'));
  assert.equal(f.calls.prompt, 1);
  assert.equal(f.calls.abort, 0, 'diagnostic health cannot terminate or replay a side-effectful process');
  const runtime = f.sidecar.activeRuns.get('run');
  assert.ok(runtime);
  assert.equal(runtime.watchdogMonitor.snapshot().checks, 0, 'no new actions were needed to run health checks');
  await f.sidecar.cancel('run');
  assert.equal(runtime.healthMonitor.timer, null, 'cancel disposes health even while native status remains unresolved');
  assert.equal(runtime.healthMonitor.controller.signal.aborted, true);
  releaseStatus({ data: { session: { type: 'busy' } } });
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.watchdog.health.state, 'completed');
  assert.ok(result.watchdog.healthEvents.some(event => event.state === 'overdue'));
  assert.equal(result.watchdog.interventions, 0);
  assert.equal(result.toolCalls[0].callId, 'background-start');
  assert.equal(runtime.healthMonitor.timer, null);
  const count = f.events.length;
  await pause(30);
  assert.equal(f.events.length, count, 'no health callbacks survive run finalization');
});

test('a run starting with its observer off still diagnoses overdue tools and can enable observation without restarting', async t => {
  let releaseStatus;
  const f = fixture(t, {
    request: { observerEnabled: false },
    prompt: state => {
      state.messages = [assistant([{ type: 'tool', tool: 'bash', callID: 'running-tool',
        state: { status: 'running', time: { start: Date.now() }, input: { timeout: 10 } } }])];
      return { data: true };
    },
    status: () => new Promise(resolve => { releaseStatus = resolve; })
  });
  const pending = f.run();
  await until(() => f.events.some(event => event.data?.health?.state === 'overdue'));
  const runtime = f.sidecar.activeRuns.get('run');
  assert.equal(runtime.watchdogMonitor.snapshot().enabled, false);
  assert.equal(runtime.watchdogMonitor.snapshot().phase, 'disabled');
  assert.equal(runtime.modelObserver, undefined);
  assert.equal(f.sidecar.setObserverEnabled('run', true).enabled, true);
  assert.equal(f.calls.prompt, 1);
  assert.equal(f.calls.abort, 0);
  assert.equal(runtime.abortController.signal.aborted, false);
  assert.ok(runtime.healthMonitor.timer);
  await f.sidecar.cancel('run');
  releaseStatus({ data: { session: { type: 'busy' } } });
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.ok(result.watchdog.healthEvents.some(event => event.state === 'overdue'));
});

test('closing observation during a checkpoint baseline read drops captured advice before another model request', async t => {
  let finishFirstPrompt, finishCheckpointRead;
  const f = fixture(t, {
    prompt: async (state, request) => {
      if (request.noReply) return { data: true };
      assert.equal(finishFirstPrompt, undefined, 'the cancelled observer checkpoint must not start another primary prompt');
      await new Promise(resolve => { finishFirstPrompt = resolve; });
      const reply = assistant([{ type: 'text', text: 'The requested inspection is complete.' }]);
      reply.info.time.completed = Date.now();
      reply.info.finish = 'stop';
      state.messages = [reply];
      return { data: true };
    },
    onEvent: (event, state) => { if (event.type === 'z.interjection.processing') state.holdCheckpoint = true; },
    messages: state => {
      if (!state.holdCheckpoint || state.checkpointReadPending) return { data: state.messages };
      state.checkpointReadPending = true;
      return new Promise(resolve => { finishCheckpointRead = () => { state.holdCheckpoint = false; resolve({ data: state.messages }); }; });
    }
  });
  const pending = f.run();
  await until(() => !!finishFirstPrompt);
  const delivered = await f.sidecar.deliverInterjection('run', { source: 'runtime', observerGeneration: 0,
    guidance: 'An observer follow-up that the user is about to turn off.' });
  assert.equal(delivered.ok, true);
  finishFirstPrompt();
  await until(() => !!finishCheckpointRead);
  f.sidecar.setObserverEnabled('run', false);
  f.sidecar.setObserverEnabled('run', true);
  finishCheckpointRead();
  const result = await pending;
  assert.equal(result.status, 'done');
  assert.equal(f.calls.prompt, 2, 'only the first prompt and accepted noReply insertion were sent');
  assert.equal(f.calls.abort, 0, 'switching the observer never aborts the main agent');
});

for (const status of ['pending', 'running', '']) test(`native retry refuses an ambiguous ${status || 'unknown'} tool without assistant.error`, async t => {
  const f = fixture(t, { prompt: state => {
    state.messages = [assistant([{ type: 'tool', tool: 'bash', callID: 'launch-once', state: { status, input: {} } }])];
    throw new Error('fetch failed');
  } });
  await assert.rejects(f.run(), /fetch failed/);
  assert.equal(f.calls.prompt, 1);
  assert.equal(f.calls.abort, 0);
});

test('native retry does not assume that an unreachable session became idle', async t => {
  const f = fixture(t, { prompt: () => { throw new Error('fetch failed'); },
    status: () => { throw new Error('native status unavailable'); } });
  await assert.rejects(f.run(), /fetch failed/);
  assert.equal(f.calls.prompt, 1);
});

test('native retry refuses to repeat after the bounded drain remains busy', async t => {
  const f = fixture(t, { prompt: () => { throw new Error('fetch failed'); },
    status: () => ({ data: { session: { type: 'busy' } } }) });
  await assert.rejects(f.run(), /fetch failed/);
  assert.equal(f.calls.prompt, 1);
});
