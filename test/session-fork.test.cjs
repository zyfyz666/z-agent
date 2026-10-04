'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fork = require('../lib/session-fork');
const rewind = require('../lib/session-rewind');
const { createSessionWriteQueue, sessionModelSnapshot, inferSessionModelSelection } = require('../lib/session-model');
const { ensureTaskWorkspace, defaultTaskWorkspace } = require('../lib/task-workspace');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function section(start, end) {
  const offset = main.indexOf(start);
  const finish = main.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return main.slice(offset, finish);
}
const clone = value => JSON.parse(JSON.stringify(value));
const model = suffix => ({ providerId: `provider-${suffix}`, supplierId: 'official', modelId: `model-${suffix}`, modelType: 'text', name: `Model ${suffix}`, capabilities: {} });

function fixture(t, { defaultWorkspace = false, count = 112 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-session-fork-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const sessionsDir = path.join(root, 'sessions');
  const defaultTasksRoot = path.join(root, 'Tasks');
  fs.mkdirSync(sessionsDir);
  const source = { id: 'sess_source_fixture', title: 'Original task', pinned: true, createdAt: 1, updatedAt: 2,
    modelSelection: model('latest'), openCodeSessionId: 'source-native-FUTURE',
    handoff: { context: 'FUTURE-HANDOFF' }, pendingRequests: ['approval'], queuedTurns: ['future'],
    contextCompression: { summary: 'FUTURE-COMPRESSION' },
    workspaceKind: defaultWorkspace ? 'default' : 'selected',
    messages: Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: `Message ${index}${index >= 14 ? ' FUTURE-MARKER' : ''}`, ts: 1000 + index,
      ...(index % 2 ? { agentRun: { status: 'done', runId: `original-run-${index}`, openCodeSessionId: 'source-native-FUTURE',
        rollbackChanges: [{ path: 'fixture' }], changeCount: 1,
        watchdog: { checks: index, events: [{ action: 'observe', message: `Observation ${index}` }] },
        timeline: [{ type: 'tool', content: `Recorded tool output ${index}` }] } }
        : { modelSelection: model(index <= 12 ? 'historic' : 'latest'), intentId: `source-intent-${index}` })
    })) };
  source.workspace = defaultWorkspace ? defaultTaskWorkspace(defaultTasksRoot, source.id) : path.join(root, 'selected-workspace');
  fs.mkdirSync(source.workspace, { recursive: true });
  fs.writeFileSync(path.join(source.workspace, 'keep.txt'), 'current file state');
  const file = id => path.join(sessionsDir, `${id}.json`);
  fs.writeFileSync(file(source.id), JSON.stringify(source, null, 2));
  const sourceBytes = fs.readFileSync(file(source.id), 'utf8');
  const handlers = new Map();
  const notifications = [];
  const config = { agentModel: model('default') };
  const context = vm.createContext({
    ...fork, ...rewind, fs, fsp: fs.promises, path, crypto, process: { pid: process.pid }, console,
    defaultTasksRoot, dataDir: root, ensureTaskWorkspace, withSessionWrite: createSessionWriteQueue(),
    sessionModelSnapshot,
    initialSessionModelSelection: session => inferSessionModelSelection(session, config.agentModel),
    isSafeSessionId: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || '')),
    sessionPath: file, ensureDirs() {}, loadConfig: () => clone(config),
    composerConnections: () => ['historic', 'latest', 'default'].map(suffix => ({
      providerId: `provider-${suffix}`, supplierId: 'official', models: [{ id: `model-${suffix}` }]
    })),
    readSessionRecord: async id => JSON.parse(await fs.promises.readFile(file(id), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null'; throw error;
    })),
    refreshSessionSummaryCache() {}, touchSessionRecordCache() {}, invalidateSessionRecordCache() {},
    notifyDesktopSessionUpdate: event => notifications.push(clone(event)),
    sanitizeSessionReviewSummaries() {}, pruneSessionRuntimeBookkeeping() {},
    selectTailMessages: (messages, limit) => ({ tail: messages.slice(-limit), messagesStart: Math.max(0, messages.length - limit) }),
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
  });
  for (const code of [
    section('async function forkSessionRecord(', 'async function validateHandoffTarget('),
    section('async function writeSessionFileAtomic(', "ipcMain.handle('session:save',"),
    section("ipcMain.handle('session:fork',", '// Session JSON is the only durable copy'),
    section("ipcMain.handle('session:save',", '// 会话级工作区')
  ]) vm.runInContext(code, context);
  const boundary = index => ({ sessionId: source.id, messageIndex: index, messageAnchor: fork.messageForkAnchor(source.messages[index]) });
  return { root, source, sourceBytes, file, context, notifications,
    boundary, create: payload => handlers.get('session:fork')(null, payload),
    save: session => handlers.get('session:save')(null, clone(session)),
    read: id => JSON.parse(fs.readFileSync(file(id), 'utf8')) };
}

