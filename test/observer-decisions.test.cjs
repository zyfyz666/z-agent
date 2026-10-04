'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelObserver } = require('../lib/observer-model');
const { WDMonitorState } = require('../lib/wd-monitor-state');
const { recordReconcileEvent, watchdogReplay } = require('../lib/wd-replay-state');
const renderer = require('../renderer/wd-monitor');

const connection = { name: 'Test observer', modelId: 'test-observer', providerId: 'test' };
const actions = length => Array.from({ length }, (_, index) => ({ op: 'read', target: `file-${index}` }));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  let now = 1000;
  const monitor = new WDMonitorState({ now: () => now });
  const emitted = [];
  const delivered = [];
  const observer = new ModelObserver({ connection, judgeEvery: 1, now: () => now,
    review: async (_connection, input) => ({ action: 'observe', message: `步骤 ${input.totalActions} 正常推进。` }),
    onState: state => {
      monitor.modelStatus(state);
      emitted.push({ type: 'yan.thrash.watchdog.status', data: monitor.snapshot() });
    },
    onGuidance: result => {
      delivered.push(result);
      const id = monitor.decision({ ...result, rules: ['model_observer'], advisories: [] });
      monitor.delivery(id, { ok: true, delivered: true });
    }, ...options });
  return { monitor, observer, emitted, delivered, setNow(value) { now = value; } };
}

test('each completed observe judgment records its real time, step and conclusion without notifying the main agent', async () => {
  const f = fixture();
  f.observer.observe(actions(1)); await f.observer.pending;
  f.setNow(2000);
  f.observer.observe(actions(2)); await f.observer.pending;
  const value = f.monitor.snapshot();
  assert.equal(value.model.checks, 2);
  assert.equal(value.observations, 2);
  assert.equal(value.interventions, 0);
  assert.deepEqual(f.delivered, []);
  assert.deepEqual(value.events.map(event => [event.ts, event.step, event.action, event.message, event.delivery]), [
    [1000, 1, 'observe', '步骤 1 正常推进。', 'not-needed'],
    [2000, 2, 'observe', '步骤 2 正常推进。', 'not-needed']
  ]);
  assert.notEqual(value.events[0].id, value.events[1].id);
  f.observer.stop();
});

test('observations and grounded reminders have separate counts and no duplicated judgment entries', async () => {
  const f = fixture({ review: async (_connection, input) => input.totalActions === 1
    ? { action: 'remind', message: 'The current action contradicts the requested target.',
      evidence: [{ actionIndex: 1, fact: 'The first action reads a file excluded by the task.' }] }
    : { action: 'observe', message: 'The task is progressing within scope.' } });
  f.observer.observe(actions(1)); await f.observer.pending;
  f.observer.observe(actions(2)); await f.observer.pending;
  const value = f.monitor.snapshot();
  assert.equal(value.interventions, 1);
  assert.equal(value.observations, 1);
  assert.equal(value.events.length, 2);
  assert.equal(f.delivered.length, 1);
  assert.deepEqual(value.events.map(event => [event.action, event.delivery]), [['remind', 'delivered'], ['observe', 'not-needed']]);
  assert.equal(f.monitor.delivery(value.events[1].id, { ok: true, delivered: true }), false);
  assert.equal(f.monitor.snapshot().events[1].delivery, 'not-needed');
  f.observer.stop();
});

test('reviewing, repeated status and stopping do not duplicate the previous observation', async () => {
  let finish;
  const f = fixture();
  f.observer.observe(actions(1)); await f.observer.pending;
  f.observer.emit(); f.observer.emit();
  f.observer.review = () => new Promise(resolve => { finish = resolve; });
  f.observer.observe(actions(2)); await tick();
  assert.equal(f.monitor.snapshot().model.phase, 'reviewing');
  assert.equal(f.monitor.snapshot().events.length, 1);
  finish({ action: 'observe', message: 'New judgment.' }); await f.observer.pending;
  f.observer.stop(); f.observer.emit();
  assert.equal(f.monitor.snapshot().events.length, 2);
  assert.equal(f.monitor.snapshot().observations, 2);
});

test('errors and cancelled or late responses never invent a no-intervention judgment', async () => {
  const failed = fixture({ review: async () => { throw new Error('Unavailable'); } });
  failed.observer.observe(actions(1)); await failed.observer.pending;
  assert.equal(failed.monitor.snapshot().model.phase, 'error');
  assert.equal(failed.monitor.snapshot().observations, 0);
  assert.deepEqual(failed.monitor.snapshot().events, []);
  failed.observer.stop();
  let finish;
  const stopped = fixture({ review: () => new Promise(resolve => { finish = resolve; }) });
  stopped.observer.observe(actions(1)); await tick();
  const pending = stopped.observer.pending;
  stopped.observer.stop();
  finish({ action: 'observe', message: 'Arrived after stop.' }); await pending;
  assert.deepEqual(stopped.monitor.snapshot().events, []);
  assert.equal(stopped.monitor.snapshot().observations, 0);
});

