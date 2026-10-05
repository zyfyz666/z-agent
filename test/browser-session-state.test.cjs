'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { normalizeBrowserSessionState, normalizeBrowserSessionUrl } = require('../lib/browser-session-state');
const { createSessionWriteQueue } = require('../lib/session-model');
const { preserveForkAuthority } = require('../lib/session-fork');
const { assertConversationRevision, sessionConversationRevision } = require('../lib/session-rewind');
const { evaluateSessionDeletion, findReusableBlankSession, isBlankUnassignedNewChat } = require('../lib/session-policy');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function section(start, end) {
  const offset = main.indexOf(start);
  const finish = main.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return main.slice(offset, finish);
}
function browserState(suffix = 'a') {
  return { version: 1, tabs: [{ id: 'browser-1', url: `https://${suffix}.example.test/`, title: `Page ${suffix}` }],
    activeTabId: 'browser-1', selectedTabId: 'browser-1' };
}

function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'z-browser-state-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith('z-browser-state-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const handlers = new Map();
  const cache = new Map();
  const file = id => path.join(root, `${id}.json`);
  let writeGate = null;
  let failure = null;
  const context = vm.createContext({
    fs, path, crypto, process: { pid: process.pid }, normalizeBrowserSessionState,
    fsp: { ...fs.promises, async rename(from, to) {
      if (writeGate?.file === to) {
        const gate = writeGate;
        writeGate = null;
        gate.enter();
        await gate.promise;
      }
      if (failure?.file === to) {
        const error = failure.error;
        failure = null;
        throw error;
      }
      return fs.promises.rename(from, to);
    } },
    withSessionWrite: createSessionWriteQueue(),
    isSafeSessionId: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || '').trim()),
    sessionPath: file,
    async readSessionRecord(id, options) {
      assert.equal(options.sessionLocked, true, 'read owns the same session write queue');
      return JSON.parse(await fs.promises.readFile(file(id), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return 'null';
        throw error;
      }));
    },
    refreshSessionSummaryCache(id, data) { cache.set(id, clone(data)); },
    touchSessionRecordCache(id, data) { cache.set(id, clone(data)); },
    invalidateSessionRecordCache(id) { cache.delete(id); },
    assertConversationRevision, sessionConversationRevision, preserveForkAuthority,
    ensureDirs() {}, initialSessionModelSelection() { return { modelId: 'synthetic-model' }; },
    ensureTaskWorkspace(session, options) {
      const owner = options.previousSession || session;
      return { workspace: owner.workspace, workspaceKind: owner.workspaceKind };
    },
    defaultTasksRoot: root, dataDir: root,
    sanitizeSessionReviewSummaries() {}, pruneSessionRuntimeBookkeeping() {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
  });
  vm.runInContext(section('async function writeSessionFileAtomic(', "ipcMain.handle('session:save',"), context);
  vm.runInContext(section('async function getSessionBrowserStateRecord(', 'async function setSessionModelRecord('), context);
  vm.runInContext(section("ipcMain.handle('session:save',", '// 会话级工作区'), context);
  const invoke = async (channel, ...args) => clone(await handlers.get(channel)(null, ...args.map(clone)));
  return {
    root, cache,
    seed(id, extra = {}) {
      const record = { id, title: `Conversation ${id}`, pinned: true, createdAt: 1, updatedAt: 2,
        conversationRevision: 0, modelSelection: { modelId: 'synthetic-model' }, workspace: root, workspaceKind: 'selected',
        messages: [{ role: 'user', content: 'Older request' }, { role: 'assistant', content: 'Older response' }], ...extra };
      fs.writeFileSync(file(id), JSON.stringify(record));
      return clone(record);
    },
    disk: id => JSON.parse(fs.readFileSync(file(id), 'utf8')),
    get: id => invoke('session:browser-state-get', id),
    set: (id, state) => invoke('session:browser-state-set', { id, browserState: state }),
    save: record => invoke('session:save', record),
    pauseWrite(id) {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const promise = new Promise(resolve => { release = resolve; });
      writeGate = { file: file(id), enter, promise };
      return { entered, release };
    },
    failWrite(id) { failure = { file: file(id), error: Object.assign(new Error('Synthetic write failure'), { code: 'EIO' }) }; }
  };
}

