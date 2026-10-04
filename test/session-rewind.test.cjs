'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fork = require('../lib/session-fork');
const rewind = require('../lib/session-rewind');
const { createSessionWriteQueue, inferSessionModelSelection, sessionModelSnapshot } = require('../lib/session-model');
const { ensureTaskWorkspace } = require('../lib/task-workspace');
const { normalizeIntent } = require('../lib/yan-core/protocol');
const { filterReviewSummary } = require('../lib/run-change-summary');

const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
function section(start, end) {
  const offset = main.indexOf(start);
  const finish = main.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return main.slice(offset, finish);
}
const clone = value => JSON.parse(JSON.stringify(value));
const model = suffix => ({ providerId: `provider-${suffix}`, supplierId: 'official',
  modelId: `model-${suffix}`, modelType: 'text', name: suffix, capabilities: {} });

function fixture(t, { count = 64, branch = false } = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'z-session-rewind-'));
  t.after(() => {
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith('z-session-rewind-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sessionsDir = path.join(root, 'sessions');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'keep.txt'), 'current files stay unchanged');
  const file = id => path.join(sessionsDir, `${id}.json`);
  const source = { id: 'sess_rewind_fixture', title: 'Current task', pinned: true,
    workspace, workspaceKind: 'selected', createdAt: 1, updatedAt: 2, modelSelection: model('latest'),
    openCodeSessionId: 'OLD_NATIVE_HANDLE', handoff: { context: 'FUTURE_HANDOFF' },
    pendingRequests: ['old-request'], queuedTurns: ['old-turn'], contextCompression: { summary: 'FUTURE_SUMMARY' },
    ...(branch ? { forkedFrom: { sessionId: 'sess_previous_source', messageIndex: 49, messageCount: 50 } } : {}),
    messages: Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: `Message ${index}${index >= 14 ? ' FUTURE_CONTENT' : ''}`, ts: 1000 + index,
      ...(index % 2 ? { agentRun: { status: 'done', runId: `old-run-${index}`, openCodeSessionId: 'OLD_NATIVE_HANDLE',
        rollbackChanges: [{ path: 'keep.txt' }], watchdog: { checks: index, events: [{ action: 'observe', message: `Observer ${index}` }] },
        timeline: [{ type: 'tool', output: `Historical evidence ${index}`, sessionID: 'OLD_NATIVE_HANDLE' }] } }
        : { modelSelection: model(index <= 12 ? 'historic' : 'latest'), attachments: [{ name: `item-${index}.txt` }], intentId: 'old-intent' })
    })) };
  fs.writeFileSync(file(source.id), JSON.stringify(source, null, 2));
  const handlers = new Map();
  const notifications = [];
  let beforeRename = null;
  const fsp = { ...fs.promises, async rename(from, to) {
    if (beforeRename) await beforeRename(from, to);
    return fs.promises.rename(from, to);
  } };
  const context = vm.createContext({
    ...fork, ...rewind, fs, fsp, path, crypto, process: { pid: process.pid }, console,
    sessionModelSnapshot, filterReviewSummary, sessionRecordCache: new Map(),
    defaultTasksRoot: path.join(root, 'Tasks'), dataDir: root, ensureTaskWorkspace,
    withSessionWrite: createSessionWriteQueue(),
    isSafeSessionId: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || '')),
    sessionPath: file, ensureDirs() {},
    loadConfig: () => ({ agentModel: model('default') }), composerConnections: () => [],
    initialSessionModelSelection: session => inferSessionModelSelection(session, model('default')),
    readSessionRecord: async id => JSON.parse(await fs.promises.readFile(file(id), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null'; throw error;
    })),
    refreshSessionSummaryCache() {}, touchSessionRecordCache() {}, invalidateSessionRecordCache() {},
    notifyDesktopSessionUpdate: event => notifications.push(clone(event)),
    sanitizeSessionReviewSummaries() {}, pruneSessionRuntimeBookkeeping() {},
    selectTailMessages: (messages, limit) => ({ tail: messages.slice(-limit), messagesStart: Math.max(0, messages.length - limit) }),
    manualContextCompressions: new Set(), openCodeActiveRuns: new Map(), openCodeRunAdmissions: new Map(),
    yanCore: { state: { intents: {} }, enqueueIntent(payload) {
      const id = payload.intentId || 'fixture-intent';
      const record = { id, threadId: payload.threadId, status: 'queued', intent: normalizeIntent(payload.intent) };
      this.state.intents[id] = record;
      return clone(record);
    }, consumeIntent(id) { const record = this.state.intents[id]; if (!record) return null; record.status = 'consumed'; return clone(record); },
    requeueIntent(id) { const record = this.state.intents[id]; if (!record) return null; record.status = 'queued'; return clone(record); }
    }, MAX_CONCURRENT_AGENT_RUNS: 3,
    resolveSessionModelSelection: (_cfg, selection) => selection,
    applySessionModelToRunConfig: (_cfg, selection) => selection,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
  });
  for (const code of [
    section('function isSessionRunActive(', 'async function createFreshSessionRecord('),
    section('async function forkSessionRecord(', 'async function validateHandoffTarget('),
    section('async function writeSessionFileAtomic(', "ipcMain.handle('session:save',"),
    section("ipcMain.handle('session:fork',", '// Session JSON is the only durable copy'),
    section("ipcMain.handle('session:save',", '// 会话级工作区'),
    section("ipcMain.handle('yan:core-enqueue-intent',", "ipcMain.handle('yan:core-ack-intent',"),
    section('async function setSessionModelRecord(', "ipcMain.handle('session:messages',")
  ]) vm.runInContext(code, context);
  // Execute production admission validation; the separate Electron E2E
  // exercises the actual sidecar and model transport after this boundary.
  vm.runInContext(section("ipcMain.handle('opencode:start-run',", '    // The persisted conversation owns its directory.')
    + 'return { ok: true, request }; } catch (error) { return { ok: false, code: error.code, error: error.message }; }'
    + ' finally { openCodeRunAdmissions.delete(admittedRunId); } });', context);
  const read = id => JSON.parse(fs.readFileSync(file(id), 'utf8'));
  return { root, source, file, context, notifications, read,
    records: () => fs.readdirSync(sessionsDir).filter(name => name.endsWith('.json')),
    boundary(index, session = read(source.id)) { return { sessionId: session.id, messageIndex: index,
      messageAnchor: fork.messageForkAnchor(session.messages[index]), conversationRevision: rewind.sessionConversationRevision(session) }; },
    rewind: request => handlers.get('session:rewind')(null, request),
    restore: request => handlers.get('session:rewind-restore')(null, request),
    save: session => handlers.get('session:save')(null, clone(session)),
    start: request => handlers.get('opencode:start-run')(null, clone(request)),
    enqueue: request => handlers.get('yan:core-enqueue-intent')(null, request),
    consume: id => handlers.get('yan:core-consume-intent')(null, id),
    requeue: id => handlers.get('yan:core-requeue-intent')(null, id),
    model: request => handlers.get('session:model-set')(null, request),
    enableProductionRead() {
      vm.runInContext(section('function sanitizeSessionReviewSummaries(', '// Subagent records keep live'), context);
      vm.runInContext(section('const TERMINAL_SUBAGENT_STATUSES =', '// session:get fires on every task switch'), context);
      vm.runInContext(section('async function readSessionRecord(', '// session:list fires after every run completion'), context);
    },
    onRename(hook) { beforeRename = hook; },
    filesUnchanged() { assert.equal(fs.readFileSync(path.join(workspace, 'keep.txt'), 'utf8'), 'current files stay unchanged'); }
  };
}

