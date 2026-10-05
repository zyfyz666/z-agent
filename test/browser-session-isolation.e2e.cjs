'use strict';

// Uses temporary app data and local fixture pages; no real agent/model runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron: electron } = require('playwright');
const appRoot = path.resolve(__dirname, '..');
const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'browser-agent.html')).href;
const tempRoot = fs.realpathSync.native(os.tmpdir());
const profile = fs.mkdtempSync(path.join(tempRoot, 'z-browser-session-e2e-'));
const report = { ok: false, checks: [], pageErrors: [] };
let application, page;

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile,
    Z_E2E_PARENT_PID: String(process.pid), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    page = application.windows().find(window => /\/renderer\/index\.html/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'isolated main window exists');
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.setDefaultTimeout(25000);
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession);
  assert.equal(fs.realpathSync.native(await application.evaluate(({ app }) => app.getPath('userData'))), profile);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getAppPath())), appRoot);
}
async function load(id) {
  await page.evaluate(async id => { await loadSession(id); await ensureBrowserSessionState(id); }, id);
  assert.equal(await page.evaluate(() => state.currentSession.id), id);
}
async function userTab(owner) {
  await page.evaluate(() => openRightSidebarTool('browser'));
  await page.waitForFunction(() => getActiveRightSidebarTab()?.type === 'browser');
  return page.evaluate(async ({ url, value }) => {
    const controller = getBrowserTabController();
    await controller.navigate(url, { waitForLoad: true });
    await controller.webview.executeJavaScript(`document.querySelector('#nameInput').value = ${JSON.stringify(value)}`);
    return { id: controller.id, guest: controller.webview.getWebContentsId() };
  }, { url: `${fixture}?owner=${owner}`, value: `${owner} unsaved value` });
}
async function command(id, runId, action, owner) {
  return page.evaluate(input => executeBrowserAgentCommand({ action: input.action, params: {
    z_run_id: input.runId, z_session_id: input.id, z_workspace: input.workspace,
    target_type: 'url', url_or_path: input.url
  } }), { id, runId, action, workspace: appRoot, url: `${fixture}?owner=${owner}` });
}
async function ui() {
  return page.evaluate(() => ({ active: activeRightSidebarTab,
    visible: [...document.querySelectorAll('[data-rs-tab-type="browser"]')].map(element => element.dataset.rsTabUnit),
    live: [...browserTabControllers.keys()], open: !document.querySelector('#app').classList.contains('rs-hidden') }));
}
async function select(id) { await page.evaluate(id => activateRightSidebarTab(id), id); }

