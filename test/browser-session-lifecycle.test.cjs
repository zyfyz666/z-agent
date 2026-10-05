'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const browserStateApi = require('../lib/browser-session-state');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}

function persisted(owner = 'a') {
  return { version: 1, tabs: [{ id: 'browser-1', url: `https://${owner}.example.test/`, title: `Saved ${owner}` }],
    activeTabId: 'browser-1', selectedTabId: 'browser-1' };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ read } = {}) {
  const writes = [];
  const destroyed = [];
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    URL, console, window: { ZBrowserSessionState: browserStateApi },
    state: { currentSession: { id: 'sess_a', workspace: 'same-workspace' },
      sessions: ['a', 'b', 'c'].map(id => ({ id: `sess_${id}` })) },
    api: {
      getSessionBrowserState: async id => ({ ok: true, browserState: read ? await read(id) : null }),
      setSessionBrowserState: async (id, state) => { writes.push({ id, state: clone(state) }); return { ok: true }; }
    },
    browserSessionRecords: new Map(), browserTabControllers: new Map(), deletedBrowserSessionIds: new Set(),
    openRightSidebarTabs: [], browserDraftSessionId: 'draft:fixture', displayedBrowserSessionId: '',
    rightSidebarBrowserCounter: 0, activeRightSidebarTab: null, lastActiveBrowserTabId: null,
    currentWindowView: 'main', currentMainPage: 'chat', RIGHT_SIDEBAR_TOOLS: {},
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    normalizeBrowserTabFavicon: value => value,
    renderRightSidebarTabs() {}, updateBrowserFocusControls() {}, syncBrowserViewport() {},
    setRightSidebarOpen() {}, closeAllBrowserSettingsMenus() {}, hideReviewQuickDiff() {}, toast() {},
    createBrowserTabController(tab) {
      context.browserTabControllers.set(tab.id, {
        id: tab.id, agentSessionId: tab.agentSessionId, agentWorkspace: tab.agentWorkspace,
        agentScopeKey: tab.agentScopeKey, annotations: { stop() {} },
        webview: { getWebContentsId: () => Number(tab.id.split('-').at(-1)) },
        async navigate(url) { tab.url = url; return { url }; }
      });
    },
    getBrowserTabController(id = context.activeRightSidebarTab) { return context.browserTabControllers.get(id); },
    destroyBrowserTabController(id) { destroyed.push(id); context.browserTabControllers.delete(id); }
  });
  for (const code of [
    section('function browserScopeKey(', 'function findRunCtxByRunId('),
    section('function getActiveRightSidebarTab(', 'function openRightSidebarTool('),
    section('function openBrowserUrlInNewTab(', "$('#rightSidebarTabStrip')?.addEventListener('click'"),
    section('function syncAgentBrowserVisibility(', "document.addEventListener('keydown', event => {")
  ]) vm.runInContext(code, context);
  return { context, writes, destroyed, timers };
}

test('a new page opened during first hydration does not replace the saved page with the same runtime ID', async () => {
  const read = deferred();
  const { context, writes } = fixture({ read: () => read.promise });
  const hydration = context.ensureBrowserSessionState('sess_a');
  context.openBrowserUrlInNewTab('https://new.example.test/');
  const newTab = context.openRightSidebarTabs[0];
  assert.equal(newTab.id, 'browser-1');
  read.resolve(persisted());
  await hydration;
  assert.deepEqual(context.openRightSidebarTabs.map(tab => tab.url).sort(),
    ['https://a.example.test/', 'https://new.example.test/']);
  assert.equal(new Set(context.openRightSidebarTabs.map(tab => tab.id)).size, 2);
  assert.equal(context.activeRightSidebarTab, newTab.id, 'the deliberate new selection survives hydration');
  await context.flushBrowserSessionState('sess_a');
  assert.equal(writes.at(-1).state.tabs.length, 2);
});

test('closing a new page during hydration cannot mark a different saved page with the same ID as closed', async () => {
  const read = deferred();
  const { context, writes } = fixture({ read: () => read.promise });
  const hydration = context.ensureBrowserSessionState('sess_a');
  context.openBrowserUrlInNewTab('https://temporary.example.test/');
  context.closeRightSidebarTool(context.openRightSidebarTabs[0].id);
  read.resolve(persisted());
  await hydration;
  await context.flushBrowserSessionState('sess_a');
  assert.deepEqual(context.openRightSidebarTabs.map(tab => tab.url), ['https://a.example.test/']);
  assert.equal(writes.at(-1).state.tabs.length, 1);
});