test('rewind IPC keeps the same session and inclusive prefix, preserves Observer/model, and saves the complete detached backup', async t => {
  const f = fixture(t);
  const result = await f.rewind(f.boundary(13));
  assert.equal(result.ok, true);
  assert.equal(result.session.id, f.source.id);
  assert.equal(result.conversationRevision, 1);
  const current = f.read(f.source.id);
  const backup = f.read(result.backupSessionId);
  assert.equal(current.messages.length, 14);
  assert.deepEqual(current.messages.map(m => m.content), f.source.messages.slice(0, 14).map(m => m.content));
  assert.deepEqual(backup.messages.map(m => m.content), f.source.messages.map(m => m.content));
  assert.deepEqual(current.messages[13].agentRun.watchdog, f.source.messages[13].agentRun.watchdog);
  assert.equal(current.messages[13].agentRun.timeline[0].output, 'Historical evidence 13');
  assert.deepEqual(current.messages[12].attachments, f.source.messages[12].attachments);
  assert.equal(current.modelSelection.modelId, 'model-historic');
  assert.equal(backup.modelSelection.modelId, 'model-latest');
  for (const key of ['workspace', 'workspaceKind', 'title', 'pinned', 'createdAt']) assert.deepEqual(current[key], f.source[key]);
  for (const record of [current, backup]) {
    assert.equal(record.openCodeSessionId, undefined);
    for (const key of ['handoff', 'parentSessionId', 'pendingRequests', 'queuedTurns', 'contextCompression']) assert.equal(record[key], undefined);
    assert.doesNotMatch(JSON.stringify(record), /OLD_NATIVE_HANDLE|old-run-|old-intent|rollbackChanges/);
  }
  assert.equal(backup.contextReset.messageCount, 64);
  assert.equal(backup.conversationRevision, 0);
  assert.equal(backup.workspace, current.workspace);
  assert.equal(backup.pinned, false);
  f.filesUnchanged();
});

