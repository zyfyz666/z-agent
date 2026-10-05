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
      setSessionModel(id, selection, conversationRevision) {
        const pending = deferred();
        saves.push({ id, selection, conversationRevision, ...pending });
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
  vm.runInContext(section('const DEFAULT_CONTEXT_SETTINGS = Object.freeze({', 'function sanitizeContextKInput('), context);
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

test('a model change freezes the history revision and its late response cannot overwrite a rewound conversation', async () => {
  const f = fixture();
  f.a.conversationRevision = 4;
  const pending = f.context.selectSessionTextModel(model('late'));
  assert.equal(f.saves[0].conversationRevision, 4);
  Object.assign(f.context, {
    observerHistorySelection: new Map(), interjectionThreads: new Map(), pendingAgentHandoffs: new Map()
  });
  vm.runInContext(section('function clearSessionRewindUiHistory(', 'async function applySessionRewindResult('), f.context);
  f.context.clearSessionRewindUiHistory('A');
  const rewound = { ...f.a, conversationRevision: 5, modelSelection: model('historical') };
  f.context.state.currentSession = rewound;
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: model('late') });
  assert.equal(await pending, false);
  assert.equal(rewound.modelSelection.modelId, 'historical');
  assert.equal(f.a.modelSelection.modelId, 'a');
  assert.deepEqual(f.badges, []);
});

test('the actual menu callback saves to its original conversation without repainting the other conversation menu', async () => {
  const f = fixture();
  f.a.modelSelection.maxOutputTokens = 64000;
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
  assert.equal(f.saves[0].selection.maxOutputTokens, 0, 'a different model starts with its automatic output allowance');
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
  f.a.modelSelection.reasoningSpeed = 'max';
  f.b.modelSelection.reasoningSpeed = 'low';
  f.context.state.currentSession = f.b;
  const runCtx = {};
  const pending = f.context.runOpenCodeLoop(f.a, null, runCtx);
  f.a.modelSelection.modelId = 'next-turn-only';
  f.a.modelSelection.capabilities.vision = false;
  f.a.modelSelection.reasoningSpeed = 'medium';
  f.b.modelSelection = model('other-page-selection');
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].zSessionId, 'A');
  assert.equal(f.calls[0].modelSelection.modelId, 'a');
  assert.equal(f.calls[0].modelSelection.providerId, 'provider-a');
  assert.equal(f.calls[0].modelSelection.capabilities.vision, true);
  assert.equal(runCtx.modelSelection.modelId, 'a');
  assert.equal(f.calls[0].modelSelection.reasoningSpeed, 'max');
  assert.equal(runCtx.modelSelection.reasoningSpeed, 'max');
});

test('a queued or utility run preserves its explicit frozen model over the current session selection', async () => {
  const f = fixture();
  f.context.state.currentSession = f.b;
  const runCtx = { modelSelection: { ...model('queued'), reasoningSpeed: 'xhigh' }, utility: true };
  await f.context.runOpenCodeLoop(f.a, null, runCtx);
  assert.equal(f.calls[0].modelSelection.modelId, 'queued');
  assert.equal(f.calls[0].utility, true);
  assert.equal(f.calls[0].modelSelection.reasoningSpeed, 'xhigh');
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

test('output cap saves belong to the captured conversation and leave a running model snapshot intact', async () => {
  const f = fixture();
  f.a.modelSelection.maxOutputTokens = 24000;
  f.b.modelSelection.maxOutputTokens = 48000;
  const runCtx = {};
  f.context.setRunModelPresentation(runCtx, f.context.getAgentModelSelection(f.a));
  f.context.state.activeRuns.set('A', runCtx);
  const pending = f.context.selectSessionTextModel({ ...f.a.modelSelection, maxOutputTokens: 64000 }, f.a);
  assert.equal(f.saves[0].selection.maxOutputTokens, 64000);
  f.context.state.currentSession = f.b;
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: f.saves[0].selection });
  await pending;
  assert.equal(f.a.modelSelection.maxOutputTokens, 64000);
  assert.equal(f.b.modelSelection.maxOutputTokens, 48000);
  assert.equal(runCtx.modelSelection.maxOutputTokens, 24000);
  assert.equal(f.context.state.config.agentModel.maxOutputTokens, undefined);
});

