'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { sessionModelSnapshot, inferSessionModelSelection, createSessionWriteQueue } = require('../lib/session-model');
const { taskWorkspaceRoot, ensureTaskWorkspace } = require('../lib/task-workspace');
const { normalizeWorkspacePath, sameWorkspace } = require('../lib/session-handoff');
const { preserveForkAuthority, forkRunContext } = require('../lib/session-fork');
const rewind = require('../lib/session-rewind');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}
const selection = suffix => ({ providerId: `fixture-${suffix}`, supplierId: 'official',
  modelId: `model-${suffix}`, modelType: 'text', name: `Model ${suffix}`, capabilities: { vision: false } });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-session-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'profile', 'YanData');
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const defaultTasksRoot = taskWorkspaceRoot({ userDataDirectory: path.join(root, 'profile'), isolated: true });
  const providers = Object.fromEntries(['a', 'b'].map(suffix => [`fixture-${suffix}`, {
    id: `fixture-${suffix}`, name: `Provider ${suffix}`, apiFormat: 'openai'
  }]));
  let config = { agentModel: selection('a'), api: { provider: 'fixture-a', model: 'model-a', providerSuppliers: {},
    providerActiveSupplierIds: {}, connections: [], reasoningSpeed: 'medium' },
    observer: { judgeEvery: 3 }, media: { imageProvider: 'fixture-image' }, context: {}, agent: {} };
  for (const suffix of ['a', 'b']) {
    const id = `fixture-${suffix}`;
    config.api.providerSuppliers[id] = [{ id: 'official', apiKey: `fixture-key-${suffix}`, baseUrl: `http://127.0.0.1:9/${suffix}`,
      models: [{ id: `model-${suffix}`, name: `Model ${suffix}`, modelType: 'text', capabilities: { vision: false } }] }];
    config.api.providerActiveSupplierIds[id] = 'official';
    config.api.connections.push({ providerId: id, supplierId: 'official' });
  }
  const handlers = new Map();
  const cache = new Map();
  const compressionCalls = [];
  let writeGate = null;
  const context = vm.createContext({
    ...rewind, fs, fsp: { ...fs.promises, async writeFile(...args) {
      if (writeGate) { const gate = writeGate; writeGate = null; gate.enter(); await gate.promise; }
      return fs.promises.writeFile(...args);
    } }, path, crypto, process: { pid: process.pid }, dataDir, defaultTasksRoot, sessionRecordCache: cache,
    ensureTaskWorkspace, normalizeWorkspacePath, sameWorkspace,
    sessionModelSnapshot, inferSessionModelSelection, createSessionWriteQueue, preserveForkAuthority, forkRunContext,
    MODEL_PROVIDERS: providers,
    loadConfig: () => structuredClone(config),
    saveConfig() { throw new Error('session model changes must not write global config'); },
    publishModelState() { throw new Error('session model changes must not publish global model selection'); },
    composerConnections: cfg => cfg.api.connections.map(connection => ({ ...connection,
      models: cfg.api.providerSuppliers[connection.providerId]?.find(item => item.id === connection.supplierId)?.models || [] })),
    isConfiguredSupplier: (cfg, providerId, supplier) => !!supplier.apiKey && cfg.api.connections.some(item =>
      item.providerId === providerId && item.supplierId === supplier.id),
    getProviderModels: (cfg, providerId, supplierId) => cfg.api.providerSuppliers[providerId]?.find(item => item.id === supplierId)?.models || [],
    getProviderConnectionForSupplier: (cfg, providerId, supplierId) => cfg.api.providerSuppliers[providerId]?.find(item => item.id === supplierId),
    getModelType: (_providerId, model) => model.modelType || 'text',
    normalizeAgentModelSelection: cfg => cfg.agentModel,
    buildOpenCodeConfig: options => options,
    providerAdapterPreset: (_cfg, id) => id,
    DEFAULT_INPUT_TOKENS_PER_SECOND: 10000,
    normalizeInputTokensPerSecond: value => Number(value) || 10000,
    measurementKey: (provider, model) => `${provider}:${model}`,
    appRoot: root, skillsDir: path.join(root, 'skills'), getOpenCodeMcpServers: () => [],
    isSafeSessionId: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || '')),
    sessionPath: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || '')) ? path.join(sessionsDir, `${id}.json`) : null,
    ensureDirs() {},
    touchSessionRecordCache(id, session, stat) { cache.set(id, { session, mtimeMs: stat.mtimeMs, size: stat.size }); },
    invalidateSessionRecordCache(id) { cache.delete(id); },
    async refreshSessionSummaryCache(id, data) {
      const stat = await fs.promises.stat(path.join(sessionsDir, `${id}.json`));
      cache.set(id, { session: data, mtimeMs: stat.mtimeMs, size: stat.size });
    },
    sanitizeSessionReviewSummaries: value => value, pruneSessionRuntimeBookkeeping: value => value,
    selectTailMessages: (messages, limit) => ({ tail: messages.slice(-limit), messagesStart: Math.max(0, messages.length - limit) }),
    activateWorkspace() {}, migrateMemoryToWorkspace() {}, ensureYanagent() {}, notifyDesktopSessionUpdate() {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    console: { info() {}, warn() {}, error() {} },
    isSessionRunActive: () => false,
    withOpenCodeBackgroundLease: operation => operation(),
    workspaceSandbox: { normalizeWorkspace: value => value },
    getNoWorkspaceAgentDirectory: () => root,
    ensureOpenCodeSidecar: async runtime => ({ compressSession: async request => {
      compressionCalls.push({ runtime, request }); return { compacted: true };
    } }),
    MAX_CONCURRENT_AGENT_RUNS: 10,
    openCodeActiveRuns: new Map(), openCodeRunAdmissions: new Map()
  });
  for (const name of ['stageDeepSeekProviderModule', 'stageCodingEnvironmentModule', 'stageGlmmProviderModule',
    'stageQwemProviderModule', 'stageKimlProviderModule', 'stageResponsesProviderModule', 'stageGptlProviderModule']) context[name] = () => '';
  for (const code of [
    section('async function writeSessionFileAtomic(', "ipcMain.handle('session:save',"),
    section('const sessionWorkspaceAssignments =', '// session:list fires after every run completion'),
    section('async function createFreshSessionRecord(', 'async function validateHandoffTarget('),
    section('async function renameSessionRecord(', 'function deleteSessionRecord('),
    section('async function setSessionModelRecord(', "ipcMain.handle('session:messages',"),
    section("ipcMain.handle('session:save',", '// 会话级工作区'),
    section("ipcMain.handle('session:set-workspace',", "ipcMain.handle('session:rename',"),
    section('function getOpenCodeRuntimeConfig(', 'function getOpenCodeCapabilityContext('),
    section('const manualContextCompressions =', "ipcMain.handle('opencode:start-run',")
  ]) vm.runInContext(code, context);
  // Execute the actual admission/routing block, stopping at the kernel
  // boundary. The separate desktop E2E exercises real provider requests.
  vm.runInContext(section("ipcMain.handle('opencode:start-run',", '    // The persisted conversation owns its directory.')
    + 'return { ok: true, selection, runtime: getOpenCodeRuntimeConfig(cfg), cfg }; } catch (error) { return { ok: false, error: error.message, code: error.code }; } });', context);
  return {
    root, context, compressionCalls,
    create: () => context.createFreshSessionRecord(),
    read: id => context.readSessionRecord(id),
    disk: id => JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8')),
    seed: data => { cache.clear(); fs.writeFileSync(path.join(sessionsDir, `${data.id}.json`), JSON.stringify(data)); },
    config: () => structuredClone(config),
    editConfig: operation => operation(config),
    set: (id, modelSelection) => handlers.get('session:model-set')(null, { id, modelSelection }),
    save: session => handlers.get('session:save')(null, structuredClone(session)),
    workspace: (id, workspace) => handlers.get('session:set-workspace')(null, { id, workspace, activate: false }),
    start: request => handlers.get('opencode:start-run')(null, request),
    compress: id => handlers.get('opencode:compress-session')(null, { yanSessionId: id }),
    pauseWrite() {
      let release, enter;
      const promise = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { enter = resolve; });
      writeGate = { promise, enter };
      return { entered, release };
    }
  };
}