(async () => {
  try {
    await launch();
    const [a, b] = await page.evaluate(async workspace => {
      const ids = [];
      for (const title of ['Browser A', 'Browser B']) {
        const session = await z.createSession(true, workspace);
        session.messages = [{ role: 'user', content: 'Local fixture test. No model request.', ts: Date.now() }];
        await z.saveSession(session); await z.renameSession(session.id, title); ids.push(session.id);
      }
      await refreshSessions(); return ids;
    }, appRoot);
    assert.notEqual(a, b);
    await load(a);
    const userA = await userTab('user-a');
    const agentA = await command(a, 'test-a', 'open', 'agent-a');
    assert.equal(agentA.ok, true);
    await command(a, 'test-a', 'release'); await select(userA.id);
    await load(b);
    assert.deepEqual((await ui()).visible, []);
    const userB = await userTab('user-b');
    const agentB = await command(b, 'test-b', 'open', 'agent-b');
    assert.equal(agentB.ok, true); assert.notEqual(agentA.tabId, agentB.tabId);
    await command(b, 'test-b', 'release'); await select(userB.id);
    const staleB = await page.evaluate(id => z.getSession(id), b);
    await load(a);
    assert.deepEqual((await ui()).visible.sort(), [userA.id, agentA.tabId].sort());
    assert.equal((await ui()).active, userA.id);
    const retained = await page.evaluate(async id => {
      const controller = getBrowserTabController(id);
      await controller.webview.executeJavaScript("history.pushState({}, '', '#retained-history')");
      return { value: await controller.webview.executeJavaScript("document.querySelector('#nameInput').value"),
        guest: controller.webview.getWebContentsId(), history: controller.webview.canGoBack() };
    }, userA.id);
    assert.equal(retained.value, 'user-a unsaved value'); assert.equal(retained.guest, userA.guest); assert.equal(retained.history, true);
    assert.equal(await page.evaluate(id => activateRightSidebarTab(id), userB.id), false);
    assert.equal((await ui()).open, true);
    report.checks.push('same-workspace user/agent tabs isolated; page input, selection and history retained');
    const background = await command(b, 'test-b2', 'open', 'agent-b-background');
    assert.equal(background.ok, true); assert.equal(background.tabId, agentB.tabId);
    assert.equal((await ui()).active, userA.id);
    await command(b, 'test-b2', 'release');
    const rebound = await command(b, 'test-b3', 'status');
    assert.notEqual(rebound.ok, false); assert.equal((await ui()).active, userA.id);
    await command(b, 'test-b3', 'release');
    const popupUrl = `${fixture}?owner=background-popup-b`;
    await page.evaluate(async ({ id, url }) => getBrowserTabController(id).webview.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank'); void 0`), { id: userB.id, url: popupUrl });
    await page.waitForFunction(({ id, url }) => openRightSidebarTabs.some(tab => tab.agentSessionId === id && tab.url === url), { id: b, url: popupUrl });
    const popupB = await page.evaluate(({ id, url }) => openRightSidebarTabs.find(tab => tab.agentSessionId === id && tab.url === url).id, { id: b, url: popupUrl });
    assert.equal((await ui()).active, userA.id);
    assert.deepEqual((await ui()).visible.sort(), [userA.id, agentA.tabId].sort());
    await load(b);
    assert.equal((await ui()).active, userB.id);
    assert.deepEqual((await ui()).visible.sort(), [userB.id, agentB.tabId, popupB].sort());
    await page.evaluate(() => { state.currentSession.workspace = ''; syncAgentBrowserVisibility(); });
    assert.equal((await ui()).active, userB.id);
    report.checks.push('background tool open/rebind and popup preserve owner; changing workspace preserves chat pages');
    await load(a);
    assert.equal(await page.evaluate(id => getBrowserTabController(id).webview.canGoBack(), userA.id), true);
    await page.evaluate(id => closeRightSidebarTool(id), userA.id);
    assert.equal((await ui()).live.includes(userA.id), false); assert.equal((await ui()).live.includes(userB.id), true);
    await select(agentA.tabId);
    await page.evaluate(async ids => { for (const id of ids) await flushBrowserSessionState(id); }, [a, b]);
    await page.evaluate(session => z.saveSession(session), staleB);
    const saved = await page.evaluate(async ids => Promise.all(ids.map(id => z.getSessionBrowserState(id))), [a, b]);
    assert.equal(saved[0].browserState.tabs.length, 1); assert.equal(saved[0].browserState.selectedTabId, agentA.tabId);
    assert.equal(saved[1].browserState.tabs.length, 3); assert.equal(saved[1].browserState.selectedTabId, userB.id);
    report.checks.push('closing one chat tab leaves other pages mounted; stale session save cannot erase browser state');
    await application.close(); application = null;
    await launch();
    await load(a);
    await page.waitForFunction(id => getBrowserTabController(id)?.currentUrl.includes('owner=agent-a'), agentA.tabId);
    assert.deepEqual((await ui()).visible, [agentA.tabId]); assert.equal((await ui()).active, agentA.tabId);
    await load(b);
    await page.waitForFunction(id => getBrowserTabController(id)?.currentUrl.includes('owner=user-b'), userB.id);
    assert.equal((await ui()).active, userB.id); assert.equal((await ui()).visible.length, 3);
    assert.equal(await page.evaluate(id => getBrowserTabController(id).agentControlActive, agentB.tabId), false);
    report.checks.push('isolated restart restores URLs and selected page per chat; no stale run lease');
    const empty = await page.evaluate(async () => {
      const session = await z.createSession(true, ''); await refreshSessions();
      await loadSession(session.id); await ensureBrowserSessionState(session.id); return session.id;
    });
    const emptyTab = await userTab('empty-chat');
    await page.evaluate(() => newSession());
    assert.notEqual(await page.evaluate(() => state.currentSession.id), empty);
    assert.deepEqual((await ui()).visible, []);
    const emptyStored = await page.evaluate(id => z.getSession(id), empty);
    assert.ok(emptyStored); assert.equal(emptyStored.browserState.tabs.length, 1);
    await load(empty); assert.equal((await ui()).active, emptyTab.id);
    await page.evaluate(async ({ id, tab }) => { closeRightSidebarTool(tab); await flushBrowserSessionState(id); }, { id: empty, tab: emptyTab.id });
    assert.deepEqual((await page.evaluate(id => z.getSessionBrowserState(id), empty)).browserState.tabs, []);
    report.checks.push('browser-only empty chat is preserved; closing last page persists empty tabs');
    await load(b);
    await page.evaluate(async id => {
      const removed = await z.deleteSession(id, true);
      if (!removed?.ok) throw new Error(removed?.error || 'test session deletion failed');
      await applyExternalSessionChange({ id });
    }, a);
    assert.equal((await ui()).live.includes(agentA.tabId), false);
    assert.equal((await ui()).live.includes(userB.id), true);
    assert.equal((await ui()).active, userB.id);
    assert.equal(await page.evaluate(id => browserSessionRecords.has(id), a), false);
    assert.equal(await page.evaluate(id => createRightSidebarTab('browser', { sessionId: id }), a), null);
    report.checks.push('deleting one conversation disposes only its pages and rejects late page creation');
    assert.deepEqual(report.pageErrors, []); report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await application?.close().catch(() => {});
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(`${tempRoot}${path.sep}`)) throw new Error('Unsafe temporary cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); console.error(JSON.stringify(report)); process.exitCode = 1; });