test('absolute boundaries and anchors reject stale, forged, unfinished or invalid choices without touching records', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file(f.source.id), 'utf8');
  for (const request of [
    { ...f.boundary(13), messageIndex: 1 }, { ...f.boundary(13), messageIndex: -1 },
    { ...f.boundary(13), messageIndex: 64 }, { ...f.boundary(13), messageAnchor: 'f'.repeat(64) },
    { ...f.boundary(13), sessionId: '../wrong' }, { ...f.boundary(13), conversationRevision: 1 },
    { ...f.boundary(13), includeSelected: false }
  ]) assert.equal((await f.rewind(request)).ok, false);
  assert.equal(f.records().length, 1);
  assert.equal(fs.readFileSync(f.file(f.source.id), 'utf8'), before);
  const active = f.read(f.source.id); active.messages[13].agentRun.status = 'running';
  fs.writeFileSync(f.file(active.id), JSON.stringify(active));
  assert.equal((await f.rewind(f.boundary(13))).code, 'SESSION_REWIND_BUSY');
});

test('withdraw-and-rewrite excludes only the selected user and supports an empty authoritative prefix', async t => {
  const f = fixture(t);
  const result = await f.rewind({ ...f.boundary(0), includeSelected: false });
  assert.equal(result.ok, true);
  assert.equal(result.session.messages.length, 0);
  assert.equal(result.session.contextReset.messageCount, 0);
  assert.equal(fork.isAuthoritativeHistorySession(result.session), true);
  const prompt = { role: 'user', content: 'Replacement', ts: 12345 };
  const saved = await f.save({ ...result.session, messages: [prompt] });
  const started = await f.start({ yanSessionId: saved.id, conversationRevision: 1, prompt: prompt.content,
    requestMessageIndex: 0, requestMessageAnchor: fork.messageForkAnchor(prompt), openCodeSessionId: 'OLD_NATIVE_HANDLE' });
  assert.equal(started.ok, true);
  assert.equal(started.request.history.length, 0);
  assert.equal(started.request.openCodeSessionId, '');
  assert.equal(started.request.forkHistory.kind, 'rewind');
  f.filesUnchanged();
});

test('stale full/tail saves, starts and late native bindings cannot overwrite a rewound revision', async t => {
  const f = fixture(t);
  const stale = clone(f.source);
  const result = await f.rewind(f.boundary(13));
  const before = fs.readFileSync(f.file(f.source.id), 'utf8');
  for (const input of [stale, { ...stale, messagesTruncated: true, messagesStart: 40, messages: stale.messages.slice(40) },
    { ...result.session, conversationRevision: '1' }, { ...result.session, conversationRevision: 99 }]) {
    assert.equal((await f.save(input)).code, 'SESSION_REVISION_CHANGED');
  }
  assert.equal((await f.start({ yanSessionId: f.source.id, prompt: 'Old request' })).code, 'SESSION_REVISION_CHANGED');
  await assert.rejects(f.context.persistForkKernelBinding(f.source.id, 'old-late-native', 0), { code: 'SESSION_REVISION_CHANGED' });
  assert.equal(fs.readFileSync(f.file(f.source.id), 'utf8'), before);
});

