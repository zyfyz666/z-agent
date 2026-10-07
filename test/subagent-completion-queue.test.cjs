'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SubagentCompletionQueue } = require('../lib/subagent-completion-queue');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-subagent-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = 2_000;
  const config = { file: path.join(directory, 'subagent-completions.json'), now: () => time, ...options };
  const queue = new SubagentCompletionQueue(config);
  const parent = { parentRunId: 'parent-1', zSessionId: 'sess_alpha', conversationRevision: 0, startedAt: 1_000 };
  const event = { ...parent, parentSessionID: 'native-parent', childSessionID: 'native-child',
    callId: 'task-1', startedAt: 1_100, directory: directory, status: 'running', role: 'researcher', title: 'Check result' };
  queue.authorizeParent(parent);
  return { queue, parent, event, config, clock: value => { time = value; }, reload: () => new SubagentCompletionQueue(config) };
}

function complete(queue, event) {
  queue.recordLifecycle({ ...event, status: 'completed', result: 'Verified child result', completedAt: 1_900 });
  queue.settleParent(event.parentRunId, { status: 'done' });
  return queue.list().wakes[0];
}

test('only a newly registered child of the authorized parent can wake after normal parent completion', t => {
  const { queue, event } = fixture(t);
  assert.equal(queue.recordLifecycle({ ...event, parentRunId: 'other' }), false);
  assert.equal(queue.recordLifecycle({ ...event, zSessionId: 'sess_beta' }), false);
  assert.equal(queue.recordLifecycle({ ...event, conversationRevision: 1 }), false);
  assert.equal(queue.recordLifecycle({ ...event, startedAt: -1 }), false);
  queue.bindParent(event.parentRunId, event.parentSessionID);
  assert.equal(queue.recordLifecycle({ ...event, parentSessionID: 'other-native' }), false);
  assert.equal(queue.recordLifecycle(event), true);
  queue.recordLifecycle({ ...event, status: 'completed', result: 'done' });
  assert.equal(queue.list().wakes.length, 0, 'child finishing does not race the still-running native parent');
  queue.settleParent(event.parentRunId, { status: 'done' });
  assert.equal(queue.list().wakes.length, 1);
  assert.equal(queue.recordLifecycle({ ...event, callId: 'historical-task' }), false);
});

test('a child may finish later, and duplicate lifecycle events retain exactly one stable wake', t => {
  const { queue, event } = fixture(t);
  queue.recordLifecycle(event);
  queue.settleParent(event.parentRunId, { status: 'done' });
  const first = { ...event, status: 'completed', result: 'result', completedAt: 2_000 };
  queue.recordLifecycle(first);
  const id = queue.list().wakes[0].id;
  queue.recordLifecycle(first);
  assert.deepEqual(queue.list().wakes.map(item => item.id), [id]);
  assert.equal(queue.recordLifecycle({ ...first, childSessionID: 'replaced-child' }), false);
});

test('native consumption wins and does not revive when completion is replayed or the app restarts', t => {
  const { queue, event, reload } = fixture(t);
  queue.recordLifecycle({ ...event, status: 'completed', consumed: true, result: 'Already read by parent' });
  queue.settleParent(event.parentRunId, { status: 'done' });
  assert.equal(queue.recordLifecycle({ ...event, status: 'completed', consumed: false }), false);
  assert.equal(queue.list().wakes.length, 0);
  assert.equal(reload().list().wakes.length, 0);
});

for (const result of [{ status: 'error' }, { status: 'cancelled' }, { status: 'done', userRequestedFinish: true }]) {
  test(`parent ${JSON.stringify(result)} cannot revive child work after reload`, t => {
    const { queue, event, reload } = fixture(t);
    queue.recordLifecycle(event);
    queue.settleParent(event.parentRunId, result);
    assert.equal(queue.recordLifecycle({ ...event, status: 'completed' }), false);
    assert.equal(reload().list().wakes.length, 0);
  });
}

test('a parent interrupted by app shutdown has no implicit authorization to restart', t => {
  const { queue, event, reload } = fixture(t);
  queue.recordLifecycle(event);
  const restored = reload();
  restored.settleParent(event.parentRunId, { status: 'done' });
  assert.equal(restored.recordLifecycle({ ...event, status: 'completed' }), false);
  assert.equal(restored.list().wakes.length, 0);
});

