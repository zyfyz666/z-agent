'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');

function section(start, end) {
  const offset = renderer.indexOf(start);
  const finish = renderer.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return renderer.slice(offset, finish);
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const source = { id: 'source', workspace: 'source-folder', messages: [] };
  const target = { id: 'target', workspace: 'target-folder', messages: [] };
  const other = { id: 'other', workspace: 'other-folder', messages: [] };
  const sessions = [source, target, other];
  const toasts = [];
  const saved = [];
  const queued = [];
  const context = {
    console: { error() {} },
    sessionLoadToken: 0,
    observerPendingSessionId: '',
    MESSAGE_LOAD_LIMIT: 40,
    state: { currentSession: source, sessions, activeRuns: new Map() },
    pendingAgentHandoffs: new Map([['source', { targetSessionId: 'target', reused: false }]]),
    api: {
      getSession: async id => sessions.find(session => session.id === id),
      setConfig: async patch => patch
    },
    refreshSessions: async () => {},
    isSessionExecutionActive: id => context.state.activeRuns.has(id),
    toast: message => toasts.push(message),
    getRunCtx: () => null,
    currentChatSessionId: () => context.state.currentSession?.id,
    openCodeResultToAgentRun: (result, runCtx) => ({
      runId: runCtx.runId, status: 'done', textContent: 'Finished source task.', ...result
    }),
    extractMediaAssetsFromAgentRun: () => [],
    saveCurrentSession: async session => saved.push({ id: session.id, count: session.messages.length }),
    scheduleQueuedTurnDispatch: session => queued.push({ id: session.id, selected: context.state.currentSession?.id })
  };
  for (const name of [
    'cancelPromptOptimization', 'closeModelPicker', 'closeReasoningPicker',
    'captureComposerDraftForSession', 'pauseUiForSession', 'showSessionLoading',
    'markSessionLoadBaseline', 'markSessionForkMessagesSaved', 'syncAgentBrowserVisibility', 'syncPetFocusedSession',
    'restoreComposerDraftForSession', 'renderMessages', 'setEmptyState',
    'ensureEarlierMessagesBar', 'syncCurrentSessionAgentUi', 'showTyping',
    'renderRightSidebarReview', 'updateTaskBar', 'updateSendState', 'renderSessionList',
    'renderWdMonitor', 'renderWdMonitorLoading', 'renderModelBadge', 'syncSessionOpenCodeIdAfterRun',
    'attachAgentRunChangeSummary', 'persistSessionContextCompression',
    'syncChatAutoFollowUi', 'finishPetSupervision', 'syncAgentInteractionPanel', 'settleAgentInteractionForRun'
  ]) context[name] = () => {};
  vm.createContext(context);
  for (const code of [
    section('async function loadSession(id)', 'async function saveCurrentSession('),
    section('async function activatePendingAgentHandoff(', 'api.onSessionAgentCommand'),
    section('async function persistResumedOpenCodeRunOnce(', 'async function resumeOpenCodeRunFromDescriptor(')
  ]) vm.runInContext(code, context);
  return { context, source, target, other, toasts, saved, queued };
}

test('handoff is completed only after the target conversation is selected', async () => {
  const f = fixture();
  assert.equal(await f.context.activatePendingAgentHandoff('source'), true);
  assert.equal(f.context.state.currentSession.id, 'target');
  assert.equal(f.context.pendingAgentHandoffs.has('source'), false);
  assert.deepEqual(f.toasts, ['已进入新的工作区任务']);
});

test('a failed conversation load retains the pending handoff without a success toast', async () => {
  const f = fixture();
  f.context.api.getSession = async () => { throw new Error('Temporary session read failure'); };
  assert.equal(await f.context.activatePendingAgentHandoff('source'), false);
  assert.equal(f.context.state.currentSession.id, 'source');
  assert.equal(f.context.pendingAgentHandoffs.get('source').targetSessionId, 'target');
  assert.deepEqual(f.toasts, []);

  f.context.api.getSession = async () => f.target;
  assert.equal(await f.context.activatePendingAgentHandoff('source'), true);
  assert.equal(f.context.state.currentSession.id, 'target');
});

test('a user selection superseding a slow handoff load does not falsely complete the handoff', async () => {
  const f = fixture();
  const loadingTarget = deferred();
  const targetResponse = deferred();
  f.context.api.getSession = async id => {
    if (id === 'target') {
      loadingTarget.resolve();
      return targetResponse.promise;
    }
    return f.other;
  };
  const handoff = f.context.activatePendingAgentHandoff('source');
  await loadingTarget.promise;
  await f.context.loadSession('other');
  targetResponse.resolve(f.target);
  assert.equal(await handoff, false);
  assert.equal(f.context.state.currentSession.id, 'other');
  assert.equal(f.context.pendingAgentHandoffs.has('source'), true);
  assert.deepEqual(f.toasts, []);
});

test('a recovered foreground run activates its handoff after saving and releasing the run', async () => {
  const f = fixture();
  const runCtx = { runId: 'recovered-run', startedAt: Date.now() };
  f.context.state.activeRuns.set('source', { runCtx });
  assert.equal(await f.context.activatePendingAgentHandoff('source'), false);
  f.context.api.getSession = async () => {
    assert.deepEqual(f.saved, [{ id: 'source', count: 1 }]);
    assert.equal(f.context.state.activeRuns.has('source'), false);
    return f.target;
  };
  await f.context.persistResumedOpenCodeRunOnce(f.source, runCtx, {});
  assert.equal(f.context.state.currentSession.id, 'target');
  assert.equal(f.context.pendingAgentHandoffs.has('source'), false);
  assert.deepEqual(f.toasts, ['已进入新的工作区任务']);
  assert.deepEqual(f.queued, [{ id: 'source', selected: 'target' }]);
});

test('a recovered background run preserves the user selected conversation and pending handoff', async () => {
  const f = fixture();
  const runCtx = { runId: 'background-run', startedAt: Date.now() };
  f.context.state.currentSession = f.other;
  f.context.state.activeRuns.set('source', { runCtx });
  await f.context.persistResumedOpenCodeRunOnce(f.source, runCtx, {});
  assert.equal(f.context.state.activeRuns.has('source'), false);
  assert.equal(f.context.state.currentSession.id, 'other');
  assert.equal(f.context.pendingAgentHandoffs.has('source'), true);
  assert.deepEqual(f.toasts, []);
  assert.deepEqual(f.saved, [{ id: 'source', count: 1 }]);
});