test('browser snapshots whitelist display/navigation fields and remove credentials and runtime ownership', () => {
  const input = browserState();
  Object.assign(input, { runId: 'live-run', apiKey: 'secret', sessionId: 'sess_other' });
  Object.assign(input.tabs[0], { favicon: 'https://a.example.test/favicon.ico', agentOwned: true, workspace: 'C:\\synthetic',
    runId: 'live-run', agentRunId: 'live-run', webContentsId: 123, sessionId: 'sess_other', credentials: { password: 'secret' } });
  const before = clone(input);
  assert.deepEqual(normalizeBrowserSessionState(input), { ...browserState(), tabs: [{ ...browserState().tabs[0],
    favicon: 'https://a.example.test/favicon.ico', agentOwned: true, workspace: 'C:\\synthetic' }] });
  assert.deepEqual(input, before, 'taking a snapshot does not modify the live tab');
});

test('only safe restorable URLs survive; unsafe favicons cannot reintroduce credentials or executable URLs', () => {
  for (const url of ['https://user:secret@example.test/', 'http://user@example.test/', 'javascript:alert(1)',
    'data:text/html,hello', 'blob:https://example.test/123', 'ftp://example.test/', 'about:config', 'about:blank#unsafe',
    'https://exam\nple.test/', 'not a URL']) {
    assert.equal(normalizeBrowserSessionUrl(url), '', url);
    const state = browserState();
    state.tabs.push({ id: 'browser-2', url, title: 'Unsafe' });
    state.tabs[0].favicon = url;
    state.activeTabId = 'browser-2';
    assert.deepEqual(normalizeBrowserSessionState(state), { ...browserState(), activeTabId: null });
  }
  for (const url of ['http://127.0.0.1:1234/', 'https://example.test/path?q=1', 'file:///C:/synthetic/report.html', 'about:blank']) {
    assert.equal(normalizeBrowserSessionUrl(url), url);
  }
});

test('empty states stay empty, tab IDs are safe and unique, and invalid selection cannot reference another tab', () => {
  const empty = { version: 1, tabs: [], activeTabId: null, selectedTabId: null };
  assert.deepEqual(normalizeBrowserSessionState(empty), empty);
  assert.equal(normalizeBrowserSessionState(null), null);
  assert.equal(normalizeBrowserSessionState({ ...empty, version: 2 }), null);
  assert.equal(normalizeBrowserSessionState({ ...empty, tabs: {} }), null);
  const state = browserState();
  state.tabs.push({ ...state.tabs[0], title: 'Duplicate' }, { id: '../unsafe', url: 'about:blank' },
    { id: 'safe_tab-2', url: 'about:blank', title: 'Blank', agentOwned: false });
  state.selectedTabId = 'file-another-task';
  assert.deepEqual(normalizeBrowserSessionState(state), { ...browserState(), selectedTabId: null,
    tabs: [...browserState().tabs, { id: 'safe_tab-2', url: 'about:blank', title: 'Blank', agentOwned: false }] });
});

test('the same normalizer is exposed to renderer scripts without Node dependencies', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'browser-session-state.js'), 'utf8'), context);
  assert.deepEqual(clone(context.ZBrowserSessionState.normalizeBrowserSessionState(browserState())), browserState());
});

test('dedicated save preserves all other owner fields and never changes a sibling session', async t => {
  const f = fixture(t);
  const a = f.seed('sess_browser_a');
  const b = f.seed('sess_browser_b', { browserState: browserState('b') });
  assert.deepEqual(await f.get(a.id), { ok: true, id: a.id, browserState: null });
  const state = { ...browserState('a'), id: b.id, sessionId: b.id, messages: [] };
  assert.deepEqual(await f.set(a.id, state), { ok: true, id: a.id, browserState: browserState('a') });
  assert.deepEqual(f.disk(a.id), { ...a, browserState: browserState('a') });
  assert.deepEqual(f.disk(b.id), b);
  assert.deepEqual(f.cache.get(a.id), f.disk(a.id));
  assert.deepEqual(await f.get(a.id), { ok: true, id: a.id, browserState: browserState('a') });
});

