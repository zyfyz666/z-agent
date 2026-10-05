'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const outputLimits = require('../lib/model-output-limits');
const source = fs.readFileSync(path.join(__dirname, '../renderer/z-connection-controls.js'), 'utf8');

class Element {
  constructor(id = '') { this.id = id; this.value = ''; this.disabled = false; this.dataset = {}; this.events = new Map(); this.children = []; }
  addEventListener(type, callback) { this.events.set(type, callback); }
  async fire(type) { await this.events.get(type)?.({ preventDefault() {}, target: this, currentTarget: this }); }
  replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ''; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  removeAttribute(name) { delete this[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function fixture({ rules = false, failSave = false } = {}) {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const connections = [
    { providerId: 'one', supplierId: 'primary', name: 'First', models: [
      { id: 'claude-opus-4-7', name: 'Opus', capabilities: { maxOutputTokens: 128000 } },
      { id: 'gpt-6', name: 'GPT', capabilities: { maxOutputTokens: 64000 } }
    ] },
    { providerId: 'two', supplierId: 'secondary', name: 'Second', models: [
      { id: 'claude-opus-4-7', name: 'Opus', capabilities: { maxOutputTokens: 128000 } }
    ] }
  ];
  const config = { context: { window: 1000000 }, agentModel: { modelId: 'main', maxOutputTokens: 48000 }, observer: {
    model: rules ? null : { providerId: 'one', supplierId: 'primary', modelId: 'claude-opus-4-7', name: 'Opus' },
    judgeEvery: 6, reasoningEffort: 'max', maxOutputTokens: 24000
  } };
  const calls = [], resolutions = [];
  const root = {
    ZModelOutputLimits: { resolveOutputLimit(options) {
      resolutions.push(structuredClone(options));
      return outputLimits.resolveOutputLimit(options);
    } }
  };
  const document = { documentElement: { lang: 'zh' }, getElementById: element, createElement: () => new Element(),
    querySelector: () => element('toolbar'), addEventListener() {} };
  vm.runInNewContext(source, { window: root, document, ResizeObserver: class { observe() {} } });
  root.ZConnectionControls.mount({
    config,
    api: {
      async listModelConnections() { return { connections: structuredClone(connections), observer: structuredClone(config.observer) }; },
      async configureObserver(payload) { calls.push(structuredClone(payload)); return failSave ? { error: 'fixture rejection' } : { observer: payload }; }
    },
    onObserverChange(observer) { config.observer = observer; }, onNotice() {}
  });
  return { root, document, config, element, calls, resolutions,
    open: () => element('zObserverPill').fire('click'), save: () => element('zConnectionForm').fire('submit') };
}

test('output preview names unverified sources honestly and validates confirmed maxima', () => {
  const f = fixture();
  const state = f.root.ZConnectionControls.outputLimitState;
  const automatic = state({ modelId: 'claude-opus-4-7' }, '');
  assert.equal(automatic.requested, 0);
  assert.match(automatic.summary, /128,000.*官方资料/);
  assert.match(state({ modelId: 'claude-opus-4-7' }, 128001).error, /不能超过已确认上限/);
  for (const invalid of [-1, 0.5, 'nope', Infinity]) assert.match(state({}, invalid).error, /正整数/);
  for (const modelId of ['unknown-route', 'claude-opus-4-7[1M]']) {
    const manual = state({ modelId }, 50000);
    assert.equal(manual.requested, 50000);
    assert.match(manual.summary, /未确认/);
    assert.doesNotMatch(manual.summary, /官方/);
  }
  assert.equal(state({ modelId: 'claude-opus-4-7' }, '0').requested, 0);
  const aliasError = state({ modelId: 'claude-opus-4-7[1M]' }, 128001).error;
  assert.match(aliasError, /不能超过当前额度/);
  assert.doesNotMatch(aliasError, /已确认/);
  assert.equal(state({ modelId: 'unknown-route' }, 0, { native: true }).resolution.tokens, 32000);
  assert.equal(state({ modelId: 'unknown-route' }, 0).resolution.tokens, 32768);
});

test('observer restores its independent cap and saves it without changing the primary model or context', async () => {
  const f = fixture();
  const original = JSON.stringify({ agentModel: f.config.agentModel, context: f.config.context });
  await f.open();
  assert.equal(f.element('zObserverOutputTokens').value, '24000');
  assert.equal(f.element('zObserverOutputTokens').disabled, false);
  f.element('zObserverOutputTokens').value = '32000';
  await f.element('zObserverOutputTokens').fire('input');
  await f.save();
  assert.equal(f.calls[0].maxOutputTokens, 32000);
  assert.equal(f.config.observer.maxOutputTokens, 32000);
  assert.equal(JSON.stringify({ agentModel: f.config.agentModel, context: f.config.context }), original);
  assert.equal(f.element('zConnectionDialog').open, false);
});

test('changing an observer model or connection returns its cap to automatic, while cancel preserves saved settings', async () => {
  const f = fixture();
  await f.open();
  f.element('zConnectionModel').value = 'gpt-6';
  await f.element('zConnectionModel').fire('change');
  assert.equal(f.element('zObserverOutputTokens').value, '');
  assert.match(f.element('zObserverOutputSummary').textContent, /自动.*64,000/);
  await f.element('zConnectionCancel').fire('click');
  assert.equal(f.config.observer.maxOutputTokens, 24000);
  await f.open();
  f.element('zConnectionSelect').value = JSON.stringify(['two', 'secondary']);
  await f.element('zConnectionSelect').fire('change');
  assert.equal(f.element('zObserverOutputTokens').value, '');
  await f.save();
  assert.equal(f.calls[0].maxOutputTokens, 0);
  assert.equal(f.calls[0].model.providerId, 'two');
});

test('rule mode disables the output field and never saves a stale model budget', async () => {
  const f = fixture({ rules: true });
  await f.open();
  assert.equal(f.element('zObserverOutputTokens').disabled, true);
  assert.match(f.element('zObserverOutputSummary').textContent, /规则模式不调用模型/);
  assert.equal(f.resolutions.length, 0);
  await f.save();
  assert.equal(f.calls[0].model, null);
  assert.equal(f.calls[0].maxOutputTokens, 0);
});

test('observer rejects an oversized cap before saving and retains the draft after a save failure', async () => {
  const f = fixture({ failSave: true });
  await f.open();
  f.element('zObserverOutputTokens').value = '200000';
  await f.element('zObserverOutputTokens').fire('input');
  await f.save();
  assert.equal(f.calls.length, 0);
  assert.match(f.element('zConnectionNotice').textContent, /不能超过已确认上限/);
  f.element('zObserverOutputTokens').value = '32000';
  await f.element('zObserverOutputTokens').fire('input');
  await f.save();
  assert.equal(f.config.observer.maxOutputTokens, 24000);
  assert.equal(f.element('zConnectionDialog').open, true);
  assert.equal(f.element('zObserverOutputTokens').value, '32000');
  assert.equal(f.element('zObserverOutputTokens').disabled, false);
});