test('claim is exclusive, validates session/revision/intent, expires and can be released only before acceptance', t => {
  const { queue, event, clock } = fixture(t, { claimMs: 100 });
  const wake = complete(queue, event);
  const claim = { id: wake.id, sessionId: wake.sessionId, conversationRevision: 0 };
  assert.equal(queue.claim({ ...claim, sessionId: 'sess_other' }).ok, false);
  assert.equal(queue.claim({ ...claim, conversationRevision: 1 }).ok, false);
  const first = queue.claim(claim);
  assert.equal(first.ok, true);
  assert.equal(queue.claim(claim).ok, false);
  assert.equal(queue.accept({ ...claim, claimToken: first.claimToken, intentId: 'forged' }, 'run-wake').ok, false);
  assert.equal(queue.release({ id: wake.id, claimToken: 'forged' }).ok, false);
  clock(2_101);
  assert.equal(queue.list().wakes.length, 1);
  const second = queue.claim(claim);
  assert.notEqual(second.claimToken, first.claimToken);
  assert.equal(queue.accept({ ...claim, claimToken: first.claimToken, intentId: wake.intentId }, 'run-wake').ok, false);
  assert.equal(queue.accept({ ...claim, claimToken: second.claimToken, intentId: wake.intentId }, 'run-wake').ok, true);
  assert.equal(queue.release({ id: wake.id, claimToken: second.claimToken }).ok, false);
  assert.equal(queue.list().wakes.length, 0);
});

test('renderer-only claims recover, but accepted receipts survive the delivery crash window without a duplicate run', t => {
  const { queue, event, reload } = fixture(t);
  const wake = complete(queue, event);
  const input = { id: wake.id, sessionId: wake.sessionId, conversationRevision: 0 };
  queue.claim(input);
  const recovered = reload();
  assert.equal(recovered.list().wakes.length, 1);
  const claimed = recovered.claim(input);
  const payload = { ...input, claimToken: claimed.claimToken, intentId: wake.intentId };
  assert.equal(recovered.accept(payload, 'stable-run-id').ok, true);
  const afterCrash = reload();
  assert.equal(afterCrash.list().wakes.length, 0);
  assert.equal(afterCrash.list().uncertain[0].acceptedRunId, 'stable-run-id');
  assert.equal(afterCrash.accept(payload, 'duplicate').ok, false);
  assert.equal(afterCrash.claim(input).ok, false);
  afterCrash.settleDelivery('stable-run-id');
  assert.equal(reload().list().uncertain.length, 0);
});

for (const reason of ['user_cancelled', 'session_deleted', 'revision_changed']) {
  test(`${reason} cancels pending and claimed results without affecting another conversation`, t => {
    const { queue, parent, event, reload } = fixture(t);
    const wake = complete(queue, event);
    queue.authorizeParent({ ...parent, parentRunId: 'parent-b', zSessionId: 'sess_beta' });
    complete(queue, { ...event, parentRunId: 'parent-b', zSessionId: 'sess_beta' });
    queue.claim({ id: wake.id, sessionId: wake.sessionId, conversationRevision: 0 });
    queue.cancelSession(event.zSessionId, reason);
    assert.deepEqual(reload().list().wakes.map(item => item.sessionId), ['sess_beta']);
    assert.equal(queue.recordLifecycle({ ...event, status: 'completed' }), false);
  });
}

test('ordinary user input releases a claim and defers the wake without abandoning a running child', t => {
  const { queue, event } = fixture(t);
  queue.recordLifecycle(event);
  queue.cancelSession(event.zSessionId, 'user_message');
  assert.equal(queue.state.parents[event.parentRunId].status, 'running');
  const wake = complete(queue, event);
  const claimed = queue.claim({ id: wake.id, sessionId: wake.sessionId, conversationRevision: 0 });
  queue.cancelSession(event.zSessionId, 'user_message');
  assert.equal(queue.list().wakes.length, 1);
  assert.equal(queue.release({ id: wake.id, claimToken: claimed.claimToken }).ok, false);
  queue.applyInspection(wake, { status: 'completed', consumed: true });
  assert.equal(queue.list().wakes.length, 0, 'the later user turn actually consuming the result suppresses the wake');
});

test('revisions and deletion are checked independently of any renderer observer setting', t => {
  const { queue, event } = fixture(t);
  complete(queue, event);
  queue.reconcileSession(event.zSessionId, 1);
  assert.equal(queue.list().wakes.length, 0);
  queue.reconcileSession(event.zSessionId, null);
  assert.equal(queue.list().uncertain.length, 0);
});

