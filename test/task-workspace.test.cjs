'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {
  taskWorkspaceRoot, defaultTaskWorkspace, legacyRuntimeWorkspace,
  resolveTaskWorkspace, ensureTaskWorkspace
} = require('../lib/task-workspace');
const { findReusableBlankSession } = require('../lib/session-policy');
const { normalizeWorkspacePath, sameWorkspace } = require('../lib/session-handoff');
const { sessionModelSnapshot, inferSessionModelSelection, createSessionWriteQueue } = require('../lib/session-model');
const { preserveForkAuthority, forkRunContext } = require('../lib/session-fork');
const rewind = require('../lib/session-rewind');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-task-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'profile', 'YanData');
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const defaultTasksRoot = taskWorkspaceRoot({ userDataDirectory: path.join(root, 'profile'), isolated: true });
  const handlers = new Map();
  const cache = new Map();
  const events = [];
  const activations = [];
  const context = vm.createContext({
    ...rewind, fs, fsp: fs.promises, path, crypto, process: { pid: process.pid }, dataDir, defaultTasksRoot, sessionRecordCache: cache,
    ensureTaskWorkspace, normalizeWorkspacePath, sameWorkspace,
    sessionModelSnapshot, inferSessionModelSelection, createSessionWriteQueue, preserveForkAuthority, forkRunContext,
    loadConfig: () => ({ agentModel: { providerId: '', supplierId: '', modelId: '', modelType: 'text' } }),
    composerConnections: () => [],
    isSafeSessionId: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || '')),
    sessionPath: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || '')) ? path.join(sessionsDir, `${id}.json`) : null,
    ensureDirs() {},
    touchSessionRecordCache(id, session, stat) { cache.set(id, { session, mtimeMs: stat.mtimeMs, size: stat.size }); },
    invalidateSessionRecordCache(id) { cache.delete(id); },
    refreshSessionSummaryCache: async () => {},
    sanitizeSessionReviewSummaries: value => value,
    pruneSessionRuntimeBookkeeping: value => value,
    selectTailMessages(messages, limit) { return { tail: messages.slice(-limit), messagesStart: Math.max(0, messages.length - limit) }; },
    activateWorkspace(value) { activations.push(value); },
    migrateMemoryToWorkspace() {}, ensureYanagent() {},
    notifyDesktopSessionUpdate(detail) { events.push(detail); },
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } }
  });
  for (const code of [
    section('async function writeSessionFileAtomic(', "ipcMain.handle('session:save',"),
    section('const sessionWorkspaceAssignments =', '// session:list fires after every run completion'),
    section('async function createFreshSessionRecord(', 'async function validateHandoffTarget('),
    section('function toSessionSummary(', 'function notifyDesktopSessionUpdate('),
    section("ipcMain.handle('session:save',", '// 会话级工作区'),
    section("ipcMain.handle('session:set-workspace',", "ipcMain.handle('session:rename',")
  ]) vm.runInContext(code, context);
  return {
    root, dataDir, defaultTasksRoot, context, events, activations, handlers, cache,
    read: id => context.readSessionRecord(id),
    create: options => context.createFreshSessionRecord(options),
    save: data => handlers.get('session:save')(null, structuredClone(data)),
    setWorkspace: (id, workspace) => handlers.get('session:set-workspace')(null, { id, workspace }),
    file: id => path.join(sessionsDir, `${id}.json`),
    seed(data) { fs.writeFileSync(path.join(sessionsDir, `${data.id}.json`), JSON.stringify(data)); }
  };
}

test('automatic task roots isolate tests and reject unsafe task IDs', () => {
  const documents = path.resolve('fixture-documents');
  const profile = path.resolve('fixture-profile');
  assert.equal(taskWorkspaceRoot({ documentsDirectory: documents, userDataDirectory: profile }), path.join(documents, 'Z Agent', 'Tasks'));
  const root = taskWorkspaceRoot({ documentsDirectory: documents, userDataDirectory: profile, isolated: true });
  assert.equal(root, path.join(profile, 'Z Agent', 'Tasks'));
  for (const id of ['', '../outside', 'sess_../../outside', 'C:\\Windows', 'sess_a/b']) {
    assert.throws(() => defaultTaskWorkspace(root, id), /Invalid task ID/);
  }
  assert.equal(defaultTaskWorkspace(root, 'sess_valid123'), path.join(root, 'sess_valid123'));
});

test('new tasks get distinct durable folders and default blanks remain reusable', async t => {
  const f = fixture(t);
  const first = await f.create();
  const second = await f.create();
  assert.equal(first.workspaceKind, 'default');
  assert.notEqual(first.workspace, second.workspace);
  assert.ok(fs.statSync(first.workspace).isDirectory());
  const reopened = JSON.parse(fs.readFileSync(f.file(first.id), 'utf8'));
  assert.equal(reopened.workspace, first.workspace);
  assert.equal(findReusableBlankSession([first, second]).id, first.id);
  const selected = { ...first, workspaceKind: 'selected' };
  assert.equal(findReusableBlankSession([selected]), null);
  assert.equal(findReusableBlankSession([{ ...first, messages: [{ role: 'user', content: 'hello' }] }]), null);
});

