'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('const openCodeSteeringRequests =');
const end = source.indexOf("ipcMain.handle('opencode:interject',", start);
assert.ok(start >= 0 && end > start);
const request = (overrides = {}) => ({ runId: 'run-a', zSessionId: 'sess_alpha', requestId: 'message-1', text: 'Keep the public API unchanged.', ...overrides });

function fixture(deliver) {
  const calls = [];
  const active = { zSessionId: 'sess_alpha', visionAbortController: new AbortController() };
  const runs = new Map([['run-a', active]]);
  const kernels = new Set(['run-a']);
  const handlers = new Map();
  const context = vm.createContext({
    crypto,
    require: name => require(path.join('..', name)),
    openCodeActiveRuns: runs,
    openCodeRunReconcile: new Map([['run-a', { meta: { zSessionId: 'sess_alpha' } }]]),
    openCodeSidecar: {
      hasRun: id => kernels.has(id),
      async deliverInterjection(runId, analysis) {
        calls.push({ runId, analysis });
        return deliver ? deliver(runId, analysis) : { ok: true, accepted: true, delivered: false, version: calls.length, phase: 'work' };
      },
      analyzeInterjection() { throw new Error('live steering must not call an auxiliary model'); }
    },
    loadConfig() { throw new Error('live steering must not select another model'); },
    saveConfig() { throw new Error('live steering must not write configuration'); },
    readSessionRecord() { throw new Error('the frontend owns durable user-message persistence'); },
    ipcMain: { handle(name, callback) { handlers.set(name, callback); } }
  });
  vm.runInContext(source.slice(start, end), context);
  return { calls, active, runs, kernels, send: payload => handlers.get('opencode:steer-run')(null, payload),
    detach: payload => handlers.get('opencode:detach-pending-guidance')(null, payload), context };
}

test('live guidance directly reaches the active kernel with exact session ownership and no auxiliary classification', async () => {
  const f = fixture();
  const result = await f.send(request());
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.equal(result.delivered, false);
  assert.equal(result.requestId, 'message-1');
  assert.equal(result.zSessionId, 'sess_alpha');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [{ runId: 'run-a', analysis: {
    kind: 'guidance', guidance: request().text, requestId: request().requestId, requestFinish: false, hardCancel: false, source: 'user'
  } }]);
});

test('concurrent retries and later acknowledgement retries share one delivery and the same receipt', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture(() => pending);
  const first = f.send(request());
  const concurrent = f.send(request());
  assert.equal(first, concurrent);
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  resolve({ ok: true, accepted: true, delivered: false, version: 7 });
  const result = await first;
  assert.equal(await concurrent, result);
  f.runs.delete('run-a');
  assert.equal(await f.send(request()), result, 'a retry can recover an already acknowledged receipt after completion');
  assert.equal(f.calls.length, 1);
});

test('reusing a message id for different text is rejected and cannot inject a second message', async () => {
  const f = fixture();
  await f.send(request());
  const conflict = await f.send(request({ text: 'Different instruction' }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.delivered, false);
  assert.equal(conflict.code, 'STEERING_REQUEST_CONFLICT');
  assert.equal(f.calls.length, 1);
});

test('another conversation cannot steer this run and distinct messages are delivered independently', async () => {
  const f = fixture();
  const wrong = await f.send(request({ zSessionId: 'sess_other' }));
  assert.equal(wrong.code, 'STEERING_SESSION_MISMATCH');
  assert.equal(f.calls.length, 0);
  const [first, second] = await Promise.all([
    f.send(request()), f.send(request({ requestId: 'message-2', text: 'Also retain the tests.' }))
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(f.calls.length, 2);
  assert.notEqual(first.requestId, second.requestId);
});

test('empty, finished, cancelled, and not-yet-started runs report failure without claiming delivery', async () => {
  for (const state of ['empty', 'finished', 'cancelled', 'kernel-missing']) {
    const f = fixture();
    if (state === 'finished') f.runs.clear();
    if (state === 'cancelled') f.active.visionAbortController.abort();
    if (state === 'kernel-missing') f.kernels.clear();
    const result = await f.send(request(state === 'empty' ? { text: '   ' } : {}));
    assert.equal(result.ok, false, state);
    assert.equal(result.delivered, false, state);
    assert.equal(f.calls.length, 0, state);
  }
});

for (const state of ['finished', 'cancelled', 'replaced']) {
  test(`a run ${state} during kernel delivery does not get a false success acknowledgement`, async () => {
    let resolve;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    const pending = f.send(request());
    await Promise.resolve();
    if (state === 'finished') f.runs.clear();
    if (state === 'cancelled') f.active.visionAbortController.abort();
    if (state === 'replaced') f.runs.set('run-a', { zSessionId: 'sess_other' });
    resolve({ ok: true, accepted: true, delivered: false, version: 1 });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.equal(result.code, 'STEERING_STALE');
  });
}

test('missing kernel acknowledgement and thrown delivery errors are explicit failures', async () => {
  for (const deliver of [() => ({ ok: true, delivered: false }), () => { throw new Error('fixture delivery failed'); }]) {
    const f = fixture(deliver);
    const result = await f.send(request());
    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.equal(result.code, 'STEERING_DELIVERY_FAILED');
    assert.equal(await f.send(request()), result);
    assert.equal(f.calls.length, 1);
  }
});

test('attachments are immutable, included in idempotence, and relayed using the active run model', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-live-guidance-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const image = path.join(temporary, 'diagram.png');
  fs.writeFileSync(image, Buffer.from([137, 80, 78, 71]));
  const f = fixture();
  f.context.filesDir = temporary;
  const cfg = { permissions: { allowFileRead: true }, api: { visionRelayEnabled: true } };
  const selection = { modelId: 'active-text-model' };
  f.active.guidanceConfig = cfg;
  f.active.selection = selection;
  let relayed = 0;
  f.context.relayImagesForTextModel = async (actualCfg, actualSelection, request) => {
    assert.equal(actualCfg, cfg); assert.equal(actualSelection, selection);
    assert.equal(request.attachments[0].path, image);
    relayed += 1;
    return { prompt: `${request.prompt}\nVisual description`, attachments: [] };
  };
  const payload = request({ text: '', attachments: [{ path: image, name: 'diagram.png', mimeType: 'image/png' }] });
  const snapshot = JSON.parse(JSON.stringify(payload));
  const pending = f.send(payload);
  payload.attachments[0].path = 'do-not-read-this';
  const result = await pending;
  assert.equal(result.accepted, true);
  assert.match(f.calls[0].analysis.guidance, /Visual description/);
  assert.equal(await f.send(snapshot), result);
  assert.equal(relayed, 1);
  assert.equal((await f.send({ ...snapshot, attachments: [{ ...snapshot.attachments[0], name: 'different.png' }] })).code, 'STEERING_REQUEST_CONFLICT');
});

test('missing, outside-upload, and denied attachments fail before delivery', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-guidance-invalid-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const uploads = path.join(temporary, 'uploads'); fs.mkdirSync(uploads);
  const outside = path.join(temporary, 'outside.txt'); fs.writeFileSync(outside, 'private');
  for (const kind of ['missing', 'outside', 'denied']) {
    const f = fixture(); f.context.filesDir = uploads;
    f.active.guidanceConfig = { permissions: { allowFileRead: kind !== 'denied' } };
    const result = await f.send(request({ attachments: [{ path: kind === 'missing' ? path.join(uploads, 'missing.txt') : outside }] }));
    assert.equal(result.ok, false, kind); assert.equal(f.calls.length, 0, kind);
  }
});

test('stopping during image preparation cannot insert guidance into the cancelled run', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-guidance-cancel-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'photo.png'); fs.writeFileSync(file, 'fixture');
  const f = fixture(); f.context.filesDir = temporary;
  f.active.guidanceConfig = { permissions: { allowFileRead: true } };
  let finishRelay;
  f.context.relayImagesForTextModel = () => new Promise(resolve => { finishRelay = resolve; });
  const pending = f.send(request({ attachments: [{ path: file, mimeType: 'image/png' }] }));
  await Promise.resolve();
  f.active.visionAbortController.abort();
  finishRelay({ prompt: 'description', attachments: [] });
  assert.equal((await pending).code, 'STEERING_STALE');
  assert.equal(f.calls.length, 0);
  f.runs.clear(); f.kernels.clear();
  assert.equal((await f.detach({ ...request(), requestIds: ['message-1'] })).items[0].status, 'not-inserted');
});

