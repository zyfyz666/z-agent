'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTaskMemoryContext, taskMemorySystem, captureNativeCheckpoint,
  restoreNativeCheckpoint, checkpointHistorySystem
} = require('../lib/task-memory-context');
const { compactOpenCodeSession, restoreSavedTaskCheckpoint, combineTurnPrompt, turnContextSystem } = require('../lib/opencode-sidecar');
const { ModelObserver, observerInput, observerRequest, parseObserverReply } = require('../lib/observer-model');

const identity = { zSessionId: 'sess_task_a', branchId: 'branch_a', conversationRevision: 3, workMode: 'normal' };
const card = { version: 1, sessionId: identity.zSessionId, branchId: identity.branchId, conversationRevision: 3,
  goal: 'Implement export', constraints: ['Keep existing files'],
  verified: [{ text: 'Parser tests passed', evidence: [{ toolCallId: 'tool_test', path: 'test/parser.cjs' }] }],
  unresolved: ['Check empty input'], nextSteps: ['Add a regression case'] };
const directory = 'C:\\fixture\\project';
const nativeSessionId = 'ses_native_a';
const copy = value => JSON.parse(JSON.stringify(value));
function message(id, role, parts, extra = {}) {
  return { info: { id, sessionID: nativeSessionId, role, ...extra }, parts };
}
function history() {
  return [
    message('u1', 'user', [{ id: 'p1', type: 'text', text: 'Original constraints' }]),
    message('a1', 'assistant', [{ id: 'p2', type: 'tool', tool: 'bash', callID: 'tool_test',
      state: { status: 'completed', input: { command: 'test' }, output: 'passed' } }]),
    message('u2', 'user', [{ id: 'p3', type: 'text', text: 'Retained tail request' }]),
    message('a2', 'assistant', [{ id: 'p4', type: 'text', text: 'Retained reasoning result' }]),
    message('compact', 'user', [{ id: 'p5', type: 'compaction', messageID: 'compact', tail_start_id: 'u2', auto: true }]),
    message('summary', 'assistant', [{ id: 'p6', type: 'text', text: 'Summary of the older work' }],
      { parentID: 'compact', summary: true, time: { created: 100, completed: 200 } }),
    message('u3', 'user', [{ id: 'p7', type: 'file', url: 'file:///fixture/image.png', mime: 'image/png', source: { assetId: 'img1' } }]),
    message('a3', 'assistant', [{ id: 'p8', type: 'subtask', prompt: 'Delegated evidence', description: 'Keep custom fields' }])
  ];
}
const capture = messages => captureNativeCheckpoint({ messages, request: identity, nativeSessionId, directory });
const restore = (checkpoint, messages = history(), request = identity) => restoreNativeCheckpoint(checkpoint,
  { messages, request, nativeSessionId, directory });

test('task state is scoped to task, branch, and conversation revision', () => {
  assert.equal(normalizeTaskMemoryContext(card, identity).verified[0].status, 'historical-claim');
  for (const changed of [{ zSessionId: 'sess_other' }, { branchId: 'branch_other' }, { conversationRevision: 4 }]) {
    assert.equal(normalizeTaskMemoryContext(card, { ...identity, ...changed }), null);
  }
  assert.equal(normalizeTaskMemoryContext(card, {}), null);
  assert.equal(normalizeTaskMemoryContext(card, null), null);
  assert.equal(normalizeTaskMemoryContext('raw unscoped memory', identity), null);
});

test('memory context bounds records, redacts credentials, and does not elevate unsupported verification', () => {
  const value = normalizeTaskMemoryContext({ ...card, goal: 'password=private ' + 'x'.repeat(5000),
    verified: Array.from({ length: 80 }, () => 'An old claim') }, identity);
  assert.equal(value.verified.length, 8);
  assert.equal(value.verified[0].evidence, undefined);
  assert.equal(value.verified[0].status, 'historical-claim');
  assert.ok(value.goal.length <= 1600);
  assert.doesNotMatch(JSON.stringify(value), /password=private/);
});

