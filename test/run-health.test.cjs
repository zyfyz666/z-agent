'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunHealthMonitor, promptReplaySafe, declaredToolTimeout, readWithDeadline } = require('../lib/run-health');
const { WDMonitorState } = require('../lib/wd-monitor-state');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tool = (overrides = {}) => ({ id: 'part', type: 'tool', tool: 'bash', callID: 'call',
  state: { status: 'running', time: { start: 1000 }, input: { timeout: 10_000 }, metadata: { output: 'PID: 29812' } }, ...overrides });
const message = (part, id = 'new') => ({ info: { id, role: 'assistant', sessionID: 'session' }, parts: [part] });
const event = (type, data = {}) => ({ type, data: { sessionID: 'session', ...data } });
function health(options = {}) {
  const monitor = new RunHealthMonitor({ startedAt: 1000, intervalMs: 20_000, ...options });
  monitor.setSession('session', new Set(['old']));
  monitor.beginRequest(1000);
  return monitor;
}

test('explicit timeout needs two separated unchanged observations and never retries the tool', () => {
  const monitor = health();
  monitor.observeMessages([message(tool())], 1000);
  assert.equal(monitor.snapshot(15_999).state, 'working');
  assert.equal(monitor.snapshot(40_000).state, 'unknown', 'cached time alone cannot confirm native state');
  monitor.observeMessages([message(tool())], 40_000);
  monitor.observeMessages([message(tool())], 40_100);
  assert.equal(monitor.snapshot(40_100).state, 'unknown', 'fast UI polls are not independent confirmations');
  monitor.observeMessages([message(tool())], 60_000);
  const snapshot = monitor.snapshot(60_000);
  assert.equal(snapshot.state, 'overdue');
  assert.equal(snapshot.tool.callId, 'call');
  assert.equal(snapshot.tool.timeoutMs, 10_000);
  assert.equal(snapshot.tool.deadlineAt, 11_000);
  assert.equal(snapshot.lastProgressAt, 1000, 'unchanged output is not progress');
  assert.match(snapshot.message, /未自动重放或终止/);
});

test('heartbeats, other sessions, old history and user messages cannot mask a stall', () => {
  const monitor = health({ silentAfterMs: 100 });
  monitor.observeMessages([message({ type: 'text', text: 'old content' }, 'old')], 2000);
  monitor.observeEvent(event('server.heartbeat'), 2100);
  monitor.observeEvent({ type: 'file.edited', data: { file: 'unrelated' } }, 2200);
  monitor.observeEvent(event('session.next.text.delta', { sessionID: 'other', delta: 'other work' }), 2300);
  monitor.observeEvent(event('message.updated', { info: { id: 'user', role: 'user', sessionID: 'session' } }), 2400);
  monitor.observeEvent(event('message.part.updated', { part: { id: 'user-part', messageID: 'user', type: 'text', text: 'a steer' } }), 2500);
  assert.equal(monitor.snapshot(3000).lastProgressAt, 1000);
  assert.equal(monitor.snapshot(3000).state, 'silent');
  monitor.observeEvent(event('message.updated', { info: { id: 'answer', role: 'assistant', sessionID: 'session' } }), 3050);
  monitor.observeEvent(event('message.part.delta', { messageID: 'answer', field: 'reasoning', delta: 'real work' }), 3100);
  assert.equal(monitor.snapshot(3150).state, 'working');
  monitor.endRequest();
  assert.equal(monitor.snapshot(10_000).state, 'working', 'finalization is not model silence');
});

test('permission and question waits suspend stall judgments and pending tools do not start execution deadlines', () => {
  const monitor = health();
  const pending = tool({ state: { status: 'pending', input: { timeout: 10_000 } } });
  monitor.observeMessages([message(pending)], 1000);
  monitor.observeEvent(event('permission.asked', { id: 'permission', tool: { callID: 'call' } }), 2000);
  monitor.observeEvent(event('question.asked', { id: 'question', tool: { callID: 'call' } }), 3000);
  const waiting = monitor.snapshot(3600_000);
  assert.equal(waiting.state, 'waiting_user');
  assert.equal(waiting.waitingPermissions, 1);
  assert.equal(waiting.waitingQuestions, 1);
  assert.equal(waiting.tool.deadlineAt, 0);
  monitor.resolveWait('permission', 'permission', 3600_000);
  monitor.observeEvent(event('question.replied', { requestID: 'question' }), 3600_001);
  const running = tool({ state: { ...tool().state, time: { start: 3600_100 } } });
  monitor.observeMessages([message(running)], 3600_100);
  assert.equal(monitor.snapshot(3600_101).state, 'working');
  assert.equal(monitor.snapshot(3600_101).tool.deadlineAt, 3610_100);
});

