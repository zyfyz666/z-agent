'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { projectHistoryForModel } = require('../lib/history-model-context');
const { detachedHistoryMessage } = require('../lib/session-fork');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const session = { id: 'task-a', conversationRevision: 2, messages: [] };
  const other = { id: 'task-b', conversationRevision: 1, messages: [] };
  const records = {}, submissions = [], ipc = [], notices = [], timers = [], saves = [];
  let counter = 0, enqueueResult, submit, detach;
  const runCtx = { runId: 'run-a', sessionId: session.id, sessionRef: session,
    modelSelection: { providerId: 'p', modelId: 'm', reasoningEffort: 'high', modelType: 'text' } };
  const state = { currentSession: session, sessions: [session, other], queuedTurns: new Map(),
    activeRuns: new Map([[session.id, { runCtx, sessionRef: session }]]) };
  const context = vm.createContext({
    state, console, queueMicrotask, setTimeout: callback => { timers.push(callback); },
    api: {
      zCoreConsumeIntent() {},
      zCoreGetState: async () => ({ intents: records }),
      openCodeDetachPendingGuidance: async payload => {
        ipc.push({ method: 'detach', payload: structuredClone(payload) });
        return detach ? detach(payload) : { ok: true, items: payload.requestIds.map(requestId => ({ requestId, status: 'detached' })) };
      }
    },
    invokeZCore: async (method, ...args) => {
      ipc.push({ method, args: structuredClone(args) });
      if (method === 'zCoreEnqueueIntent') {
        const payload = args[0];
        if (enqueueResult) return enqueueResult(payload);
        records[payload.intentId] = { id: payload.intentId, threadId: payload.threadId, intent: payload.intent,
          conversationRevision: payload.conversationRevision, status: 'queued', createdAt: payload.intent.queuedAt };
        return { ok: true };
      }
      const record = records[args[0]];
      if (method === 'zCoreConsumeIntent') {
        if (!record || record.status !== 'queued') return { ok: false };
        record.status = 'consumed'; record.dispatchingAt = Date.now(); return { ok: true };
      }
      if (method === 'zCoreRequeueIntent' && record) record.status = 'queued';
      if (method === 'zCoreAckIntent' && record) record.status = 'dispatched';
      if (method === 'zCoreDeleteIntent' && record) record.status = 'deleted';
      if (method === 'zCoreGetState') return { intents: records };
      return { ok: true };
    },
    normalizeModelSelectionSnapshot: value => structuredClone(value),
    getAgentModelSelection: () => structuredClone(runCtx.modelSelection),
    createQueuedTurnId: () => `continued-${++counter}`,
    saveCurrentSession: async value => { saves.push(structuredClone(value)); },
    refreshLiveGuidanceStatus() {}, syncQueuedTurnUi() {}, updateSendState() {},
    toast: value => notices.push(value),
    ensureFullSessionLoaded: async () => {},
    isSessionExecutionActive: id => state.activeRuns.has(id),
    getRunCtx: id => state.activeRuns.get(id)?.runCtx,
    settleAgentInteractionForRun() {}, applyAbortRunUi() {}, finishPetSupervision() {},
    dispatchRunCancel: ctx => ipc.push({ method: 'cancel', runId: ctx.runId }),
    window: { z: {} },
    submitMessage: async (text, attachments, skills, options) => {
      submissions.push({ text, attachments: structuredClone(attachments), skills, options });
      if (submit) return submit(text, attachments, skills, options);
      options.session.messages.push({ role: 'user', content: text, attachments, intentId: options.intentId },
        { role: 'assistant', content: `answer for ${text}` });
      return { ok: true };
    }
  });
  vm.runInContext(section('function queuedTurnsForSession(', 'function syncQueuedTurnUi('), context);
  vm.runInContext(section('async function hydrateQueuedTurns(', 'async function listRecoveredZCoreTurns('), context);
  vm.runInContext(section('function applyLiveGuidanceStatus(', 'async function steerCurrentComposerTurn('), context);
  vm.runInContext(section('function abortSessionById(', 'function applyAbortRunUi('), context);
  vm.runInContext(section('const queuedTurnDispatching =', '// 核心发送流程'), context);
  const enqueue = (id, at, extra = {}) => context.enqueueQueuedTurn({ id, queuedAt: at, sessionRef: session,
    conversationRevision: 2, text: id, attachments: [{ name: `${id}.png`, path: `/${id}.png` }],
    skillCalls: [{ id: `${id}-skill` }], subagentRoles: ['reviewer'], modelSelection: { ...runCtx.modelSelection }, ...extra });
  const guide = (id, at, delivered = false) => {
    const message = { role: 'user', content: id, ts: at, attachments: [{ name: `${id}.png`, path: `/${id}.png` }],
      modelSelection: { ...runCtx.modelSelection }, liveGuidance: { requestId: id, runId: runCtx.runId,
        status: delivered ? 'delivered' : 'queued', ...(delivered ? { deliveryEvidence: 'provider-response' } : {}) } };
    session.messages.push(message);
    return message;
  };
  const drain = async () => { await tick(); for (let count = 0; timers.length && count < 10; count++) { timers.shift()(); await tick(); } };
  return { context, state, session, other, runCtx, records, submissions, ipc, notices, saves, timers, enqueue, guide, drain,
    setEnqueue: value => { enqueueResult = value; }, setSubmit: value => { submit = value; }, setDetach: value => { detach = value; } };
}