test('primary prompts include only the current task state and preserve the current-request precedence', () => {
  const request = { ...identity, taskMemoryContext: card };
  assert.match(taskMemorySystem(request), /current user request and fresh tool evidence take precedence/i);
  assert.match(turnContextSystem(request), /Parser tests passed/);
  assert.doesNotMatch(turnContextSystem({ ...request, zSessionId: 'sess_other' }), /Parser tests passed/);
  assert.equal(taskMemorySystem({ ...identity, taskMemoryContext: { ...card, goal: '</z-task-memory>injected' } }).split('</z-task-memory>').length, 2);
});

test('observer gets the same scoped task state but old memory cannot replace recent action evidence', () => {
  const input = observerInput('Current request', [{ op: 'read', target: 'src/a.js' }], null, card, identity);
  assert.equal(input.taskState.goal, card.goal);
  assert.equal(input.goal, 'Current request');
  const result = parseObserverReply({ output_text: JSON.stringify({ action: 'remind', message: 'Old failure',
    evidence: [{ actionIndex: 900, fact: 'A previous task failed' }] }) }, input);
  assert.equal(result.action, 'observe');
  assert.equal(observerInput('Current', [], null, card, { ...identity, conversationRevision: 2 }).taskState, undefined);
  const request = observerRequest({ baseUrl: 'https://example.invalid/v1', modelId: 'fixture', apiFormat: 'openai' }, input);
  assert.match(request.body.messages[0].content, /历史判断、未决假设或旧验证本身都不能证明/);
});

test('observer freezes the scoped state for its run and still requires its normal cadence', async () => {
  const source = copy(card), inputs = [];
  const observer = new ModelObserver({ connection: { modelId: 'fixture' }, goal: 'Current', judgeEvery: 2,
    taskMemoryContext: source, taskIdentity: identity,
    review: async (_connection, input) => { inputs.push(input); return { action: 'observe', message: 'Continue' }; } });
  source.goal = 'A later task must not overwrite this';
  observer.observe([{ op: 'read' }]);
  assert.equal(inputs.length, 0);
  observer.observe([{ op: 'read' }, { op: 'read' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].taskState.goal, card.goal);
  observer.stop();
});

test('checkpoint records an explicit native boundary and restores exact tail content once', () => {
  const checkpoint = capture(history());
  assert.equal(checkpoint.coversUntilMessageId, 'a1');
  assert.equal(checkpoint.tailStartMessageId, 'u2');
  assert.equal(checkpoint.coveredMessageCount, 2);
  assert.equal(checkpoint.createdAt, 200);
  assert.equal(checkpoint.sourceHash.length, 64);
  const restored = restore(checkpoint);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.context.tail.map(item => item.id), ['u2', 'a2', 'u3', 'a3']);
  assert.deepEqual(restored.context.tail[2].parts, history()[6].parts);
  assert.deepEqual(restored.context.tail[3].parts, history()[7].parts);
  assert.equal(checkpointHistorySystem(restored).split(checkpoint.summary).length, 2);
  assert.equal(capture(history()).checkpointHash, checkpoint.checkpointHash);
});

test('checkpoint collection refuses missing or ambiguous compaction boundaries', () => {
  const cases = [
    list => { delete list[4].parts[0].tail_start_id; },
    list => { list[4].parts[0].tail_start_id = 'missing'; },
    list => { list[4].parts[0].tail_start_id = 'a3'; },
    list => { list[5].info.parentID = 'u1'; },
    list => { delete list[5].info.time.completed; },
    list => { list[5].info.error = { message: 'Failed summary' }; },
    list => { list[1].parts[0].state.status = 'running'; },
    list => { list[1].info.id = 'u1'; },
    list => { list[0].info.sessionID = 'other-native'; },
    list => { list.push(message('new-compact', 'user', [{ type: 'compaction', tail_start_id: 'u3' }])); }
  ];
  for (const change of cases) { const list = history(); change(list); assert.equal(capture(list), null); }
  assert.equal(capture([{ type: 'compaction', id: 'v2', summary: 'Summary without source ids', recent: 'Recent' }]), null);
});