test('stop continuation ownership is checked and insertion acknowledgement must finish first', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.send(request()); await Promise.resolve();
  f.runs.clear(); f.kernels.clear();
  const payload = { runId: 'run-a', zSessionId: 'sess_alpha', requestIds: ['message-1'] };
  assert.equal((await f.detach({ ...payload, zSessionId: 'sess_wrong' })).items[0].status, 'failed');
  assert.equal((await f.detach(payload)).items[0].status, 'pending');
  finish({ ok: true, accepted: true, delivered: false }); await pending;
  f.context.openCodeSidecar.detachPendingGuidance = async value => {
    assert.equal(value.runId, 'run-a');
    return [{ requestId: 'message-1', status: 'detached' }];
  };
  assert.equal((await f.detach(payload)).items[0].status, 'detached');
});

test('expired or unknown receipt caches never make a previously submitted guide safe to resend', async () => {
  const payload = { runId: 'run-a', zSessionId: 'sess_alpha', requestIds: ['message-1'] };
  const f = fixture(); await f.send(request());
  vm.runInContext('openCodeSteeringRequests.clear()', f.context);
  assert.equal((await f.send(request())).code, 'STEERING_RECEIPT_EXPIRED');
  f.runs.clear(); f.kernels.clear();
  assert.equal((await f.detach(payload)).items[0].status, 'failed');
  assert.equal((await f.detach({ ...payload, requestIds: ['never-submitted'] })).items[0].status, 'not-inserted');
  vm.runInContext('openCodeGuidanceRuns.clear()', f.context);
  assert.equal((await f.detach({ ...payload, requestIds: ['never-submitted'] })).items[0].status, 'failed');
});

test('preload sends live-guidance and session-model payloads through their dedicated IPC channels', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(name, value) { if (name === 'z') api = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on() {}, removeListener() {} },
        webUtils: {} };
    }
  });
  const payload = request();
  await api.openCodeSteerRun(payload);
  await api.openCodeDetachPendingGuidance({ runId: 'run-a', zSessionId: 'sess_alpha', requestIds: ['message-1'] });
  await api.setSessionModel('sess_alpha', { providerId: 'fixture-a', supplierId: 'official', modelId: 'model-a' });
  await api.setSessionModel('sess_alpha', { providerId: 'fixture-b', supplierId: 'official', modelId: 'model-b' }, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['opencode:steer-run', payload],
    ['opencode:detach-pending-guidance', { runId: 'run-a', zSessionId: 'sess_alpha', requestIds: ['message-1'] }],
    ['session:model-set', { id: 'sess_alpha', modelSelection: { providerId: 'fixture-a', supplierId: 'official', modelId: 'model-a' }, conversationRevision: 0 }],
    ['session:model-set', { id: 'sess_alpha', modelSelection: { providerId: 'fixture-b', supplierId: 'official', modelId: 'model-b' }, conversationRevision: 3 }]
  ]);
});