test('run submission freezes the selected output cap before subsequent UI changes', async () => {
  const f = fixture();
  f.a.modelSelection.maxOutputTokens = 64000;
  const runCtx = {};
  const pending = f.context.runOpenCodeLoop(f.a, null, runCtx);
  f.a.modelSelection.maxOutputTokens = 12000;
  await pending;
  assert.equal(f.calls[0].modelSelection.maxOutputTokens, 64000);
  assert.equal(runCtx.modelSelection.maxOutputTokens, 64000);
});

function outputMenuFixture() {
  const f = fixture();
  f.a.modelSelection.maxOutputTokens = 24000;
  f.b.modelSelection.maxOutputTokens = 48000;
  const elements = new Map(['#modelQuickOutputTokens', '#modelQuickOutputSummary', '#modelQuickOutputSave'].map(id => [id, {
    value: '', dataset: {}, disabled: false, removeAttribute(name) { delete this[name]; },
    setCustomValidity(message) { this.validationMessage = message; }, reportValidity() {}
  }]));
  const notices = [];
  Object.assign(f.context, {
    document: { documentElement: { lang: 'zh' } },
    window: { ZConnectionControls: { outputLimitState(_selection, value) {
      const requested = Number(value) || 0;
      return { requested, automatic: { maximum: 128000, verified: true }, summary: `${requested || 128000} tokens` };
    } } },
    modelPickerSaving: false, modelPickerSaveOperation: null,
    $: selector => elements.get(selector),
    setModelPickerMenuNotice: message => notices.push(message)
  });
  vm.runInContext(section('function renderModelOutputControl(', 'function resetModelPickerDraft('), f.context);
  return { ...f, elements, notices, input: elements.get('#modelQuickOutputTokens') };
}

test('the quick output input keeps edits during redraw and resets to each conversation saved value', () => {
  const f = outputMenuFixture();
  f.context.renderModelOutputControl();
  assert.equal(f.input.value, '24000');
  f.input.value = '64000';
  f.context.renderModelOutputControl();
  f.context.renderModelOutputControl();
  assert.equal(f.input.value, '64000');
  assert.match(f.elements.get('#modelQuickOutputSummary').textContent, /待保存/);
  f.context.state.currentSession = f.b;
  f.context.renderModelOutputControl();
  assert.equal(f.input.value, '48000');
  f.context.state.currentSession = f.a;
  f.context.renderModelOutputControl();
  assert.equal(f.input.value, '24000');
});

test('the actual quick output save targets its original conversation without announcing completion in another', async () => {
  const f = outputMenuFixture();
  f.context.renderModelOutputControl();
  f.input.value = '';
  const pending = f.context.saveModelOutputTokens();
  assert.equal(f.saves[0].id, 'A');
  assert.equal(f.saves[0].selection.maxOutputTokens, 0);
  f.context.state.currentSession = f.b;
  f.context.renderModelOutputControl();
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: f.saves[0].selection });
  await pending;
  assert.equal(f.a.modelSelection.maxOutputTokens, 0);
  assert.equal(f.b.modelSelection.maxOutputTokens, 48000);
  assert.equal(f.input.value, '48000');
  assert.deepEqual(f.notices, []);
});