test('ungrounded reminders become explicit no-intervention history rather than guidance', async () => {
  const f = fixture({ review: async () => ({ action: 'remind', message: 'Try something different.' }) });
  f.observer.observe(actions(1)); await f.observer.pending;
  const value = f.monitor.snapshot();
  assert.equal(value.events[0].action, 'observe');
  assert.match(value.events[0].message, /尚无足够可核验/);
  assert.equal(value.interventions, 0);
  assert.deepEqual(f.delivered, []);
  f.observer.stop();
});

test('no-intervention decisions survive live replay, saving, task switching and history selection', async () => {
  const f = fixture();
  f.observer.observe(actions(1)); await f.observer.pending;
  const entry = { events: [], watchdogStatus: null, completed: null };
  f.emitted.forEach(event => recordReconcileEvent(entry, { ...event, data: { ...event.data, runID: 'run-a' } }, { runId: 'run-a' }));
  for (let index = 0; index < 600; index++) recordReconcileEvent(entry, { type: 'message.part.delta', data: { delta: 'x' } }, { runId: 'run-a' });
  const restored = watchdogReplay(entry, { runId: 'run-a' }).events.reduce(renderer.reduce, null);
  assert.equal(restored.events.length, 1);
  assert.equal(restored.events[0].delivery, 'not-needed');
  const saved = JSON.parse(JSON.stringify({ id: 'task-a', messages: [
    { role: 'user', content: 'Original task' },
    { role: 'assistant', agentRun: { runId: 'run-a', status: 'done', watchdog: renderer.finish(restored, 'done') } }
  ] }));
  const selected = renderer.selectSession(saved, { sessionId: 'other-task', activeAgentRun: { watchdog: {} } }, 'run:run-a');
  const view = renderer.viewModel(selected);
  assert.equal(selected.mode, 'history');
  assert.equal(selected.key, 'run:run-a');
  assert.equal(view.events[0].actionLabel, '判断为不介入');
  assert.equal(view.events[0].ts, 1000);
  assert.equal(view.events[0].deliveryLabel, '未向主 Agent 发送提示');
  assert.equal(view.stats[2].value, 0);
  f.observer.stop();
});

test('later rule checks do not replace the latest actual model conclusion with a generic empty reminder', async () => {
  const f = fixture();
  f.observer.observe(actions(1)); await f.observer.pending;
  f.monitor.observe({ checks: 5, observedSteps: 5, judgedSteps: 5 });
  const view = renderer.viewModel({ mode: 'live', snapshot: f.monitor.snapshot() });
  assert.equal(view.latestTitle, '判断为不介入 · 第 1 个动作');
  assert.equal(view.latestDescription, '步骤 1 正常推进。');
  f.observer.stop();
});

test('bounded observation history keeps cumulative counts and never fabricates records from old summaries', () => {
  const monitor = new WDMonitorState({ now: () => 5000 });
  for (let check = 1; check <= 35; check++) monitor.modelStatus({ ...connection, phase: 'observing', checks: check,
    message: 'Continuing.', lastDecision: { check, ts: check * 100, step: check, action: 'observe', message: `Decision ${check}` } });
  const value = monitor.snapshot();
  assert.equal(value.events.length, 30);
  assert.equal(value.events[0].message, 'Decision 6');
  assert.equal(value.observations, 35);
  assert.equal(value.interventions, 0);
  const legacy = new WDMonitorState();
  legacy.modelStatus({ ...connection, phase: 'observing', checks: 2, message: 'A legacy summary with no timestamp or decision.' });
  assert.deepEqual(legacy.snapshot().events, []);
});

test('the rendered history visibly labels and timestamps an observation without a misleading delivery state', async () => {
  const f = fixture();
  f.observer.observe(actions(1)); await f.observer.pending;
  const nodes = [];
  const document = { createElement(tag) {
    const node = { tag, className: '', textContent: '', dataset: {}, children: [], ownerDocument: document,
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute() {}, set innerHTML(_) { throw new Error('Unexpected HTML parsing'); } };
    nodes.push(node); return node;
  } };
  renderer.render(document.createElement('section'), { mode: 'live', snapshot: f.monitor.snapshot() });
  assert.ok(nodes.some(node => node.className === 'wd-event-action' && node.textContent.startsWith('判断为不介入')));
  assert.ok(nodes.some(node => node.tag === 'time' && node.dateTime === new Date(1000).toISOString()));
  assert.ok(nodes.some(node => node.className === 'wd-delivery' && node.textContent === '未向主 Agent 发送提示'));
  assert.ok(!nodes.some(node => /送达状态未记录|提醒已送达/.test(node.textContent)));
  assert.ok(nodes.some(node => node.textContent === '观察时间线'));
  f.observer.stop();
});