test('unknown duration and progressing delegated work remain uncertainty, not confirmed failure', () => {
  const monitor = health({ unknownAfterMs: 100 });
  const task = tool({ tool: 'task', state: { status: 'running', input: {}, time: { start: 1000 } } });
  monitor.observeMessages([message(task)], 1000);
  assert.equal(monitor.snapshot(1200).state, 'unknown');
  monitor.observeChildProgress('call', event('message.part.delta', { field: 'text', delta: 'child progress' }), 1250);
  assert.equal(monitor.snapshot(1300).state, 'working');
  monitor.observeChildProgress('call', event('server.heartbeat'), 1400);
  assert.equal(monitor.snapshot(1401).state, 'unknown');
  assert.equal(declaredToolTimeout(tool({ tool: 'third_party', state: { input: { timeout: 30 } } })), 0);
});

test('terminal tools cannot be resurrected by late snapshots and output changes count as progress', () => {
  const monitor = health();
  monitor.observeMessages([message(tool())], 1000);
  monitor.observeMessages([message(tool({ state: { ...tool().state, metadata: { output: 'PID: 29812\nwork done' } } }))], 2000);
  assert.equal(monitor.snapshot(2100).lastProgressAt, 2000);
  monitor.observeMessages([message(tool({ state: { ...tool().state, status: 'completed', output: 'finished' } }))], 3000);
  monitor.observeMessages([message(tool())], 2000);
  monitor.observeMessages([message(tool())], 4000);
  assert.equal(monitor.snapshot(4000).tool, undefined);
});

test('large unchanged history cannot reset actual progress when finished tool details are retired', () => {
  const monitor = health({ silentAfterMs: 100 });
  const history = [
    ...Array.from({ length: 300 }, (_, index) => message(tool({ id: `t${index}`, callID: `call${index}`,
      state: { status: 'completed', output: 'unchanged' } }), `tool-message${index}`)),
    ...Array.from({ length: 600 }, (_, index) => message({ id: `text${index}`, type: 'text', text: 'unchanged' }, `text-message${index}`))
  ];
  monitor.observeMessages(history, 1100);
  assert.equal(monitor.tools.size, 256);
  monitor.observeMessages(history, 10_000);
  assert.equal(monitor.snapshot(10_000).lastProgressAt, 1100);
  assert.equal(monitor.snapshot(10_000).state, 'silent');
  assert.ok([...monitor.parts.values()].every(part => part.value.length < 100), 'text records retain only compact fingerprints');
});

test('a running tool deadline excludes matching approval waits and does not invent output on resume', () => {
  const monitor = health();
  monitor.observeMessages([message(tool())], 1000);
  monitor.observeEvent(event('permission.asked', { id: 'p', tool: { callID: 'call' } }), 2000);
  monitor.observeEvent(event('question.asked', { id: 'q', tool: { callID: 'call' } }), 3000);
  monitor.observeMessages([message(tool())], 80_000);
  assert.equal(monitor.snapshot(90_000).state, 'waiting_user');
  monitor.resolveWait('permission', 'p', 100_000);
  assert.equal(monitor.snapshot(100_000).state, 'waiting_user');
  monitor.resolveWait('question', 'q', 100_001);
  const resumed = monitor.snapshot(100_001);
  assert.equal(resumed.state, 'working');
  assert.equal(resumed.tool.deadlineAt, 109_001);
  assert.equal(resumed.lastProgressAt, 1000);
  monitor.observeMessages([message(tool())], 100_002);
  assert.equal(monitor.snapshot(100_002).tool.deadlineAt, 109_001, 'native old start time cannot undo approval pause');
  monitor.observeMessages([message(tool())], 115_000);
  assert.equal(monitor.snapshot(115_000).state, 'unknown');
  monitor.observeMessages([message(tool())], 135_000);
  assert.equal(monitor.snapshot(135_000).state, 'overdue');
});

