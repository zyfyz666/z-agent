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
const { preserveForkAuthority, forkRunContext, createSessionForkRecord, messageForkAnchor } = require('../lib/session-fork');
const rewind = require('../lib/session-rewind');
const { isDefaultSessionTitle } = require('../lib/session-policy');
const { normalizeOutputTokens, validateOutputTokens } = require('../lib/model-output-limits');
const { normalizeReasoningSpeed, reasoningSpeedEnablesThinking } = require('../lib/reasoning-effort');
const { normalizeContextSettings } = require('../lib/context-settings');

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
  const dataDir = path.join(root, 'profile', 'ZData');
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
    normalizeOutputTokens, validateOutputTokens,
    normalizeReasoningSpeed, reasoningSpeedEnablesThinking,
    normalizeContextSettings,
    isDefaultSessionTitle,
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
    activateWorkspace() {}, migrateMemoryToWorkspace() {}, ensureZagent() {}, notifyDesktopSessionUpdate() {},
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
    section("ipcMain.handle('session:rename',", "ipcMain.handle('session:set-pinned',"),
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
    rename: (id, title, options = {}) => handlers.get('session:rename')(null, { id, title, ...options }),
    workspace: (id, workspace) => handlers.get('session:set-workspace')(null, { id, workspace, activate: false }),
    start: request => handlers.get('opencode:start-run')(null, request),
    compress: id => handlers.get('opencode:compress-session')(null, { zSessionId: id }),
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

test('session output caps retain explicit values and preserve legacy omitted fields', () => {
  const original = selection('a');
  assert.equal(Object.hasOwn(sessionModelSnapshot(original), 'maxOutputTokens'), false);
  assert.equal(sessionModelSnapshot({ ...original, maxOutputTokens: '64000' }).maxOutputTokens, 64000);
  for (const value of [0, '', undefined, -1, 0.5, Infinity, 'bad']) {
    assert.equal(sessionModelSnapshot({ ...original, maxOutputTokens: value }).maxOutputTokens, 0);
  }
  const restored = inferSessionModelSelection({ modelSelection: { ...original, maxOutputTokens: 24000 } }, selection('b'));
  assert.equal(restored.maxOutputTokens, 24000);
});

test('reasoning snapshots normalize legacy values and history retains the originating turn effort', () => {
  assert.equal(Object.hasOwn(sessionModelSnapshot(selection('a')), 'reasoningSpeed'), false);
  assert.equal(sessionModelSnapshot({ ...selection('a'), reasoningSpeed: 'smart' }).reasoningSpeed, 'high');
  assert.equal(sessionModelSnapshot({ ...selection('a'), thinking: true }).reasoningSpeed, 'high');
  assert.equal(sessionModelSnapshot({ ...selection('a'), reasoningSpeed: 'invalid' }).reasoningSpeed, 'medium');
  const inferred = inferSessionModelSelection({ messages: [
    { role: 'user', modelSelection: { ...selection('a'), reasoningSpeed: 'max' } },
    { role: 'assistant', agentRun: selection('a') }
  ] }, { ...selection('b'), reasoningSpeed: 'low' });
  assert.equal(inferred.reasoningSpeed, 'max');
});

test('reasoning effort is isolated in storage, real run configuration, compression and queued snapshots', async t => {
  const f = fixture(t);
  const a = await f.create();
  const b = await f.create();
  const global = f.config();
  assert.equal(a.modelSelection.reasoningSpeed, 'medium');
  await f.set(a.id, { ...selection('a'), reasoningSpeed: 'max' });
  await f.set(b.id, { ...selection('b'), reasoningSpeed: 'low' });
  const queued = structuredClone(f.disk(a.id).modelSelection);
  const running = await f.start({ zSessionId: a.id });
  assert.equal(running.runtime.reasoningSpeed, 'max');
  assert.equal(running.cfg.api.thinking, true);
  await f.set(a.id, { ...selection('a'), reasoningSpeed: 'medium' });
  await f.save({ ...a, messages: [{ role: 'user', content: 'A stale progress save' }] });
  assert.equal(f.disk(a.id).modelSelection.reasoningSpeed, 'medium');
  assert.equal(f.disk(b.id).modelSelection.reasoningSpeed, 'low');
  assert.equal(running.runtime.reasoningSpeed, 'max', 'already running configuration is immutable');
  assert.equal((await f.start({ zSessionId: a.id, modelSelection: queued })).runtime.reasoningSpeed, 'max');
  assert.equal((await f.start({ zSessionId: b.id })).runtime.reasoningSpeed, 'low');
  assert.equal((await f.start({ zSessionId: a.id, modelSelection: selection('a') })).runtime.reasoningSpeed, 'medium',
    'legacy queued requests missing effort inherit their own conversation, not global settings');
  f.seed({ ...f.disk(b.id), openCodeSessionId: 'kernel-b' });
  assert.equal((await f.compress(b.id)).ok, true);
  assert.equal(f.compressionCalls[0].runtime.reasoningSpeed, 'low');
  assert.equal(f.compressionCalls[0].request.openCodeConfig.reasoningSpeed, 'low');
  assert.deepEqual(f.config(), global);
});