test('several queued sends preserve separate frozen inputs and hydrate every intent in order', async () => {
  const f = fixture();
  f.enqueue('later', 30); f.enqueue('earlier', 10); f.enqueue('middle', 20);
  await tick();
  assert.deepEqual(Array.from(f.context.queuedTurnsForSession(f.session.id), item => item.id), ['earlier', 'middle', 'later']);
  assert.equal(Object.keys(f.records).length, 3);
  f.state.queuedTurns.clear();
  await f.context.hydrateQueuedTurns();
  const turns = Array.from(f.context.queuedTurnsForSession(f.session.id));
  assert.deepEqual(turns.map(item => item.id), ['earlier', 'middle', 'later']);
  assert.equal(turns[1].attachments[0].path, '/middle.png');
  assert.equal(turns[1].subagentRoles[0], 'reviewer');
  assert.equal(turns[1].modelSelection.reasoningEffort, 'high');
});

test('stop preserves queued turns, forwards only pending guidance in timestamp order, and keeps prior work', async () => {
  const f = fixture();
  f.session.messages.push({ role: 'user', content: 'original task' });
  f.guide('delivered', 5, true);
  f.enqueue('queue-one', 10);
  const pending = f.guide('pending-guide', 20);
  f.enqueue('queue-two', 30);
  f.context.abortSessionById(f.session.id);
  f.context.abortSessionById(f.session.id);
  assert.equal(f.ipc.filter(item => item.method === 'cancel').length, 1);
  assert.equal(f.context.queuedTurnsForSession(f.session.id).length, 3);
  f.context.scheduleQueuedTurnDispatch(f.session);
  await tick();
  assert.equal(f.submissions.length, 0);
  assert.equal(f.ipc.filter(item => item.method === 'detach').length, 0);
  f.session.messages.push({ role: 'assistant', content: 'partial work before stop', agentRun: { status: 'interrupted' } });
  f.state.activeRuns.delete(f.session.id);
  f.context.scheduleQueuedTurnDispatch(f.session);
  await f.drain();
  assert.deepEqual(f.submissions.map(item => item.text), ['queue-one', 'pending-guide', 'queue-two']);
  assert.equal(f.submissions[1].attachments[0].path, '/pending-guide.png');
  assert.equal(pending.liveGuidance.continuationStatus, 'dispatched');
  assert.equal(pending.liveGuidance.nativeDetached, true);
  assert.ok(f.session.messages.some(message => message.content === 'partial work before stop'));
  assert.equal(f.state.queuedTurns.size, 0);
});

test('a receipt arriving during cancellation removes its placeholder and never resends delivered guidance', async () => {
  const f = fixture();
  const guide = f.guide('late-receipt', 10);
  f.context.abortSessionById(f.session.id);
  f.context.applyLiveGuidanceStatus(f.runCtx, { type: 'z.guidance.status', data: {
    requestId: 'late-receipt', status: 'delivered', deliveryEvidence: 'provider-response', deliveredAt: 50
  } });
  f.state.activeRuns.clear();
  f.context.scheduleQueuedTurnDispatch(f.session);
  await f.drain();
  assert.equal(f.submissions.length, 0);
  assert.equal(f.state.queuedTurns.size, 0);
  assert.equal(guide.liveGuidance.continuationStatus, 'delivered');
});

test('backend delivered proof excludes a guidance item even when the renderer missed its event', async () => {
  const f = fixture();
  const guide = f.guide('missed-receipt', 10);
  f.enqueue('normal-followup', 20);
  f.context.abortSessionById(f.session.id);
  f.setDetach(payload => ({ items: payload.requestIds.map(requestId => ({ requestId, status: 'delivered' })) }));
  f.state.activeRuns.clear();
  f.context.scheduleQueuedTurnDispatch(f.session);
  await f.drain();
  assert.deepEqual(f.submissions.map(item => item.text), ['normal-followup']);
  assert.equal(guide.liveGuidance.deliveryEvidence, 'provider-response');
});

test('stop before native insertion can continue the saved text and image exactly once', async () => {
  const f = fixture();
  const guide = f.guide('saving-guide', 10);
  guide.liveGuidance.status = 'pending';
  f.context.abortSessionById(f.session.id);
  f.setDetach(payload => ({ items: payload.requestIds.map(requestId => ({ requestId, status: 'not-inserted' })) }));
  f.context.settleLiveGuidanceStatuses(f.runCtx);
  assert.equal(guide.liveGuidance.status, 'pending');
  f.state.activeRuns.clear();
  f.context.scheduleQueuedTurnDispatch(f.session);
  await f.drain();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].attachments[0].name, 'saving-guide.png');
});

