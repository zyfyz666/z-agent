'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WDMonitorState } = require('../lib/wd-monitor-state');
const { createThrashWatch } = require('../lib/thrash-watchdog');
const { OpenCodeSidecar } = require('../lib/opencode-sidecar');

function action(id, target = `src/${id}.js`) {
  return {
    info: { id, role: 'assistant', parentID: 'user', time: { created: Date.now(), completed: Date.now() } },
    parts: [{ type: 'tool', tool: 'read', callID: id,
      state: { status: 'completed', input: { filePath: target }, output: 'source' } }]
  };
}

function fixture(t, { enabled = true, repetitive = false, polls = 3, initial = [], tools = 6, observerConnection, observerJudgeEvery,
  prompt = 'Read the project source files.' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-wd-telemetry-'));
  // Startup may fail while the read-only baseline child is still exiting.
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const messages = [...initial];
  const calls = { prompts: 0, deliveries: 0, polls: 0 };
  const sidecar = new OpenCodeSidecar({ appRoot: process.cwd(), dataDir: directory, log: { warn() {} } });
  sidecar.thrashWatchdogEnabled = enabled;
  sidecar.thrashWatchdogN = 6;
  sidecar.start = async () => ({ ok: true });
  sidecar.client = {
    session: {
      create: async () => ({ data: { id: 'session-wd', directory } }),
      messages: async () => ({ data: messages }),
      status: async () => ({ data: { 'session-wd': { type: ++calls.polls <= polls ? 'busy' : 'idle' } } }),
      todo: async () => ({ data: [] }),
      diff: async () => ({ data: [] }),
      promptAsync: async () => {
        calls.prompts += 1;
        for (let i = 0; i < tools; i++) messages.push(action(`action-${i}`, repetitive ? 'src/config.js' : undefined));
        messages.push({
          info: { id: 'final', parentID: 'user', role: 'assistant', time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
          parts: [{ type: 'text', text: 'Finished the requested task.' }]
        });
        return { data: true };
      }
    },
    event: { subscribe: async (_payload, options) => ({ stream: (async function* () {
      if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    })() }) }
  };
  sidecar.deliverInterjection = async () => { calls.deliveries += 1; return { ok: true, delivered: true }; };
  const events = [];
  const run = listener => sidecar.run({
    runId: 'run-wd', workspace: directory, hasUserWorkspace: true,
    prompt, workMode: 'normal', enableSubagents: false,
    providerId: 'test', modelId: 'test', observerConnection, observerJudgeEvery
  }, event => { events.push(event); listener?.(event); });
  return { sidecar, events, calls, run };
}

for (const grounded of [true, false]) test(`runtime invokes the independent observer API and ${grounded ? 'delivers evidence-backed advice' : 'suppresses advice without evidence'}`, async t => {
  const http = require('node:http');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    requests.push(request);
    const input = JSON.parse(request.body.messages.find(message => message.role === 'user').content);
    const repeatedAction = input.recentActions[1];
    const decision = { action: 'remind', message: 'The task requires reading each file once; move on from the repeatedly read file.',
      ...(grounded ? { evidence: [{ actionIndex: repeatedAction.index,
        fact: `This action reads ${repeatedAction.target} again despite the goal requiring each file to be read exactly once.` }] } : {}) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const f = fixture(t, { repetitive: true, prompt: 'Read each source file exactly once.', observerJudgeEvery: 2, observerConnection: {
    providerId: 'independent', supplierId: 'official', modelId: 'reviewer', name: 'Reviewer',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'observer-only', apiFormat: 'openai'
  } });
  const result = await f.run();
  assert.equal(result.status, 'done'); assert.equal(requests.length, 1);
  assert.equal(requests[0].auth, 'Bearer observer-only'); assert.equal(requests[0].body.model, 'reviewer');
  assert.equal(result.watchdog.judgeEvery, 2); assert.equal(result.watchdog.model.checks, 1);
  assert.equal(result.watchdog.model.phase, 'stopped');
  if (grounded) {
    assert.equal(result.watchdog.events[0].rules[0], 'model_observer');
    assert.equal(result.watchdog.events[0].delivery, 'delivered');
    assert.equal(f.calls.deliveries, 1);
  } else {
    assert.equal(result.watchdog.events.length, 1);
    assert.equal(result.watchdog.events[0].action, 'observe');
    assert.equal(result.watchdog.events[0].delivery, 'not-needed');
    assert.ok(result.watchdog.events[0].ts > 0);
    assert.equal(result.watchdog.interventions, 0);
    assert.equal(result.watchdog.observations, 1);
    assert.equal(f.calls.deliveries, 0);
  }
  assert.doesNotMatch(JSON.stringify(f.events), /observer-only/);
});

test('a slow observer never holds the main task open and its request is aborted', async t => {
  const http = require('node:http');
  let requests = 0;
  const server = http.createServer(() => { requests++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const f = fixture(t, { polls: 2, observerConnection: {
    providerId: 'independent', supplierId: 'official', modelId: 'slow',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fake'
  } });
  const result = await f.run();
  assert.equal(requests, 1); assert.equal(result.status, 'done');
  assert.equal(result.watchdog.model.phase, 'stopped'); assert.equal(f.calls.deliveries, 0);
});

test('unavailable observer connection preserves normal rule monitoring', async t => {
  const f = fixture(t, { observerConnection: { modelId: 'deleted', unavailable: true }, observerJudgeEvery: 10, tools: 12 });
  const result = await f.run();
  assert.equal(result.status, 'done'); assert.equal(result.watchdog.checks, 1);
  assert.equal(result.watchdog.judgeEvery, 10); assert.equal(result.watchdog.model.phase, 'error');
  assert.equal(f.calls.deliveries, 0);
});

test('disabled WD reports disabled from startup through the saved result', async t => {
  const f = fixture(t, { enabled: false });
  const result = await f.run();
  const statuses = f.events.filter(event => event.type === 'z.thrash.watchdog.status');
  assert.equal(statuses.length, 2, 'runtime health still reports startup and completion when model observation is disabled');
  assert.equal(statuses[0].data.enabled, false);
  assert.equal(statuses[0].data.phase, 'disabled');
  assert.equal(result.watchdog.phase, 'disabled');
  assert.equal(result.watchdog.checks, 0);
  assert.equal(result.watchdog.interventions, 0);
  assert.equal(result.watchdog.health.state, 'completed');
  assert.equal(f.calls.deliveries, 0);
});

test('checks count normal judgments, while judgedSteps remains the last action index', () => {
  const watch = createThrashWatch({ judgeEvery: 6 });
  const messages = Array.from({ length: 12 }, (_, i) => action(`unique-${i}`));
  assert.equal(watch.observe(messages.slice(0, 5)), null);
  assert.deepEqual(watch.telemetry, { judgeEvery: 6, observedSteps: 5, judgedSteps: 0, checks: 0, streak: 0 });
  assert.equal(watch.observe(messages.slice(0, 6)), null);
  assert.equal(watch.telemetry.checks, 1);
  assert.equal(watch.telemetry.judgedSteps, 6);
  assert.equal(watch.observe(messages.slice(0, 6)), null);
  assert.equal(watch.telemetry.checks, 1);
  assert.equal(watch.observe(messages), null);
  assert.equal(watch.telemetry.checks, 2);
  assert.equal(watch.telemetry.judgedSteps, 12);
  assert.equal(watch.state.fires, 0);
});

test('custom rule intervals honor the initial six-action warmup then the selected cadence', () => {
  const messages = Array.from({ length: 20 }, (_, i) => action(`interval-${i}`));
  for (const every of [1, 2, 10]) {
    const watch = createThrashWatch({ judgeEvery: every });
    const first = Math.max(6, every);
    watch.observe(messages.slice(0, first - 1)); assert.equal(watch.telemetry.checks, 0);
    watch.observe(messages.slice(0, first)); assert.equal(watch.telemetry.checks, 1);
    watch.observe(messages.slice(0, first + every - 1)); assert.equal(watch.telemetry.checks, 1);
    watch.observe(messages.slice(0, first + every)); assert.equal(watch.telemetry.checks, 2);
  }
});

test('repeated busy polls neither increment counters nor emit unchanged snapshots', async t => {
  const f = fixture(t);
  const result = await f.run();
  const statuses = f.events.filter(event => event.type === 'z.thrash.watchdog.status');
  assert.deepEqual(statuses.map(event => event.data.phase), ['waiting', 'observing', 'completed']);
  assert.equal(result.status, 'done');
  assert.equal(result.watchdog.observedSteps, 6);
  assert.equal(result.watchdog.judgedSteps, 6);
  assert.equal(result.watchdog.checks, 1);
  assert.equal(result.watchdog.interventions, 0);
  assert.equal(f.calls.deliveries, 0);
  assert.equal(f.calls.prompts, 1);
  assert.deepEqual(result.watchdog, Object.fromEntries(Object.entries(statuses.at(-1).data)
    .filter(([key]) => !['sessionID', 'runID'].includes(key))));
});

test('existing history counts as session actions and final-only tools are counted without a new check', async t => {
  const f = fixture(t, { initial: [action('earlier-turn')], polls: 0, tools: 2 });
  const result = await f.run();
  assert.equal(result.watchdog.observedSteps, 3);
  assert.equal(result.watchdog.checks, 0);
  assert.equal(result.watchdog.judgedSteps, 0);
  assert.equal(f.calls.deliveries, 0);
});

test('decisions retain the compatible event and update delivery only after confirmation', async t => {
  const f = fixture(t, { repetitive: true });
  const result = await f.run();
  const statuses = f.events.filter(event => event.type === 'z.thrash.watchdog.status');
  const decision = f.events.find(event => event.type === 'z.thrash.watchdog');
  assert.equal(decision.data.sessionID, 'session-wd');
  assert.equal(decision.data.delivery, 'pending');
  assert.equal(decision.data.step, 6);
  assert.ok(statuses.some(event => event.data.events[0]?.delivery === 'pending'));
  assert.ok(statuses.some(event => event.data.events[0]?.delivery === 'delivered'));
  assert.equal(result.watchdog.events[0].delivery, 'delivered');
  assert.equal(result.watchdog.interventions, 1);
  assert.equal(result.watchdog.checks, 1);
  assert.equal(f.calls.deliveries, 1);
  assert.equal(f.calls.prompts, 1);
});

test('failed, rejected and queued deliveries remain distinct from delivered', async t => {
  for (const mode of ['rejected', 'throw', 'queued']) await t.test(mode, async t => {
    const f = fixture(t, { repetitive: true, polls: 1 });
    f.sidecar.deliverInterjection = async () => {
      f.calls.deliveries += 1;
      if (mode === 'throw') throw new Error('interjection unavailable');
      return mode === 'queued' ? { ok: true, queued: true } : { ok: false, delivered: false, error: 'session ended' };
    };
    const result = await f.run();
    assert.equal(result.status, 'done');
    assert.equal(result.watchdog.events[0].delivery, mode === 'queued' ? 'queued' : 'failed');
    if (mode !== 'queued') assert.match(result.watchdog.events[0].deliveryError, /interjection unavailable|session ended/);
    assert.equal(f.calls.prompts, 1, 'a telemetry failure must not create another model request');
  });
});

test('an unconfirmed delivery is still pending when the run finishes', async t => {
  const f = fixture(t, { repetitive: true, polls: 1 });
  let confirm;
  f.sidecar.deliverInterjection = () => new Promise(resolve => { confirm = resolve; });
  const result = await f.run();
  assert.equal(result.watchdog.phase, 'completed');
  assert.equal(result.watchdog.events[0].delivery, 'pending');
  confirm({ ok: true, delivered: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.filter(event => event.type === 'z.thrash.watchdog.status').at(-1).data.events[0].delivery, 'delivered');
  assert.equal(result.watchdog.events[0].delivery, 'pending', 'returned snapshots are detached point-in-time values');
});

test('closed status consumers cannot block the run or watchdog reminder', async t => {
  const f = fixture(t, { repetitive: true, polls: 1 });
  const result = await f.run(event => {
    if (event.type.startsWith('z.thrash.watchdog')) throw new Error('renderer closed');
  });
  assert.equal(result.status, 'done');
  assert.equal(result.watchdog.events[0].delivery, 'delivered');
  assert.equal(f.calls.deliveries, 1);
});

test('startup error and cancellation preserve truthful terminal snapshots', async t => {
  for (const interrupted of [false, true]) await t.test(interrupted ? 'interrupted' : 'error', async t => {
    const f = fixture(t);
    f.sidecar.start = async () => {
      const error = new Error('startup stopped');
      if (interrupted) error.name = 'AbortError';
      throw error;
    };
    if (interrupted) {
      const result = await f.run();
      assert.equal(result.status, 'interrupted');
      assert.equal(result.watchdog.phase, 'completed');
      assert.equal(result.watchdog.outcome, 'interrupted');
    } else {
      await assert.rejects(f.run(), error => error.message === 'startup stopped' && error.watchdog.phase === 'error');
    }
    assert.equal(f.calls.prompts, 0);
    const latest = f.events.filter(event => event.type === 'z.thrash.watchdog.status').at(-1).data;
    assert.equal(latest.outcome, interrupted ? 'interrupted' : 'error');
  });
});

test('snapshots are bounded, detached, serializable and preserve cumulative counts', () => {
  let now = 100;
  const monitor = new WDMonitorState({ now: () => now++ });
  const circular = {};
  circular.self = circular;
  for (let i = 0; i < 35; i++) {
    const id = monitor.decision({ action: 'remind', rules: ['R1_loop'], advisories: [], severity: 1,
      step: i * 6, streak: 1, message: circular });
    monitor.delivery(id, { ok: true, delivered: true });
  }
  monitor.observe({ observedSteps: Infinity, checks: NaN });
  monitor.stop('completed');
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.interventions, 35);
  assert.equal(snapshot.events.length, 30);
  assert.equal(snapshot.events[0].id, 'wd-6');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  snapshot.events[0].rules.push('outside-change');
  snapshot.events.pop();
  assert.equal(monitor.snapshot().events.length, 30);
  assert.deepEqual(monitor.snapshot().events[0].rules, ['R1_loop']);
});
