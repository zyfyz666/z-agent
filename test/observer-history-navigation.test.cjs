'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../renderer/wd-monitor');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('an older delayed conversation cannot replace the chosen chat or observer', async () => {
  const pending = { B: deferred(), C: deferred() };
  const displayed = [];
  const context = {
    sessionLoadToken: 0, observerPendingSessionId: '', MESSAGE_LOAD_LIMIT: 40,
    state: { currentSession: { id: 'A' }, sessions: [], activeRuns: new Map() },
    api: { getSession: id => pending[id].promise, setConfig: async patch => patch },
    renderWdMonitorLoading: () => displayed.push(`loading:${context.observerPendingSessionId}`),
    renderWdMonitor: session => displayed.push(`record:${session?.id || context.state.currentSession.id}`),
    getRunCtx: () => null,
  };
  for (const name of ['cancelPromptOptimization', 'closeModelPicker', 'closeReasoningPicker',
    'captureComposerDraftForSession', 'pauseUiForSession', 'showSessionLoading', 'markSessionLoadBaseline',
    'syncAgentBrowserVisibility', 'syncPetFocusedSession', 'restoreComposerDraftForSession', 'renderMessages',
    'setEmptyState', 'ensureEarlierMessagesBar', 'syncCurrentSessionAgentUi', 'showTyping',
    'renderRightSidebarReview', 'updateTaskBar', 'updateSendState', 'renderSessionList', 'renderModelBadge',
    'syncAgentInteractionPanel']) context[name] = () => {};
  vm.createContext(context);
  vm.runInContext(renderer.slice(renderer.indexOf('async function loadSession(id)'), renderer.indexOf('async function saveCurrentSession(')), context);
  const b = context.loadSession('B');
  assert.equal(displayed.at(-1), 'loading:B');
  const c = context.loadSession('C');
  assert.equal(displayed.at(-1), 'loading:C');
  pending.C.resolve({ id: 'C', messages: [], workspace: '' });
  await c;
  pending.B.resolve({ id: 'B', messages: [], workspace: '' });
  await b;
  assert.equal(context.state.currentSession.id, 'C');
  assert.equal(context.observerPendingSessionId, '');
  assert.deepEqual(displayed, ['loading:B', 'loading:C', 'record:C']);
});

function pagingContext(session, getPage) {
  const context = { state: { currentSession: session }, sessionHistoryLoads: new WeakMap(), EARLIER_MESSAGES_PAGE: 60,
    api: { getSessionMessages: getPage },
    rebaseRenderedMessageIndices() {}, prependRenderedHistory() {}, ensureEarlierMessagesBar() {}, renderWdMonitor() {} };
  vm.createContext(context);
  vm.runInContext(renderer.slice(renderer.indexOf('async function loadSessionHistoryBackwards('),
    renderer.indexOf('// Run submission must always see the complete conversation')), context);
  return context;
}

test('simultaneous history readers share one page and cannot duplicate messages', async () => {
  const session = { id: 'A', messages: [{ id: 2 }], messagesStart: 2, messagesTruncated: true };
  const result = deferred();
  let calls = 0;
  const context = pagingContext(session, () => { calls++; return result.promise; });
  const a = context.loadSessionHistoryBackwards(session, { render: true, maxPages: 1 });
  const b = context.loadSessionHistoryBackwards(session, { render: true, maxPages: 1 });
  result.resolve({ ok: true, offset: 0, messages: [{ id: 0 }, { id: 1 }] });
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual(Array.from(session.messages, item => item.id), [0, 1, 2]);
  assert.equal(session.messagesStart, 0);
});

test('size-limited suffix pages keep every message and stable observation keys', async () => {
  const rows = Array.from({ length: 6 }, (_, id) => ({ id, role: 'assistant', agentRun: { status: 'done' } }));
  const session = { id: 'A', messages: rows.slice(4), messagesStart: 4, messagesTruncated: true };
  const selected = monitor.availableRuns(session)[0].key;
  const context = pagingContext(session, async (id, offset, limit, options) => {
    assert.equal(options.fromEnd, true);
    const end = offset + limit;
    return { ok: true, offset: end - 1, messages: rows.slice(end - 1, end) };
  });
  await context.loadSessionHistoryBackwards(session);
  assert.deepEqual(Array.from(session.messages, item => item.id), [0, 1, 2, 3, 4, 5]);
  assert.equal(monitor.availableRuns(session)[0].key, selected);
});

test('a non-contiguous legacy page is rejected without losing historical messages', async () => {
  const session = { id: 'A', messages: [{ id: 4 }], messagesStart: 4, messagesTruncated: true };
  const context = pagingContext(session, async () => ({ ok: true, offset: 0, messages: [{ id: 0 }] }));
  await assert.rejects(context.loadSessionHistoryBackwards(session), /历史分页结果不连续/);
  assert.deepEqual(session.messages, [{ id: 4 }]);
  assert.equal(session.messagesStart, 4);
});

test('selecting an earlier saved run remains independent from current and other chats', () => {
  const a = { id: 'A', messages: [
    { role: 'assistant', agentRun: { runId: 'A1', watchdog: { checks: 1 } } },
    { role: 'assistant', agentRun: { runId: 'A2', watchdog: { checks: 2 } } }
  ] };
  const live = { sessionId: 'A', runId: 'A3', activeAgentRun: { watchdog: { checks: 3 } } };
  assert.equal(monitor.selectSession(a, live, 'run:A1').snapshot.checks, 1);
  live.activeAgentRun.watchdog.checks = 4;
  assert.equal(monitor.selectSession(a, live, 'run:A1').snapshot.checks, 1);
  assert.equal(monitor.selectSession(a, live).snapshot.checks, 4);
  assert.equal(monitor.selectSession({ id: 'B', messages: [] }, live, 'run:A1').snapshot, null);
});