test('invalid requests and missing owner sessions do not create or rewrite records', async t => {
  const f = fixture(t);
  const a = f.seed('sess_browser_a');
  for (const id of ['../escape', ' sess_browser_a', '', null]) {
    assert.equal((await f.get(id)).code, 'invalid-session-id');
    assert.equal((await f.set(id, browserState())).code, 'invalid-session-id');
  }
  assert.equal((await f.get('sess_absent')).code, 'session-not-found');
  assert.equal((await f.set('sess_absent', browserState())).code, 'session-not-found');
  assert.equal((await f.set(a.id, { version: 2, tabs: [] })).code, 'invalid-browser-state');
  assert.deepEqual(f.disk(a.id), a);
  assert.deepEqual(fs.readdirSync(f.root), [`${a.id}.json`]);
});

test('ordinary saves preserve authoritative state and cannot inject browser state into old or new records', async t => {
  const f = fixture(t);
  const a = f.seed('sess_browser_a', { browserState: browserState('a') });
  const b = f.seed('sess_browser_b');
  await f.save({ ...a, browserState: browserState('stale') });
  await f.save({ ...b, browserState: browserState('untrusted') });
  await f.save({ ...b, id: 'sess_imported', browserState: browserState('untrusted') });
  assert.deepEqual(f.disk(a.id).browserState, browserState('a'));
  assert.equal(Object.hasOwn(f.disk(b.id), 'browserState'), false);
  assert.equal(Object.hasOwn(f.disk('sess_imported'), 'browserState'), false);
});

for (const browserFirst of [true, false]) {
  test(`a ${browserFirst ? 'browser' : 'message'} write followed by the other preserves both changes and full history`, async t => {
    const f = fixture(t);
    const a = f.seed('sess_browser_a', { browserState: browserState('old') });
    const snapshot = { ...a, messages: [a.messages[1], { role: 'user', content: 'New request' }],
      messagesTruncated: true, messagesStart: 1, totalMessages: 2 };
    const gate = f.pauseWrite(a.id);
    const first = browserFirst ? f.set(a.id, browserState('new')) : f.save(snapshot);
    await gate.entered;
    const second = browserFirst ? f.save(snapshot) : f.set(a.id, browserState('new'));
    gate.release();
    await Promise.all([first, second]);
    assert.deepEqual(f.disk(a.id).browserState, browserState('new'));
    assert.deepEqual(f.disk(a.id).messages.map(message => message.content), ['Older request', 'Older response', 'New request']);
  });
}

test('a blocked owner write does not block another session and closing all tabs cannot be undone by stale messages', async t => {
  const f = fixture(t);
  const a = f.seed('sess_browser_a', { browserState: browserState('a') });
  const b = f.seed('sess_browser_b');
  const empty = { version: 1, tabs: [], activeTabId: null, selectedTabId: null };
  const gate = f.pauseWrite(a.id);
  const closing = f.set(a.id, empty);
  await gate.entered;
  try {
    assert.equal((await f.set(b.id, browserState('b'))).ok, true);
    assert.deepEqual(f.disk(a.id), a, 'the blocked atomic write has not replaced its owner');
  } finally { gate.release(); }
  await closing;
  await f.save({ ...a, messages: [...a.messages, { role: 'user', content: 'Completed after closing tabs' }] });
  assert.deepEqual(f.disk(a.id).browserState, empty);
  assert.deepEqual(f.disk(b.id).browserState, browserState('b'));
  assert.deepEqual((await f.get(a.id)).browserState, empty);
});

test('failed atomic writes keep the durable state and release the session queue for retries', async t => {
  const f = fixture(t);
  const a = f.seed('sess_browser_a', { browserState: browserState('old') });
  f.failWrite(a.id);
  assert.equal((await f.set(a.id, browserState('failed'))).code, 'EIO');
  assert.deepEqual(f.disk(a.id), a);
  assert.deepEqual(fs.readdirSync(f.root), [`${a.id}.json`], 'failed temporary file is removed');
  assert.equal((await f.set(a.id, browserState('retry'))).ok, true);
  assert.deepEqual(f.disk(a.id).browserState, browserState('retry'));
});

