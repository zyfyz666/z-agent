'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start); return source.slice(from, to);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) {
  for (let turn = 0; turn < 100 && !check(); turn++) await Promise.resolve();
  assert.ok(check(), 'asynchronous test progress');
}
function fixture() {
  const a = { id: 'A', messages: [], conversationRevision: 2 }, b = { id: 'B', messages: [], conversationRevision: 0 };
  const runCtx = { runId: 'run-A', sessionId: 'A', sessionRef: a, modelSelection: { modelType: 'text' } };
  const calls = [], prepared = [], writes = [], drafts = { A: 'A unsent draft', B: 'B unsent draft' };
  let counter = 0, prepareResult = { ok: true };
  const ctx = {
    state: { currentSession: a, queuedTurns: new Map(), activeRuns: new Map([['A', { runCtx, sessionRef: a }]]), attachments: [], selectedSkills: [], selectedSubagents: [] },
    createQueuedTurnId: () => `fixture-${++counter}`,
    api: { zCorePrepareGuidanceIntent: async payload => { prepared.push(payload); return prepareResult; },
      openCodeSteerRun: payload => { const response = deferred(); calls.push({ payload, response }); return response.promise; } },
    invokeZCore: async (name, ...args) => { writes.push({ name, args }); return { ok: true }; },
    saveCurrentSession: async () => {}, captureLiveGuidanceDisplayBoundary() {}, appendMessage() {}, renderOpenCodeRunNow() {},
    normalizeModelSelectionSnapshot: value => ({ ...value }), getAgentModelSelection: () => ({ modelType: 'text' }),
    getComposerText: () => drafts[ctx.state.currentSession.id], syncComposerSkillsFromDom() {}, syncComposerSubagentsFromDom() {},
    clearComposerPayload: () => { drafts[ctx.state.currentSession.id] = ''; },
    syncQueuedTurnUi() {}, updateSendState() {}, refreshLiveGuidanceStatus() {}, toast() {},
    isSessionExecutionActive: id => ctx.state.activeRuns.has(id), scheduleQueuedTurnDispatch() {}, console
  };
  vm.createContext(ctx);
  vm.runInContext(section('function queuedTurnsForSession(', 'function syncQueuedTurnUi('), ctx);
  vm.runInContext(section('function queuedTurnGuidanceUnavailable(', 'function clearComposerPayload('), ctx);
  vm.runInContext(section('function applyLiveGuidanceStatus(', 'async function steerCurrentComposerTurn('), ctx);
  vm.runInContext(section('async function steerCurrentComposerTurn(', 'function queueCurrentComposerTurn('), ctx);
  vm.runInContext(section('async function steerQueuedTurn(', 'function editCurrentQueuedTurn('), ctx);
  const add = (id, queuedAt, options = {}) => {
    const turn = { id, sessionRef: a, conversationRevision: 2, text: id, attachments: [], skillCalls: [], subagentRoles: [],
      modelSelection: { modelType: 'text' }, queuedAt, ...options };
    ctx.insertQueuedTurn(turn); return turn;
  };
  return { ctx, a, b, runCtx, calls, prepared, writes, drafts, add, setPrepareResult: value => { prepareResult = value; } };
}

test('converting an arbitrary queued card preserves its attachment, other queued messages and drafts', async () => {
  const f = fixture(); f.add('first', 1);
  const promoted = f.add('middle', 2, { attachments: [{ path: 'C:/synthetic/image.png', name: 'image.png', mimeType: 'image/png' }] });
  f.add('last', 3);
  const conversion = f.ctx.steerQueuedTurn('A', promoted.id);
  assert.equal(await f.ctx.steerQueuedTurn('A', promoted.id), false, 'duplicate click does not begin a second conversion');
  await until(() => f.calls.length === 1);
  f.ctx.state.currentSession = f.b;
  f.calls[0].response.resolve({ ok: true, accepted: true });
  assert.equal(await conversion, true);
  assert.equal(f.calls[0].payload.zSessionId, 'A');
  assert.equal(f.calls[0].payload.attachments[0].path, 'C:/synthetic/image.png');
  assert.deepEqual(Array.from(f.ctx.queuedTurnsForSession('A'), item => item.id), ['first', 'last']);
  assert.deepEqual(f.drafts, { A: 'A unsent draft', B: 'B unsent draft' });
  assert.equal(f.a.messages[0].liveGuidance.status, 'queued');
  assert.equal(f.a.messages[0].liveGuidance.queueIntentId, 'middle');
  assert.equal(f.b.messages.length, 0);
  assert.equal(f.writes.some(write => write.name === 'zCoreAckIntent'), false, 'kernel acceptance is not a provider receipt');
  f.ctx.applyLiveGuidanceStatus(f.runCtx, { type: 'z.guidance.status', data: { requestId: f.calls[0].payload.requestId,
    status: 'delivered', deliveryEvidence: 'provider-response' } });
  assert.equal(f.a.messages[0].liveGuidance.status, 'delivered');
  assert.equal(f.writes.some(write => write.name === 'zCoreAckIntent' && write.args[0] === 'middle'), true);
});

