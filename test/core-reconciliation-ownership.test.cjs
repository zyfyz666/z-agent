'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
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

function fixture(blockedPhase) {
  const noop = () => {};
  const entered = deferred();
  const barrier = deferred();
  const session = {
    id: 'fixture-a', title: 'Fixture', messages: [],
    modelSelection: { providerId: 'fixture-provider', supplierId: 'fixture-supplier', modelId: 'fixture-model' }
  };
  const starts = [];
  const saves = [];
  let sequence = 0;
  let summaryCount = 0;
  const context = vm.createContext({
    console: { log: noop }, window: {},
    state: { currentSession: null, config: {}, sessions: [session], queuedTurns: new Map(), activeRuns: new Map() },
    normalizeSkillCalls: value => value,
    ensureFullSessionLoaded: async value => value,
    findPersistedIntentSubmission: () => null,
    isSessionExecutionActive: id => context.state.activeRuns.has(id),
    canStartRun: () => true,
    normalizeModelSelectionSnapshot: value => value,
    getAgentModelSelection: value => value.modelSelection,
    createRunCtx: id => ({ sessionId: id, runId: `fixture-run-${++sequence}`, agentState: {} }),
    setRunModelPresentation: noop, getCurrentAccessMode: () => 'full',
    startPetSupervision: noop, renderSessionList: noop, buildModelSwitchNotice: () => '',
    syncCurrentSessionAgentUi: noop,
    async saveCurrentSession(value) {
      saves.push(structuredClone(value));
      if (blockedPhase === 'save' && saves.length === 2) {
        entered.resolve();
        await barrier.promise;
      }
    },
    runOpenCodeLoop(_session, _element, runCtx) {
      return new Promise((resolve, reject) => {
        runCtx.rejectCompletion = reject;
        starts.push({ runCtx, resolve, reject });
      });
    },
    getActiveAssistantElement: () => null, getActiveAssistantBody: () => null,
    flushOpenCodeStreamDeltas: noop,
    finalizeAgentRun: (_content, status, _active, _body, _error, runCtx) => ({
      runId: runCtx.runId, status, textContent: 'Partial original response'
    }),
    getActiveRun: () => null,
    async attachAgentRunChangeSummary() {
      summaryCount++;
      if (blockedPhase === 'summary' && summaryCount === 1) {
        entered.resolve();
        await barrier.promise;
      }
    },
    syncSessionOpenCodeIdAfterRun: noop, extractMediaAssetsFromAgentRun: () => [],
    persistSessionContextCompression: noop, finishPetSupervision: noop,
    scheduleChatAutoFollow: noop, syncChatAutoFollowUi: noop, currentChatSessionId: () => '',
    syncInterjectionUi: noop, activatePendingAgentHandoff: async () => {}, scheduleQueuedTurnDispatch: noop,
    settleAgentInteractionForRun: noop,
    findActiveRunByRunId(id) {
      for (const [sessionId, entry] of context.state.activeRuns) {
        if (entry.runCtx.runId === id) return { sessionId, entry };
      }
      return null;
    },
    CORE_TERMINAL_RECONCILE_LABELS: { aborted: '中止' },
    upsertOpenCodeTimeline: noop, applyAbortRunUi: noop, updateTaskBar: noop,
    updateSendState: noop, toast: noop, showTyping: noop
  });
  // Exercise the entire production submit/catch/finally path with a real
  // pending completion promise; only persistence and presentation are mocked.
  vm.runInContext(section('async function submitMessage(', 'function agentRunHasCollapsibleWork('), context);
  vm.runInContext(section('function reconcileRunFromCoreTerminal(', 'function abortSessionById('), context);
  return { context, session, starts, saves, entered: entered.promise, release: barrier.resolve };
}

for (const phase of ['summary', 'save']) {
  test(`Core reconciliation retains conversation ownership while interrupted ${phase} is pending`, async () => {
    const f = fixture(phase);
    const first = f.context.submitMessage('Original request', [], [], { session: f.session });
    await until(() => f.starts.length === 1);
    const originalRun = f.starts[0].runCtx;
    f.context.reconcileRunFromCoreTerminal(originalRun.runId, { payload: { turn: { status: 'aborted' } } });
    await f.entered;

    assert.equal(f.context.state.activeRuns.get(f.session.id)?.runCtx, originalRun,
      'An interrupted response must be recorded before another turn can own this conversation');
    const blocked = await f.context.submitMessage('Continue request', [], [], { session: f.session });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'busy');
    assert.equal(f.starts.length, 1);

    f.release();
    await first;
    assert.equal(f.context.state.activeRuns.has(f.session.id), false);
    assert.deepEqual(f.session.messages.map(message => message.content), ['Original request', 'Partial original response']);
    assert.equal(f.saves.at(-1).messages.at(-1).agentRun.runId, originalRun.runId);

    const next = f.context.submitMessage('Continue request', [], [], { session: f.session });
    await until(() => f.starts.length === 2);
    assert.equal(f.context.state.activeRuns.get(f.session.id)?.runCtx, f.starts[1].runCtx);
    f.starts[1].resolve({ content: 'Continued response', agentRun: { status: 'done', runId: f.starts[1].runCtx.runId } });
    await next;
    assert.deepEqual(f.session.messages.map(message => message.content), [
      'Original request', 'Partial original response', 'Continue request', 'Continued response'
    ]);
  });
}

test('Core reconciliation also waits for persistence before releasing a reattached run without a completion promise', async () => {
  const f = fixture('none');
  const entered = deferred();
  const barrier = deferred();
  const runCtx = {
    runId: 'fixture-reattached', sessionId: f.session.id,
    openCodeSessionId: 'fixture-kernel-session', partialContent: 'Recovered partial response', agentState: {}
  };
  f.session.messages.push({ role: 'user', content: 'Original request' });
  f.context.state.activeRuns.set(f.session.id, { runCtx, sessionRef: f.session, assistantEl: null });
  f.context.openCodeResultToAgentRun = (result, run) => ({
    ...result, textContent: result.text, runId: run.runId
  });
  let saves = 0;
  f.context.saveCurrentSession = async () => {
    saves++;
    entered.resolve();
    await barrier.promise;
  };
  vm.runInContext(section('const resumedRunPersistence =', 'async function resumeOpenCodeRunFromDescriptor('), f.context);

  f.context.reconcileRunFromCoreTerminal(runCtx.runId, { payload: { turn: { status: 'aborted' } } });
  await entered.promise;
  assert.equal(f.context.state.activeRuns.get(f.session.id)?.runCtx, runCtx);
  const blocked = await f.context.submitMessage('Continue request', [], [], { session: f.session });
  assert.equal(blocked.error, 'busy');
  f.context.reconcileRunFromCoreTerminal(runCtx.runId, { payload: { turn: { status: 'aborted' } } });
  assert.equal(saves, 1);

  barrier.resolve();
  await until(() => !f.context.state.activeRuns.has(f.session.id));
  assert.deepEqual(f.session.messages.map(message => message.content), ['Original request', 'Recovered partial response']);
  assert.equal(f.session.messages.at(-1).agentRun.openCodeSessionId, 'fixture-kernel-session');
});