test('each post-rewind run gets the full authoritative history and only the newly owned native binding', async t => {
  const f = fixture(t);
  const result = await f.rewind(f.boundary(55));
  assert.equal(result.session.messagesTruncated, true);
  assert.equal(result.session.messagesStart, 16);
  const prompt = { role: 'user', content: 'Continue here', ts: 9999 };
  await f.save({ ...result.session, messages: [...result.session.messages, prompt], openCodeSessionId: 'OLD_NATIVE_HANDLE' });
  const request = { yanSessionId: f.source.id, conversationRevision: 1, prompt: prompt.content,
    requestMessageIndex: 56, requestMessageAnchor: fork.messageForkAnchor(prompt), history: [{ content: 'FORGED' }] };
  const first = await f.start(request);
  assert.equal(first.ok, true);
  assert.equal(first.request.history.length, 56);
  assert.equal(first.request.history[0].content, 'Message 0');
  assert.equal(first.request.openCodeSessionId, '');
  await f.context.persistForkKernelBinding(f.source.id, 'rewound-owned-native', 1);
  const second = await f.start({ ...request, openCodeSessionId: 'OLD_NATIVE_HANDLE' });
  assert.equal(second.ok, true);
  assert.equal(second.request.forkHistory.messages.length, 56);
  assert.equal(second.request.openCodeSessionId, 'rewound-owned-native');
  assert.doesNotMatch(JSON.stringify(second.request.history), /FORGED|Continue here|Message 63/);
});

test('rewinding an existing fork locks only the shortened prefix, never reviving the original fork boundary', async t => {
  const f = fixture(t, { branch: true });
  const result = await f.rewind(f.boundary(5));
  const current = clone(result.session);
  current.messages[0].content = 'FORGED_HISTORY';
  current.messages.push({ role: 'user', content: 'A new direction', ts: 5000 });
  current.contextReset.messageCount = 50;
  current.rewindState = null;
  const saved = await f.save(current);
  assert.equal(saved.messages.length, 7);
  assert.equal(saved.messages[0].content, 'Message 0');
  assert.equal(saved.messages[6].content, 'A new direction');
  assert.equal(saved.contextReset.messageCount, 6);
  assert.equal(saved.forkedFrom.messageCount, 50, 'Older provenance can remain without restoring its longer prefix');
  assert.equal(saved.rewindState.backupSessionId, result.backupSessionId);
});

test('restore recovers the exact pre-rewind snapshot/model and first backs up messages added since rewind', async t => {
  const f = fixture(t);
  const first = await f.rewind(f.boundary(13));
  await f.save({ ...first.session, messages: [...first.session.messages, { role: 'user', content: 'NEW_AFTER_REWIND', ts: 9000 }] });
  const backup = f.read(first.backupSessionId);
  backup.messages.push({ role: 'user', content: 'BACKUP_BRANCH_CONTINUED', ts: 9001 });
  // Model changes in the independent backup must not mutate its frozen snapshot.
  backup.modelSelection = model('other');
  fs.writeFileSync(f.file(backup.id), JSON.stringify(backup));
  const restored = await f.restore({ sessionId: f.source.id, conversationRevision: 1 });
  assert.equal(restored.ok, true);
  const current = f.read(f.source.id);
  assert.equal(current.conversationRevision, 2);
  assert.equal(current.messages.length, f.source.messages.length);
  assert.deepEqual(current.messages.map(m => m.content), f.source.messages.map(m => m.content));
  assert.equal(current.modelSelection.modelId, 'model-latest');
  assert.equal(current.openCodeSessionId, undefined);
  assert.equal(f.read(restored.backupSessionId).messages.at(-1).content, 'NEW_AFTER_REWIND');
  assert.doesNotMatch(JSON.stringify(current), /BACKUP_BRANCH_CONTINUED|NEW_AFTER_REWIND/);
  const undoRestore = await f.restore({ sessionId: f.source.id, conversationRevision: 2 });
  assert.equal(undoRestore.ok, true);
  assert.equal(undoRestore.session.messages.at(-1).content, 'NEW_AFTER_REWIND');
  f.filesUnchanged();
});

