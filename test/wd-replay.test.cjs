'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WDMonitorState } = require('../lib/wd-monitor-state');
const { recordReconcileEvent, watchdogReplay } = require('../lib/wd-replay-state');
const renderer = require('../renderer/wd-monitor');

const freshEntry = () => ({ events: [], watchdogStatus: null, completed: null });
const noise = index => ({ type: 'message.part.delta', data: { field: 'text', delta: String(index) } });
function status(runId, overrides = {}) {
  const snapshot = new WDMonitorState({ now: () => 100 }).snapshot();
  return { type: 'yan.thrash.watchdog.status', data: {
    ...snapshot, runID: runId, sessionID: `session-${runId}`,
    phase: 'observing', observedSteps: 18, judgedSteps: 18, checks: 3, interventions: 1,
    events: [{ id: 'wd-1', ts: 90, step: 18, action: 'remind', rules: ['R1_loop'], advisories: [],
      severity: 1, message: 'Change strategy.', delivery: 'delivered' }],
    ...overrides
  } };
}
const renderReplay = replay => replay.events.reduce(renderer.reduce, null);

test('the latest complete WD snapshot survives more than 400 unrelated stream events', () => {
  const entry = freshEntry();
  recordReconcileEvent(entry, status('a'), { runId: 'a' });
  for (let i = 0; i < 1000; i++) recordReconcileEvent(entry, noise(i), { runId: 'a', cap: 400 });
  assert.equal(entry.events.length, 400);
  assert.ok(entry.events.every(event => event.type === 'message.part.delta'));
  const replay = watchdogReplay(entry, { runId: 'a' });
  assert.equal(replay.events[0].type, 'yan.thrash.watchdog.status');
  assert.deepEqual(replay.events.slice(1), Array.from({ length: 400 }, (_, i) => noise(i + 600)));
  const restored = renderReplay(replay);
  assert.equal(restored.checks, 3);
  assert.equal(restored.observedSteps, 18);
  assert.equal(restored.interventions, 1);
  assert.equal(restored.events[0].delivery, 'delivered');
});

test('older snapshots and legacy events cannot downgrade the authoritative replay prefix', () => {
  const entry = freshEntry();
  const pending = status('a', { events: [{ ...status('a').data.events[0], delivery: 'pending' }] });
  recordReconcileEvent(entry, pending, { runId: 'a' });
  recordReconcileEvent(entry, { type: 'yan.thrash.watchdog', data: pending.data.events[0] }, { runId: 'a' });
  recordReconcileEvent(entry, noise(1), { runId: 'a' });
  // Delivery confirmation intentionally has the same millisecond timestamp.
  recordReconcileEvent(entry, status('a'), { runId: 'a' });
  recordReconcileEvent(entry, status('a', { updatedAt: 50, checks: 1 }), { runId: 'a' });
  const replay = watchdogReplay(entry, { runId: 'a' });
  assert.deepEqual(replay.events.map(event => event.type), ['yan.thrash.watchdog.status', 'message.part.delta']);
  const restored = renderReplay(replay);
  assert.equal(restored.checks, 3);
  assert.equal(restored.events.length, 1);
  assert.equal(restored.events[0].delivery, 'delivered');
});

test('parallel runs retain independent snapshots even when event IDs match', () => {
  const entries = new Map([['a', freshEntry()], ['b', freshEntry()]]);
  for (const [runId, entry] of entries) {
    recordReconcileEvent(entry, status(runId, { checks: runId === 'a' ? 3 : 7 }), { runId });
    for (let i = 0; i < 500; i++) recordReconcileEvent(entry, noise(i), { runId });
  }
  assert.equal(renderReplay(watchdogReplay(entries.get('a'), { runId: 'a' })).checks, 3);
  assert.equal(renderReplay(watchdogReplay(entries.get('b'), { runId: 'b' })).checks, 7);
  recordReconcileEvent(entries.get('b'), status('a', { checks: 99 }), { runId: 'b' });
  assert.equal(renderReplay(watchdogReplay(entries.get('b'), { runId: 'b' })).checks, 7);
});

test('a new run cannot inherit the prior run snapshot or caller mutations', () => {
  const previous = freshEntry();
  const original = status('old');
  recordReconcileEvent(previous, original, { runId: 'old' });
  original.data.events[0].delivery = 'failed';
  assert.equal(renderReplay(watchdogReplay(previous, { runId: 'old' })).events[0].delivery, 'delivered');
  const next = freshEntry();
  recordReconcileEvent(next, noise(1), { runId: 'new' });
  assert.equal(renderReplay(watchdogReplay(next, { runId: 'new' })), null);
  assert.deepEqual(watchdogReplay(next, { runId: 'new' }).events, [noise(1)]);
});

test('a final result supplies a full replay snapshot when no live snapshot was retained', () => {
  const entry = freshEntry();
  entry.completed = { status: 'done', openCodeSessionId: 'session-a',
    watchdog: { ...status('a').data, phase: 'completed', outcome: 'completed' } };
  const replay = watchdogReplay(entry, { runId: 'a' });
  assert.equal(replay.events.length, 1);
  assert.equal(renderReplay(replay).phase, 'completed');
  assert.equal(replay.completed.watchdog.checks, 3);
  assert.equal(replay.completed.watchdog.runID, undefined);
});

test('late delivery acknowledgement updates completed replay without reopening its ring', () => {
  const entry = freshEntry();
  const pending = status('a', { phase: 'completed', outcome: 'interrupted',
    events: [{ ...status('a').data.events[0], delivery: 'pending' }] });
  recordReconcileEvent(entry, pending, { runId: 'a' });
  entry.completed = { status: 'interrupted', watchdog: pending.data };
  recordReconcileEvent(entry, status('a', { phase: 'completed', outcome: 'interrupted' }), { runId: 'a' });
  assert.equal(entry.events.length, 1);
  const replay = watchdogReplay(entry, { runId: 'a' });
  assert.equal(replay.completed.status, 'interrupted');
  assert.equal(replay.completed.watchdog.events[0].delivery, 'delivered');
  assert.equal(renderReplay(replay).events[0].delivery, 'delivered');
  assert.equal(entry.completed.watchdog.events[0].delivery, 'pending', 'the original completed result remains a point-in-time record');
});

test('legacy-only records remain replayable and do not invent full monitoring counters', () => {
  const entry = freshEntry();
  const legacy = { type: 'yan.thrash.watchdog', data: { action: 'remind', rules: ['R1_loop'], advisories: [], streak: 1 } };
  recordReconcileEvent(entry, legacy, { runId: 'a' });
  const replay = watchdogReplay(entry, { runId: 'a' });
  assert.deepEqual(replay.events, [legacy]);
  assert.equal(renderReplay(replay).checks, null);
  assert.equal(renderReplay(replay).events[0].delivery, 'unknown');
});
