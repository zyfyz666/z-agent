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

function model(id) {
  return { providerId: `provider-${id}`, supplierId: 'official', modelId: id, modelType: 'text',
    name: `Model ${id}`, capabilities: { vision: true } };
}

function fixture() {
  const a = { id: 'A', modelSelection: model('a'), messages: [{ role: 'user', content: 'Task A' }] };
  const b = { id: 'B', modelSelection: model('b'), messages: [] };
  const saves = [];
  const badges = [];
  const calls = [];
  let completed;
  const element = { disabled: false, classList: { contains: () => true }, open: false };
  const context = {
    console,
    state: { currentSession: a, sessions: [a, b], activeRuns: new Map(), config: { agentModel: model('global'), api: {} } },
    api: {
      setSessionModel(id, selection) {
        const pending = deferred();
        saves.push({ id, selection, ...pending });
        return pending.promise;
      },
      setModelRole() { throw new Error('Text model must not mutate the global role'); },
      async openCodeStartRun(payload) {
        calls.push(payload);
        queueMicrotask(() => completed({ result: { textContent: 'Done', status: 'done' } }));
        return { ok: true };
      },
      openCodeCancelRun: async () => {}
    },
    renderModelBadge() { badges.push({ session: context.state.currentSession.id, model: context.getAgentModelSelection().modelId }); },
    createRendererRunId: id => `run-${id}`,
    initOpenCodeRunState() {},
    attachOpenCodeRunEventListeners(_ctx, handler) { completed = handler; return () => {}; },
    openCodeResultToAgentRun: value => value,
    normalizeSkillCalls: value => value || [],
    extractMediaAssetsFromAgentRun: () => [],
    settleAgentInteractionForRun() {},
    syncSessionOpenCodeIdAfterRun() {},
    rejectStartedOpenCodeRunIfAborted: async () => {},
    resolveAgentPresentationMode: () => 'standard',
    $: () => element,
    settingsOverlay: element,
    isModelPickerBusy: () => false,
    resetModelPickerDraft() {},
    refreshQuickModels: async () => {},
    renderConnectionList: async () => {},
    primeMediaModelLabels: async () => {},
    renderModelGrid: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(section('function getAgentModelConfigName(', 'function modelSelectionIdentity('), context);
  vm.runInContext(section('function setRunModelPresentation(', 'function aicssG2GlobeOpacity('), context);
  vm.runInContext(section('async function runOpenCodeLoop(', '// Reload reconciliation:'), context);
  return { context, a, b, saves, badges, calls };
}

test('each conversation keeps its model even when the global default changes or its model is unavailable', () => {
  const f = fixture();
  assert.equal(f.context.getAgentModelSelection(f.a).modelId, 'a');
  assert.equal(f.context.getAgentModelSelection(f.b).modelId, 'b');
  f.context.state.config.agentModel = model('new-global');
  f.context.state.currentSession = f.b;
  assert.equal(f.context.getAgentModelSelection().modelId, 'b');
  assert.equal(f.context.getAgentModelSelection(f.a).providerId, 'provider-a');
  assert.equal(f.context.getAgentModelSelection(f.a).name, 'Model a');
  assert.equal(f.context.getAgentModelSelection({ id: 'legacy' }).modelId, 'new-global');
});

test('a delayed save updates the captured conversation and cannot change the newly opened conversation', async () => {
  const f = fixture();
  const originalGlobal = JSON.stringify(f.context.state.config);
  const pending = f.context.selectSessionTextModel(model('chosen-a'));
  f.context.state.currentSession = f.b;
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: model('chosen-a') });
  assert.equal(await pending, true);
  assert.equal(f.a.modelSelection.modelId, 'chosen-a');
  assert.equal(f.b.modelSelection.modelId, 'b');
  assert.equal(f.context.getAgentModelSelection().modelId, 'b');
  assert.equal(JSON.stringify(f.context.state.config), originalGlobal);
  assert.deepEqual(f.badges, []);
});

test('an unresolved historical supplier remains empty instead of silently adopting the current gateway', () => {
  const f = fixture();
  f.a.modelSelection.supplierId = '';
  f.context.state.config.api.providerActiveSupplierIds = { 'provider-a': 'new-gateway' };
  f.context.state.config.api.providerSuppliers = { 'provider-a': [{ id: 'new-gateway', name: 'Current gateway', models: [] }] };
  const selected = f.context.getAgentModelSelection(f.a);
  assert.equal(selected.supplierId, '');
  assert.equal(selected.configName, '');
  assert.equal(selected.modelId, 'a');
});