function reasoningFixture() {
  const f = fixture();
  f.a.modelSelection.reasoningSpeed = 'high';
  f.b.modelSelection.reasoningSpeed = 'low';
  f.context.state.config.api.reasoningSpeed = 'medium';
  f.context.api.setConfig = () => { throw new Error('Reasoning changes must not write global settings'); };
  const renders = [], notices = [], announcements = [];
  Object.assign(f.context, {
    REASONING_SPEED_UI: Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map(mode => [mode, { label: mode, toast: mode }])),
    REASONING_SPEED_ORDER: ['low', 'medium', 'high', 'xhigh', 'max'],
    modelPickerDraft: { reasoningSpeed: 'high' }, modelQuickSaving: false,
    maxReasoningNoticeTimer: null, clearTimeout() {}, setTimeout() { return 1; },
    clearMaxReasoningNotice() {}, showMaxReasoningNotice() {}, getReasoningSpeedBillingNote: () => '',
    renderReasoningSpeedControl(mode) { renders.push({ id: f.context.state.currentSession.id, mode: mode || f.context.getReasoningSpeedMode() }); },
    setModelPickerMenuNotice(message) { if (message) notices.push({ id: f.context.state.currentSession.id, message }); },
    toast(message) { announcements.push({ id: f.context.state.currentSession.id, message }); }
  });
  vm.runInContext(section('function getReasoningSpeedMode(', 'function getReasoningSpeedBillingNote('), f.context);
  vm.runInContext(section('function reasoningModeFromProgress(', 'let maxReasoningNoticeTimer'), f.context);
  vm.runInContext(section('async function selectReasoningSpeed(', 'function previewReasoningSlider('), f.context);
  vm.runInContext(section('async function commitReasoningSlider(', 'const WORK_MODE_UI'), f.context);
  return { ...f, renders, notices, announcements };
}

test('switching conversations restores each reasoning value even after global catalog updates', () => {
  const f = reasoningFixture();
  assert.equal(f.context.getReasoningSpeedMode(), 'high');
  f.context.state.currentSession = f.b;
  assert.equal(f.context.getReasoningSpeedMode(), 'low');
  assert.equal(f.context.getAgentModelSelection().reasoningSpeed, 'low');
  f.context.state.config.api.reasoningSpeed = 'max';
  assert.equal(f.context.getReasoningSpeedMode(), 'low');
  f.context.state.currentSession = f.a;
  assert.equal(f.context.getReasoningSpeedMode(), 'high');
});

test('the reasoning slider persists only its captured conversation and does not alter a running snapshot', async () => {
  const f = reasoningFixture();
  const originalGlobal = JSON.stringify(f.context.state.config);
  const runCtx = {};
  f.context.setRunModelPresentation(runCtx, f.context.getAgentModelSelection(f.a));
  f.context.state.activeRuns.set('A', runCtx);
  const pending = f.context.commitReasoningSlider(100);
  assert.equal(f.saves[0].id, 'A');
  assert.equal(f.saves[0].selection.reasoningSpeed, 'max');
  f.context.state.currentSession = f.b;
  f.context.modelPickerDraft.reasoningSpeed = 'low';
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: f.saves[0].selection });
  await pending;
  assert.equal(f.a.modelSelection.reasoningSpeed, 'max');
  assert.equal(f.b.modelSelection.reasoningSpeed, 'low');
  assert.equal(runCtx.modelSelection.reasoningSpeed, 'high');
  assert.equal(f.context.modelPickerDraft.reasoningSpeed, 'low');
  assert.equal(f.context.getReasoningSpeedMode(), 'low');
  assert.equal(JSON.stringify(f.context.state.config), originalGlobal);
  assert.deepEqual(f.announcements, []);
  assert.deepEqual(f.notices, []);
  assert.equal(f.renders.filter(item => item.id === 'B').every(item => item.mode === 'low'), true);
});

test('a late failed reasoning save cannot reset or display its error in another conversation', async () => {
  const f = reasoningFixture();
  const pending = f.context.commitReasoningSlider(75);
  f.context.state.currentSession = f.b;
  f.saves[0].resolve({ ok: false, error: 'Fixture failed' });
  await pending;
  assert.equal(f.a.modelSelection.reasoningSpeed, 'high');
  assert.equal(f.b.modelSelection.reasoningSpeed, 'low');
  assert.deepEqual(f.notices, []);
  assert.equal(f.context.modelQuickSaving, false);
});

test('a model-only selection keeps its conversation effort instead of inheriting another task or default', async () => {
  const f = reasoningFixture();
  const pending = f.context.selectSessionTextModel(model('other'));
  assert.equal(f.saves[0].selection.reasoningSpeed, 'high');
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: f.saves[0].selection });
  await pending;
  assert.equal(f.a.modelSelection.reasoningSpeed, 'high');
  assert.equal(f.b.modelSelection.reasoningSpeed, 'low');
});

