'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenCodeSidecar } = require('../lib/opencode-sidecar');
const { ModelObserver } = require('../lib/observer-model');
const { WDMonitorState } = require('../lib/wd-monitor-state');

const tick = () => new Promise(resolve => setImmediate(resolve));
const actions = length => Array.from({ length }, (_, index) => ({ op: 'read', target: `file-${index}` }));
const connection = { name: 'Fixture observer', modelId: 'fixture-observer' };

function fixture() {
  const sidecar = new OpenCodeSidecar({ appRoot: process.cwd(), dataDir: process.cwd(), log: { warn() {} } });
  sidecar.thrashWatchdogEnabled = true;
  const calls = [];
  sidecar.client = { session: { promptAsync: async (...args) => { calls.push(args); return { data: true }; } } };
  const events = [];
  const makeRun = id => ({ runId: id, openCodeSessionID: `session-${id}`, directory: '',
    request: { observerConnection: connection }, observerGeneration: 0,
    acceptingInterjections: true, aborted: false, abortController: new AbortController(),
    eventController: new AbortController(), watchdogMonitor: new WDMonitorState(),
    healthMonitor: { timer: 'running-health-timer' }, interjections: [], nextGuidanceVersion: 0,
    guidanceVersion: 0, processedGuidanceVersion: 0, pendingInterjectionDeliveries: 0,
    finishRequested: false, onEvent: event => events.push(event) });
  const a = makeRun('a'), b = makeRun('b');
  sidecar.activeRuns.set('a', a); sidecar.activeRuns.set('b', b);
  return { sidecar, a, b, events, calls };
}

test('switching one observer preserves its history and does not stop another task, health, or the main run', () => {
  const { sidecar, a, b, events } = fixture();
  a.watchdogMonitor.decision({ action: 'observe', message: 'A completed judgment.', step: 1 });
  const result = sidecar.setObserverEnabled('a', false);
  assert.equal(result.ok, true);
  assert.equal(a.request.observerEnabled, false);
  assert.equal(result.monitor.phase, 'disabled');
  assert.equal(result.monitor.events[0].message, 'A completed judgment.');
  assert.equal(result.monitor.observations, 1);
  assert.equal(b.watchdogMonitor.snapshot().enabled, true);
  assert.equal(b.request.observerEnabled, undefined);
  assert.equal(a.abortController.signal.aborted, false);
  assert.equal(a.eventController.signal.aborted, false);
  assert.equal(a.healthMonitor.timer, 'running-health-timer');
  assert.equal(events.at(-1).data.phase, 'disabled');
  a.watchdogMonitor.healthStatus({ state: 'overdue', checkedAt: Date.now(), message: 'Tool timeout remains visible.' });
  assert.equal(a.watchdogMonitor.snapshot().health.state, 'overdue');
  sidecar.setObserverEnabled('a', true);
  assert.equal(a.watchdogMonitor.snapshot().events.length, 1);
  assert.equal(a.watchdogMonitor.snapshot().enabled, true);
  sidecar.thrashWatchdogEnabled = false;
  assert.equal(sidecar.setObserverEnabled('a', true).enabled, false, 'a task cannot override the global switch');
});

test('an in-flight model check is aborted, and rapid off/on cannot deliver its late reply or clear a newer check', async () => {
  const { sidecar, a } = fixture();
  const requests = [], delivered = [];
  const observer = a.modelObserver = new ModelObserver({ connection, judgeEvery: 1,
    isActive: () => a.request.observerEnabled !== false,
    review: (_connection, _input, options) => new Promise(resolve => requests.push({ resolve, signal: options.signal })),
    onState: state => a.watchdogMonitor.modelStatus(state), onGuidance: decision => delivered.push(decision) });
  observer.observe(actions(1)); await tick();
  requests[0].resolve({ action: 'observe', message: 'The first completed judgment.' }); await observer.pending;
  observer.observe(actions(2)); await tick();
  const stalePending = observer.pending;
  sidecar.setObserverEnabled('a', false);
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(observer.state.phase, 'disabled');
  sidecar.setObserverEnabled('a', true);
  observer.observe(actions(2));
  const freshPending = observer.pending;
  await tick();
  await stalePending;
  assert.equal(observer.pending, freshPending);
  requests[1].resolve({ action: 'remind', message: 'Outdated reminder.', evidence: [{ actionIndex: 2, fact: 'Old evidence.' }] });
  await tick();
  assert.deepEqual(delivered, []);
  assert.equal(observer.state.checks, 1);
  requests[2].resolve({ action: 'observe', message: 'Fresh judgment after resuming.' });
  await freshPending;
  assert.equal(observer.state.checks, 2);
  assert.equal(a.watchdogMonitor.snapshot().events.length, 2);
  assert.equal(a.watchdogMonitor.snapshot().events[1].message, 'Fresh judgment after resuming.');
  observer.stop();
});

