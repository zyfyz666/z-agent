'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRewindBackup, sessionConversationRevision } = require('../lib/session-rewind');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function section(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-backup-sidebar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const context = vm.createContext({ fs, fsp: fs.promises, path, sessionsDir: directory,
    sessionRecordCache: new Map(), state: {},
    isSafeSessionId: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(id),
    ensureDirs() {}, sanitizeSessionReviewSummaries() {}, sessionConversationRevision });
  vm.runInContext(section(main, 'const sessionSummaryCache = ', '\nfunction notifyDesktopSessionUpdate('), context);
  vm.runInContext(section(renderer, 'function setSessionSummaries(', '\nasync function refreshSessions('), context);
  vm.runInContext(section(renderer, 'function sessionRewindBackupsFor(', '\nfunction openSessionRewindBackups('), context);
  const source = { id: 'sess_source', title: 'Long identical source title', workspace: directory, workspaceKind: 'default',
    createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'keep request', ts: 1 }, { role: 'assistant', content: 'keep answer', ts: 2 }] };
  const write = record => fs.writeFileSync(path.join(directory, record.id + '.json'), JSON.stringify(record));
  write(source);
  return { context, source, write, directory };
}

function externalChangeFixture(t) {
  const f = fixture(t);
  const { context, source, directory } = f;
  const backup = createRewindBackup(source, { id: 'sess_viewed_backup', now: 20 });
  f.write(backup);
  const draft = { text: 'Keep my unfinished continuation' };
  const queued = { id: 'intent_backup', text: 'Keep this queued continuation' };
  const effects = [];
  Object.assign(context.state, {
    currentSession: backup,
    composerDrafts: new Map([[backup.id, draft]]),
    queuedTurns: new Map([[backup.id, queued]])
  });
  Object.assign(context, {
    refreshSessions: async () => context.setSessionSummaries(await context.listSessionSummaries({ includeRewindBackups: true })),
    settleAgentInteractionsForSession: id => effects.push(['settle', id]),
    clearYanCoreQueuedIntentsForThread: async id => effects.push(['clear-intents', id]),
    restoreComposerDraftForSession: id => effects.push(['restore-draft', id]),
    clearMessages: () => effects.push(['clear-messages']),
    setEmptyState: value => effects.push(['empty-state', value]),
    loadSession: async id => { effects.push(['load', id]); context.state.currentSession = source; },
    syncAgentInteractionPanel() {}, syncPetFocusedSession() {}, updateTaskBar() {}, updateSendState() {},
    renderModelBadge() {}, syncAgentBrowserVisibility() {}, renderSessionList() {},
    sessionModelSelectionVersions: new Map(),
    api: { getSession: async id => JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8')) }
  });
  vm.runInContext(section(renderer, 'async function applyExternalSessionChange(', '\nfunction isDefaultSessionTitle('), context);
  return { ...f, backup, draft, queued, effects };
}

test('untouched rewind snapshots are hidden from default backend discovery but retained for their source history', async t => {
  const { context, source, write } = fixture(t);
  for (let index = 0; index < 4; index++) write(createRewindBackup(source, { id: `sess_backup${index}`, now: index + 10 }));
  const ordinary = await context.listSessionSummaries();
  assert.deepEqual(Array.from(ordinary, session => session.id), [source.id]);
  const complete = await context.listSessionSummaries({ includeRewindBackups: true });
  assert.equal(complete.length, 5);
  context.setSessionSummaries(complete);
  assert.deepEqual(Array.from(context.state.sessions, session => session.id), [source.id]);
  assert.equal(context.sessionRewindBackupsFor(source.id).length, 4);
  assert.equal((await context.listSessionSummaries()).length, 1, 'cached summaries keep the same classification');
});

test('real branches, continued snapshots and orphan backups remain distinct visible conversations', async t => {
  const { context, source, write } = fixture(t);
  const branch = { ...source, id: 'sess_branch', forkedFrom: { sessionId: source.id, messageCount: 2 } };
  const continued = createRewindBackup(source, { id: 'sess_continued', now: 15 });
  continued.messages.push({ role: 'user', content: 'continue this independent branch', ts: 16 });
  const orphan = createRewindBackup({ ...source, id: 'sess_missing' }, { id: 'sess_orphan', now: 20 });
  for (const record of [branch, continued, orphan]) write(record);
  const complete = await context.listSessionSummaries({ includeRewindBackups: true });
  context.setSessionSummaries(complete);
  assert.equal(context.state.sessions.length, 4);
  assert.equal((await context.listSessionSummaries()).length, 4);
  assert.equal(context.state.sessions.find(session => session.id === continued.id).isRewindBackup, false);
  assert.ok(context.state.sessions.find(session => session.id === branch.id).forkedFrom);
});

test('a matching title or workspace cannot hide an ordinary conversation', async t => {
  const { context, source, write } = fixture(t);
  write({ ...source, id: 'sess_same_title' });
  write({ ...source, id: 'sess_unmarked', rewindBackupOf: { sessionId: source.id, messageCount: 2 } });
  const complete = await context.listSessionSummaries({ includeRewindBackups: true });
  context.setSessionSummaries(complete);
  assert.equal(context.state.sessions.length, 3);
});

test('metadata changes to a viewed hidden backup preserve its draft and queued continuation', async t => {
  const f = externalChangeFixture(t);
  const updatedModel = { providerId: 'fixture-provider', modelId: 'fixture-model' };
  const originalMessages = f.backup.messages;
  f.write({ ...f.backup, title: 'Renamed saved version', modelSelection: updatedModel, updatedAt: 30 });
  await f.context.applyExternalSessionChange({ id: f.backup.id, reason: 'model-selection-changed' });
  assert.equal(f.context.state.sessions.some(session => session.id === f.backup.id), false);
  assert.equal(f.context.state.rewindBackups.some(session => session.id === f.backup.id), true);
  assert.equal(f.context.state.currentSession, f.backup);
  assert.equal(f.backup.title, 'Renamed saved version');
  assert.deepEqual(f.backup.modelSelection, updatedModel);
  assert.equal(f.backup.messages, originalMessages);
  assert.equal(f.context.state.composerDrafts.get(f.backup.id), f.draft);
  assert.equal(f.context.state.queuedTurns.get(f.backup.id), f.queued);
  assert.deepEqual(f.effects, []);
});

test('deleting a viewed backup still clears its draft and queued intent and opens a surviving conversation', async t => {
  const f = externalChangeFixture(t);
  fs.unlinkSync(path.join(f.directory, `${f.backup.id}.json`));
  await f.context.applyExternalSessionChange({ id: f.backup.id, reason: 'deleted' });
  assert.equal(f.context.state.currentSession, f.source);
  assert.equal(f.context.state.composerDrafts.has(f.backup.id), false);
  assert.equal(f.context.state.queuedTurns.has(f.backup.id), false);
  assert.deepEqual(f.effects, [
    ['settle', f.backup.id], ['clear-intents', f.backup.id], ['restore-draft', ''],
    ['clear-messages'], ['empty-state', true], ['load', f.source.id]
  ]);
});

test('rewind backup dialog and dynamic counts are localized without changing stored user text', () => {
  const context = vm.createContext({ window: {}, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/i18n.js'), 'utf8'), context);
  const translate = text => context.window.YanI18n.translate(text, 'en');
  assert.equal(translate('回退备份（4）'), 'Rewind backups (4)');
  assert.equal(translate('118 条消息'), '118 messages');
  assert.equal(translate('1 条消息 · 已继续'), '1 message · Continued');
  for (const text of ['回退备份', '查看', '关闭', '分支', '备份', '这个对话还没有回退备份',
    '每次回退前的记录都保留在这里。查看备份不会改变当前项目文件；从备份继续发送会成为独立分支。']) {
    assert.doesNotMatch(translate(text), /[\u3400-\u9fff]/u);
  }
});