test('snapshots retain only model identity and safe display metadata', () => {
  const snapshot = sessionModelSnapshot({ ...selection('a'), apiKey: 'secret', baseUrl: 'private-endpoint',
    capabilities: { vision: true, apiKey: 'secret', nested: { key: 'secret' } } });
  assert.deepEqual(snapshot, { ...selection('a'), capabilities: { vision: true } });
  assert.equal(sessionModelSnapshot({ ...selection('a'), modelType: 'image' }), null);
});

test('history initialization preserves removed models and can recover a supplier from its original user turn', () => {
  const missing = { ...selection('b'), providerId: 'deleted-provider', modelId: 'removed-model' };
  assert.deepEqual(inferSessionModelSelection({ messages: [{ role: 'user', modelSelection: missing },
    { role: 'assistant', agentRun: { providerId: missing.providerId, modelId: missing.modelId } }] }, selection('a')),
  { ...missing, name: 'removed-model', capabilities: {} });
});

test('new conversations snapshot the default once and A/B selection changes do not touch global or sibling settings', async t => {
  const f = fixture(t);
  const a = await f.create();
  const b = await f.create();
  const global = f.config();
  assert.equal((await f.set(b.id, { ...selection('b'), apiKey: 'must-not-persist' })).ok, true);
  assert.equal(f.disk(a.id).modelSelection.modelId, 'model-a');
  assert.equal(f.disk(b.id).modelSelection.modelId, 'model-b');
  assert.deepEqual(f.config(), global);
  assert.equal(JSON.stringify(f.disk(b.id)).includes('must-not-persist'), false);
  f.editConfig(cfg => { cfg.agentModel = selection('b'); });
  assert.equal((await f.read(a.id)).modelSelection.modelId, 'model-a');
  assert.equal((await f.create()).modelSelection.modelId, 'model-b');
});