test('opening an old blank task persists its folder without changing history or timestamp', async t => {
  const f = fixture(t);
  const id = 'sess_oldblank';
  const history = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }];
  f.seed({ id, workspace: '', title: 'Old task', messages: history, createdAt: 10, updatedAt: 20 });
  const legacy = legacyRuntimeWorkspace(f.dataDir, id);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'existing.txt'), 'keep');
  const [first, concurrent] = await Promise.all([f.read(id), f.read(id)]);
  assert.equal(first.workspace, concurrent.workspace);
  assert.equal(first.workspaceKind, 'default');
  assert.equal(first.legacyRuntimeWorkspace, legacy);
  assert.equal(first.updatedAt, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(first.messages)), history);
  assert.equal(fs.readFileSync(path.join(legacy, 'existing.txt'), 'utf8'), 'keep');
  f.cache.clear();
  const reopened = await f.read(id);
  assert.equal(reopened.workspace, first.workspace);
  assert.equal(reopened.legacyRuntimeWorkspace, legacy);
  const summary = f.context.toSessionSummary(reopened);
  assert.equal(summary.workspaceKind, 'default');
});

test('old explicitly selected projects retain their directory and gain selected metadata', async t => {
  const f = fixture(t);
  const project = path.join(f.root, 'existing-project');
  f.seed({ id: 'sess_selected', workspace: project, messages: [], updatedAt: 42 });
  const session = await f.read('sess_selected');
  assert.equal(session.workspace, project);
  assert.equal(session.workspaceKind, 'selected');
  assert.equal(session.updatedAt, 42);
  assert.equal(fs.existsSync(project), false, 'opening history must not silently recreate a deleted selected project');
});

test('stale saves preserve authoritative directories and the hidden history prefix', async t => {
  const f = fixture(t);
  const initial = await f.create();
  const defaultDirectory = initial.workspace;
  initial.messages = [{ content: 'one' }, { content: 'two' }, { content: 'three' }];
  await f.save(initial);
  const saved = await f.save({
    ...initial, workspace: '', workspaceKind: undefined,
    messages: [{ content: 'changed-three' }], messagesTruncated: true, messagesStart: 2
  });
  assert.equal(saved.workspace, initial.workspace);
  assert.equal(saved.workspaceKind, 'default');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.messages)), [{ content: 'one' }, { content: 'two' }, { content: 'changed-three' }]);
  const project = path.join(f.root, 'project');
  const selected = await f.setWorkspace(initial.id, project);
  assert.equal(selected.workspaceKind, 'selected');
  const oldRenderer = await f.save({ ...selected, workspace: '', workspaceKind: 'default' });
  assert.equal(oldRenderer.workspace, project);
  assert.equal(oldRenderer.workspaceKind, 'selected');
  assert.equal(f.activations.at(-1), project);
  const cleared = await f.setWorkspace(initial.id, '');
  assert.equal(cleared.workspace, defaultDirectory);
  assert.equal(cleared.workspaceKind, 'default');
  assert.equal(f.activations.at(-1), defaultDirectory);
});

test('start-run uses the persisted task folder even when the renderer sends blank or another folder', async t => {
  const f = fixture(t);
  f.context.applySessionModelToRunConfig = () => ({ providerId: 'fixture', supplierId: 'official', modelId: 'fixture' });
  const session = await f.create();
  for (const supplied of ['', path.join(f.root, 'wrong-project')]) {
    f.context.request = { yanSessionId: session.id, workspace: supplied };
    f.context.admittedRunId = 'run-check';
    f.context.cfg = { workspace: path.join(f.root, 'global-project') };
    const block = section('    const authoritativeSession = request.yanSessionId ?', '    const prompt = String(request.prompt');
    const result = await vm.runInContext(`(async () => { ${block}; return { workspace, workspaceKind }; })()`, f.context);
    assert.equal(result.workspace, session.workspace);
    assert.equal(result.workspaceKind, 'default');
  }
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0].id, session.id);
  assert.equal(f.events[0].reason, 'workspace-assigned');
});

test('direct folder resolution keeps explicit selection and never shares anonymous task folders', async t => {
  const f = fixture(t);
  const project = path.join(f.root, 'project');
  const explicit = resolveTaskWorkspace({ id: 'sess_explicit', workspace: project, workspaceKind: 'default' }, { root: f.defaultTasksRoot });
  assert.equal(explicit.workspaceKind, 'selected', 'a stale default marker cannot reclassify a selected folder');
  assert.equal(explicit.workspace, project);
  const first = await ensureTaskWorkspace({ id: 'sess_anon_one' }, { root: f.defaultTasksRoot });
  const second = await ensureTaskWorkspace({ id: 'sess_anon_two' }, { root: f.defaultTasksRoot });
  assert.notEqual(first.workspace, second.workspace);
});
