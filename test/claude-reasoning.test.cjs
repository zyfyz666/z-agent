'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProviderReasoning } = require('../lib/reasoning-effort');
const { buildOpenCodeConfig } = require('../lib/opencode-sidecar');

const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
function config(modelId, reasoningSpeed, extra = {}) {
  return buildOpenCodeConfig({
    providerId: 'fixture-provider', modelId, reasoningSpeed,
    baseUrl: 'http://127.0.0.1:9/v1', apiFormat: 'anthropic',
    capabilities: { reasoning: true }, enableSubagents: false, mcpServers: [], ...extra
  });
}
function modelOptions(modelId, reasoningSpeed, extra) {
  return config(modelId, reasoningSpeed, extra).provider['fixture-provider'].models[modelId].options;
}

for (const level of levels) {
  test(`Claude Opus 4.7 native ${level} config enables adaptive thinking with the actual Anthropic effort key`, () => {
    const expected = { thinking: { type: 'adaptive', display: 'summarized' }, effort: level };
    assert.deepEqual(modelOptions('claude-opus-4-7', level), expected);
    const resolution = resolveProviderReasoning('claude-opus-4-7', level, { apiFormat: 'anthropic' });
    assert.deepEqual(resolution.options, expected);
    assert.deepEqual(resolution.metadata, { requested: level, effective: level, mode: 'adaptive', adjusted: false });
    assert.equal('reasoningEffort' in resolution.options, false);
    assert.equal('budgetTokens' in resolution.options.thinking, false);
    assert.equal('metadata' in resolution.options, false);
  });
}

test('namespace, dated, dotted and legacy-order Claude identities keep their exact model ID', () => {
  for (const id of ['anthropic/claude-opus-4-7', 'claude-opus-4.7', 'claude-opus-4-7-20260416', 'claude-4-7-opus']) {
    const built = config(id, 'max');
    const model = built.provider['fixture-provider'].models[id];
    assert.equal(model.id, id);
    assert.deepEqual(model.options, { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max' });
    assert.equal(model.limit.output, 32768, 'this fix preserves the existing output ceiling');
  }
});

test('an inferred Messages endpoint uses Anthropic options, while explicit compatible routing stays compatible', () => {
  assert.equal(modelOptions('claude-opus-4-7', 'max', {
    apiFormat: 'auto', baseUrl: 'http://127.0.0.1:9/v1/messages'
  }).effort, 'max');
  for (const level of levels) {
    assert.deepEqual(modelOptions('claude-opus-4-7', level, { apiFormat: 'openai' }), { reasoningEffort: level });
  }
});

test('Opus and Sonnet 4.6 support max but map unsupported xhigh to max explicitly', () => {
  for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-4.6-sonnet']) {
    for (const level of ['low', 'medium', 'high', 'max']) {
      assert.deepEqual(modelOptions(id, level), { thinking: { type: 'adaptive' }, effort: level });
    }
    const mapped = resolveProviderReasoning(id, 'xhigh', { apiFormat: 'anthropic' });
    assert.deepEqual(mapped.options, { thinking: { type: 'adaptive' }, effort: 'max' });
    assert.equal(mapped.metadata.requested, 'xhigh');
    assert.equal(mapped.metadata.effective, 'max');
    assert.equal(mapped.metadata.adjusted, true);
  }
});

test('Opus 4.5 uses manual thinking and does not send unsupported xhigh or max effort', () => {
  for (const level of levels) {
    const resolved = resolveProviderReasoning('claude-opus-4-5-20251101', level, { apiFormat: 'anthropic' });
    assert.deepEqual(resolved.options, {
      thinking: { type: 'enabled', budgetTokens: 16000 }, effort: ['xhigh', 'max'].includes(level) ? 'high' : level
    });
    assert.equal(resolved.metadata.adjusted, ['xhigh', 'max'].includes(level));
    assert.equal(resolved.metadata.budgetTokens, 16000);
  }
});

test('earlier thinking models get legal high/max budgets without an unsupported effort field', () => {
  for (const id of ['claude-3-7-sonnet-latest', 'claude-sonnet-4-20250514', 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
    const high = resolveProviderReasoning(id, 'high', { apiFormat: 'anthropic' });
    const max = resolveProviderReasoning(id, 'max', { apiFormat: 'anthropic' });
    assert.deepEqual(high.options, { thinking: { type: 'enabled', budgetTokens: 16000 } });
    assert.deepEqual(max.options, { thinking: { type: 'enabled', budgetTokens: 31999 } });
    assert.deepEqual(modelOptions(id, 'low'), high.options);
  }
});

test('unverified or non-reasoning Claude models never receive guessed thinking parameters', () => {
  for (const id of ['claude-3-5-sonnet-latest', 'claude-3-haiku-20240307', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-9', 'claude-opus-4-7custom', 'claude-private-alias']) {
    const resolved = resolveProviderReasoning(id, 'max', { apiFormat: 'anthropic' });
    assert.deepEqual(resolved.options, {});
    assert.equal(resolved.metadata.effective, null);
    assert.equal(resolved.metadata.reason, 'unverified-claude-model');
  }
  const disabled = resolveProviderReasoning('claude-opus-4-7', 'max', { apiFormat: 'anthropic', reasoning: false });
  assert.deepEqual(disabled.options, {});
  assert.equal(disabled.metadata.reason, 'reasoning-disabled');
});

test('declared supported tiers constrain native effort and manual budgets stay valid for small output limits', () => {
  const constrained = resolveProviderReasoning('claude-opus-4-7', 'medium', {
    apiFormat: 'anthropic', supported: ['low', 'high', 'max']
  });
  assert.equal(constrained.options.effort, 'high');
  assert.equal(constrained.metadata.adjusted, true);
  const small = resolveProviderReasoning('claude-sonnet-4-5', 'max', { apiFormat: 'anthropic', outputLimit: 4096 });
  assert.equal(small.options.thinking.budgetTokens, 4095);
  const impossible = resolveProviderReasoning('claude-sonnet-4-5', 'high', { apiFormat: 'anthropic', outputLimit: 1024 });
  assert.deepEqual(impossible.options, {});
  assert.equal(impossible.metadata.reason, 'output-limit-below-thinking-minimum');
});

test('non-Claude protocol adapters retain their established reasoning mapping', () => {
  assert.deepEqual(modelOptions('glm-5.3', 'medium', { apiFormat: 'openai' }), {
    reasoningEffort: 'high', reasoningEffortAdjusted: { requested: 'medium', model: 'glm-5.3' }
  });
  assert.deepEqual(resolveProviderReasoning('custom-anthropic-model', 'max', { apiFormat: 'anthropic' }).options,
    { reasoningEffort: 'max' });
});