test('legacy sessions freeze current default effort once and model-only saves preserve it', async t => {
  const f = fixture(t);
  const a = await f.create();
  f.seed({ ...a, updatedAt: 42, modelSelection: selection('a') });
  f.editConfig(config => { config.api.reasoningSpeed = 'xhigh'; });
  assert.equal((await f.read(a.id)).modelSelection.reasoningSpeed, 'xhigh');
  assert.equal(f.disk(a.id).updatedAt, 42, 'migration does not reorder old conversations');
  f.editConfig(config => { config.api.reasoningSpeed = 'low'; });
  assert.equal((await f.read(a.id)).modelSelection.reasoningSpeed, 'xhigh');
  assert.equal((await f.create()).modelSelection.reasoningSpeed, 'low');
  await f.set(a.id, selection('b'));
  assert.equal(f.disk(a.id).modelSelection.reasoningSpeed, 'xhigh');
  const stale = structuredClone(await f.read(a.id));
  const gate = f.pauseWrite();
  const change = f.set(a.id, { ...selection('b'), reasoningSpeed: 'max' });
  await gate.entered;
  const save = f.save({ ...stale, messages: [{ role: 'user', content: 'Keep progress' }] });
  gate.release();
  await Promise.all([change, save]);
  assert.equal(f.disk(a.id).modelSelection.reasoningSpeed, 'max');
  assert.equal(f.disk(a.id).messages[0].content, 'Keep progress');
});

test('forks and rewinds of legacy message snapshots keep the source conversation frozen effort', () => {
  const source = { id: 'sess_source_effort', title: 'Source', workspace: '/fixture',
    modelSelection: { ...selection('a'), reasoningSpeed: 'xhigh', compactionThreshold: 720000 }, messages: [
      { role: 'user', content: 'Earlier request', modelSelection: selection('b') },
      { role: 'assistant', content: 'Earlier response', agentRun: selection('b') }
    ] };
  const defaultSelection = { ...selection('a'), reasoningSpeed: 'low' };
  const fork = createSessionForkRecord(source, { sessionId: source.id, messageIndex: 1,
    messageAnchor: messageForkAnchor(source.messages[1]) }, { id: 'sess_fork_effort', workspace: source.workspace, defaultSelection });
  const rewound = rewind.createRewoundSession(source, source.messages, { backupSessionId: 'sess_backup_effort', defaultSelection });
  for (const derived of [fork, rewound]) {
    assert.equal(derived.modelSelection.modelId, 'model-b');
    assert.equal(derived.modelSelection.reasoningSpeed, 'xhigh');
    assert.equal(derived.modelSelection.compactionThreshold, 720000);
  }
});

test('compaction snapshots retain positive integer boundaries and recover the originating turn value', () => {
  assert.equal(sessionModelSnapshot({ ...selection('a'), compactionThreshold: 725000 }).compactionThreshold, 725000);
  for (const value of [undefined, 0, -1, 0.5, Infinity, NaN, 'invalid']) {
    assert.equal(Object.hasOwn(sessionModelSnapshot({ ...selection('a'), compactionThreshold: value }), 'compactionThreshold'), false);
  }
  const inferred = inferSessionModelSelection({ messages: [
    { role: 'user', modelSelection: { ...selection('a'), compactionThreshold: 625000 } },
    { role: 'assistant', agentRun: selection('a') }
  ] }, { ...selection('b'), compactionThreshold: 800000 });
  assert.equal(inferred.compactionThreshold, 625000);
});

