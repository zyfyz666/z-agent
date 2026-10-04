'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeObserverSettings, observerRequest, reviewWithModel } = require('../lib/observer-model');

const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
const connection = { providerId: 'fixture-observer', supplierId: 'fixture', modelId: 'claude-opus-4-7',
  name: 'Fixture Observer', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-key', apiFormat: 'anthropic' };

test('observer effort defaults to max and normalizes independently of the primary model', () => {
  for (const value of [undefined, null, '', 'unsupported']) assert.equal(normalizeObserverSettings({ reasoningEffort: value }).reasoningEffort, 'max');
  for (const value of levels) assert.equal(normalizeObserverSettings({ reasoningEffort: value }).reasoningEffort, value);
});

for (const effort of levels) {
  test(`observer ${effort} reaches the native Claude 4.7, Responses, and compatible wire fields`, () => {
    const anthropic = observerRequest({ ...connection, reasoningEffort: effort }, {}).body;
    assert.deepEqual(anthropic.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(anthropic.output_config, { effort });
    assert.equal(anthropic.max_tokens, 32768);
    assert.equal(anthropic.reasoning_effort, undefined);
    assert.equal(anthropic.effort, undefined);

    const responses = observerRequest({ ...connection, modelId: 'gpt-6', apiFormat: 'responses', reasoningEffort: effort }, {}).body;
    assert.deepEqual(responses.reasoning, { effort });
    assert.equal(responses.max_output_tokens, 32768);
    assert.equal(responses.reasoning_effort, undefined);
    const chat = observerRequest({ ...connection, apiFormat: 'openai', reasoningEffort: effort }, {}).body;
    assert.equal(chat.reasoning_effort, effort);
    assert.equal(chat.max_tokens, 32768);
    for (const body of [anthropic, responses, chat]) {
      assert.equal(body.reasoningEffort, undefined);
      assert.equal(body.reasoningEffortAdjusted, undefined);
      assert.equal(body.metadata, undefined);
    }
  });
}

test('default max is actually serialized in outgoing requests for all three protocols', async () => {
  for (const [apiFormat, modelId] of [['anthropic', 'claude-opus-4-7'], ['responses', 'gpt-6'], ['openai', 'kimi-k3']]) {
    await reviewWithModel({ ...connection, apiFormat, modelId }, {}, { fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      const effort = body.output_config?.effort || body.reasoning?.effort || body.reasoning_effort;
      assert.equal(effort, 'max');
      assert.ok((body.max_tokens || body.max_output_tokens || body.max_completion_tokens) >= 16384);
      return { ok: true, json: async () => ({ output_text: '{"action":"observe","message":"Evidence is insufficient."}' }) };
    } });
  }
});

test('provider capabilities map unsupported effort without leaking SDK-only metadata', () => {
  const claude = observerRequest({ ...connection, modelId: 'claude-sonnet-4-6', reasoningEffort: 'xhigh' }, {}).body;
  assert.equal(claude.output_config.effort, 'max');
  const qwen = observerRequest({ ...connection, apiFormat: 'openai', modelId: 'qwen3.8-max' }, {}).body;
  assert.equal(qwen.reasoning_effort, 'xhigh');
  const constrained = observerRequest({ ...connection, capabilities: { reasoningEffortLevels: ['low', 'high'] } }, {}).body;
  assert.equal(constrained.output_config.effort, 'high');
  for (const body of [claude, qwen, constrained]) assert.equal(body.reasoningEffortAdjusted, undefined);
});

test('legacy Claude gets snake-case manual thinking with sufficient room for its JSON decision', () => {
  for (const modelId of ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet-latest']) {
    const body = observerRequest({ ...connection, modelId }, {}).body;
    assert.equal(body.thinking.type, 'enabled');
    assert.ok(body.thinking.budget_tokens >= 1024);
    assert.ok(body.max_tokens - body.thinking.budget_tokens >= 2048);
    assert.equal(body.thinking.budgetTokens, undefined);
    assert.equal(body.output_config?.effort, modelId === 'claude-opus-4-5' ? 'high' : undefined);
  }
  const small = observerRequest({ ...connection, modelId: 'claude-sonnet-4-5', capabilities: { maxOutputTokens: 4096 } }, {}).body;
  assert.equal(small.max_tokens, 4096);
  assert.equal(small.thinking.budget_tokens, 2048);
  const insufficient = observerRequest({ ...connection, modelId: 'claude-sonnet-4-5', capabilities: { maxOutputTokens: 1024 } }, {}).body;
  assert.equal(insufficient.thinking, undefined, 'Do not send a thinking budget that the model must reject');
});

test('known OpenAI profiles bound efforts and omit unsupported thinking controls', () => {
  for (const apiFormat of ['responses', 'openai']) {
    for (const modelId of ['gpt-5.4', 'o3', 'openai/o4-mini']) {
      const body = observerRequest({ ...connection, apiFormat, modelId }, {}).body;
      assert.equal(body.reasoning?.effort || body.reasoning_effort, 'high');
      if (apiFormat === 'openai') assert.equal(body.max_completion_tokens, 32768);
    }
    for (const modelId of ['gpt-4o', 'gpt-4.1', 'o1-mini']) {
      const body = observerRequest({ ...connection, apiFormat, modelId }, {}).body;
      assert.equal(body.reasoning, undefined);
      assert.equal(body.reasoning_effort, undefined);
    }
  }
  const unknown = observerRequest({ ...connection, modelId: 'claude-unverified' }, {}).body;
  assert.equal(unknown.thinking, undefined);
  assert.equal(unknown.output_config, undefined);
});

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function settingsFixture() {
  let config = { api: { reasoningSpeed: 'low', thinking: false }, agentModel: { modelId: 'primary-model' },
    observer: { judgeEvery: 6, model: { ...connection } } };
  const handlers = new Map();
  const context = vm.createContext({
    normalizeObserverSettings, MODEL_PROVIDERS: { [connection.providerId]: { apiFormat: 'anthropic' } },
    composerConnections: () => [{ providerId: connection.providerId, supplierId: connection.supplierId, models: [{ id: connection.modelId, name: connection.name }] }],
    getProviderModels: () => [{ id: connection.modelId, capabilities: { reasoning: true } }],
    getProviderConnectionForSupplier: () => ({ baseUrl: connection.baseUrl, apiKey: connection.apiKey }),
    loadConfig: () => structuredClone(config), saveConfig: value => { config = structuredClone(value); },
    publishModelState() {}, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
  });
  vm.runInContext(main.slice(main.indexOf('function observerConnectionForRun('), main.indexOf("ipcMain.handle('models:quick-list',")), context);
  return { context, config: () => config,
    save: payload => handlers.get('observer:configure')(null, payload),
    publicState: () => handlers.get('models:connections')() };
}

test('main config and run connection carry only the observer effort while preserving the primary effort', () => {
  const f = settingsFixture();
  const primary = structuredClone(f.config().api);
  assert.equal(f.context.observerConnectionForRun(f.config()).reasoningEffort, 'max');
  const saved = f.save({ judgeEvery: 3, model: connection, reasoningEffort: 'high' });
  assert.equal(saved.observer.reasoningEffort, 'high');
  const runtime = f.context.observerConnectionForRun(f.config());
  assert.equal(runtime.reasoningEffort, 'high');
  assert.equal(runtime.apiFormat, 'anthropic');
  assert.equal(runtime.capabilities.reasoning, true);
  assert.deepEqual(f.config().api, primary);
  assert.equal(f.config().agentModel.modelId, 'primary-model');
  assert.equal(f.publicState().observer.reasoningEffort, 'high');
  assert.equal(f.publicState().observer.model.apiKey, undefined);
  f.save({ judgeEvery: 4, model: connection });
  assert.equal(f.config().observer.reasoningEffort, 'high', 'Legacy payloads must not erase an independently saved effort');
});