test('missing or changed backups fail restoration without creating records or truncating the current conversation', async t => {
  const f = fixture(t);
  const first = await f.rewind(f.boundary(13));
  const originalBackup = f.read(first.backupSessionId);
  const changed = clone(originalBackup); changed.messages[0].content = 'changed';
  fs.writeFileSync(f.file(changed.id), JSON.stringify(changed));
  assert.equal((await f.restore({ sessionId: f.source.id, conversationRevision: 1 })).code, 'SESSION_REWIND_BACKUP_CHANGED');
  fs.unlinkSync(f.file(first.backupSessionId));
  const before = fs.readFileSync(f.file(f.source.id), 'utf8');
  const result = await f.restore({ sessionId: f.source.id, conversationRevision: 1 });
  assert.equal(result.code, 'SESSION_REWIND_BACKUP_NOT_FOUND');
  assert.equal(fs.readFileSync(f.file(f.source.id), 'utf8'), before);
  assert.equal(f.records().length, 1);
});

test('active, admitting, queued, dispatching and compressing tasks refuse rewind without cancellation', async t => {
  const f = fixture(t);
  const contexts = [
    [() => f.context.openCodeActiveRuns.set('run', { yanSessionId: f.source.id }), () => f.context.openCodeActiveRuns.clear()],
    [() => f.context.openCodeRunAdmissions.set('run', f.source.id), () => f.context.openCodeRunAdmissions.clear()],
    ...['queued', 'consumed'].map(status => [
      () => { f.context.yanCore.state.intents.intent = { threadId: f.source.id, status }; },
      () => { delete f.context.yanCore.state.intents.intent; }
    ]),
    [() => f.context.manualContextCompressions.add(f.source.id), () => f.context.manualContextCompressions.clear()]
  ];
  for (const [enter, leave] of contexts) {
    enter();
    assert.equal((await f.rewind(f.boundary(13))).code, 'SESSION_REWIND_BUSY');
    assert.equal(f.records().length, 1);
    leave();
  }
  assert.equal(f.read(f.source.id).messages.length, 64);
});

test('a new admission during backup aborts rewind; a new queue entry during rewind is rejected', async t => {
  const f = fixture(t);
  f.onRename(async (_from, to) => {
    if (to !== f.file(f.source.id)) {
      assert.equal((await f.enqueue({ threadId: f.source.id })).code, 'SESSION_REWIND_BUSY');
      f.context.openCodeRunAdmissions.set('racing-run', f.source.id);
    }
  });
  const before = fs.readFileSync(f.file(f.source.id), 'utf8');
  const result = await f.rewind(f.boundary(13));
  assert.equal(result.code, 'SESSION_REWIND_BUSY');
  assert.equal(fs.readFileSync(f.file(f.source.id), 'utf8'), before);
  assert.equal(f.records().length, 2, 'The completed backup is retained');
});

for (const destination of ['backup', 'original']) test(`${destination} commit failure keeps the complete original conversation`, async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file(f.source.id), 'utf8');
  f.onRename(async (_from, to) => {
    if ((to === f.file(f.source.id)) === (destination === 'original')) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
  });
  const result = await f.rewind(f.boundary(13));
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(f.file(f.source.id), 'utf8'), before);
  assert.equal(f.records().length, destination === 'backup' ? 1 : 2);
  assert.equal(fs.readdirSync(path.dirname(f.file(f.source.id))).some(name => name.includes('.tmp-')), false);
  f.filesUnchanged();
});

test('rewind serializes behind an in-flight save and stale writes queued afterwards are rejected', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pendingSave = f.context.withSessionWrite(f.source.id, async () => {
    await gate;
    const updated = f.read(f.source.id); updated.messages.push({ role: 'user', content: 'SAVED_BEFORE_REWIND', ts: 99999 });
    fs.writeFileSync(f.file(f.source.id), JSON.stringify(updated));
  });
  const rewindPromise = f.rewind(f.boundary(13));
  const staleSave = f.save(f.source);
  release(); await pendingSave;
  const result = await rewindPromise;
  assert.equal(result.ok, true);
  assert.equal(f.read(result.backupSessionId).messages.at(-1).content, 'SAVED_BEFORE_REWIND');
  assert.equal((await staleSave).code, 'SESSION_REVISION_CHANGED');
});