test('an older delayed response cannot overwrite a newer model selection in the same conversation', async () => {
  const f = fixture();
  const older = f.context.selectSessionTextModel(model('old'));
  const newer = f.context.selectSessionTextModel(model('new'));
  f.saves[1].resolve({ ok: true, id: 'A', modelSelection: model('new') });
  assert.equal(await newer, true);
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: model('old') });
  assert.equal(await older, false);
  assert.equal(f.a.modelSelection.modelId, 'new');
  assert.deepEqual(f.badges, [{ session: 'A', model: 'new' }]);
});

test('the actual menu callback saves to its original conversation without repainting the other conversation menu', async () => {
  const f = fixture();
  const chosen = { ...model('chosen'), id: 'chosen' };
  Object.assign(f.context, {
    modelPickerSaving: false, modelPickerSaveOperation: null,
    modelPickerDraft: { modelId: 'other-menu-draft' },
    quickTextModels: () => [chosen], setModelPickerMenuNotice() {},
    setModelQuickView() { throw new Error('A completion must not switch B menu'); },
    renderModelPickerChoices() { throw new Error('A completion must not repaint B menu'); },
    toast() { throw new Error('A completion must not announce a model switch in B'); }
  });
  vm.runInContext(section('async function selectModelFromMenu(', 'async function saveModelPicker('), f.context);
  const option = {
    dataset: { modelPickerProvider: chosen.providerId, modelPickerSupplier: chosen.supplierId, modelPickerModel: chosen.id },
    setAttribute() {}, removeAttribute() {}
  };
  const pending = f.context.selectModelFromMenu(option);
  assert.equal(f.saves[0].id, 'A');
  f.context.state.currentSession = f.b;
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: model('chosen') });
  await pending;
  assert.equal(f.a.modelSelection.modelId, 'chosen');
  assert.equal(f.b.modelSelection.modelId, 'b');
  assert.equal(f.context.modelPickerDraft.modelId, 'other-menu-draft');
  assert.equal(f.context.modelPickerSaving, false);
});

test('a rejected model selection leaves the saved conversation model intact', async () => {
  const f = fixture();
  const pending = f.context.selectSessionTextModel(model('missing'));
  f.saves[0].resolve({ ok: false, error: 'Model unavailable' });
  await assert.rejects(pending, /Model unavailable/);
  assert.equal(f.a.modelSelection.modelId, 'a');
  assert.deepEqual(f.badges, []);
});

test('a background run sends the target conversation model and freezes it before later UI changes', async () => {
  const f = fixture();
  f.context.state.currentSession = f.b;
  const runCtx = {};
  const pending = f.context.runOpenCodeLoop(f.a, null, runCtx);
  f.a.modelSelection.modelId = 'next-turn-only';
  f.a.modelSelection.capabilities.vision = false;
  f.b.modelSelection = model('other-page-selection');
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].yanSessionId, 'A');
  assert.equal(f.calls[0].modelSelection.modelId, 'a');
  assert.equal(f.calls[0].modelSelection.providerId, 'provider-a');
  assert.equal(f.calls[0].modelSelection.capabilities.vision, true);
  assert.equal(runCtx.modelSelection.modelId, 'a');
});

test('a queued or utility run preserves its explicit frozen model over the current session selection', async () => {
  const f = fixture();
  f.context.state.currentSession = f.b;
  const runCtx = { modelSelection: model('queued'), utility: true };
  await f.context.runOpenCodeLoop(f.a, null, runCtx);
  assert.equal(f.calls[0].modelSelection.modelId, 'queued');
  assert.equal(f.calls[0].utility, true);
  assert.equal(f.a.modelSelection.modelId, 'a');
});

test('global model notifications refresh the catalog without replacing conversation model selections', async () => {
  const f = fixture();
  let handler;
  f.context.api.onModelChanged = callback => { handler = callback; };
  f.context.api.getConfig = async () => ({ agentModel: model('new-global'), api: {} });
  vm.runInContext(section('  api.onModelChanged?.(async () => {', "  window.addEventListener('focus'"), f.context);
  await handler();
  assert.equal(f.a.modelSelection.modelId, 'a');
  assert.equal(f.b.modelSelection.modelId, 'b');
  assert.equal(f.context.state.config.agentModel.modelId, 'new-global');
  assert.deepEqual(f.badges, [{ session: 'A', model: 'a' }]);
});
