'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { safeText, taskMemoryIdentity, taskSource, buildTaskProgressRecord, buildReviewJobPayload, summarizeHarnessBaselines } = require('../lib/task-memory-service');
const { LongTermMemoryStore } = require('../lib/long-term-memory');
const { ContinualHarnessStore } = require('../lib/continual-harness');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-task-memory-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, session: { id: 'sess_aaaa', conversationRevision: 2, workspace: root,
    messages: [{ id: 'm1', role: 'user', ts: 100, content: '修复图表。必须保留原文件。' }] } };
}

test('safeText excludes plain, quoted, nested and escaped credential assignments', () => {
  for (const value of [
    'password=secret-sentinel', { apiKey: 'secret-sentinel' }, { nested: { access_token: 'secret-sentinel' } },
    '{"password":"secret-sentinel"}', '{\\"apiKey\\":\\"secret-sentinel\\"}',
    'curl -H "Authorization: Bearer secret-sentinel"', 'https://username:secret-sentinel@example.com',
    'TOKEN=secret-sentinel', { clientSecret: 'secret-sentinel' }
  ]) assert.equal(safeText(value), '', JSON.stringify(value));
  assert.equal(safeText({ command: 'npm test', exitCode: 0 }), '{"command":"npm test","exitCode":0}');
});

test('task identity and sources use authoritative revision and exact history boundary', t => {
  const { session } = fixture(t);
  session.messages.push({ role: 'assistant', ts: 200, content: 'First result' }, { role: 'user', ts: 300, content: 'Continue' });
  assert.equal(taskMemoryIdentity(session).cutoff, undefined);
  assert.equal(taskMemoryIdentity({ ...session, forkedFrom: { messageCount: 2 } }).cutoff, 200);
  assert.equal(taskMemoryIdentity({ ...session, forkedFrom: { messageCount: 2 }, contextReset: { messageCount: 0 } }).cutoff, 0);
  const source = taskSource(session, { requestMessageIndex: 0 }, 'run-1', 1000);
  assert.equal(source.sourceMessageId, 'm1');
  assert.equal(source.sourceMessageIndex, 0);
  assert.equal(source.conversationRevision, 2);
  assert.equal(taskSource(session, {}, 'run-2', 1000).sourceMessageIndex, 2);
  assert.equal(taskSource(session, {}, 'run-2', 1000).sourceMessageId, taskSource(session, {}, 'run-2', 1000).sourceMessageId);
  const frozen = taskSource(session, { requestMessageIndex: 0, sourceMessageId: 'frozen-start-message' }, 'run-2', 1000);
  assert.equal(frozen.sourceMessageIndex, 0);
  assert.equal(frozen.sourceMessageId, 'frozen-start-message');
});

test('continue preserves task goal, constraints, unresolved work and verified evidence through storage', t => {
  const { root, session } = fixture(t);
  const store = new LongTermMemoryStore({ dbPath: path.join(root, 'memory.sqlite') });
  const first = buildTaskProgressRecord({ session, request: { prompt: session.messages[0].content }, runId: 'run-1', runStartedAt: 1000,
    result: { status: 'done', text: '图表已更新，移动端尚需验证', todos: [{ text: '验证移动端', done: false }],
      toolCalls: [{ id: 'test-1', name: 'exec', ok: true }, { id: 'test-2', name: 'build', ok: false }] } });
  const saved = store.upsert(first, first).memory;
  assert.equal(saved.taskState.verified.length, 1);
  assert.equal(saved.taskState.verified[0].evidence[0].toolCallId, 'test-1');
  session.messages.push({ id: 'm2', role: 'user', ts: 200, content: '继续' });
  const continuing = buildTaskProgressRecord({ session, request: { prompt: '继续' }, runId: 'run-2', runStartedAt: 2000, previous: saved });
  assert.equal(continuing.taskState.goal, first.taskState.goal);
  assert.ok(continuing.taskState.constraints.some(text => text.includes('保留原文件')));
  assert.deepEqual(continuing.taskState.unresolved, ['验证移动端']);
  assert.equal(continuing.taskState.verified[0].evidence[0].toolCallId, 'test-1');
  assert.equal(continuing.taskState.status, 'running');
  assert.equal(store.upsert(continuing, continuing).ok, true);
  const result = store.query({ ...taskMemoryIdentity(session), query: 'continue' });
  assert.equal(result.memories[0].taskState.verified[0].evidence[0].toolCallId, 'test-1');
});