test('independent cadence emits while its own bounded read hangs; stopped and stale runs emit nothing', async () => {
  let now = 1000;
  let active = true;
  let reads = 0;
  let release;
  const states = [];
  const monitor = health({ now: () => ++now, intervalMs: 5, readTimeoutMs: 15, silentAfterMs: 1 });
  monitor.start({ isActive: () => active, onStatus: value => states.push(value), readMessages: () => {
    reads += 1;
    return new Promise(resolve => { release = resolve; });
  } });
  await pause(48);
  assert.ok(states.length >= 3, 'health timer is independent of an awaited read');
  assert.ok(reads >= 2, 'a timed-out health query cannot block future bounded reads');
  assert.ok(reads < states.length, 'reads are not overlapped on every timer');
  active = false;
  const count = states.length;
  release([message(tool())]);
  await pause(12);
  assert.equal(states.length, count);
  assert.equal(monitor.timer, null, 'inactive runs dispose even before their main wait settles');
  const stopped = monitor.stop('interrupted');
  assert.equal(stopped.state, 'completed');
  assert.match(stopped.message, /中断/);
  monitor.observeMessages([message(tool())]);
  monitor.observeEvent(event('session.next.text.delta', { delta: 'late' }));
  await pause(12);
  assert.equal(states.length, count);
  assert.equal(monitor.timer, null);
});

test('health snapshots and bounded history stay independent from model decisions and delivery', () => {
  const monitor = new WDMonitorState();
  for (let index = 0; index < 40; index++) monitor.healthStatus({
    state: index % 2 ? 'overdue' : 'working', checkedAt: index + 1000,
    lastProgressAt: 1000, message: 'runtime inspection', tool: { callId: 'call', name: 'bash', status: 'running' }
  });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.healthEvents.length, 30);
  assert.equal(snapshot.interventions, 0);
  assert.equal(snapshot.checks, 0);
  assert.equal(snapshot.observations, 0);
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.healthEvents.at(-1).delivery, undefined);
  monitor.healthStatus({ ...snapshot.health, checkedAt: 2000 });
  assert.equal(monitor.snapshot().healthEvents.length, 30, 'unchanged state does not add a history row');
  snapshot.health.tool.name = 'tampered';
  snapshot.healthEvents[0].tool.name = 'tampered';
  assert.equal(monitor.snapshot().health.tool.name, 'bash');
  assert.equal(monitor.snapshot().healthEvents[0].tool.name, 'bash');
  assert.equal(monitor.healthStatus({ state: 'silent', checkedAt: 1 }), false);
  monitor.healthStatus({ state: 'completed', checkedAt: 3000 });
  assert.equal(monitor.healthStatus({ state: 'overdue', checkedAt: 4000 }), false);
});

test('replay safety rejects pending, running, missing status and executed current responses, preserving earlier finished history', () => {
  const failed = { info: { id: 'failed', role: 'assistant', error: { message: 'timeout' } }, parts: [] };
  for (const status of ['pending', 'running', '', 'completed', 'error']) {
    const current = message(tool({ state: { status } }));
    assert.equal(promptReplaySafe([current]), false, `current tool ${status || 'unknown'} cannot replay without an assistant error`);
    if (!['completed', 'error'].includes(status)) assert.equal(promptReplaySafe([current, failed]), false);
  }
  const earlier = message(tool({ state: { status: 'completed' } }));
  assert.equal(promptReplaySafe([earlier, failed]), true);
  assert.equal(promptReplaySafe([message(tool())], new Set(['new'])), true);
  assert.equal(promptReplaySafe([{ info: { id: 'done', role: 'assistant', time: { completed: 1 } }, parts: [] }]), false);
});

test('bounded read aborts its request on expiry', async () => {
  let signal;
  await assert.rejects(readWithDeadline(value => { signal = value; return new Promise(() => {}); }, 5), /timed out/);
  assert.equal(signal.aborted, true);
});
