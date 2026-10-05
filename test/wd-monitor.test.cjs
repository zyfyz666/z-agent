'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../renderer/wd-monitor');

const trigger = overrides => ({
  id: 'run-a:6', ts: 1000, step: 6, action: 'remind', rules: ['R1_loop'],
  advisories: [], severity: 1, message: 'Change approach.', delivery: 'queued', ...overrides
});
const snapshot = overrides => ({
  enabled: true, phase: 'observing', judgeEvery: 6, observedSteps: 6,
  judgedSteps: 6, checks: 1, interventions: 1, streak: 1, updatedAt: 1000,
  events: [trigger()], ...overrides
});
const statusEvent = data => ({ type: 'z.thrash.watchdog.status', data });

test('authoritative snapshots replace replayed events and keep delivery updates', () => {
  const initial = monitor.reduce(null, statusEvent(snapshot()));
  const replay = monitor.reduce(initial, statusEvent(snapshot()));
  assert.equal(replay.events.length, 1);
  assert.equal(replay.interventions, 1);
  const delivered = monitor.reduce(replay, statusEvent(snapshot({ updatedAt: 1001, events: [trigger({ delivery: 'delivered' })] })));
  assert.equal(delivered.events.length, 1);
  assert.equal(delivered.events[0].delivery, 'delivered');
  const legacyReplay = monitor.reduce(delivered, { type: 'z.thrash.watchdog', data: trigger({ ts: undefined, delivery: 'pending' }) });
  assert.equal(legacyReplay.events[0].delivery, 'delivered');
  assert.equal(legacyReplay.events[0].ts, 1000);
  assert.equal(initial.events[0].delivery, 'queued');
  assert.equal(monitor.reduce(delivered, statusEvent(snapshot())), delivered);
});

test('legacy events remain useful without inventing missing counters or delivery', () => {
  const event = { type: 'z.thrash.watchdog', data: { action: 'remind', rules: ['R1_loop'], advisories: [], streak: 1 } };
  const first = monitor.reduce(null, event);
  const replay = monitor.reduce(first, event);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].delivery, 'unknown');
  assert.equal(replay.events[0].ts, null);
  assert.equal(replay.checks, null);
  assert.equal(replay.observedSteps, null);
  assert.equal(replay.interventions, null);
  assert.deepEqual(monitor.viewModel({ mode: 'live', snapshot: replay }).stats.map(item => item.value), [null, null, null]);
  const full = monitor.reduce(replay, statusEvent(snapshot()));
  assert.equal(full.events.length, 1);
  assert.equal(full.checks, 1);
});

test('a new current run does not show the preceding run or another task', () => {
  const session = { id: 'task-a', messages: [{ role: 'assistant', agentRun: { status: 'done', watchdog: snapshot() } }] };
  const live = { sessionId: 'task-a', activeAgentRun: { watchdog: null } };
  const newRun = monitor.selectSession(session, live);
  assert.equal(newRun.mode, 'live');
  assert.equal(newRun.snapshot, null);
  assert.equal(monitor.viewModel(newRun).title, '等待观察者状态');
  const otherTask = { sessionId: 'task-b', activeAgentRun: { watchdog: snapshot({ interventions: 9 }) } };
  assert.equal(monitor.selectSession(session, otherTask).snapshot.interventions, 1);
  assert.equal(monitor.selectSession({ id: 'task-c', messages: [] }, otherTask).mode, 'empty');
});

test('history follows the latest run, including old runs with no WD data', () => {
  const session = { id: 'task-a', messages: [
    { role: 'assistant', agentRun: { watchdog: snapshot() } },
    { role: 'assistant', agentRun: { status: 'done' } }
  ] };
  const selection = monitor.selectSession(session);
  assert.equal(selection.mode, 'history');
  assert.equal(selection.snapshot, null);
  assert.equal(monitor.viewModel(selection).title, '此轮没有监控记录');
});

test('completion and interruption retain counts while changing presentation', () => {
  const saved = monitor.finish(snapshot(), 'done');
  assert.equal(saved.phase, 'completed');
  assert.equal(saved.interventions, 1);
  const session = { id: 'task-a' };
  const selection = monitor.selectSession(session, { sessionId: 'task-a', shouldAbort: true, activeAgentRun: { watchdog: saved } });
  assert.equal(selection.mode, 'history');
  assert.equal(monitor.viewModel(selection).title, '观察已停止');
  assert.equal(monitor.finish(snapshot({ enabled: false, phase: 'disabled' }), 'done').phase, 'disabled');
  assert.equal(monitor.finish(snapshot(), 'error').phase, 'error');
  assert.equal(monitor.finish(null, 'done'), null);
});

test('the final backend outcome distinguishes an interrupted observation from completion', () => {
  const stopped = snapshot({ phase: 'completed', outcome: 'interrupted' });
  assert.equal(monitor.finish(stopped, 'done').outcome, 'interrupted');
  assert.equal(monitor.viewModel({ mode: 'history', status: 'done', snapshot: stopped }).title, '观察已停止');
  const selected = monitor.selectSession({ id: 'a' }, { sessionId: 'a', activeAgentRun: { watchdog: stopped } });
  assert.equal(selected.mode, 'history');
  assert.equal(selected.status, 'interrupted');
});