test('progress does not inherit another task or previous revision and clears explicitly completed todos', t => {
  const { session } = fixture(t);
  const previous = { taskState: { sessionId: 'sess_other', conversationRevision: 2, goal: 'Other task objective', constraints: ['Other restriction'] } };
  const foreign = buildTaskProgressRecord({ session, request: { prompt: '继续' }, previous, runId: 'new', runStartedAt: 2000 });
  assert.doesNotMatch(JSON.stringify(foreign.taskState), /Other task|Other restriction/);
  previous.taskState = { ...previous.taskState, sessionId: session.id, conversationRevision: 1 };
  assert.doesNotMatch(JSON.stringify(buildTaskProgressRecord({ session, request: { prompt: '继续' }, previous })), /Other task/);
  previous.taskState = { ...previous.taskState, conversationRevision: 2, unresolved: ['Pending verification'], nextSteps: ['Verify'] };
  const completed = buildTaskProgressRecord({ session, request: { prompt: '继续' }, previous,
    result: { status: 'done', todos: [{ text: 'Pending verification', done: true }] } });
  assert.deepEqual(completed.taskState.unresolved, []);
  assert.deepEqual(completed.taskState.nextSteps, []);
});

test('continuing after a manual task summary edit uses the new text instead of the old structured goal', t => {
  const { root, session } = fixture(t);
  const store = new LongTermMemoryStore({ dbPath: path.join(root, 'memory.sqlite') });
  const old = buildTaskProgressRecord({ session, request: { prompt: 'Old goal. Never alter old constraint.' }, runId: 'run-1', runStartedAt: 1000 });
  const saved = store.upsert(old, old).memory;
  const changed = store.update(saved.id, { content: '人工修正：先修复新的上下文问题。' }, taskMemoryIdentity(session)).memory;
  assert.equal(changed.taskState, undefined);
  const next = buildTaskProgressRecord({ session, request: { prompt: '继续' }, previous: changed, runId: 'run-2', runStartedAt: Date.now() });
  assert.equal(next.taskState.goal, '人工修正：先修复新的上下文问题。');
  assert.doesNotMatch(JSON.stringify(next.taskState), /Old goal|old constraint/);
});

test('review payload excludes provider config and credentials in copied tool results and harness state', t => {
  const { session } = fixture(t);
  const payload = buildReviewJobPayload({ session, request: { workMode: 'agent', history: [{ role: 'user', content: '{"apiKey":"secret-sentinel"}' }] },
    selection: { providerId: 'provider-a', modelId: 'model-a', apiKey: 'secret-sentinel', baseURL: 'https://secret-sentinel' },
    result: { status: 'done', text: 'Finished', toolCalls: [{ name: 'exec', ok: true, args: { apiKey: 'secret-sentinel' }, output: { password: 'secret-sentinel' } }] },
    prompt: 'Continue', workspace: session.workspace, runId: 'run-1', runStartedAt: 1000, evolutionMode: true,
    harnessBaselines: { global: { revision: 3, apiKey: 'secret-sentinel', refinements: ['secret-sentinel'], entries: {
      prompt: { one: { id: 'one', content: 'secret-sentinel', metadata: { token: 'secret-sentinel' } } }
    } } }, refinementRequest: { action: 'refine', scope: 'global', instructions: 'password=secret-sentinel', apiKey: 'secret-sentinel', runId: 'run-1' } });
  assert.doesNotMatch(JSON.stringify(payload), /secret-sentinel|apiKey|baseURL|refinements/);
  assert.deepEqual(Object.keys(payload.selection).sort(), ['modelId','providerId']);
  assert.match(payload.harnessBaselines.global.entryFingerprints.prompt.one, /^[a-f0-9]{64}$/);
  assert.equal(payload.refinementRequest.instructions, '');
  assert.equal(payload.result.toolCalls[0].args, '');
  assert.equal(payload.result.toolCalls[0].output, '');
});

test('compact harness baselines preserve disjoint-update concurrency and reject conflicting stale writes', async t => {
  const { root } = fixture(t);
  const store = new ContinualHarnessStore({ globalPath: path.join(root, 'harness.json') });
  const edit = (id, content, action = 'create') => ({ id, content, action, kind: 'prompt', title: id, path: 'policy', scope: 'global', metadata: { status: 'active' } });
  await store.apply({ edits: [edit('original', 'Original verified user preference about concise reporting.')] }, { scope: 'global' });
  const baseline = summarizeHarnessBaselines({ global: store.load({ scope: 'global' }) }).global;
  await store.apply({ edits: [edit('unrelated', 'Unrelated verified rule for reviewing build results.')] }, { scope: 'global' });
  const first = await store.apply({ edits: [edit('original', 'Updated verified user preference for concise reporting.', 'update')] },
    { scope: 'global', expectedRevision: baseline.revision, baselineState: baseline });
  assert.equal(first.ok, true);
  const stale = await store.apply({ edits: [edit('original', 'Stale preference must not replace the newer instruction.', 'update')] },
    { scope: 'global', expectedRevision: baseline.revision, baselineState: baseline });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
});

test('large harness baselines remain below the persistent queue payload limit', () => {
  const entries = Object.fromEntries(['prompt','memory','skill','subagent'].map(kind => [kind,
    Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`${kind}-${index}-${'x'.repeat(70)}`, { content: 'y'.repeat(12000) }]))]));
  const compact = summarizeHarnessBaselines({ global: { revision: 1, entries }, workspace: { revision: 2, entries } });
  assert.ok(JSON.stringify(compact).length < 400000);
  assert.doesNotMatch(JSON.stringify(compact), /yyyy/);
});
