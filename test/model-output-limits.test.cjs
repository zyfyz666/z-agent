'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getOutputProfile, resolveOutputLimit, validateOutputTokens } = require('../lib/model-output-limits');
const { decorateModel } = require('../lib/model-capabilities');
const { buildOpenCodeConfig } = require('../lib/opencode-sidecar');
const { observerRequest, normalizeObserverSettings } = require('../lib/observer-model');

test('Claude exact IDs use published decimal output limits independently of 1M context', () => {
  for (const modelId of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5']) {
    const value = resolveOutputLimit({ modelId, contextWindow: 1_000_000 });
    assert.equal(value.tokens, 128000);
    assert.equal(value.verified, true);
    assert.equal(value.source, 'official');
  }
  for (const modelId of ['claude-opus-4-5', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001']) {
    assert.equal(resolveOutputLimit({ modelId, contextWindow: 1_000_000 }).tokens, 64000);
  }
  assert.equal(getOutputProfile('claude-opus-4-8').maximum, 0, 'do not infer future Claude limits');
});

test('gateway names are reference matches, never replacements or official verification', () => {
  const modelId = 'claude-kr-claude-opus-5.5[1M]';
  const value = resolveOutputLimit({ modelId });
  assert.equal(value.modelId, modelId);
  assert.equal(value.referenceModelId, 'claude-opus-5-5');
  assert.equal(value.tokens, 128000);
  assert.equal(value.verified, false);
  assert.equal(value.source, 'alias-reference');
  assert.equal(resolveOutputLimit({ modelId: 'secret-claude-opus-5.5[1M]' }).source, 'unknown');
});

test('existing OpenAI capability data remains visibly unverified, including wrapped names', () => {
  for (const modelId of ['gpt-6-astra', 'gpt-5.6-sol-2026-07-09', 'gpt-5.6-luna', 'gpt-5.6-terra', 'claude-kr-gpt-5.6-sol[1M]']) {
    const value = resolveOutputLimit({ modelId });
    assert.equal(value.tokens, 128000);
    assert.equal(value.source, 'legacy');
    assert.equal(value.verified, false);
    assert.equal(value.sourceUrl, '');
  }
});

test('smaller supplier ceilings survive repeated model decoration; inferred values stay unverified', () => {
  for (const modelId of ['claude-opus-4-7', 'gpt-6-astra']) {
    let model = { id: modelId, capabilities: { maxOutputTokens: 16000 } };
    for (let count = 0; count < 3; count++) model = decorateModel('custom-gateway', model);
    const value = resolveOutputLimit({ modelId, capabilities: model.capabilities, maxOutputTokens: 128000 });
    assert.equal(value.tokens, 16000);
    assert.equal(value.maximum, 16000);
    assert.equal(value.automaticSource, 'declared');
  }
  const model = decorateModel('custom', decorateModel('custom', { id: 'gpt-6-astra' }));
  assert.equal(resolveOutputLimit({ modelId: model.id, capabilities: model.capabilities }).verified, false);
});

test('manual output is optional, bounded, and distinct from the context window', () => {
  const base = { modelId: 'claude-opus-4-7', contextWindow: 1000000 };
  for (const maxOutputTokens of [undefined, null, '', 0]) assert.equal(resolveOutputLimit({ ...base, maxOutputTokens }).tokens, 128000);
  assert.equal(resolveOutputLimit({ ...base, maxOutputTokens: 48000 }).tokens, 48000);
  assert.equal(resolveOutputLimit({ ...base, maxOutputTokens: 1000000 }).tokens, 128000);
  assert.equal(validateOutputTokens(48000, base), '');
  assert.ok(validateOutputTokens(128001, base));
  for (const value of [-1, 0.5, Infinity, 'bad', Number.MAX_SAFE_INTEGER + 1]) assert.ok(validateOutputTokens(value, base));
  assert.equal(resolveOutputLimit({ ...base, contextWindow: 8192 }).tokens, 8191);
});

test('CSU and other non-focus families keep existing native and observer budgets', () => {
  for (const modelId of ['GLM', 'qwen3.8-max', 'kimi-k3', 'other-model']) {
    assert.equal(resolveOutputLimit({ modelId, native: true, capabilities: { maxOutputTokens: 96000 } }).tokens, 32000);
    assert.equal(resolveOutputLimit({ modelId }).tokens, 32768);
    assert.equal(resolveOutputLimit({ modelId, capabilities: { maxOutputTokens: 4096 } }).tokens, 4096);
  }
});

test('main and observer serialize separate total budgets without rewriting context settings', () => {
  const modelId = 'claude-opus-4-5';
  const config = buildOpenCodeConfig({ providerId: 'fixture', modelId, apiFormat: 'anthropic',
    baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 1000000, compactionThreshold: 800000,
    maxOutputTokens: 48000, reasoningSpeed: 'max', enableSubagents: false, mcpServers: [] });
  const model = config.provider.fixture.models[modelId];
  assert.equal(model.limit.context, 1000000);
  assert.equal(model.limit.output + model.options.thinking.budgetTokens, 48000,
    'native Anthropic adds legacy thinking to the completion allowance');
  const body = observerRequest({ modelId, baseUrl: 'http://127.0.0.1:9/v1', apiFormat: 'anthropic',
    maxOutputTokens: 12000, reasoningEffort: 'max' }, {}).body;
  assert.equal(body.max_tokens, 12000);
  assert.ok(body.thinking.budget_tokens < body.max_tokens);
  assert.equal(normalizeObserverSettings({ maxOutputTokens: 12000 }).maxOutputTokens, 12000);
  assert.equal(model.limit.output + model.options.thinking.budgetTokens, 48000);
});
