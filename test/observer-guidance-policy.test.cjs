'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../lib/opencode-sidecar.js'), 'utf8');
const start = source.indexOf('        if (this.thrashWatchdogEnabled && run) {');
const end = source.indexOf('        const settled = settledAssistantSince', start);
assert.ok(start > 0 && end > start);
const pollBlock = source.slice(start, end);

function fixture(connection) {
  const deliveries = [], decisions = [], modelStates = [], observations = [], events = [];
  const verdict = { action: 'remind', rules: ['R1_loop'], advisories: [], streak: 1, step: 12,
    severity: 1, message: 'Repeated actions are a candidate for review.' };
  const run = {
    runId: 'observer-policy-run', directory: '', request: { prompt: 'Fix the failing test', observerConnection: connection },
    acceptingInterjections: true, aborted: false, abortController: new AbortController(),
    thrashWatch: { observe: () => verdict, telemetry: { checks: 2, observedSteps: 12 } },
    watchdogMonitor: {
      observe: detail => { observations.push(detail); return true; },
      modelStatus: detail => { modelStates.push(detail); return true; },
      decision: detail => { decisions.push(detail); return `decision-${decisions.length}`; },
      delivery: () => true,
      fail: () => true
    },
    onEvent: event => events.push(event)
  };
  class ControlledObserver {
    constructor(options) { this.options = options; this.reviews = []; }
    emit() {}
    observe(steps, candidate) { this.reviews.push({ steps, candidate }); }
  }
  const driver = {
    thrashWatchdogEnabled: true, thrashWatchdogN: 6, log: { warn() {} },
    async deliverInterjection(runId, request) { deliveries.push({ runId, request }); return { ok: true }; }
  };
  const context = vm.createContext({ run, driver, messages: [], sessionID: 'kernel-session',
    ModelObserver: ControlledObserver, emitWatchdogStatus() {},
    stepsFromMessages: () => Array.from({ length: 12 }, (_, index) => ({ op: 'read', target: `file-${index}` })),
    thrashGuidance: value => value.message, errorText: error => error.message,
    appendAudit() { throw new Error('Fixture has no audit path'); }, path,
    createThrashWatch() { throw new Error('Existing watcher should be reused'); }
  });
  const poll = () => vm.runInContext(`(async function(){${pollBlock}}).call(driver)`, context);
  return { run, poll, verdict, deliveries, decisions, modelStates, observations, events };
}

test('model observation treats a rule hit as unsent evidence rather than immediate guidance', async () => {
  const f = fixture({ modelId: 'observer-model' });
  await f.poll();
  assert.equal(f.run.modelObserver.reviews.length, 1);
  assert.equal(f.run.modelObserver.reviews[0].candidate, f.verdict);
  assert.equal(f.observations.length, 1);
  assert.deepEqual(f.deliveries, []);
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.events, []);
  await f.poll();
  assert.deepEqual(f.deliveries, []);
});

test('only the model confirmation callback can deliver guidance in model mode', async () => {
  const f = fixture({ modelId: 'observer-model' });
  await f.poll();
  await f.run.modelObserver.options.onGuidance({ action: 'remind', message: 'Confirmed deviation with evidence.', step: 12,
    evidence: [{ actionIndex: 12, fact: 'The failing result disproved this assumption.' }] });
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].runId, 'observer-policy-run');
  assert.equal(f.deliveries[0].request.requestFinish, false);
  assert.match(f.deliveries[0].request.guidance, /Confirmed deviation with evidence/);
  assert.match(f.deliveries[0].request.guidance, /行动 12：The failing result disproved this assumption/);
  assert.equal(f.decisions.length, 1);
  assert.equal(f.decisions[0].rules[0], 'model_observer');
});

test('an unavailable model keeps rule telemetry without falling back to unsolicited rule guidance', async () => {
  const f = fixture({ modelId: 'disabled-observer', unavailable: true });
  await f.poll(); await f.poll();
  assert.equal(f.run.observerUnavailable, true);
  assert.equal(f.modelStates.length, 1);
  assert.equal(f.modelStates[0].phase, 'error');
  assert.equal(f.observations.length, 2);
  assert.deepEqual(f.deliveries, []);
  assert.deepEqual(f.decisions, []);
});

test('a failed model review cannot enable direct rule delivery on later polls', async () => {
  const f = fixture({ modelId: 'observer-model' });
  await f.poll();
  f.run.modelObserver.options.onState({ phase: 'error', error: 'Observer unavailable' });
  await f.poll();
  assert.equal(f.modelStates.at(-1).phase, 'error');
  assert.equal(f.run.modelObserver.reviews.length, 2);
  assert.deepEqual(f.deliveries, []);
});

test('explicit rules-only observation still delivers its deterministic rule guidance', async () => {
  const f = fixture(null);
  await f.poll();
  assert.equal(f.run.modelObserver, undefined);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].request.guidance, f.verdict.message);
  assert.equal(f.decisions.length, 1);
  assert.equal(f.events.length, 1);
});