test('old and new conversations freeze compaction defaults once without changing history or window size', async t => {
  const f = fixture(t);
  const a = await f.create();
  assert.equal(a.modelSelection.compactionThreshold, 800000);
  const legacy = { ...a, updatedAt: 42, modelSelection: { ...selection('a'), reasoningSpeed: 'max' },
    openCodeSessionId: 'native-preserved', messages: [{ role: 'user', content: 'Keep legacy context' }] };
  f.seed(legacy);
  f.editConfig(cfg => { cfg.context = { maxTokens: 1000000, compactionThreshold: 750000 }; });
  const migrated = await f.read(a.id);
  assert.equal(migrated.modelSelection.compactionThreshold, 750000);
  assert.equal(f.disk(a.id).updatedAt, 42);
  assert.deepEqual(f.disk(a.id).messages, legacy.messages);
  assert.equal(f.disk(a.id).openCodeSessionId, 'native-preserved');
  f.editConfig(cfg => { cfg.context.compactionThreshold = 650000; });
  assert.equal((await f.read(a.id)).modelSelection.compactionThreshold, 750000);
  assert.equal((await f.create()).modelSelection.compactionThreshold, 650000);
  assert.equal(f.config().context.maxTokens, 1000000);
});

test('per-conversation thresholds survive stale saves, model changes, frozen runs and manual compression', async t => {
  const f = fixture(t);
  f.editConfig(cfg => { cfg.context = { maxTokens: 1000000, compactionThreshold: 800000 }; });
  const a = await f.create();
  const b = await f.create();
  const global = f.config();
  assert.equal((await f.set(a.id, { ...selection('a'), compactionThreshold: 600000 })).ok, true);
  assert.equal((await f.set(b.id, { ...selection('b'), compactionThreshold: 900000 })).ok, true);
  const queued = structuredClone(f.disk(a.id).modelSelection);
  const running = await f.start({ zSessionId: a.id });
  assert.equal(running.runtime.compactionThreshold, 600000);
  assert.equal(running.runtime.contextWindow, 1000000);
  const gate = f.pauseWrite();
  const changing = f.set(a.id, { ...selection('a'), compactionThreshold: 700000 });
  await gate.entered;
  const staleSave = f.save({ ...a, messages: [{ role: 'user', content: 'Progress remains' }] });
  gate.release();
  await Promise.all([changing, staleSave]);
  assert.equal(f.disk(a.id).modelSelection.compactionThreshold, 700000);
  assert.equal(f.disk(b.id).modelSelection.compactionThreshold, 900000);
  assert.equal(running.runtime.compactionThreshold, 600000);
  assert.equal((await f.start({ zSessionId: a.id, modelSelection: queued })).runtime.compactionThreshold, 600000);
  assert.equal((await f.start({ zSessionId: b.id })).runtime.compactionThreshold, 900000);
  assert.equal((await f.start({ zSessionId: a.id, modelSelection: selection('a') })).runtime.compactionThreshold, 700000);
  assert.equal((await f.set(a.id, selection('b'))).ok, true);
  assert.equal(f.disk(a.id).modelSelection.compactionThreshold, 700000, 'changing models preserves the conversation threshold');
  f.seed({ ...f.disk(a.id), openCodeSessionId: 'native-a' });
  assert.equal((await f.compress(a.id)).ok, true);
  assert.equal(f.compressionCalls[0].request.openCodeSessionId, 'native-a');
  assert.equal(f.compressionCalls[0].runtime.compactionThreshold, 700000);
  assert.equal(f.compressionCalls[0].request.openCodeConfig.compactionThreshold, 700000);
  assert.deepEqual(f.config(), global);
});

