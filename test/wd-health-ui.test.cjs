'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const monitor = require('../renderer/wd-monitor');
const start = 1_700_000_000_000;
const health = overrides => ({ state: 'overdue', checkedAt: start + 8 * 3_600_000, lastProgressAt: start,
  message: '工具尚未返回，需要核实。', waitingQuestions: 0, waitingPermissions: 0,
  tool: { callId: 'shell-1', name: 'run_command', startedAt: start, timeoutMs: 10_000,
    deadlineAt: start + 10_000, lastProgressAt: start, status: 'running' }, ...overrides });
const snapshot = overrides => ({ enabled: true, phase: 'observing', observedSteps: 8, checks: 2, interventions: 0,
  events: [], health: health(), healthEvents: [{ id: 'check-1', ts: start + 8 * 3_600_000, ...health() }],
  updatedAt: start + 8 * 3_600_000, ...overrides });
const statusEvent = data => ({ type: 'z.thrash.watchdog.status', data });

test('an overdue declared tool wait is separate from judgments, interventions and delivered guidance', () => {
  const view = monitor.viewModel({ mode: 'live', snapshot: snapshot() });
  assert.equal(view.health.title, '工具等待超出声明时限');
  assert.equal(view.health.caution, true);
  assert.deepEqual(view.stats.map(item => item.value), [2, 8, 0]);
  assert.equal(view.events.length, 0);
  assert.equal(view.health.events.length, 1);
  assert.equal(view.health.facts.find(item => item.label === '声明时限').value, '10 秒');
  assert.equal(view.health.facts.find(item => item.label === '至最近巡检已等待').value, '8 小时');
  assert.equal(view.health.facts.find(item => item.label === '最近实际进展').value, new Date(start).toLocaleString('sv-SE'));
  assert.doesNotMatch(view.emptyDescription, /正常执行/);
  assert.equal(view.health.events[0].delivery, undefined);
});

test('waiting for a user is distinct from a running tool even if its deadline passed', () => {
  const view = state => monitor.viewModel({ mode: 'live', snapshot: snapshot({ health: health(state) }) }).health;
  assert.equal(view({ state: 'working' }).title, '等待工具返回');
  assert.equal(view({ state: 'waiting_user', waitingPermissions: 1 }).title, '等待用户授权');
  assert.equal(view({ state: 'waiting_user', waitingQuestions: 1 }).title, '等待用户回复');
  assert.equal(view({ state: 'waiting_user', waitingQuestions: 1 }).caution, false);
  assert.equal(view({ state: 'silent', tool: null }).title, '等待模型进展');
  assert.equal(view({ state: 'completed', tool: null }).title, '本轮已结束');
});

test('unknown deadlines and missing telemetry never invent an overdue or healthy state', () => {
  const unknown = monitor.viewModel({ mode: 'live', snapshot: snapshot({ health: health({ state: 'unknown',
    lastProgressAt: null, tool: { name: 'run_command', startedAt: null, timeoutMs: null } }) }) }).health;
  assert.equal(unknown.title, '运行状态待确认');
  assert.equal(unknown.facts.find(item => item.label === '声明时限').value, '未声明');
  assert.equal(unknown.facts.find(item => item.label === '最近实际进展').value, '未记录');
  assert.equal(unknown.facts.some(item => item.label === '至最近巡检已等待'), false);
  assert.equal(monitor.viewModel({ mode: 'history', snapshot: { checks: 2 } }).health.title, '此轮没有运行巡检记录');
  assert.equal(monitor.viewModel({ mode: 'live' }).health.title, '等待运行巡检');
});

test('a pending tool with the backend zero start sentinel never shows waiting since 1970', () => {
  const { WDMonitorState } = require('../lib/wd-monitor-state');
  const backend = new WDMonitorState();
  backend.healthStatus(health({ state: 'waiting_user', lastProgressAt: 0, waitingPermissions: 1,
    tool: { callId: 'pending', name: 'bash', startedAt: 0, timeoutMs: 10_000, deadlineAt: 0, status: 'pending' } }));
  const view = monitor.viewModel({ mode: 'live', snapshot: backend.snapshot() }).health;
  assert.equal(view.title, '等待用户授权');
  assert.equal(view.facts.some(item => item.label === '至最近巡检已等待'), false);
  assert.equal(view.facts.find(item => item.label === '最近实际进展').value, '未记录');
  assert.doesNotMatch(JSON.stringify(view), /1970/);
});