test('background inspection is fair and bounded; read-only completion becomes ready and timeout needs manual continuation', t => {
  const { queue, event, clock } = fixture(t, { maxObserveMs: 1_000 });
  for (let index = 0; index < 6; index++) queue.recordLifecycle({ ...event, callId: `call-${index}`, childSessionID: `child-${index}` });
  queue.settleParent(event.parentRunId, { status: 'done' });
  const first = queue.pollable(4);
  assert.equal(first.length, 4);
  for (const record of first) queue.applyInspection(record, { status: 'unknown' });
  assert.ok(!first.some(item => item.id === queue.pollable(1)[0].id));
  queue.applyInspection(first[0], { status: 'completed', result: 'Late result', completedAt: 2_500 });
  assert.equal(queue.list().wakes[0].result, 'Late result');
  for (const record of queue.pollable(6)) queue.applyInspection(record, { status: 'unknown' });
  clock(3_001);
  assert.equal(queue.pollable(4).length, 0);
  assert.equal(queue.list().uncertain.length, 5);
});

test('confirmed running children remain observable beyond the former six-hour limit', t => {
  const { queue, event, clock } = fixture(t, { maxObserveMs: 1_000 });
  queue.recordLifecycle(event);
  queue.settleParent(event.parentRunId, { status: 'done' });
  const [record] = queue.pollable();
  queue.applyInspection(record, { status: 'unknown' });
  clock(2_500);
  queue.applyInspection(record, { status: 'running' });
  clock(50_000);
  assert.equal(queue.pollable().length, 1);
  queue.applyInspection(record, { status: 'completed', result: 'long-running result' });
  assert.equal(queue.list().wakes[0].result, 'long-running result');
});

test('unknown consumption of a saved completion survives reload and retries only with bounded backoff', t => {
  const { queue, event, clock, reload } = fixture(t);
  const wake = complete(queue, event);
  queue.applyInspection(wake, { status: 'unknown' });
  assert.equal(queue.list().wakes.length, 0);
  assert.equal(queue.claim({ id: wake.id, sessionId: wake.sessionId, conversationRevision: 0 }).ok, false);
  assert.equal(queue.pollable().length, 0);
  const restored = reload();
  assert.equal(restored.list().wakes.length, 0);
  clock(12_000);
  assert.equal(restored.pollable().length, 1);
  restored.applyInspection(wake, { status: 'unknown' });
  assert.equal(restored.state.records[wake.id].inspectionRetryAt, 32_000);
  assert.equal(restored.pollable().length, 0);
  clock(32_000);
  restored.applyInspection(wake, { status: 'completed', consumed: false, result: 'Confirmed unread' });
  assert.equal(restored.list().wakes[0].result, 'Confirmed unread');
  assert.equal(restored.state.records[wake.id].inspectionRetryAt, undefined);
});

test('capacity failure is visible and startup failures require manual continuation', t => {
  const { queue, event } = fixture(t, { maxRecords: 1 });
  const wake = complete(queue, event);
  const claimed = queue.claim({ id: wake.id, sessionId: wake.sessionId, conversationRevision: 0 });
  queue.failClaim({ id: wake.id, claimToken: claimed.claimToken }, 'Model configuration missing');
  assert.equal(queue.list().uncertain[0].reason, 'Model configuration missing');
  queue.authorizeParent({ parentRunId: 'parent-2', zSessionId: 'sess_beta', conversationRevision: 0, startedAt: 1_000 });
  assert.equal(queue.recordLifecycle({ ...event, parentRunId: 'parent-2', zSessionId: 'sess_beta' }), false);
  assert.equal(queue.list({ sessionId: 'sess_beta' }).uncertain[0].reason, 'queue_capacity');
});

test('a failed durable acceptance write leaves the claim unaccepted and never grants permission to start', t => {
  const { queue, event, reload } = fixture(t);
  const wake = complete(queue, event);
  const input = { id: wake.id, sessionId: wake.sessionId, conversationRevision: 0 };
  const claimed = queue.claim(input);
  queue.write = () => { throw new Error('disk unavailable'); };
  assert.throws(() => queue.accept({ ...input, claimToken: claimed.claimToken, intentId: wake.intentId }, 'run'), /disk unavailable/);
  assert.equal(queue.state.records[wake.id].delivery, 'claimed');
  assert.equal(reload().list().wakes.length, 1, 'the last durable state never claimed a provider start');
});

test('corrupt queue data fails closed instead of discarding accepted receipts', t => {
  const { config } = fixture(t);
  fs.writeFileSync(config.file, '{broken');
  assert.throws(() => new SubagentCompletionQueue(config));
});
