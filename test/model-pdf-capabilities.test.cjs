'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decorateModels, resolveModelCapabilities } = require('../lib/model-capabilities');
const { normalizeRemoteModels, parseRemoteModelCatalog } = require('../lib/model-catalog');

test('verified Astra PDF and vision input work across OpenAI, GPTL, and custom connections', () => {
  for (const provider of ['openai', 'gptl', 'conn-test', 'custom']) {
    for (const id of ['gpt-6-astra', 'openai/gpt-6-astra', 'gateway/GPT-6-ASTRA']) {
      const capabilities = resolveModelCapabilities(provider, { id });
      assert.equal(capabilities.pdfInput, true, `${provider}/${id} PDF`);
      assert.equal(capabilities.vision, true, `${provider}/${id} vision`);
      assert.equal(capabilities.imageInput, true, `${provider}/${id} images`);
    }
  }
});

test('verified Claude Opus 4.7 accepts PDF through Anthropic and custom connections', () => {
  for (const provider of ['anthropic', 'conn-trip-claude', 'custom']) {
    for (const id of ['claude-opus-4-7', 'anthropic/claude-opus-4-7', 'gateway/CLAUDE-OPUS-4-7']) {
      const capabilities = resolveModelCapabilities(provider, { id });
      assert.equal(capabilities.pdfInput, true, `${provider}/${id} PDF`);
      assert.equal(capabilities.imageInput, true, `${provider}/${id} images`);
    }
  }
});

test('PDF support is not inferred for arbitrary vision models or unverified Astra variants', () => {
  for (const id of ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-7-astra', 'gpt-6-astra-preview',
    'gpt-6-astra-2026-10-08', 'astra', 'claude-opus-4-8', 'unknown-vision']) {
    const capabilities = resolveModelCapabilities('openai', { id, capabilities: { vision: true } });
    assert.equal(capabilities.imageInput, true, id);
    assert.equal(capabilities.pdfInput, false, id);
  }
});

test('ADA aliases and Kimi that did not pass the live PDF check stay disabled', () => {
  for (const [provider, id] of [
    ['anthropic', 'claude-kr-claude-opus-5[1M]'],
    ['anthropic', 'claude-kr-claude-opus-5.5[1M]'],
    ['openai', 'kimi-k3'],
    ['kimi', 'kimi-k3']
  ]) {
    assert.equal(resolveModelCapabilities(provider, { id, capabilities: { vision: true } }).pdfInput, false);
  }
});

test('Claude PDF support persists through catalog reloads and honors explicit disabling', () => {
  let models = [{ id: 'claude-opus-4-7', inputModalities: ['text', 'image'] }];
  for (let pass = 0; pass < 3; pass++) {
    models = decorateModels('anthropic', normalizeRemoteModels(models));
    assert.equal(models[0].capabilities.pdfInput, true);
  }
  models[0].capabilities.pdfInput = false;
  models[0].inputModalities.push('pdf');
  for (let pass = 0; pass < 3; pass++) {
    models = decorateModels('anthropic', normalizeRemoteModels(models));
    assert.equal(models[0].capabilities.pdfInput, false);
  }
});

test('explicit PDF false overrides verified inference and positive modality metadata', () => {
  const models = [
    { id: 'gpt-6-astra', capabilities: { pdfInput: false } },
    { id: 'gpt-6-astra', pdfInput: false },
    { id: 'gpt-6-astra', inputModalities: ['text', 'image', 'pdf'], capabilities: { pdfInput: false } },
    { id: 'gpt-6-astra', pdfInput: true, capabilities: { pdfInput: false } }
  ];
  for (const model of models) {
    assert.equal(resolveModelCapabilities('gptl', model).pdfInput, false);
  }
});

test('declared PDF support works independently from the verified model fallback', () => {
  const declarations = [
    { capabilities: { pdfInput: true, vision: false } },
    { pdfInput: true },
    { inputModalities: ['text', 'pdf'] },
    { input_modalities: ['text', 'application/pdf'] },
    { modalities: { input: ['text', 'pdf'] } },
    { capabilities: { inputModalities: ['text', 'pdf'] } },
    { capabilities: { input_modalities: ['text', 'pdf'] } },
    { capabilities: { input: ['text', 'pdf'] } }
  ];
  for (const declaration of declarations) {
    const model = { id: 'custom-document-model', ...declaration };
    assert.equal(resolveModelCapabilities('custom', model).pdfInput, true, JSON.stringify(declaration));
  }
});

test('Astra text/image catalog entries retain PDF inference while explicit text-only inputs stay restricted', () => {
  const model = { id: 'gpt-6-astra', inputModalities: ['text', 'image'] };
  assert.equal(resolveModelCapabilities('gptl', model).pdfInput, true);
  assert.equal(resolveModelCapabilities('gptl', { id: model.id, inputModalities: ['text'] }).pdfInput, false);
  const restricted = resolveModelCapabilities('gptl', { id: model.id, capabilities: { vision: false } });
  assert.equal(restricted.vision, false);
  assert.equal(restricted.pdfInput, false);
});

test('catalog normalization preserves explicit PDF booleans including false', () => {
  for (const pdfInput of [true, false]) {
    const source = { id: 'gpt-6-astra', pdfInput, input_modalities: ['text', 'image'] };
    const models = parseRemoteModelCatalog({ data: [source] });
    assert.deepEqual(models, [{ id: source.id, name: source.id,
      inputModalities: ['text', 'image'], capabilities: { pdfInput } }]);
    let roundTrip = models;
    for (let pass = 0; pass < 3; pass++) {
      roundTrip = decorateModels('gptl', normalizeRemoteModels(roundTrip));
      assert.equal(roundTrip[0].capabilities.pdfInput, pdfInput);
    }
    assert.equal(source.pdfInput, pdfInput);
    assert.equal(source.capabilities, undefined);
  }
});

test('nested declared PDF modalities survive catalog normalization and capability decoration', () => {
  const models = parseRemoteModelCatalog({ data: [{ id: 'custom-document-model',
    capabilities: { inputModalities: ['text', 'pdf'] } }] });
  assert.deepEqual(models[0].inputModalities, ['text', 'pdf']);
  assert.equal(decorateModels('custom', models)[0].capabilities.pdfInput, true);
});

test('inferred Astra capabilities remain usable after repeated saved-catalog round trips', () => {
  const source = [{ id: 'gpt-6-astra', name: 'Astra' }];
  let models = source;
  for (let pass = 0; pass < 3; pass++) {
    models = decorateModels('gptl', normalizeRemoteModels(models));
    assert.equal(models[0].capabilities.pdfInput, true);
    assert.equal(models[0].capabilities.imageInput, true);
  }
  assert.deepEqual(source, [{ id: 'gpt-6-astra', name: 'Astra' }]);
});