test('old conversations migrate from history once without changing timestamps; unavailable history never becomes the default', async t => {
  const f = fixture(t);
  const a = await f.create();
  const old = { ...a, updatedAt: 42, modelSelection: undefined,
    messages: [{ role: 'assistant', agentRun: { providerId: 'deleted-provider', supplierId: 'official', modelId: 'removed-model' } }] };
  f.seed(old);
  const migrated = await f.read(a.id);
  assert.equal(migrated.modelSelection.modelId, 'removed-model');
  assert.equal(f.disk(a.id).updatedAt, 42);
  assert.equal(f.disk(a.id).modelSelection.providerId, 'deleted-provider');
  const run = await f.start({ yanSessionId: a.id });
  assert.equal(run.ok, false);
  assert.equal(run.code, 'SESSION_MODEL_UNAVAILABLE');
  assert.equal(f.disk(a.id).modelSelection.modelId, 'removed-model');
});

test('old conversations without history snapshot the current default and ordinary saves cannot replace it', async t => {
  const f = fixture(t);
  const a = await f.create();
  f.seed({ ...a, modelSelection: undefined });
  f.editConfig(cfg => { cfg.agentModel = selection('b'); });
  assert.equal((await f.read(a.id)).modelSelection.modelId, 'model-b');
  await f.save({ ...a, modelSelection: selection('a'), messages: [{ role: 'user', content: 'new message' }] });
  assert.equal(f.disk(a.id).modelSelection.modelId, 'model-b');
  assert.equal(f.disk(a.id).messages.length, 1);
});