test('health snapshots survive stale replay, terminal persistence and switching without leaking across runs', () => {
  const current = monitor.reduce(null, statusEvent(snapshot()));
  assert.equal(monitor.reduce(current, statusEvent(snapshot({ updatedAt: start }))), current);
  const stored = JSON.parse(JSON.stringify(monitor.finish(current, 'interrupted')));
  const session = { id: 'task-a', messages: [{ role: 'assistant', agentRun: { runId: 'old', watchdog: stored } }] };
  const live = { sessionId: session.id, runId: 'new', activeAgentRun: { watchdog: null } };
  assert.equal(monitor.selectSession(session, live).snapshot, null);
  const old = monitor.selectSession(session, live, 'run:old');
  assert.equal(old.snapshot.health.state, 'overdue');
  assert.equal(old.snapshot.healthEvents.length, 1);
  assert.equal(monitor.selectSession({ id: 'task-b', messages: [] }, live).snapshot, null);
  assert.equal(monitor.selectSession(JSON.parse(JSON.stringify(session))).snapshot.health.tool.timeoutMs, 10_000);
});

test('production event routing rejects a late old run and a mismatched kernel session', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const start = source.indexOf('function applyOpenCodeEvent(');
  const end = source.indexOf('  const part = data.part;', start);
  const context = vm.createContext({ window: { ZWdMonitor: monitor }, state: { currentSession: { id: 'task-a' } },
    renderWdMonitor() {}, updateSubagentWorkflow() { return false; } });
  vm.runInContext(source.slice(start, end) + '\n}', context);
  const run = { sessionId: 'task-a', runId: 'new', openCodeSessionId: 'kernel-new', activeAgentRun: { watchdog: null } };
  context.applyOpenCodeEvent(run, statusEvent({ ...snapshot(), runID: 'old' }));
  context.applyOpenCodeEvent(run, statusEvent({ ...snapshot(), runID: 'new', sessionID: 'kernel-old' }));
  assert.equal(run.activeAgentRun.watchdog, null);
  context.applyOpenCodeEvent(run, statusEvent({ ...snapshot(), runID: 'new', sessionID: 'kernel-new' }));
  assert.equal(run.activeAgentRun.watchdog.health.state, 'overdue');
});

test('health history is bounded, deduplicated, rendered as text, and has no stop or guidance action', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const events = Array.from({ length: 40 }, (_, index) => ({ id: `health-${index}`, ts: start + index,
    state: 'unknown', message: payload, tool: { name: payload, input: 'sensitive tool input' } }));
  const normalized = monitor.normalizeSnapshot(snapshot({ healthEvents: [...events, events.at(-1)] }));
  assert.equal(normalized.healthEvents.length, 30);
  assert.equal(normalized.healthEvents[0].id, 'health-10');
  assert.equal(normalized.healthEvents[0].tool.input, undefined);
  const elements = [];
  const document = { createElement(tag) {
    const element = { tag, className: '', textContent: '', dataset: {}, children: [], ownerDocument: document,
      append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
      setAttribute() {}, set innerHTML(_) { throw new Error('health data must use text nodes'); } };
    elements.push(element); return element;
  } };
  monitor.render(document.createElement('section'), { mode: 'live', snapshot: normalized });
  assert.equal(elements.filter(item => item.className === 'wd-health-event').length, 30);
  assert.ok(elements.some(item => item.textContent === payload));
  assert.equal(elements.filter(item => item.tag === 'img').length, 0);
  const card = elements.find(item => item.className === 'wd-health');
  const walk = node => [node, ...node.children.flatMap(walk)];
  assert.equal(walk(card).filter(item => item.tag === 'button').length, 0);
  assert.equal(walk(card).filter(item => item.className === 'wd-delivery').length, 0);
});

test('runtime labels and wait durations support English without rewriting stored events', () => {
  const context = vm.createContext({ window: {}, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/i18n.js'), 'utf8'), context);
  for (const value of ['运行巡检', '巡检记录（30）', '8 小时', '10 秒', '等待用户回复', '声明时限',
    '此轮没有运行巡检记录', '工具等待超出声明时限', '最近实际进展', '至最近巡检已等待']) {
    assert.doesNotMatch(context.window.ZI18n.translate(value, 'en'), /[\u3400-\u9fff]/u);
  }
});