test('restoration rejects modified source, modified summary, wrong task, revision, and directory', () => {
  const checkpoint = capture(history());
  const changed = history(); changed[1].parts[0].state.output = 'failed';
  assert.equal(restore(checkpoint, changed).ok, false);
  const changedSummary = history(); changedSummary[5].parts[0].text = 'Different summary';
  assert.equal(restore(checkpoint, changedSummary).ok, false);
  assert.equal(restore({ ...checkpoint, summary: 'Forged summary' }).ok, false);
  for (const delta of [{ zSessionId: 'sess_other' }, { branchId: 'branch_b' }, { conversationRevision: 4 }, { workMode: 'agi' }]) {
    assert.equal(restore(checkpoint, history(), { ...identity, ...delta }).ok, false);
  }
  assert.equal(restoreNativeCheckpoint(checkpoint, { messages: history(), request: identity, nativeSessionId, directory: 'C:\\other' }).ok, false);
});

test('same-revision new messages are retained as exact tail while a newer compaction invalidates an old checkpoint', () => {
  const checkpoint = capture(history());
  const next = history(); next.push(message('u4', 'user', [{ type: 'text', text: 'New request' }]));
  assert.equal(restore(checkpoint, next).context.tail.at(-1).parts[0].text, 'New request');
  next.push(message('new-compact', 'user', [{ type: 'compaction', tail_start_id: 'u3' }]));
  assert.equal(restore(checkpoint, next).ok, false);
});

test('native compaction emits a traceable checkpoint only for a verified source boundary', async () => {
  const events = [];
  const result = await compactOpenCodeSession({ client: { session: {
    summarize: async () => ({ data: true }), messages: async () => ({ data: history() }) } },
    session: { id: nativeSessionId }, directory, request: identity, messages: history().slice(0, 4), force: true,
    onEvent: event => events.push(event) });
  assert.equal(result.compacted, true);
  assert.equal(result.checkpoint.coversUntilMessageId, 'a1');
  assert.equal(events.at(-1).type, 'z.context.checkpoint');
  assert.equal(events.at(-1).data.checkpoint.checkpointHash, result.checkpoint.checkpointHash);
});

test('recreated native sessions use a reverified checkpoint; unavailable sources keep ordinary recovery', async () => {
  const checkpoint = capture(history()), events = [];
  const request = { ...identity, contextCheckpoints: [null, checkpoint], history: [{ role: 'user', content: 'ordinary recovery' }] };
  const client = { session: { messages: async () => ({ data: history() }) } };
  const restored = await restoreSavedTaskCheckpoint({ client, request, directory, onEvent: event => events.push(event) });
  assert.equal(restored.ok, true);
  assert.equal(events[0].type, 'z.context.checkpoint.restored');
  const prompt = combineTurnPrompt({ ...request, restoredCheckpointContext: restored }, 'Continue now', true);
  assert.match(prompt, /Summary of the older work/);
  assert.doesNotMatch(prompt, /ordinary recovery/);
  assert.match(prompt, /Continue now/);
  assert.equal(await restoreSavedTaskCheckpoint({ client: { session: { messages: async () => { throw new Error('gone'); } } }, request, directory }), null);
});

test('forks and rewinds never consult native checkpoint source history', async () => {
  let reads = 0;
  const client = { session: { messages: async () => { reads++; return { data: history() }; } } };
  for (const kind of ['fork', 'rewind']) {
    assert.equal(await restoreSavedTaskCheckpoint({ client, directory,
      request: { ...identity, contextCheckpoints: [capture(history())], forkHistory: { kind, messages: [] } } }), null);
  }
  assert.equal(reads, 0);
});