test('ordinary queued messages have no guidance source even when the session contains normal user history', () => {
  const f = fixture(); f.a.messages.push({ role: 'user', content: 'ordinary history' });
  const queued = f.add('queued', 1);
  assert.equal(f.ctx.queuedGuidanceSource(queued), undefined);
  assert.equal(f.ctx.queuedTurnGuidanceUnavailable(queued, 'A'), '');
});

test('prepare rejection leaves the original queue intact without adding a guidance message', async () => {
  const f = fixture(); const queued = f.add('original', 1);
  f.setPrepareResult({ ok: false, error: 'Task stopped' });
  assert.equal(await f.ctx.steerQueuedTurn('A', queued.id), false);
  assert.equal(f.calls.length, 0); assert.equal(f.a.messages.length, 0);
  assert.equal(f.ctx.queuedTurnsForSession('A')[0], queued);
  assert.equal(queued.steering, undefined);
});

test('rejected or uncertain delivery preserves the original queued intent for verification', async () => {
  const f = fixture(); const queued = f.add('original', 1);
  const conversion = f.ctx.steerQueuedTurn('A', queued.id);
  await until(() => f.calls.length === 1);
  f.calls[0].response.resolve({ ok: false, error: 'Receipt unavailable' });
  assert.equal(await conversion, false);
  assert.equal(f.ctx.queuedTurnsForSession('A')[0], queued);
  assert.equal(f.a.messages[0].liveGuidance.continuationIntentId, 'original');
  assert.equal(f.a.messages[0].liveGuidance.continuationStatus, 'pending');
  assert.equal(f.writes.some(write => write.name === 'zCoreRequeueIntent' && write.args[0] === 'original'), true);
  assert.equal(await f.ctx.steerQueuedTurn('A', queued.id), false, 'uncertain delivery cannot be sent twice');
  assert.equal(f.calls.length, 1);
});

test('ending a run without a provider receipt restores its promoted message in original queue order', async () => {
  const f = fixture(); f.add('first', 1); const promoted = f.add('middle', 2); f.add('last', 3);
  const conversion = f.ctx.steerQueuedTurn('A', promoted.id);
  await until(() => f.calls.length === 1); f.calls[0].response.resolve({ ok: true, accepted: true });
  await conversion;
  f.ctx.settleLiveGuidanceStatuses(f.runCtx);
  assert.deepEqual(Array.from(f.ctx.queuedTurnsForSession('A'), item => item.id), ['first', 'middle', 'last']);
  assert.equal(f.a.messages[0].liveGuidance.continuationIntentId, 'middle');
  assert.equal(f.writes.some(write => write.name === 'zCoreRequeueIntent' && write.args[0] === 'middle'), true);
});

test('a replaced run is never used after the conversion preparation awaits', async () => {
  const f = fixture(); const queued = f.add('original', 1);
  const gate = deferred(); f.ctx.api.zCorePrepareGuidanceIntent = () => gate.promise;
  const conversion = f.ctx.steerQueuedTurn('A', queued.id);
  f.ctx.state.activeRuns.set('A', { runCtx: { ...f.runCtx, runId: 'run-replacement' }, sessionRef: f.a });
  gate.resolve({ ok: true }); await conversion;
  assert.equal(f.calls.length, 0); assert.equal(f.a.messages.length, 0);
  assert.equal(f.ctx.queuedTurnsForSession('A')[0], queued);
});