test('single-field model patches preserve identity and all other conversation settings', async t => {
  const f = fixture(t);
  const a = await f.create();
  const initial = await f.set(a.id, { ...selection('a'), reasoningSpeed: 'high',
    compactionThreshold: 700000, maxOutputTokens: 32000 });
  assert.equal(initial.ok, true, initial.error);

  const threshold = await f.set(a.id, { compactionThreshold: 625000 });
  assert.equal(threshold.ok, true, threshold.error);
  assert.equal(threshold.modelSelection.modelId, 'model-a');
  assert.equal(threshold.modelSelection.reasoningSpeed, 'high');
  assert.equal(threshold.modelSelection.maxOutputTokens, 32000);

  const reasoning = await f.set(a.id, { reasoningSpeed: 'max' });
  assert.equal(reasoning.ok, true, reasoning.error);
  assert.equal(reasoning.modelSelection.modelId, 'model-a');
  assert.equal(reasoning.modelSelection.compactionThreshold, 625000);
  assert.equal(reasoning.modelSelection.maxOutputTokens, 32000);

  const output = await f.set(a.id, { maxOutputTokens: 8000 });
  assert.equal(output.ok, true, output.error);
  assert.equal(output.modelSelection.modelId, 'model-a');
  assert.equal(output.modelSelection.compactionThreshold, 625000);
  assert.equal(output.modelSelection.reasoningSpeed, 'max');

  const switched = await f.set(a.id, { providerId: 'fixture-b', supplierId: 'official',
    modelId: 'model-b', maxOutputTokens: 0 });
  assert.equal(switched.ok, true, switched.error);
  assert.equal(switched.modelSelection.modelId, 'model-b');
  assert.equal(switched.modelSelection.compactionThreshold, 625000);
  assert.equal(switched.modelSelection.reasoningSpeed, 'max');
  assert.equal(switched.modelSelection.maxOutputTokens, 0);
});

for (const [setting, patch, expected] of [
  ['model', { providerId: 'fixture-b', supplierId: 'official', modelId: 'model-b' },
    { providerId: 'fixture-b', supplierId: 'official', modelId: 'model-b', reasoningSpeed: 'medium', maxOutputTokens: 0 }],
  ['reasoning', { reasoningSpeed: 'max' }, { modelId: 'model-a', reasoningSpeed: 'max' }]
]) {
  for (const thresholdFirst of [true, false]) {
    test(`overlapping ${thresholdFirst ? `threshold then ${setting}` : `${setting} then threshold`} patches retain both changes`, async t => {
      const f = fixture(t);
      const a = await f.create();
      const sibling = await f.create();
      const beforeSibling = f.disk(sibling.id);
      const global = f.config();
      const threshold = { compactionThreshold: 625000 };
      const gate = f.pauseWrite();
      const first = f.set(a.id, thresholdFirst ? threshold : patch);
      await gate.entered;
      const second = f.set(a.id, thresholdFirst ? patch : threshold);
      gate.release();
      for (const result of await Promise.all([first, second])) assert.equal(result.ok, true, result.error);
      const stored = f.disk(a.id).modelSelection;
      assert.equal(stored.compactionThreshold, 625000);
      for (const [field, value] of Object.entries(expected)) assert.equal(stored[field], value, field);
      assert.deepEqual(f.disk(sibling.id), beforeSibling);
      assert.deepEqual(f.config(), global);
    });
  }
}

test('identity patches reset an omitted output cap but still validate explicit caps for the new model', async t => {
  const f = fixture(t);
  f.editConfig(cfg => {
    cfg.api.providerSuppliers['fixture-b'][0].models[0].capabilities.maxOutputTokens = 16000;
  });
  const a = await f.create();
  await f.set(a.id, { maxOutputTokens: 64000, compactionThreshold: 625000, reasoningSpeed: 'high' });
  const model = { providerId: 'fixture-b', supplierId: 'official', modelId: 'model-b' };
  const before = f.disk(a.id);
  const invalid = await f.set(a.id, { ...model, maxOutputTokens: 64000 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'MODEL_OUTPUT_LIMIT_INVALID');
  assert.deepEqual(f.disk(a.id), before);

  const automatic = await f.set(a.id, model);
  assert.equal(automatic.ok, true, automatic.error);
  assert.equal(automatic.modelSelection.maxOutputTokens, 0);
  assert.equal(automatic.modelSelection.compactionThreshold, 625000);
  assert.equal(automatic.modelSelection.reasoningSpeed, 'high');
  const explicit = await f.set(a.id, { ...model, maxOutputTokens: 8000 });
  assert.equal(explicit.ok, true, explicit.error);
  assert.equal(explicit.modelSelection.maxOutputTokens, 8000);
  const sameModel = await f.set(a.id, model);
  assert.equal(sameModel.ok, true, sameModel.error);
  assert.equal(sameModel.modelSelection.maxOutputTokens, 8000, 'unchanged identity keeps the existing cap');
});

test('threshold IPC rejects invalid explicit values without saving them or changing the window', async t => {
  const f = fixture(t);
  const a = await f.create();
  const before = f.disk(a.id);
  for (const value of [0, -1, 1.25, NaN, Infinity, 1000000, 1000001, Number.MAX_SAFE_INTEGER + 1, '600000', true, null, undefined]) {
    const result = await f.set(a.id, { ...selection('a'), compactionThreshold: value });
    assert.equal(result.ok, false, String(value));
    assert.equal(result.code, 'SESSION_COMPACTION_THRESHOLD_INVALID');
    assert.deepEqual(f.disk(a.id), before);
  }
  assert.equal((await f.set(a.id, { ...selection('a'), compactionThreshold: 1 })).ok, true);
  assert.equal(f.disk(a.id).modelSelection.compactionThreshold, 1);
  assert.equal((await f.set(a.id, { ...selection('a'), compactionThreshold: 999999 })).ok, true);
});

test('old frozen thresholds above a later smaller window are resolved only for execution', async t => {
  const f = fixture(t);
  const a = await f.create();
  await f.set(a.id, { ...selection('a'), compactionThreshold: 900000 });
  const frozen = structuredClone(f.disk(a.id).modelSelection);
  f.editConfig(cfg => { cfg.context = { maxTokens: 128000, compactionThreshold: 100000 }; });
  const started = await f.start({ zSessionId: a.id, modelSelection: frozen });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.runtime.contextWindow, 128000);
  assert.equal(started.runtime.compactionThreshold, 127999);
  assert.equal(started.selection.compactionThreshold, 127999);
  assert.equal(frozen.compactionThreshold, 900000);
  assert.equal(f.disk(a.id).modelSelection.compactionThreshold, 900000);
});