test('fork IPC copies the exact selected prefix from disk, preserves Observer history, and detaches runtime authority', async t => {
  const f = fixture(t);
  f.source.messages[4].content += ' ' + 'long context '.repeat(1000);
  fs.writeFileSync(f.file(f.source.id), JSON.stringify(f.source, null, 2));
  const before = fs.readFileSync(f.file(f.source.id), 'utf8');
  const result = await f.create({ ...f.boundary(13), messages: [{ content: 'Injected replacement' }], openCodeSessionId: 'injected' });
  assert.equal(result.ok, true);
  const branch = f.read(result.session.id);
  assert.equal(branch.messages.length, 14);
  assert.deepEqual(branch.messages.map(m => m.content), f.source.messages.slice(0, 14).map(m => m.content));
  assert.equal(branch.modelSelection.modelId, 'model-historic');
  assert.equal(branch.openCodeSessionId, undefined);
  for (const field of ['handoff', 'pendingRequests', 'queuedTurns', 'contextCompression', 'parentSessionId']) assert.equal(branch[field], undefined);
  assert.equal(branch.pinned, false);
  assert.deepEqual(branch.messages[13].agentRun.watchdog, f.source.messages[13].agentRun.watchdog);
  assert.equal(branch.messages[13].agentRun.runId, undefined);
  assert.equal(branch.messages[13].agentRun.openCodeSessionId, undefined);
  assert.equal(branch.messages[13].agentRun.rollbackChanges, undefined);
  assert.equal(branch.messages[13].agentRun.forkedFrom.runId, 'original-run-13');
  assert.equal(branch.messages[12].intentId, undefined);
  assert.ok(branch.messages.every(message => message.forkedHistory));
  assert.equal(fs.readFileSync(f.file(f.source.id), 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(branch), /FUTURE-MARKER|FUTURE-HANDOFF|FUTURE-COMPRESSION|source-native-FUTURE/);
});

test('absolute message index and anchor reject stale or malformed choices without creating a session', async t => {
  const f = fixture(t);
  for (const payload of [
    { ...f.boundary(13), messageIndex: 1 }, { ...f.boundary(13), messageIndex: -1 },
    { ...f.boundary(13), messageIndex: 112 }, { ...f.boundary(13), messageIndex: '13' },
    { ...f.boundary(13), messageAnchor: '' }, { ...f.boundary(13), messageAnchor: 'a'.repeat(64) },
    { ...f.boundary(13), sessionId: '../unsafe' }
  ]) assert.equal((await f.create(payload)).ok, false);
  const changed = f.read(f.source.id); changed.messages[13].content = 'Edited after opening';
  fs.writeFileSync(f.file(f.source.id), JSON.stringify(changed));
  const stale = await f.create(f.boundary(13));
  assert.equal(stale.code, 'SESSION_FORK_INVALID_BOUNDARY');
  assert.equal(fs.readdirSync(path.dirname(f.file(f.source.id))).length, 1);
});

test('user-message boundary is inclusive and does not copy its later assistant response', async t => {
  const f = fixture(t);
  const result = await f.create(f.boundary(12));
  assert.equal(result.session.messages.length, 13);
  assert.equal(result.session.messages.at(-1).role, 'user');
  assert.equal(result.session.messages.at(-1).content, f.source.messages[12].content);
});

test('persisted but unfinished replies cannot be used as a completed branch boundary', () => {
  for (const marker of [
    ...['running', 'working', 'pending', 'waiting', 'queued', 'thinking'].map(status => ({ agentRun: { status } })),
    { streaming: true }, { pending: true }
  ]) {
    const message = { role: 'assistant', content: 'Partial output', ...marker };
    assert.throws(() => fork.forkBoundary({ id: 'source', messages: [message] }, {
      sessionId: 'source', messageIndex: 0, messageAnchor: fork.messageForkAnchor(message)
    }), { code: 'SESSION_FORK_MESSAGE_IN_PROGRESS' });
  }
});

for (const defaultWorkspace of [false, true]) test(`${defaultWorkspace ? 'automatic task' : 'selected project'} workspace is explicitly shared without copying or rewinding files`, async t => {
  const f = fixture(t, { defaultWorkspace });
  const result = await f.create(f.boundary(13));
  assert.equal(result.session.workspace, f.source.workspace);
  assert.equal(result.session.workspaceKind, 'selected');
  assert.equal(result.session.forkedFrom.workspaceShared, true);
  assert.equal(result.session.forkedFrom.sourceWorkspaceKind, f.source.workspaceKind);
  assert.equal(fs.readFileSync(path.join(f.source.workspace, 'keep.txt'), 'utf8'), 'current file state');
  assert.equal(fs.readFileSync(f.file(f.source.id), 'utf8'), f.sourceBytes);
});

test('long fork response is paged while its complete prefix remains durable and restores without the 24-turn limit', async t => {
  const f = fixture(t);
  const result = await f.create(f.boundary(105));
  assert.equal(result.session.messagesStart, 66);
  assert.equal(result.session.messages.length, 40);
  const stored = f.read(result.session.id);
  assert.equal(stored.messages.length, 106);
  const run = fork.forkRunContext(stored, { prompt: 'New branch request', history: f.source.messages, openCodeSessionId: 'source-native-FUTURE' });
  assert.equal(run.history.length, 106);
  assert.equal(run.forkHistory.messages[0].content, 'Message 0');
  assert.equal(run.openCodeSessionId, '');
  assert.equal(run.history.at(-1).content, f.source.messages[105].content);
});

test('new request boundary freezes authoritative branch history before later guidance, rejecting stale anchors', async t => {
  const f = fixture(t);
  const result = await f.create(f.boundary(13));
  const branch = f.read(result.session.id);
  const prompt = { role: 'user', content: 'Continue here', ts: 9000 };
  branch.messages.push(prompt, { role: 'user', content: 'LATER-GUIDANCE', ts: 9001 });
  const request = { prompt: prompt.content, requestMessageIndex: 14, requestMessageAnchor: fork.messageForkAnchor(prompt),
    history: f.source.messages, openCodeSessionId: f.source.openCodeSessionId };
  const context = fork.forkRunContext(branch, request);
  assert.equal(context.history.length, 14);
  assert.doesNotMatch(JSON.stringify(context), /FUTURE|LATER-GUIDANCE|Continue here/);
  assert.throws(() => fork.forkRunContext(branch, { ...request, requestMessageIndex: 15 }), { code: 'SESSION_FORK_RUN_BOUNDARY_CHANGED' });
  assert.throws(() => fork.forkRunContext(branch, { ...request, requestMessageAnchor: '' }), { code: 'SESSION_FORK_RUN_BOUNDARY_CHANGED' });
});

test('session saves cannot erase fork provenance, replace the inherited prefix, or reuse the source native session', async t => {
  const f = fixture(t);
  const result = await f.create(f.boundary(13));
  const original = f.read(result.session.id);
  const stale = clone(original);
  delete stale.forkedFrom;
  stale.handoff = { context: 'FUTURE-HANDOFF' };
  stale.openCodeSessionId = f.source.openCodeSessionId;
  stale.messages[0].content = 'FUTURE-REPLACEMENT';
  stale.messages.push({ role: 'user', content: 'Branch request', ts: 12345 });
  await f.save(stale);
  let stored = f.read(original.id);
  assert.deepEqual(stored.forkedFrom, original.forkedFrom);
  assert.equal(stored.messages[0].content, 'Message 0');
  assert.equal(stored.openCodeSessionId, undefined);
  assert.equal(stored.handoff, undefined);
  assert.equal(stored.messages.at(-1).content, 'Branch request');

  await f.context.persistForkKernelBinding(original.id, 'branch-native-owned');
  await f.save({ ...stored, forkedFrom: null, openCodeSessionId: 'source-native-FUTURE' });
  stored = f.read(original.id);
  assert.equal(stored.openCodeSessionId, 'branch-native-owned');
  assert.equal(fork.forkRunContext(stored, { prompt: 'Next', openCodeSessionId: 'source-native-FUTURE' }).openCodeSessionId, 'branch-native-owned');
  const sourceSave = await f.save({ ...f.source, forkedFrom: original.forkedFrom });
  assert.equal(sourceSave.forkedFrom, undefined, 'A renderer cannot forge a branch record');
});

test('saving a paged fork preserves its entire inherited prefix and accepts a new branch turn', async t => {
  const f = fixture(t);
  const result = await f.create(f.boundary(105));
  const tail = clone(result.session);
  tail.messages.push({ role: 'user', content: 'Continue the branch', ts: 23456 });
  await f.save(tail);
  const stored = f.read(tail.id);
  assert.equal(stored.messages.length, 107);
  assert.equal(stored.messages[0].content, 'Message 0');
  assert.equal(stored.messages.at(-1).content, 'Continue the branch');
});

test('fork creation waits for the source write queue and never captures a partial save', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queued = f.context.withSessionWrite(f.source.id, async () => {
    await gate;
    const updated = f.read(f.source.id); updated.messages.push({ role: 'assistant', content: 'FUTURE-APPEND' });
    await fs.promises.writeFile(f.file(f.source.id), JSON.stringify(updated));
  });
  let completed = false;
  const operation = f.create(f.boundary(13)).then(value => { completed = true; return value; });
  await Promise.resolve();
  assert.equal(completed, false);
  release(); await queued;
  const result = await operation;
  assert.equal(result.session.messages.length, 14);
  assert.equal(f.read(f.source.id).messages.at(-1).content, 'FUTURE-APPEND');
});