test('legacy backup remains restorable after production read/save review and subagent migrations', async t => {
  const f = fixture(t);
  const legacy = f.read(f.source.id);
  legacy.messages[13].agentRun.changeSummary = { count: 2, additions: 999, deletions: 999,
    files: [{ path: 'keep.txt', additions: 2, deletions: 0 }, { path: 'image.png', binary: true, additions: 997 }] };
  legacy.messages[13].agentRun.changeCount = 2;
  legacy.messages[13].agentRun.subagents = [{ status: 'completed', seenEvents: ['old-event'], milestones: ['buffer'],
    pendingDeltas: ['buffer'], nextStreams: {}, partKinds: {}, messages: ['duplicate transcript'],
    text: 'Durable subagent result', timeline: [{ type: 'tool', output: 'Durable subagent evidence' }] }];
  fs.writeFileSync(f.file(legacy.id), JSON.stringify(legacy));
  const first = await f.rewind(f.boundary(5));
  assert.equal(first.ok, true);
  const before = f.read(first.backupSessionId);
  assert.equal(before.messages[13].agentRun.changeCount, 2);
  assert.equal(before.messages[13].agentRun.subagents[0].seenEvents, undefined, 'Backups detach terminal runtime buffers');
  f.enableProductionRead();
  const migrated = await f.context.readSessionRecord(first.backupSessionId);
  assert.equal(migrated.messages[13].agentRun.changeCount, 1);
  assert.equal(migrated.messages[13].agentRun.changeSummary.additions, 2);
  migrated.messages.push({ role: 'user', content: 'Continue the backup independently', ts: 9911 });
  await f.save(migrated);
  const restored = await f.restore({ sessionId: f.source.id, conversationRevision: 1 });
  assert.equal(restored.ok, true);
  const current = f.read(f.source.id);
  assert.equal(current.messages.length, 64);
  assert.equal(current.messages[13].agentRun.subagents[0].text, 'Durable subagent result');
  assert.equal(current.messages[13].agentRun.subagents[0].timeline[0].output, 'Durable subagent evidence');
  assert.deepEqual(current.messages[13].agentRun.watchdog, legacy.messages[13].agentRun.watchdog);
});

test('late model choices cannot replace the restored historical model', async t => {
  const f = fixture(t);
  const first = await f.rewind(f.boundary(13));
  const before = fs.readFileSync(f.file(f.source.id), 'utf8');
  const stale = await f.model({ id: f.source.id, modelSelection: model('wrong') });
  assert.equal(stale.code, 'SESSION_REVISION_CHANGED');
  assert.equal(fs.readFileSync(f.file(f.source.id), 'utf8'), before);
  const fresh = await f.model({ id: f.source.id, modelSelection: model('current'), conversationRevision: first.conversationRevision });
  assert.equal(fresh.ok, true);
  assert.equal(f.read(f.source.id).modelSelection.modelId, 'model-current');
});

test('late enqueue, consume and requeue requests cannot revive discarded prompts after rewind', async t => {
  const f = fixture(t);
  await f.rewind(f.boundary(13));
  const stale = await f.enqueue({ threadId: f.source.id, intentId: 'old-intent', intent: { prompt: 'DISCARDED_PROMPT' } });
  assert.equal(stale.code, 'SESSION_REVISION_CHANGED');
  assert.equal(Object.keys(f.context.yanCore.state.intents).length, 0);
  const fresh = await f.enqueue({ threadId: f.source.id, intentId: 'fresh-intent', conversationRevision: 1,
    intent: { prompt: 'New prompt', conversationRevision: 999 } });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.intent.intent.conversationRevision, 1, 'The persisted normalized intent freezes the authoritative revision');
  // Simulate a restored old queue record from an earlier application run.
  f.context.yanCore.state.intents.legacy = { id: 'legacy', threadId: f.source.id, status: 'queued', intent: { prompt: 'DISCARDED_PROMPT' } };
  assert.equal((await f.consume('legacy')).code, 'SESSION_REVISION_CHANGED');
  f.context.yanCore.state.intents.legacy.status = 'consumed';
  assert.equal((await f.requeue('legacy')).code, 'SESSION_REVISION_CHANGED');
  assert.equal(f.context.yanCore.state.intents.legacy.status, 'consumed', 'Stale requests are refused without silently deleting the queue');
  assert.equal((await f.consume('fresh-intent')).ok, true);
  assert.equal((await f.requeue('fresh-intent')).ok, true);
});