test('a stale message save queued while model selection writes cannot undo the selection or lose messages', async t => {
  const f = fixture(t);
  const a = await f.create();
  const gate = f.pauseWrite();
  const change = f.set(a.id, selection('b'));
  await gate.entered;
  const save = f.save({ ...a, messages: [{ role: 'user', content: 'keep this message' }] });
  gate.release();
  await Promise.all([change, save]);
  assert.equal(f.disk(a.id).modelSelection.modelId, 'model-b');
  assert.equal(f.disk(a.id).messages[0].content, 'keep this message');
});

for (const writer of ['workspace', 'rename', 'pin', 'messages']) {
  test(`${writer} writes and a queued model change preserve both changes`, async t => {
    const f = fixture(t);
    const a = await f.create();
    const gate = f.pauseWrite();
    const writing = writer === 'workspace' ? f.workspace(a.id, path.join(f.root, 'project'))
      : writer === 'rename' ? f.context.renameSessionRecord(a.id, 'renamed')
      : writer === 'pin' ? f.context.setSessionPinnedRecord(a.id, true)
      : f.save({ ...a, messages: [{ role: 'user', content: 'saved' }] });
    await gate.entered;
    const change = f.set(a.id, selection('b'));
    gate.release();
    await Promise.all([writing, change]);
    const disk = f.disk(a.id);
    assert.equal(disk.modelSelection.modelId, 'model-b');
    if (writer === 'workspace') assert.equal(disk.workspace, path.join(f.root, 'project'));
    if (writer === 'rename') assert.equal(disk.title, 'renamed');
    if (writer === 'pin') assert.equal(disk.pinned, true);
    if (writer === 'messages') assert.equal(disk.messages[0].content, 'saved');
  });
}

test('runs and compression resolve each session or explicit frozen model into the correct runtime credentials without global writes', async t => {
  const f = fixture(t);
  const a = await f.create();
  const b = await f.create();
  await f.set(b.id, selection('b'));
  const global = f.config();
  const [runA, runB] = await Promise.all([f.start({ yanSessionId: a.id }), f.start({ yanSessionId: b.id })]);
  assert.equal(runA.runtime.modelId, 'model-a');
  assert.equal(runA.runtime.apiKey, 'fixture-key-a');
  assert.equal(runB.runtime.modelId, 'model-b');
  assert.equal(runB.runtime.apiKey, 'fixture-key-b');
  const frozen = await f.start({ yanSessionId: a.id, modelSelection: selection('b') });
  assert.equal(frozen.runtime.baseUrl, 'http://127.0.0.1:9/b');
  assert.equal(f.disk(a.id).modelSelection.modelId, 'model-a');
  f.seed({ ...f.disk(b.id), openCodeSessionId: 'kernel-b' });
  assert.equal((await f.compress(b.id)).ok, true);
  assert.equal(f.compressionCalls[0].runtime.modelId, 'model-b');
  assert.equal(f.compressionCalls[0].request.openCodeConfig.apiKey, 'fixture-key-b');
  assert.deepEqual(f.config(), global);
});

test('missing models/suppliers fail explicitly and synthetic utility sessions require an explicit valid frozen model', async t => {
  const f = fixture(t);
  const a = await f.create();
  assert.equal((await f.set(a.id, { ...selection('a'), supplierId: 'removed' })).code, 'SESSION_MODEL_UNAVAILABLE');
  assert.equal((await f.start({ yanSessionId: 'sess_deleted' })).code, 'session-not-found');
  const utility = await f.start({ yanSessionId: 'prompt-optimizer:fixture', utility: true, modelSelection: selection('b') });
  assert.equal(utility.runtime.modelId, 'model-b');
  assert.equal((await f.start({ yanSessionId: 'prompt-optimizer:fixture', utility: true })).code, 'SESSION_MODEL_UNAVAILABLE');
  f.editConfig(cfg => { cfg.api.connections = cfg.api.connections.filter(item => item.providerId !== 'fixture-a'); });
  assert.equal((await f.start({ yanSessionId: a.id })).code, 'SESSION_MODEL_UNAVAILABLE');
});
