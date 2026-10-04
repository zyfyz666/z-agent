'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}

function model(id) { return { id, name: id, modelType: 'text' }; }

// Only persistence, registry discovery, and the remote catalog are fixtures.
// The production save operation, connection handler, supplier normalization,
// and model selection run unchanged, without touching the user's profile.
function harness() {
  const providers = {};
  const calls = [];
  const handlers = new Map();
  let writes = 0;
  let sequence = 0;
  let disk = {
    api: { provider: 'conn-a', model: 'model-a', providerSuppliers: {}, providerActiveSupplierIds: {},
      providerConfigs: {}, apiKeys: {}, connections: [] },
    agent: { accessMode: 'request' },
    agentModel: { providerId: 'conn-a', supplierId: 'official', modelId: 'model-a', modelType: 'text' },
    observer: { judgeEvery: 5, model: null },
    providerModels: {}
  };
  for (const suffix of ['a', 'b']) {
    const id = `conn-${suffix}`;
    const supplier = { id: 'official', name: `Connection ${suffix}`, baseUrl: `http://127.0.0.1:9/${suffix}`,
      apiKey: 'fixture-only', models: [model(`model-${suffix}`)] };
    disk.api.providerSuppliers[id] = [supplier];
    disk.api.providerActiveSupplierIds[id] = 'official';
    disk.api.providerConfigs[id] = { ...supplier };
    disk.api.apiKeys[id] = supplier.apiKey;
    disk.api.connections.push({ id, providerId: id, supplierId: 'official', preset: 'openai', apiFormat: 'openai' });
    disk.providerModels[id] = supplier.models;
  }
  function syncConnectionProviders(cfg) {
    const ids = new Set(cfg.api.connections.map(item => item.providerId));
    for (const id of Object.keys(providers)) if (!ids.has(id)) delete providers[id];
    for (const connection of cfg.api.connections) {
      providers[connection.providerId] = { id: connection.providerId, baseUrl: 'http://127.0.0.1:9/v1',
        models: [], dynamicModels: true, apiFormat: 'openai' };
    }
  }
  syncConnectionProviders(disk);
  const context = vm.createContext({
    MODEL_PROVIDERS: providers,
    CONNECTION_PRESETS: ['auto', 'openai'],
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    loadConfig() { const cfg = structuredClone(disk); syncConnectionProviders(cfg); return cfg; },
    saveConfig(cfg) { disk = structuredClone(cfg); writes++; },
    normalizeRemoteModels: value => value,
    normalizeApiFormat: value => value || 'openai',
    fetchRemoteModelCatalog(payload) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      calls.push({ payload, resolve, reject });
      return promise;
    },
    getConfiguredSupplierEntries: cfg => cfg.api.connections.flatMap(connection => {
      const supplier = cfg.api.providerSuppliers[connection.providerId]?.find(item => item.id === connection.supplierId);
      return supplier?.apiKey ? [{ ...connection, supplier }] : [];
    }),
    getProviderModels: (cfg, providerId, supplierId = 'official') =>
      cfg.api.providerSuppliers[providerId]?.find(item => item.id === supplierId)?.models || [],
    getModelType: (_providerId, entry) => entry.modelType || 'text',
    getFirstTextModel: (_providerId, models) => models[0],
    updateImageGenerationConfig() {},
    syncConnectionProviders,
    publishModelState() {},
    publicConfig: cfg => structuredClone(cfg),
    newConnectionId: () => `conn-new-${++sequence}`,
    resolveConnectionApiFormat: connection => connection.apiFormat || 'openai',
    connectionSummary: (cfg, connection) => {
      const supplier = cfg.api.providerSuppliers[connection.providerId]?.find(item => item.id === connection.supplierId);
      return supplier ? { id: connection.id, name: supplier.name, modelCount: supplier.models.length } : null;
    }
  });
  for (const code of [
    section('function buildDefaultApiKeys(', 'function normalizeCustomModelEntry('),
    section('function ensureProviderConfigs(', 'function getProviderConnection('),
    section('function findConnection(', '// The adapter shape'),
    section('function getProviderSupplier(', '// After the connection migration'),
    section('function syncActiveProviderSupplier(', 'function rebindRolesAfterSupplierRemoval('),
    section('function normalizeAgentModelSelection(', 'function buildPublicModelState('),
    section('function applyProviderSelection(', 'function loadConfig('),
    section('const pendingProviderConfigurations = ', "ipcMain.handle('provider:configure'"),
    section("ipcMain.handle('connections:save'", "ipcMain.handle('connections:delete'")
  ]) vm.runInContext(code, context);
  return {
    calls,
    get writes() { return writes; },
    read: () => structuredClone(disk),
    edit: change => change(disk),
    configure: (payload = {}) => context.applyProviderConfiguration({
      providerId: 'conn-a', supplierId: 'official', supplierName: 'Edited A',
      baseUrl: 'http://127.0.0.1:9/edited', ...payload
    }),
    saveConnection: payload => handlers.get('connections:save')(null, payload)
  };
}