test('passing through a chat while its first hydration is pending preserves its saved selection', async () => {
  const readB = deferred();
  const { context, writes } = fixture({ read: id => id === 'sess_b' ? readB.promise : null });
  context.syncAgentBrowserVisibility();
  await context.ensureBrowserSessionState('sess_a');
  context.state.currentSession = { id: 'sess_b' };
  context.syncAgentBrowserVisibility();
  const hydration = context.ensureBrowserSessionState('sess_b');
  context.state.currentSession = { id: 'sess_c' };
  context.syncAgentBrowserVisibility();
  readB.resolve(persisted('b'));
  await hydration;
  await context.flushBrowserSessionState('sess_b');
  const savedB = writes.filter(item => item.id === 'sess_b').at(-1).state;
  assert.equal(savedB.selectedTabId, savedB.tabs[0].id);
  context.state.currentSession = { id: 'sess_b' };
  context.syncAgentBrowserVisibility();
  assert.equal(context.activeRightSidebarTab, savedB.selectedTabId);
});

test('deleting one chat disposes only its pages, pending timer, and state while leaving the visible sibling intact', async () => {
  const { context, destroyed, timers } = fixture({ read: id => persisted(id.slice(-1)) });
  await context.ensureBrowserSessionState('sess_a');
  await context.ensureBrowserSessionState('sess_b');
  const aTab = context.openRightSidebarTabs.find(tab => tab.agentSessionId === 'sess_a');
  const bTab = context.openRightSidebarTabs.find(tab => tab.agentSessionId === 'sess_b');
  context.activateRightSidebarTab(aTab.id);
  context.scheduleBrowserSessionSave('sess_b');
  const oldState = context.browserSessionRecords.get('sess_b');
  const timer = oldState.saveTimer;
  context.browserTabControllers.set('browser-orphan', { id: 'browser-orphan', agentSessionId: 'sess_b' });
  context.disposeBrowserSessionState('sess_b');
  assert.equal(oldState.disposed, true);
  assert.equal(timers.has(timer), false);
  assert.equal(context.browserSessionRecords.has('sess_b'), false);
  assert.equal(context.deletedBrowserSessionIds.has('sess_b'), true);
  assert.deepEqual(destroyed.sort(), [bTab.id, 'browser-orphan'].sort());
  assert.deepEqual(context.openRightSidebarTabs.map(tab => tab.id), [aTab.id]);
  assert.equal(context.activeRightSidebarTab, aTab.id);
  assert.equal(context.browserTabControllers.has(aTab.id), true);
  assert.equal(context.createRightSidebarTab('browser', { sessionId: 'sess_b' }), null);
  assert.equal(await context.ensureBrowserSessionState('sess_b'), null);
  await context.flushBrowserSessionState('sess_b');
  context.disposeBrowserSessionState('sess_b');
  assert.equal(context.activeRightSidebarTab, aTab.id, 'repeated deletion notifications are harmless');
});

test('deleting during an in-flight read prevents late hydration and queued saving from resurrecting pages', async () => {
  const read = deferred();
  const { context, writes } = fixture({ read: () => read.promise });
  const hydration = context.ensureBrowserSessionState('sess_a');
  const saving = context.flushBrowserSessionState('sess_a');
  const oldState = context.browserSessionRecords.get('sess_a');
  context.disposeBrowserSessionState('sess_a');
  read.resolve(persisted());
  await Promise.all([hydration, saving]);
  assert.equal(oldState.disposed, true);
  assert.equal(context.browserSessionRecords.has('sess_a'), false);
  assert.equal(context.browserTabControllers.size, 0);
  assert.equal(context.openRightSidebarTabs.length, 0);
  assert.deepEqual(writes, []);
});

test('an older preload restores the session snapshot and keeps mounted pages isolated without new IPC methods', async () => {
  const { context } = fixture();
  delete context.api.getSessionBrowserState;
  delete context.api.setSessionBrowserState;
  context.state.currentSession.browserState = persisted();
  await context.ensureBrowserSessionState('sess_a');
  context.openBrowserUrlInNewTab('https://new.example.test/');
  await context.flushBrowserSessionState('sess_a');
  assert.equal(context.state.currentSession.browserState.tabs.length, 2);
  context.state.currentSession = { id: 'sess_b' };
  context.syncAgentBrowserVisibility();
  await context.ensureBrowserSessionState('sess_b');
  assert.equal(context.visibleRightSidebarTabs().length, 0);
  assert.equal(context.browserTabControllers.size, 2);
});

test('sidebar deletion disposes browser pages only after the backend confirms the deletion', async () => {
  for (const ok of [true, false]) {
    const disposed = [];
    const context = vm.createContext({
      state: { currentSession: { id: 'sess_b' }, sessions: [{ id: 'sess_a' }, { id: 'sess_b' }],
        composerDrafts: new Map(), queuedTurns: new Map() },
      isSessionExecutionActive: () => false, isBlankNewChat: () => true,
      api: { getSession: async () => ({ id: 'sess_a' }), deleteSession: async () => ({ ok }) },
      disposeBrowserSessionState: id => disposed.push(id),
      clearZCoreQueuedIntentsForThread() {}, settleAgentInteractionsForSession() {}, refreshSessions() {}, toast() {}
    });
    vm.runInContext(section('async function performSessionDeletionFromSidebar(', '// Hint below the composer:'), context);
    await context.performSessionDeletionFromSidebar('sess_a');
    assert.deepEqual(disposed, ok ? ['sess_a'] : []);
  }
});