test('manual output caps persist per conversation through reload, stale message saves, and run admission', async t => {
  const f = fixture(t);
  f.editConfig(config => { config.context.window = 1000000; });
  const a = await f.create();
  const b = await f.create();
  const originalConfig = JSON.stringify(f.config());
  const first = await f.set(a.id, { ...selection('a'), maxOutputTokens: 64000 });
  assert.equal(first.ok, true, first.error);
  const second = await f.set(b.id, { ...selection('b'), maxOutputTokens: 8000 });
  assert.equal(second.ok, true, second.error);
  await f.save({ ...a, messages: [{ role: 'user', content: 'stale run progress' }] });
  assert.equal((await f.read(a.id)).modelSelection.maxOutputTokens, 64000);
  assert.equal(f.disk(b.id).modelSelection.maxOutputTokens, 8000);
  const started = await f.start({ zSessionId: a.id });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.selection.maxOutputTokens, 64000);
  assert.equal(started.runtime.maxOutputTokens, 64000);
  assert.equal(JSON.stringify(f.config()), originalConfig);
  const automatic = await f.set(a.id, { ...selection('a'), maxOutputTokens: 0 });
  assert.equal(automatic.ok, true, automatic.error);
  assert.equal(f.disk(a.id).modelSelection.maxOutputTokens, 0);
  assert.equal(f.disk(b.id).modelSelection.maxOutputTokens, 8000);
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
  const run = await f.start({ zSessionId: a.id });
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

for (const tailOnly of [false, true]) {
  test(`renaming a background task survives a stale ${tailOnly ? 'paged' : 'full'} run save without losing messages`, async t => {
    const f = fixture(t);
    const background = await f.create();
    const visible = await f.create();
    await f.rename(background.id, 'Original background title');
    await f.rename(visible.id, 'Visible task');
    await f.save({ ...background, messages: [
      { role: 'user', content: 'Older request' }, { role: 'assistant', content: 'Older response' },
      { role: 'user', content: 'Current request' }
    ] });
    // Real IPC transfers independent objects. Do not accidentally share the
    // cached main-process object with this simulated long-running renderer.
    const staleRun = structuredClone(await f.read(background.id));
    f.context.openCodeActiveRuns.set('background-run', { zSessionId: background.id });
    const visibleBefore = f.disk(visible.id);
    await f.rename(background.id, 'Renamed from sidebar');
    staleRun.messages.push({ role: 'assistant', content: 'Completed after rename' });
    if (tailOnly) Object.assign(staleRun, {
      messages: staleRun.messages.slice(2), messagesTruncated: true, messagesStart: 2, totalMessages: 3
    });
    const saved = await f.save(staleRun);
    assert.equal(saved.title, 'Renamed from sidebar');
    assert.equal(f.disk(background.id).title, 'Renamed from sidebar');
    assert.deepEqual(f.disk(background.id).messages.map(message => message.content), [
      'Older request', 'Older response', 'Current request', 'Completed after rename'
    ]);
    assert.deepEqual(f.disk(visible.id), visibleBefore);
    assert.equal(f.context.openCodeActiveRuns.has('background-run'), true, 'Renaming does not cancel the task');
  });
}

for (const renameFirst of [false, true]) {
  test(`${renameFirst ? 'rename then stale save' : 'message save then rename'} serialize without reverting either change`, async t => {
    const f = fixture(t);
    const session = await f.create();
    const stale = structuredClone(session);
    stale.messages.push({ role: 'user', content: 'Save this request' });
    const gate = f.pauseWrite();
    const first = renameFirst ? f.rename(session.id, 'User chosen title') : f.save(stale);
    await gate.entered;
    const second = renameFirst ? f.save(stale) : f.rename(session.id, 'User chosen title');
    gate.release();
    await Promise.all([first, second]);
    assert.equal(f.disk(session.id).title, 'User chosen title');
    assert.equal(f.disk(session.id).messages[0].content, 'Save this request');
  });
}

test('first-turn automatic naming still works and later automatic attempts retain the established name', async t => {
  const f = fixture(t);
  for (const placeholder of ['', '新对话', 'New chat']) {
    const session = await f.create();
    f.seed({ ...session, title: placeholder });
    const renamed = await f.rename(session.id, 'Derived from the first request', { automatic: true });
    assert.equal(renamed.title, 'Derived from the first request');
    // This is the renderer order: automatic rename first, then ordinary save.
    await f.save({ ...session, messages: [{ role: 'user', content: 'The first request' }] });
    const before = f.disk(session.id);
    const ignored = await f.rename(session.id, 'A late automatic suggestion', { automatic: true });
    assert.equal(ignored.title, 'Derived from the first request');
    assert.deepEqual(f.disk(session.id), before, 'Skipped automatic naming does not reorder recent tasks');
  }
});

test('an automatic rename queued behind a manual rename returns the user title and cannot overwrite it', async t => {
  const f = fixture(t);
  const session = await f.create();
  const gate = f.pauseWrite();
  const manual = f.rename(session.id, 'My deliberate title');
  await gate.entered;
  const automatic = f.rename(session.id, 'Derived from a stale blank snapshot', { automatic: true });
  gate.release();
  await manual;
  assert.equal((await automatic).title, 'My deliberate title');
  await f.save({ ...session, messages: [{ role: 'user', content: 'First request' }] });
  assert.equal(f.disk(session.id).title, 'My deliberate title');
  assert.equal((await f.rename(session.id, 'Another explicit name')).title, 'Another explicit name');
});

test('saving a new record without an existing title keeps its supplied title', async t => {
  const f = fixture(t);
  const session = await f.create();
  const imported = { ...session, id: 'sess_imported_title', title: 'Imported conversation' };
  const saved = await f.save(imported);
  assert.equal(saved.title, 'Imported conversation');
  assert.equal(f.disk(imported.id).title, 'Imported conversation');
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
  const [runA, runB] = await Promise.all([f.start({ zSessionId: a.id }), f.start({ zSessionId: b.id })]);
  assert.equal(runA.runtime.modelId, 'model-a');
  assert.equal(runA.runtime.apiKey, 'fixture-key-a');
  assert.equal(runB.runtime.modelId, 'model-b');
  assert.equal(runB.runtime.apiKey, 'fixture-key-b');
  const frozen = await f.start({ zSessionId: a.id, modelSelection: selection('b') });
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
  assert.equal((await f.start({ zSessionId: 'sess_deleted' })).code, 'session-not-found');
  const utility = await f.start({ zSessionId: 'prompt-optimizer:fixture', utility: true, modelSelection: selection('b') });
  assert.equal(utility.runtime.modelId, 'model-b');
  assert.equal((await f.start({ zSessionId: 'prompt-optimizer:fixture', utility: true })).code, 'SESSION_MODEL_UNAVAILABLE');
  f.editConfig(cfg => { cfg.api.connections = cfg.api.connections.filter(item => item.providerId !== 'fixture-a'); });
  assert.equal((await f.start({ zSessionId: a.id })).code, 'SESSION_MODEL_UNAVAILABLE');
});