test('a delayed connection save preserves other connections, permissions, Observer settings, and the latest main model', async () => {
  const h = harness();
  const pending = h.configure();
  assert.equal(h.calls.length, 1);
  h.edit(cfg => {
    cfg.api.providerSuppliers['conn-b'][0].name = 'Renamed B';
    cfg.agent.accessMode = 'full';
    cfg.observer = { judgeEvery: 2, model: { providerId: 'conn-b', supplierId: 'official', modelId: 'model-b' } };
    cfg.agentModel = { providerId: 'conn-b', supplierId: 'official', modelId: 'model-b', modelType: 'text' };
  });
  const before = h.read();
  h.calls[0].resolve([model('updated-a')]);
  assert.equal((await pending).ok, true);
  const after = h.read();
  assert.equal(after.api.providerSuppliers['conn-a'][0].name, 'Edited A');
  assert.deepEqual(after.api.providerSuppliers['conn-a'][0].models, [model('updated-a')]);
  assert.equal(after.api.providerSuppliers['conn-b'][0].name, 'Renamed B');
  assert.deepEqual(after.agent, before.agent);
  assert.deepEqual(after.observer, before.observer);
  assert.equal(after.agentModel.providerId, 'conn-b');
  assert.equal(after.agentModel.modelId, 'model-b');
  assert.equal(after.api.provider, 'conn-b');
  assert.equal(after.api.model, 'model-b');
  assert.equal(h.writes, 1);
});

test('a slower supplier save preserves another supplier save that completed first', async () => {
  const h = harness();
  const a = h.configure();
  const b = h.configure({ providerId: 'conn-b', supplierName: 'Edited B' });
  h.calls[1].resolve([model('model-b')]);
  assert.equal((await b).ok, true);
  h.calls[0].resolve([model('model-a')]);
  assert.equal((await a).ok, true);
  assert.equal(h.read().api.providerSuppliers['conn-a'][0].name, 'Edited A');
  assert.equal(h.read().api.providerSuppliers['conn-b'][0].name, 'Edited B');
});

for (const newerFinishesFirst of [true, false]) {
  test(`a newer save of the same supplier supersedes the older request (${newerFinishesFirst ? 'newer' : 'older'} catalog returns first)`, async () => {
    const h = harness();
    const older = h.configure({ supplierName: 'Older edit' });
    const newer = h.configure({ supplierName: 'Newest edit' });
    if (newerFinishesFirst) {
      h.calls[1].resolve([model('newest-model')]);
      assert.equal((await newer).ok, true);
    }
    h.calls[0].resolve([model('older-model')]);
    assert.equal((await older).code, 'PROVIDER_CONFIG_CHANGED');
    if (!newerFinishesFirst) {
      assert.equal(h.writes, 0);
      h.calls[1].resolve([model('newest-model')]);
      assert.equal((await newer).ok, true);
    }
    assert.equal(h.writes, 1);
    assert.equal(h.read().api.providerSuppliers['conn-a'][0].name, 'Newest edit');
    assert.deepEqual(h.read().api.providerSuppliers['conn-a'][0].models, [model('newest-model')]);
  });
}

