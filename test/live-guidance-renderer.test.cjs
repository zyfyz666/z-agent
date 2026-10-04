'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check) {
  for (let turn = 0; turn < 60; turn++) {
    if (check()) return;
    await Promise.resolve();
  }
  assert.ok(check(), 'Expected asynchronous fixture progress');
}

function fixture() {
  const a = { id: 'A', title: 'Task A', messages: [{ role: 'user', content: 'Original request' }] };
  const b = { id: 'B', messages: [] };
  const drafts = { A: 'First guidance', B: 'Keep B draft' };
  const saved = [], calls = [], shown = [], cleared = [], notices = [];
  const runCtx = { runId: 'run-A', sessionId: 'A', shouldAbort: false };
  let sequence = 0;
  let queued = 0;
  const context = {
    state: { currentSession: a, activeRuns: new Map([['A', { runCtx, sessionRef: a }]]),
      attachments: [], selectedSkills: [], selectedSubagents: [] },
    input: { get value() { return drafts[context.state.currentSession.id]; } },
    getComposerText: () => drafts[context.state.currentSession.id],
    getRunCtx: id => context.state.activeRuns.get(id)?.runCtx,
    isCurrentSessionExecutionActive: () => context.state.activeRuns.has(context.state.currentSession.id),
    createQueuedTurnId: () => `request-${++sequence}`,
    getActiveAssistantElement: () => ({ before: element => shown.push(element) }),
    appendMessage: (_role, content) => ({ content }),
    clearComposerPayload() { cleared.push(context.state.currentSession.id); drafts[context.state.currentSession.id] = ''; },
    updateSendState() {}, refreshLiveGuidanceStatus() {},
    syncComposerSkillsFromDom() {}, syncComposerSubagentsFromDom() {},
    queueCurrentComposerTurn() { queued++; return true; },
    toast: value => notices.push(value),
    persistCurrentSession: async session => { saved.push(JSON.parse(JSON.stringify(session))); },
    api: {
      openCodeSteerRun(payload) {
        const pending = deferred();
        calls.push({ ...payload, ...pending });
        return pending.promise;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(section('const sessionSaveQueues = ', 'async function persistCurrentSession('), context);
  vm.runInContext(section('async function steerCurrentComposerTurn(', 'function queueCurrentComposerTurn('), context);
  vm.runInContext(section('async function sendMessage()', 'async function submitMediaMessage('), context);
  return { context, a, b, drafts, runCtx, saved, calls, shown, cleared, notices, get queued() { return queued; } };
}

test('running Send persists pending guidance before directly delivering it to the same run', async () => {
  const f = fixture();
  const pending = f.context.sendMessage();
  assert.equal(f.calls.length, 0);
  await until(() => f.calls.length === 1);
  assert.equal(f.queued, 0);
  assert.equal(f.saved[0].messages.at(-1).liveGuidance.status, 'pending');
  assert.equal(f.calls[0].runId, 'run-A');
  assert.equal(f.calls[0].yanSessionId, 'A');
  assert.equal(f.calls[0].text, 'First guidance');
  assert.deepEqual(f.shown, [{ content: 'First guidance' }]);
  f.calls[0].resolve({ ok: true, delivered: true });
  await pending;
  assert.equal(f.saved.at(-1).messages.at(-1).liveGuidance.status, 'delivered');
  assert.equal(f.a.messages[0].content, 'Original request');
});

test('mounting the composer keeps explicit Stop and Queue controls before removing the old action container', () => {
  const mounted = [];
  const selectors = ['.attachment-action-wrap', '#accessModeWrap', '#workModeIndicator', '#modelPickerWrap', '#stopRunBtn', '#queueTurnBtn', '#sendBtn'];
  const nodes = new Map(selectors.map(selector => [selector, { selector }]));
  nodes.set('.composer-toolbar-controls', { append: node => mounted.push(node.selector) });
  nodes.set('.composer-actions', { remove() {
    assert.ok(mounted.includes('#stopRunBtn'));
    assert.ok(mounted.includes('#queueTurnBtn'));
  } });
  const context = vm.createContext({ document: { querySelector: selector => nodes.get(selector) || null } });
  vm.runInContext(section('function mountComposerToolbar()', 'function isImageAttachmentMeta('), context);
  assert.deepEqual(mounted.slice(-3), ['#stopRunBtn', '#queueTurnBtn', '#sendBtn']);
});

test('a failed initial save never sends an instruction that was not durably recorded', async () => {
  const f = fixture();
  let attempts = 0;
  f.context.persistCurrentSession = async session => {
    if (++attempts === 1) throw new Error('Disk write failed');
    f.saved.push(JSON.parse(JSON.stringify(session)));
  };
  assert.equal(await f.context.steerCurrentComposerTurn(), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved.at(-1).messages.at(-1).liveGuidance.status, 'failed');
  assert.match(f.saved.at(-1).messages.at(-1).liveGuidance.error, /Disk write failed/);
});

test('multiple in-flight guidance messages remain distinct when acknowledgements return out of order', async () => {
  const f = fixture();
  const first = f.context.steerCurrentComposerTurn();
  f.drafts.A = 'Second guidance';
  const second = f.context.steerCurrentComposerTurn();
  await until(() => f.calls.length === 2);
  assert.notEqual(f.calls[0].requestId, f.calls[1].requestId);
  f.calls[1].resolve({ ok: true, delivered: true });
  await second;
  f.calls[0].resolve({ ok: true, delivered: true });
  await first;
  const messages = f.saved.at(-1).messages;
  assert.deepEqual(messages.map(message => message.content), ['Original request', 'First guidance', 'Second guidance']);
  assert.deepEqual(messages.slice(1).map(message => message.liveGuidance.status), ['delivered', 'delivered']);
});

test('switching conversations while guidance is pending never clears or saves the other conversation draft', async () => {
  const f = fixture();
  const gate = deferred();
  f.context.persistCurrentSession = async session => { await gate.promise; f.saved.push(JSON.parse(JSON.stringify(session))); };
  const pending = f.context.steerCurrentComposerTurn();
  f.context.state.currentSession = f.b;
  gate.resolve();
  await until(() => f.calls.length === 1);
  f.calls[0].resolve({ ok: true, delivered: true });
  await pending;
  assert.equal(f.drafts.B, 'Keep B draft');
  assert.deepEqual(f.cleared, ['A']);
  assert.ok(f.saved.every(session => session.id === 'A'));
  assert.equal(f.b.messages.length, 0);
});

test('a rejected guidance request stays in history with its failure and never claims delivery', async () => {
  const f = fixture();
  const pending = f.context.steerCurrentComposerTurn();
  await until(() => f.calls.length === 1);
  f.calls[0].resolve({ ok: false, delivered: false, error: 'Run already stopped' });
  assert.equal(await pending, false);
  assert.equal(f.saved.at(-1).messages.at(-1).content, 'First guidance');
  assert.equal(f.saved.at(-1).messages.at(-1).liveGuidance.status, 'failed');
  assert.match(f.saved.at(-1).messages.at(-1).liveGuidance.error, /stopped/);
});

test('stop during the initial guidance save prevents injection while retaining the instruction', async () => {
  const f = fixture();
  const gate = deferred();
  f.context.persistCurrentSession = async session => { await gate.promise; f.saved.push(JSON.parse(JSON.stringify(session))); };
  const pending = f.context.steerCurrentComposerTurn();
  f.runCtx.shouldAbort = true;
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved.at(-1).messages.at(-1).liveGuidance.status, 'failed');
});

test('messages with attachments still queue explicitly and stopping tasks accept no guidance', async () => {
  const f = fixture();
  f.context.state.attachments = [{ name: 'reference.png' }];
  await f.context.sendMessage();
  assert.equal(f.queued, 1);
  assert.match(f.notices.at(-1), /已排队/);
  f.context.state.attachments = [];
  f.runCtx.shouldAbort = true;
  await f.context.sendMessage();
  assert.equal(f.calls.length, 0);
  assert.equal(f.a.messages.length, 1);
});

function terminalFixture() {
  const context = {
    window: { YanSubagentWorkflow: { importRecords() {}, consume() {}, finalize() {} } },
    subagentPanel: { schedule() {} },
    flushOpenCodeStreamDeltas() {}, cancelScheduledOpenCodeRender() {}, cancelOpenCodeStreamFlush() {}, removeOpenCodeTimeline() {},
    normalizeDeliveryAgreementTimeline: value => value.map(item => ({ ...item })),
    extractDeliveryAgreement: value => ({ text: String(value || '') }), containsDsmlProtocolMarkup: () => false,
    splitTaggedThinkingText: value => ({ text: value }), normalizeAgentTodos: value => value || [],
    resolveAgentPresentationMode: () => 'standard',
    stringifyOpenCodeValue: value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
  };
  vm.createContext(context);
  vm.runInContext(section('function openCodeResultToAgentRun(', 'function extractMediaAssetsFromAgentRun('), context);
  vm.runInContext(section('function syncSessionOpenCodeIdAfterRun(', 'async function runOpenCodeLoop('), context);
  const runCtx = {
    runId: 'run-A', openCodeSessionId: 'kernel-A', startedAt: Date.now(), partialContent: 'Partial analysis',
    activeAgentRun: { timeline: [{ type: 'tool_call', callId: 'read-1', name: 'read', args: { file: 'fixture.txt' } }], subagents: [] },
    agentState: { toolCallCount: 1, todos: [{ text: 'Check fixture', done: false }] }
  };
  return { context, runCtx };
}

test('an empty interrupted result preserves partial text, tool count, todos and the resumable kernel session', () => {
  const f = terminalFixture();
  const result = f.context.openCodeResultToAgentRun({ status: 'interrupted', text: '', toolCalls: [], todos: [] }, f.runCtx);
  assert.equal(result.textContent, 'Partial analysis');
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.todos.length, 1);
  assert.equal(result.timeline[0].callId, 'read-1');
  const session = { openCodeSessionId: 'kernel-A' };
  f.context.syncSessionOpenCodeIdAfterRun(session, result);
  assert.equal(session.openCodeSessionId, 'kernel-A');
  f.context.syncSessionOpenCodeIdAfterRun(session, { status: 'interrupted', openCodeSessionId: '' });
  assert.equal(session.openCodeSessionId, 'kernel-A');
});

test('cancellation output fills a missing result for an already streamed tool call without duplicating the call', () => {
  const f = terminalFixture();
  const result = f.context.openCodeResultToAgentRun({ status: 'interrupted', toolCalls: [
    { callId: 'read-1', name: 'read', args: {}, output: 'Recovered fixture contents', ok: true }
  ] }, f.runCtx);
  assert.equal(result.timeline.filter(item => item.type === 'tool_call').length, 1);
  assert.equal(result.timeline.filter(item => item.type === 'tool_result').length, 1);
  assert.equal(result.timeline.find(item => item.type === 'tool_result').output, 'Recovered fixture contents');
});

test('cancellation never replaces an already fuller streamed tool result with a truncated returned output', () => {
  const f = terminalFixture();
  f.runCtx.activeAgentRun.timeline.push({ type: 'tool_result', callId: 'read-1', name: 'read', output: 'Complete streamed file contents', ok: true });
  const result = f.context.openCodeResultToAgentRun({ status: 'interrupted', toolCalls: [
    { callId: 'read-1', name: 'read', output: 'Short', ok: false, status: 'interrupted' }
  ] }, f.runCtx);
  assert.equal(result.timeline.filter(item => item.type === 'tool_result').length, 1);
  assert.equal(result.timeline.find(item => item.type === 'tool_result').output, 'Complete streamed file contents');
  assert.equal(result.timeline.find(item => item.type === 'tool_result').ok, true);
  assert.equal(result.timeline.find(item => item.type === 'tool_result').interrupted, undefined);
});

test('an unfinished tool recovered at cancellation is explicitly marked interrupted', () => {
  const f = terminalFixture();
  const result = f.context.openCodeResultToAgentRun({ status: 'interrupted', toolCalls: [
    { callId: 'read-1', name: 'read', output: '', ok: false, status: 'interrupted' }
  ] }, f.runCtx);
  assert.equal(result.timeline.find(item => item.type === 'tool_result').interrupted, true);
});

test('an interrupted aggregate response does not duplicate text paragraphs already streamed into the timeline', () => {
  const f = terminalFixture();
  f.runCtx.activeAgentRun.timeline.push(
    { type: 'text', stage: 'work', content: 'First observed paragraph' },
    { type: 'text', stage: 'work', content: 'Second observed paragraph' }
  );
  const result = f.context.openCodeResultToAgentRun({
    status: 'interrupted', text: 'First observed paragraph\n\nSecond observed paragraph', toolCalls: []
  }, f.runCtx);
  assert.equal(result.timeline.filter(item => item.type === 'text').length, 2);
  assert.equal(result.textContent, 'First observed paragraph\n\nSecond observed paragraph');
});

test('core reconciliation persists observed work once and retains preceding guidance messages', async () => {
  const f = fixture();
  f.runCtx.partialContent = 'Observed before forced stop';
  f.runCtx.openCodeSessionId = 'kernel-A';
  f.runCtx.activeAgentRun = { timeline: [{ type: 'tool_call', callId: 'read-1' }] };
  f.a.messages.push({ role: 'user', content: 'Earlier guidance', liveGuidance: { requestId: 'earlier', runId: 'run-A', status: 'delivered' } });
  Object.assign(f.context, {
    flushOpenCodeStreamDeltas() {}, getActiveRun: ctx => ctx.activeAgentRun,
    finalizeAgentRun: (content, status, active, _body, _error, ctx) => ({ ...active, status, textContent: content, runId: ctx.runId, openCodeSessionId: ctx.openCodeSessionId }),
    attachAgentRunChangeSummary: async () => {}, renderMessages() {}, setEmptyState() {}
  });
  vm.runInContext(section('function syncSessionOpenCodeIdAfterRun(', 'async function runOpenCodeLoop('), f.context);
  vm.runInContext(section('async function persistReconciledRunSnapshot(', 'function agentRunHasCollapsibleWork('), f.context);
  await f.context.persistReconciledRunSnapshot(f.a, f.runCtx);
  await f.context.persistReconciledRunSnapshot(f.a, f.runCtx);
  assert.deepEqual(f.a.messages.map(message => message.content), ['Original request', 'Earlier guidance', 'Observed before forced stop']);
  assert.equal(f.a.messages.at(-1).agentRun.timeline[0].callId, 'read-1');
  assert.equal(f.a.openCodeSessionId, 'kernel-A');
  assert.equal(f.saved.length, 1);
});