function thresholdEditorFixture() {
  const f = fixture();
  f.a.modelSelection.compactionThreshold = 250500;
  f.b.modelSelection.compactionThreshold = 800000;
  f.context.state.config.context = { maxTokens: 1000000, compactionThreshold: 800000 };
  const elements = new Map();
  f.context.$ = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', disabled: false,
      dataset: {}, attributes: {}, classList: { toggle() {} }, style: { setProperty() {} },
      setAttribute(name, value) { this.attributes[name] = value; } });
    return elements.get(selector);
  };
  Object.assign(f.context, { contextRingPanelOpen: false, requestAnimationFrame() {},
    formatTokenCount: value => `${value / 1000}K`, getRunCtx: id => f.context.state.activeRuns.get(id)?.runCtx,
    updateContextInfo: () => f.context.renderContextThresholdEditor() });
  vm.runInContext(section('let contextThresholdEditorOpen = false;', 'function contextMessageTailKey('), f.context);
  f.context.renderContextThresholdEditor();
  return { ...f, elements,
    edit(value) { f.context.$('#contextQuickThresholdInput').value = value;
      vm.runInContext(`contextThresholdDraft.value = ${JSON.stringify(value)}; contextThresholdDraft.dirty = true`, f.context);
      f.context.renderContextThresholdEditor(); }
  };
}

test('context drafts survive streaming redraw and save only their captured conversation', async () => {
  const f = thresholdEditorFixture();
  const input = f.elements.get('#contextQuickThresholdInput');
  assert.equal(input.value, '250.5');
  assert.equal(f.elements.get('#contextQuickThresholdPercent').textContent, '25.05%');
  f.edit('400.125');
  f.context.renderContextThresholdEditor();
  assert.equal(input.value, '400.125');
  const pending = f.context.saveContextThreshold();
  assert.equal(f.saves[0].selection.compactionThreshold, 400125);
  f.context.state.currentSession = f.b;
  f.context.renderContextThresholdEditor();
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: f.saves[0].selection });
  await pending;
  assert.equal(f.a.modelSelection.compactionThreshold, 400125);
  assert.equal(f.b.modelSelection.compactionThreshold, 800000);
  assert.equal(input.value, '800');
  assert.equal(f.elements.get('#contextQuickThresholdNotice').textContent, '');
  assert.equal(f.context.state.config.context.compactionThreshold, 800000);
});

test('context input rejects invalid boundaries and reset copies the current default', async () => {
  const f = thresholdEditorFixture();
  for (const value of ['', '0', '-1', 'NaN', '1000', '1001']) {
    f.edit(value);
    assert.equal(await f.context.saveContextThreshold(), false);
    assert.equal(f.saves.length, 0);
  }
  f.context.state.config.context.compactionThreshold = 700000;
  const pending = f.context.saveContextThreshold({ restoreDefault: true });
  assert.equal(f.saves[0].selection.compactionThreshold, 700000);
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: f.saves[0].selection });
  await pending;
  assert.equal(f.elements.get('#contextQuickThresholdInput').value, '700');
  assert.equal(f.b.modelSelection.compactionThreshold, 800000);
});

test('a running context budget and frozen queued selection survive later threshold edits', async () => {
  const f = thresholdEditorFixture();
  const snapshot = f.context.getAgentModelSelection(f.a);
  const runCtx = { runBudget: f.context.configuredContextBudget(f.context.state.config) };
  f.context.setRunModelPresentation(runCtx, snapshot);
  f.context.state.activeRuns.set('A', { runCtx, sessionRef: f.a });
  f.edit('500');
  const pending = f.context.saveContextThreshold();
  f.saves[0].resolve({ ok: true, id: 'A', modelSelection: f.saves[0].selection });
  await pending;
  assert.equal(runCtx.runBudget.compressSoftThreshold, 250500);
  assert.equal(snapshot.compactionThreshold, 250500);
  assert.equal(f.a.modelSelection.compactionThreshold, 500000);
  assert.match(f.elements.get('#contextQuickThresholdHint').textContent, /250.5K.*下一次发送/);
  const modelChange = f.context.selectSessionTextModel(model('other'));
  assert.equal(f.saves[1].selection.compactionThreshold, 500000);
  f.saves[1].resolve({ ok: true, id: 'A', modelSelection: f.saves[1].selection });
  await modelChange;
});