for (const kind of ['supplier edit', 'connection metadata edit', 'deletion']) {
  test(`an external ${kind} while catalog discovery is pending rejects the old result`, async () => {
    const h = harness();
    const pending = h.configure();
    h.edit(cfg => {
      if (kind === 'supplier edit') cfg.api.providerSuppliers['conn-a'][0].name = 'External edit';
      else if (kind === 'connection metadata edit') cfg.api.connections[0].streamEnabled = false;
      else {
        cfg.api.connections = cfg.api.connections.filter(item => item.id !== 'conn-a');
        delete cfg.api.providerSuppliers['conn-a'];
      }
    });
    const before = h.read();
    h.calls[0].resolve([model('late-model')]);
    assert.equal((await pending).code, 'PROVIDER_CONFIG_CHANGED');
    assert.equal(h.writes, 0);
    assert.deepEqual(h.read(), before);
  });
}

for (const catalogFails of [true, false]) {
  test(`an obsolete new-connection save cannot roll back its newer edit (${catalogFails ? 'failed' : 'successful'} old catalog)`, async () => {
    const h = harness();
    const payload = { name: 'New connection', baseUrl: 'http://127.0.0.1:9/new', apiKey: 'fixture-only', apiFormat: 'openai' };
    const older = h.saveConnection(payload);
    const id = h.read().api.connections.at(-1).id;
    const newer = h.saveConnection({ ...payload, id, name: 'Corrected connection' });
    h.calls[1].resolve([model('corrected-model')]);
    assert.equal((await newer).ok, true);
    const before = h.read();
    const writesBefore = h.writes;
    if (catalogFails) h.calls[0].reject(new Error('fixture catalog failure'));
    else h.calls[0].resolve([model('obsolete-model')]);
    assert.equal((await older).code, 'PROVIDER_CONFIG_CHANGED');
    assert.equal(h.writes, writesBefore);
    assert.deepEqual(h.read(), before);
    assert.equal(h.read().api.providerSuppliers[id][0].name, 'Corrected connection');
  });
}

test('a failed new-connection catalog still rolls back its own unchanged draft', async () => {
  const h = harness();
  const pending = h.saveConnection({ name: 'Invalid connection', baseUrl: 'http://127.0.0.1:9/new', apiKey: 'fixture-only' });
  const id = h.read().api.connections.at(-1).id;
  h.calls[0].reject(new Error('fixture catalog failure'));
  const result = await pending;
  assert.match(result.error, /fixture catalog failure/);
  assert.equal(h.read().api.connections.some(item => item.id === id), false);
  assert.equal(h.read().api.providerSuppliers[id], undefined);
});

for (const samePayload of [false, true]) {
  test(`rollback rechecks ownership when a newer ${samePayload ? 'identical' : 'edited'} save starts after catalog failure`, async () => {
    const h = harness();
    const payload = { name: 'New connection', baseUrl: 'http://127.0.0.1:9/new', apiKey: 'fixture-only', apiFormat: 'openai' };
    const older = h.saveConnection(payload);
    const id = h.read().api.connections.at(-1).id;
    h.calls[0].reject(new Error('old catalog failed'));
    let newer;
    // Land after applyProviderConfiguration has returned its failure but
    // before the awaiting IPC handler attempts to delete its original draft.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      newer = h.saveConnection({ ...payload, id, name: samePayload ? payload.name : 'Newer draft' });
    })));
    const result = await older;
    assert.ok(newer, 'the newer save entered the rollback gap');
    assert.equal(result.code, 'PROVIDER_CONFIG_CHANGED');
    assert.equal(h.calls.length, 2, 'the new catalog is still in flight');
    assert.ok(h.read().api.connections.some(item => item.id === id), 'the in-flight draft was not deleted');
    h.calls[1].resolve([model('new-model')]);
    assert.equal((await newer).ok, true);
    assert.deepEqual(h.read().api.providerSuppliers[id][0].models, [model('new-model')]);
  });
}

test('rollback rechecks the draft snapshot after an external edit in the caller await gap', async () => {
  const h = harness();
  const older = h.saveConnection({ name: 'New connection', baseUrl: 'http://127.0.0.1:9/new', apiKey: 'fixture-only' });
  const id = h.read().api.connections.at(-1).id;
  h.calls[0].reject(new Error('old catalog failed'));
  queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
    h.edit(cfg => { cfg.api.providerSuppliers[id][0].name = 'External corrected draft'; });
  })));
  assert.equal((await older).code, 'PROVIDER_CONFIG_CHANGED');
  assert.equal(h.read().api.providerSuppliers[id][0].name, 'External corrected draft');
  assert.equal(h.writes, 1, 'the old operation does not write or delete the external edit');
});