test('a WD observation error survives successful task finalization and historical replay', () => {
  const failedMonitor = snapshot({ phase: 'error', outcome: 'completed' });
  const finalized = monitor.finish(failedMonitor, 'done');
  assert.equal(finalized.phase, 'error');
  assert.equal(finalized.outcome, 'completed');
  const history = monitor.viewModel({ mode: 'history', status: 'done', snapshot: finalized });
  assert.equal(history.phase, 'error');
  assert.equal(history.title, '观察者运行异常');
  assert.doesNotMatch(history.description, /任务.*(?:停止|失败)/);
  const live = monitor.viewModel({ mode: 'live', status: 'working', snapshot: snapshot({ phase: 'error' }) });
  assert.equal(live.title, '观察者运行异常');
  const failedTask = monitor.viewModel({ mode: 'history', status: 'error', snapshot: monitor.finish(snapshot(), 'error') });
  assert.equal(failedTask.title, '任务运行出现异常');
});

test('advisory actions use their own Chinese label in the judgment and timeline', () => {
  const view = monitor.viewModel({ mode: 'live', snapshot: snapshot({ events: [trigger({
    action: 'advise', rules: [], advisories: ['R5_stale_verification']
  })] }) });
  assert.equal(view.latestTitle, '建议 · 第 6 个动作');
  assert.equal(view.events[0].actionLabel, '建议');
  assert.deepEqual(view.events[0].ruleLabels, ['验证结果需要更新']);
});

test('the latest clean check does not present an earlier intervention as the current judgment', () => {
  const view = monitor.viewModel({ mode: 'live', snapshot: snapshot({ observedSteps: 13, judgedSteps: 12, checks: 2 }) });
  assert.equal(view.latestTitle, '最近检查没有触发新提醒');
  assert.equal(view.events.length, 1);
  assert.match(view.latestDescription, /12/);
  assert.equal(view.events[0].actionLabel, '提醒');
  assert.deepEqual(view.events[0].ruleLabels, ['重复操作']);
});

test('queued, delivered and failed are visibly distinct rather than implying model receipt', () => {
  assert.equal(monitor.deliveryLabel('queued'), '提醒已排队 · 等待模型接收');
  assert.equal(monitor.deliveryLabel('delivered'), '提醒已送达模型');
  assert.equal(monitor.deliveryLabel('failed'), '提醒发送失败');
  assert.equal(monitor.deliveryLabel(undefined), '送达状态未记录');
});

test('snapshot bounds are enforced and malformed counts stay unknown', () => {
  const events = Array.from({ length: 45 }, (_, index) => trigger({ id: `event-${index}`, step: index }));
  const value = monitor.normalizeSnapshot(snapshot({ checks: NaN, observedSteps: -2, events }));
  assert.equal(value.events.length, 30);
  assert.equal(value.events[0].id, 'event-15');
  assert.equal(value.checks, null);
  assert.equal(value.observedSteps, null);
  assert.equal(monitor.normalizeSnapshot(snapshot({ checks: 0 })).checks, 0);
});

test('observer eye expression follows the selected run', () => {
  const eye = selection => monitor.eyeState(monitor.viewModel(selection), selection);
  assert.equal(eye({ mode: 'empty' }), 'resting');
  assert.equal(eye({ mode: 'live', status: 'working', snapshot: snapshot() }), 'watching');
  assert.equal(eye({ mode: 'live', status: 'working', snapshot: snapshot({ model: { phase: 'reviewing' } }) }), 'pondering');
  assert.equal(eye({ mode: 'live', status: 'working', snapshot: snapshot({ phase: 'error' }) }), 'alarmed');
  assert.equal(eye({ mode: 'live', status: 'working', snapshot: snapshot({ enabled: false, phase: 'disabled' }) }), 'closed');
  assert.equal(eye({ mode: 'history', status: 'done', snapshot: snapshot() }), 'closed');
  assert.equal(eye({ mode: 'history', status: 'error', snapshot: snapshot() }), 'closed');
});

test('runtime text is rendered as text nodes, never parsed as markup', () => {
  const elements = [];
  const document = { createElement(tag) {
    const element = {
      tag, className: '', textContent: '', dataset: {}, children: [], attributes: {},
      ownerDocument: document,
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(name, value) { this.attributes[name] = value; },
      set innerHTML(_) { throw new Error('HTML parsing is forbidden for monitor data'); }
    };
    elements.push(element);
    return element;
  } };
  const host = document.createElement('section');
  const payload = '<img src=x onerror=alert(1)>';
  monitor.render(host, { mode: 'live', snapshot: snapshot({ events: [trigger({ message: payload, delivery: 'failed', deliveryError: payload })] }) });
  assert.ok(elements.filter(element => element.textContent === payload).length >= 2);
  assert.equal(elements.filter(element => element.tag === 'img').length, 0);
  assert.equal(host.dataset.wdState, 'observing');
});