test('unconfirmed native removal blocks the session queue and retains every item for retry', async () => {
  const f = fixture();
  const guide = f.guide('uncertain-guide', 20);
  f.enqueue('earlier-followup', 10);
  f.context.abortSessionById(f.session.id);
  f.setDetach(() => ({ error: 'native session still busy' }));
  f.state.activeRuns.clear();
  f.context.scheduleQueuedTurnDispatch(f.session);
  await tick();
  assert.equal(f.submissions.length, 0);
  assert.equal(f.context.queuedTurnsForSession(f.session.id).length, 2);
  assert.equal(guide.liveGuidance.continuationStatus, 'failed');
  assert.equal(f.notices.length, 2); // stop notice plus actionable reconciliation notice
});

test('failed submission is reinserted before later queued turns without overwriting them', async () => {
  const f = fixture();
  f.enqueue('first', 10); f.enqueue('second', 20);
  f.setSubmit(async () => ({ ok: false, error: 'busy' }));
  f.state.activeRuns.clear();
  f.context.scheduleQueuedTurnDispatch(f.session);
  await tick();
  assert.deepEqual(Array.from(f.context.queuedTurnsForSession(f.session.id), item => item.id), ['first', 'second']);
  assert.equal(f.records.first.status, 'queued');
});

test('dispatch waits for durable enqueue acknowledgement before consuming', async () => {
  const f = fixture(), held = deferred();
  f.setEnqueue(async payload => { await held.promise; f.records[payload.intentId] = {
    id: payload.intentId, threadId: payload.threadId, status: 'queued', intent: payload.intent
  }; return { ok: true }; });
  f.enqueue('slow-save', 10);
  f.state.activeRuns.clear();
  f.context.scheduleQueuedTurnDispatch(f.session);
  await tick();
  assert.equal(f.ipc.filter(item => item.method === 'zCoreConsumeIntent').length, 0);
  held.resolve(); await f.drain();
  assert.equal(f.submissions.length, 1);
});

test('recovery acknowledges an already completed head and continues later intents without replay', async () => {
  const f = fixture();
  f.enqueue('completed-before-reload', 10); f.enqueue('still-waiting', 20);
  await tick();
  f.records['completed-before-reload'].status = 'consumed';
  f.records['completed-before-reload'].dispatchingAt = Date.now();
  f.session.messages.push({ role: 'user', content: 'completed-before-reload', intentId: 'completed-before-reload' },
    { role: 'assistant', content: 'previous completion' });
  f.state.queuedTurns.clear();
  await f.context.hydrateQueuedTurns();
  f.state.activeRuns.clear();
  f.context.scheduleQueuedTurnDispatch(f.session);
  await f.drain();
  assert.deepEqual(f.submissions.map(item => item.text), ['still-waiting']);
  assert.equal(f.records['completed-before-reload'].status, 'dispatched');
});

test('a stale head acknowledgement cannot discard later queued inputs', async () => {
  const f = fixture();
  const head = f.enqueue('old-revision', 10), next = f.enqueue('new-revision', 20);
  assert.equal(f.context.discardStaleQueuedTurn(f.session.id, head, { code: 'SESSION_REVISION_CHANGED' }), true);
  assert.equal(f.state.queuedTurns.get(f.session.id), next);
  await tick();
});

test('stopping one conversation cannot touch another conversation queue or pending guidance', async () => {
  const f = fixture();
  const otherRun = { runId: 'other-run', sessionId: f.other.id, sessionRef: f.other };
  f.state.activeRuns.set(f.other.id, { runCtx: otherRun, sessionRef: f.other });
  f.other.messages.push({ role: 'user', content: 'other guide', liveGuidance: { runId: 'other-run', requestId: 'other-guide', status: 'queued' } });
  f.enqueue('other-queue', 2, { sessionRef: f.other, conversationRevision: 1 });
  f.guide('this-guide', 10);
  f.context.abortSessionById(f.session.id);
  assert.equal(otherRun.shouldAbort, undefined);
  assert.equal(f.other.messages[0].liveGuidance.continuationIntentId, undefined);
  assert.equal(f.state.queuedTurns.get(f.other.id).id, 'other-queue');
});

test('native session reconstruction excludes detached guidance audits while preserving work and confirmed delivered guidance', () => {
  const original = [
    { role: 'user', content: 'task' },
    { role: 'user', content: 'old pending copy', liveGuidance: { continuationIntentId: 'next', nativeDetached: true, continuationStatus: 'queued' } },
    { role: 'assistant', content: 'partial work' },
    { role: 'user', content: 'forwarded text', intentId: 'next' },
    { role: 'user', content: 'real delivered guide', liveGuidance: { continuationIntentId: 'late', nativeDetached: true, deliveryEvidence: 'provider-response' } }
  ];
  const projected = projectHistoryForModel(original);
  assert.deepEqual(projected.map(item => item.content), ['task', 'partial work', 'forwarded text', 'real delivered guide']);
  assert.equal(original.length, 5);
  const detached = original.map((message, index) => detachedHistoryMessage(message, 'source', index));
  assert.equal(detached[1].liveGuidance.continuationIntentId, undefined);
  assert.equal(detached[1].liveGuidance.continuationStatus, 'queued');
  assert.deepEqual(projectHistoryForModel(detached).map(item => item.content), projected.map(item => item.content));
});