test('closing while an observer reminder is being inserted cancels the wait and prevents a late halt or checkpoint', async () => {
  const { sidecar, a } = fixture();
  let finishInsertion, insertionSignal;
  sidecar.client.session.promptAsync = (_request, options) => {
    insertionSignal = options.signal;
    return new Promise(resolve => { finishInsertion = resolve; });
  };
  const eventId = a.watchdogMonitor.decision({ action: 'halt', message: 'A pending rule.', step: 2 });
  const pending = sidecar.deliverInterjection('a', { source: 'runtime', observerGeneration: 0,
    guidance: 'A pending observer requirement.', requestFinish: true });
  await tick();
  sidecar.setObserverEnabled('a', false);
  sidecar.setObserverEnabled('a', true);
  const result = await pending;
  assert.equal(insertionSignal.aborted, true);
  assert.equal(result.cancelled, true);
  assert.equal(a.pendingInterjectionDeliveries, 0);
  assert.deepEqual(a.interjections, []);
  assert.equal(a.finishRequested, false);
  assert.equal(a.guidanceVersion, 0);
  assert.equal(a.watchdogMonitor.snapshot().events.find(event => event.id === eventId).delivery, 'failed');
  assert.equal(a.watchdogMonitor.delivery(eventId, { ok: true, delivered: true }), false);
  finishInsertion({ data: true }); await tick();
  assert.equal(a.guidanceVersion, 0);
  assert.equal(a.finishRequested, false);
  assert.equal(a.abortController.signal.aborted, false);
});

test('normal completion accepts a late confirmation for an already sent observer notice without scheduling more work', async () => {
  const { sidecar, a } = fixture();
  let finishInsertion;
  sidecar.client.session.promptAsync = () => new Promise(resolve => { finishInsertion = resolve; });
  const pending = sidecar.deliverInterjection('a', { source: 'runtime', observerGeneration: 0,
    guidance: 'A notice already submitted before completion.', requestFinish: true });
  await tick();
  a.acceptingInterjections = false;
  a.watchdogMonitor.stop('completed');
  finishInsertion({ data: true });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(a.guidanceVersion, 0);
  assert.equal(a.finishRequested, false);
  assert.equal(a.pendingInterjectionDeliveries, 0);
  assert.equal(a.watchdogMonitor.snapshot().phase, 'completed');
});

test('old observer generations cannot send after reopening, while user guidance and other runtime notices still work', async () => {
  const { sidecar, calls } = fixture();
  sidecar.setObserverEnabled('a', false);
  const blocked = await sidecar.deliverInterjection('a', { source: 'runtime', observerGeneration: 0, guidance: 'Old reminder.' });
  assert.equal(blocked.cancelled, true);
  assert.equal((await sidecar.deliverInterjection('a', { source: 'runtime', guidance: 'An unrelated runtime requirement.' })).ok, true);
  assert.equal((await sidecar.deliverInterjection('a', { source: 'user', guidance: 'A user correction.' })).ok, true);
  sidecar.setObserverEnabled('a', true);
  assert.equal((await sidecar.deliverInterjection('a', { source: 'runtime', observerGeneration: 0, guidance: 'Still stale.' })).cancelled, true);
  assert.equal(calls.length, 2);
});

test('pool routing carries an observer switch through kernel acquisition and targets only its assigned run', async () => {
  let releaseStart, captured;
  const routed = [];
  const kernel = { start: () => new Promise(resolve => { releaseStart = resolve; }),
    status: () => ({ ok: true, activeRuns: 0, pendingRuns: 0 }),
    run: async request => { captured = request; return { status: 'done' }; },
    setObserverEnabled: (id, enabled) => { routed.push([id, enabled]); return { ok: true, enabled }; } };
  const sidecar = new OpenCodeSidecar({ maxKernels: 2, kernelFactory: () => kernel });
  const pending = sidecar.run({ runId: 'pool-a', prompt: 'Fixture' });
  await tick();
  assert.equal(sidecar.setObserverEnabled('pool-a', false).pending, true);
  releaseStart(); await pending;
  assert.equal(captured.observerEnabled, false);
  sidecar.runKernels.set('pool-a', kernel);
  assert.equal(sidecar.setObserverEnabled('pool-a', true).ok, true);
  assert.deepEqual(routed, [['pool-a', true]]);
  assert.equal(sidecar.setObserverEnabled('unknown', false).ok, false);
});