test('preload forwards explicit owner IDs on both browser state APIs', async () => {
  const calls = [];
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(name, value) { if (name === 'z') api = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(clone(args)); return Promise.resolve({ ok: true }); },
          on() {}, send() {}, sendSync() {} }, webUtils: {} };
    }
  });
  await api.getSessionBrowserState('sess_browser_a');
  await api.setSessionBrowserState('sess_browser_b', browserState('b'));
  assert.deepEqual(calls, [['session:browser-state-get', 'sess_browser_a'],
    ['session:browser-state-set', { id: 'sess_browser_b', browserState: browserState('b') }]]);
});

test('browser-only conversations survive empty-chat reuse/deletion policies and summary projection', async () => {
  const record = { id: 'sess_browser_only', title: '新对话', messages: [], workspaceKind: 'default', browserState: browserState() };
  const context = vm.createContext({
    sessionConversationRevision, isSafeSessionId: id => /^sess_[A-Za-z0-9_-]{4,160}$/.test(String(id || '')),
    findReusableBlankSession, isBlankUnassignedNewChat,
    listSessionSummaries: async () => [{ ...record, browserState: undefined, browserTabCount: 0 }],
    readSessionRecord: async () => record,
    createFreshSessionRecord: async () => ({ id: 'sess_fresh_chat' })
  });
  vm.runInContext(section('function toSessionSummary(', 'function notifyDesktopSessionUpdate('), context);
  vm.runInContext('let createSessionPromise = null;\n' + section('async function createOrReuseSessionRecord(', 'async function renameSessionRecord('), context);
  const summary = clone(context.toSessionSummary(record));
  assert.equal(summary.messageCount, 0);
  assert.equal(summary.browserTabCount, 1);
  for (const value of [record, summary]) {
    assert.equal(isBlankUnassignedNewChat(value), false);
    assert.equal(findReusableBlankSession([value]), null);
    assert.equal(evaluateSessionDeletion(value, 2).requiresConfirmation, true);
  }
  assert.deepEqual(clone(await context.createOrReuseSessionRecord()), { session: { id: 'sess_fresh_chat' }, reused: false },
    'a browser write that lands after summaries are read cannot cause the owner to be reused');
  assert.equal(isBlankUnassignedNewChat({ ...record, browserState: { version: 1, tabs: [] } }), true);
});

test('new-tab requests retain the source webContents for context-menu links, media, selection, and popup windows', () => {
  const calls = [];
  let windowOpen;
  const contents = { id: 42, isDestroyed: () => false, once() {}, on() {},
    getURL: () => 'https://owner.example.test/', isLoading: () => false,
    setWindowOpenHandler(handler) { windowOpen = handler; } };
  const context = vm.createContext({
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => calls.push(clone(args)) } },
    configuredBrowserGuestIds: new Set(),
    shell: {}, clipboard: {}, Menu: {}, console
  });
  vm.runInContext(section('function isBrowserPageUrl(', "app.on('web-contents-created',"), context);
  const templates = [
    context.buildBrowserContextMenu(contents, { linkURL: 'https://link.example.test/' }),
    context.buildBrowserContextMenu(contents, { mediaType: 'image', srcURL: 'https://image.example.test/a.png' }),
    context.buildBrowserContextMenu(contents, { mediaType: 'video', srcURL: 'https://media.example.test/a.mp4' }),
    context.buildBrowserContextMenu(contents, { selectionText: 'synthetic search' })
  ];
  for (const template of templates) template.find(item => /^(在新标签页中打开|使用 Bing 搜索)/.test(item.label || '')).click();
  context.configureBrowserGuest(contents);
  assert.deepEqual(clone(windowOpen({ url: 'https://popup.example.test/' })), { action: 'deny' });
  assert.equal(calls.length, 5);
  assert.ok(calls.every(([channel, payload]) => channel === 'browser:new-tab-request' && payload.sourceWebContentsId === 42));
});
