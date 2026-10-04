'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}

function normalizer() {
  const context = vm.createContext({
    MODEL_PROVIDERS: {
      deepseek: { id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: [] },
      'conn-fixture': { id: 'conn-fixture', baseUrl: 'http://127.0.0.1:9/v1', models: [], connection: true }
    },
    normalizeRemoteModels: value => value
  });
  for (const code of [
    section('function buildDefaultApiKeys(', 'function normalizeCustomModelEntry('),
    section('function ensureProviderConfigs(', 'function getProviderConnection('),
    section('function pruneUnlistedSupplierState(', '\nfunction ')
  ]) vm.runInContext(code, context);
  return raw => {
    context.cfg = structuredClone(raw);
    context.merged = structuredClone(raw);
    const output = vm.runInContext(`(() => {
      const hasStoredProviderSuppliers = !!cfg.api?.providerSuppliers && typeof cfg.api.providerSuppliers === 'object';
      ${section('  // 迁移旧配置：旧的单 apiKey', '  // 确保 apiKeys 包含所有已知厂商')}
      ensureProviderConfigs(merged);
      return { config: merged, mustSave: pruneUnlistedSupplierState(merged) };
    })()`, context);
    return JSON.parse(JSON.stringify(output));
  };
}

function modernConfig() {
  return {
    api: {
      apiKey: 'fixture-only', apiKeys: { deepseek: '', 'conn-fixture': 'fixture-only' },
      providerConfigs: {
        deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: '' },
        'conn-fixture': { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' }
      },
      providerSuppliers: {
        deepseek: [{ id: 'official', name: 'official', apiKey: '', models: [] }],
        'conn-fixture': [{ id: 'official', name: 'Renamed gateway', apiKey: 'fixture-only', models: [] }]
      },
      providerActiveSupplierIds: { deepseek: 'official', 'conn-fixture': 'official' },
      connectionsMigrated: true,
      connections: [{ id: 'conn-fixture', providerId: 'conn-fixture', supplierId: 'official' }]
    },
    providerModels: {}
  };
}

test('repeated modern proxy reads do not cycle a DeepSeek key or request full config writes', () => {
  const normalize = normalizer();
  let config = modernConfig();
  for (let round = 0; round < 3; round += 1) {
    const result = normalize(config);
    assert.equal(result.mustSave, false);
    assert.equal(result.config.api.apiKeys.deepseek, '');
    assert.equal(result.config.api.providerSuppliers.deepseek[0].apiKey, '');
    assert.equal(result.config.api.providerSuppliers['conn-fixture'][0].name, 'Renamed gateway');
    assert.deepEqual(result.config.api.connections.map(connection => connection.id), ['conn-fixture']);
    config = result.config;
  }
});

test('the actual old single-key schema still migrates its key to DeepSeek', () => {
  const normalize = normalizer();
  const result = normalize({ api: { apiKey: 'legacy-fixture-only', apiKeys: {}, providerConfigs: {}, connectionsMigrated: false }, providerModels: {} });
  assert.equal(result.config.api.apiKeys.deepseek, 'legacy-fixture-only');
  assert.equal(result.config.api.providerSuppliers.deepseek[0].apiKey, 'legacy-fixture-only');
});

test('supplier schemas predating flat connections are also exempt from single-key migration', () => {
  const config = modernConfig();
  config.api.connectionsMigrated = false;
  const result = normalizer()(config);
  assert.equal(result.config.api.apiKeys.deepseek, '');
  assert.equal(result.mustSave, false);
});

test('normalization cannot restore a renamed or deleted connection after an external edit', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-config-normalization-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const original = JSON.stringify({ connections: [{ name: 'Original gateway' }, { name: 'Secondary gateway' }] });
  const current = JSON.stringify({ connections: [{ name: 'Renamed gateway' }] });
  let writes = 0;
  const context = vm.createContext({ fs, configPath, saveConfig(value) { writes += 1; fs.writeFileSync(configPath, JSON.stringify(value)); } });
  vm.runInContext(section('function saveNormalizedConfigIfCurrent(', 'function normalizeAgentConfig('), context);
  fs.writeFileSync(configPath, original);
  const loaded = fs.readFileSync(configPath, 'utf8');
  const replacement = path.join(root, 'replacement.json');
  fs.writeFileSync(replacement, current);
  fs.renameSync(replacement, configPath);
  assert.equal(context.saveNormalizedConfigIfCurrent(JSON.parse(original), loaded), false);
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(configPath, 'utf8'), current);
  const normalized = { ...JSON.parse(current), normalized: true };
  assert.equal(context.saveNormalizedConfigIfCurrent(normalized, current), true);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), normalized);
  fs.unlinkSync(configPath);
  assert.equal(context.saveNormalizedConfigIfCurrent(normalized, current), false);
  assert.equal(fs.existsSync(configPath), false, 'an intentionally removed file is not recreated by a stale read');
});
