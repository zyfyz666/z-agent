'use strict';

// Real Electron guests, temporary application data, local fixtures, no model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron: electron } = require('playwright');
const appRoot = path.resolve(__dirname, '..');
const fixture = pathToFileURL(path.join(__dirname, 'fixtures/browser-agent.html')).href;
const tempRoot = fs.realpathSync.native(os.tmpdir());
const profile = fs.mkdtempSync(path.join(tempRoot, 'z-browser-tabs-e2e-'));
let app, page;
const checks = [];
const errors = [];

async function command(session, action, params = {}, operationId = '') {
  return page.evaluate(input => executeBrowserAgentCommand({ action: input.action, operationId: input.operationId,
    params: { z_run_id: 'tabs-e2e-' + input.session, z_session_id: input.session, ...input.params } }), { session, action, params, operationId });
}
async function guest(tabId, expression) {
  return page.evaluate(({ tabId, expression }) => getBrowserTabController(tabId).webview.executeJavaScript(expression), { tabId, expression });
}

(async () => {
  try {
    const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
      OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      page = app.windows().find(win => /\/renderer\/index\.html/.test(win.url()));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession);
    assert.equal(fs.realpathSync.native(await app.evaluate(({ app }) => app.getPath('userData'))), profile);
    const [a, b] = await page.evaluate(async workspace => {
      const ids = [];
      for (const title of ['Browser tabs A', 'Browser tabs B']) {
        const session = await z.createSession(true, workspace);
        session.messages = [{ role: 'user', content: 'Local fixture, no model request.', ts: Date.now() }];
        await z.saveSession(session); await z.renameSession(session.id, title); ids.push(session.id);
      }
      await refreshSessions(); await loadSession(ids[0]); await ensureBrowserSessionState(ids[0]); return ids;
    }, appRoot);
    const userTab = await page.evaluate(async url => {
      const tab = createRightSidebarTab('browser'); activateRightSidebarTab(tab.id);
      await getBrowserTabController(tab.id).navigate(url, { waitForLoad: true }); return tab.id;
    }, `${fixture}?user`);
    const first = await command(a, 'tabs', { action: 'new', url_or_path: `${fixture}?first` });
    const second = await command(a, 'open', { new_tab: true, url_or_path: `${fixture}?second` });
    assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(second.ok, true, JSON.stringify(second));
    assert.notEqual(first.tabId, second.tabId);
    assert.equal((await command(a, 'open', { new_tab: true, tab_id: first.tabId, url_or_path: fixture })).code, 'BROWSER_CONFLICTING_TAB_TARGET');
    await guest(first.tabId, "document.querySelector('#nameInput').value = 'unsaved first'; localStorage.setItem('z-tab-test', 'shared login state'); void 0");
    assert.equal(await guest(second.tabId, "localStorage.getItem('z-tab-test')"), 'shared login state');
    const firstGuest = await page.evaluate(id => getBrowserTabController(id).webview.getWebContentsId(), first.tabId);
    await page.evaluate(id => activateRightSidebarTab(id), userTab);
    const list = await command(a, 'tabs', { action: 'list' });
    assert.deepEqual(list.tabs.map(tab => tab.tabId).sort(), [first.tabId, second.tabId].sort());
    assert.equal(list.activeTabId, second.tabId);
    assert.equal(await page.evaluate(() => activeRightSidebarTab), userTab, 'listing does not steal visible user tab');
    const snap1 = await command(a, 'snapshot', { tab_id: first.tabId });
    const snap2 = await command(a, 'snapshot', { tab_id: second.tabId });
    assert.equal(snap1.tabId, first.tabId); assert.equal(snap2.tabId, second.tabId);
    const firstRef = snap1.items.find(item => item.name.includes('Run action')).ref;
    assert.equal(snap2.items.some(item => item.ref === firstRef), false, 'references never collide across tabs');
    assert.equal((await command(a, 'click', { tab_id: second.tabId, ref: firstRef })).code, 'STALE_REF');
    assert.equal((await command(a, 'snapshot')).tabId, second.tabId, 'UI tab switches do not change agent selection');
    assert.equal((await command(a, 'tabs', { action: 'select', tab_id: first.tabId })).ok, true);
    assert.equal((await command(a, 'status')).tabId, first.tabId);
    assert.equal(await guest(first.tabId, "document.querySelector('#nameInput').value"), 'unsaved first');
    assert.equal(await page.evaluate(id => getBrowserTabController(id).webview.getWebContentsId(), first.tabId), firstGuest);
    assert.equal((await command(a, 'snapshot', { tab_id: userTab })).code, 'BROWSER_TAB_NOT_OWNED');
    assert.equal((await command(b, 'snapshot', { tab_id: first.tabId })).code, 'BROWSER_TAB_NOT_OWNED');
    assert.equal((await command(b, 'tabs', { action: 'close', tab_id: first.tabId })).code, 'BROWSER_TAB_NOT_OWNED');
    await page.evaluate(({ session, tabId, url }) => state.activeRuns.set('annotation-tabs-fixture', { runCtx: {
      runId: 'tabs-e2e-' + session, sessionId: session, browserAnnotation: { tabId, url }
    } }), { session: a, tabId: userTab, url: `${fixture}?user` });
    const annotationList = await command(a, 'tabs', { action: 'list' });
    assert.deepEqual(annotationList.tabs.map(tab => tab.tabId), [userTab]);
    for (const action of ['new', 'select', 'close']) assert.equal((await command(a, 'tabs', { action, tab_id: first.tabId, url_or_path: fixture })).code, 'BROWSER_ANNOTATION_TAB_LOCKED');
    await page.evaluate(() => state.activeRuns.delete('annotation-tabs-fixture'));
    checks.push('multiple owned tabs, explicit targets, globally unique refs, preserved input/login, user/chat isolation');

    await guest(first.tabId, `(() => {
      const section = document.createElement('section'); section.id = 'long-controls';
      for (let i=0;i<650;i++) { const button=document.createElement('button'); button.textContent='Long control '+i; button.style.display='block'; section.append(button); }
      document.body.append(section);
      const paragraph=document.createElement('p'); paragraph.textContent='Reading corpus '.repeat(2000)+'END OF CORPUS'; document.body.append(paragraph);
      return true;
    })()`);
    const long = await command(a, 'snapshot', { tab_id: first.tabId, query: 'Long control', limit: 500 });
    assert.equal(long.items.length, 500); assert.equal(long.totalMatches, 650); assert.equal(long.nextOffset, 500);
    const end = await command(a, 'snapshot', { tab_id: first.tabId, query: 'Long control', offset: 500, limit: 500 });
    assert.equal(end.items.length, 150); assert.equal(end.hasMore, false);
    const found = await command(a, 'find', { tab_id: first.tabId, role: 'button', name: 'Long control 649', exact: true });
    assert.equal(found.items.length, 1); assert.equal(found.items[0].name, 'Long control 649');
    await guest(first.tabId, "document.querySelector('#long-controls').lastElementChild.scrollIntoView(); void 0");
    const viewport = await command(a, 'snapshot', { tab_id: first.tabId, viewport_only: true });
    assert.ok(viewport.items.some(item => item.name === 'Long control 649'), 'late-page controls are discoverable');
    const read = await command(a, 'read_page', { tab_id: first.tabId, limit: 1000 });
    assert.equal(read.text.length, 1000); assert.equal(read.nextOffset, 1000); assert.ok(read.totalChars > 20000);
    const readEnd = await command(a, 'read_page', { tab_id: first.tabId, offset: read.totalChars - 13 });
    assert.equal(readEnd.hasMore, false); assert.ok(readEnd.text.includes('END OF CORPUS'));
    checks.push('650 controls, targeted semantic find, pagination, viewport prioritization, long text offsets');

    await guest(first.tabId, `(() => { const b=document.createElement('button'); b.textContent='Eventually enabled'; b.disabled=true; document.body.append(b); setTimeout(()=>b.disabled=false, 250); return true; })()`);
    const enabled = await command(a, 'wait', { tab_id: first.tabId, role: 'button', name: 'Eventually enabled', exact: true, state: 'enabled', timeout_ms: 1500 });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const missing = await command(a, 'wait', { tab_id: first.tabId, text: 'definitely absent marker', timeout_ms: 150 });
    assert.equal(missing.code, 'WAIT_TIMEOUT'); assert.ok(missing.lastObservation);
    const findAgain = await command(a, 'find', { tab_id: first.tabId, name: 'Eventually enabled', exact: true });
    const conjunction = await command(a, 'wait', { tab_id: first.tabId, ref: findAgain.items[0].ref, text: 'Wrong text', state: 'enabled', timeout_ms: 150 });
    assert.equal(conjunction.code, 'WAIT_TIMEOUT', 'ref and text are AND conditions');
    checks.push('locator waits re-evaluate enabled state, diagnostics on timeout, combined conditions');

    const cancellation = await page.evaluate(async ({ session, firstId, secondId }) => {
      const params = { z_run_id: 'tabs-e2e-' + session, z_session_id: session };
      const pending = executeBrowserAgentCommand({ action: 'wait', operationId: 'cross-tab-wait', params: { ...params, tab_id: firstId, timeout_ms: 10000 } });
      await new Promise(resolve => setTimeout(resolve, 80));
      await executeBrowserAgentCommand({ action: 'tabs', params: { ...params, action: 'select', tab_id: secondId } });
      const started = Date.now();
      await executeBrowserAgentCommand({ action: 'cancel', params: { ...params, operation_id: 'cross-tab-wait' } });
      return { result: await pending, elapsed: Date.now() - started };
    }, { session: a, firstId: first.tabId, secondId: second.tabId });
    assert.equal(cancellation.result.code, 'BROWSER_ACTION_CANCELLED'); assert.ok(cancellation.elapsed < 1000);
    const bounds = await page.evaluate(async id => {
      const controller = getBrowserTabController(id), agent = controller.agent;
      await controller.webview.executeJavaScript('window.requestAnimationFrame = () => 1; void 0');
      const started = Date.now();
      const settled = await agent.enqueueAction('hidden-settle', () => agent.waitForSettle(250));
      const settleMs = Date.now() - started;
      const stalled = agent.enqueueAction('hung-guest', () => agent.withAction(() => agent.executePage('new Promise(() => {})', { timeoutMs: 120 })));
      const followup = agent.enqueueAction('after-hung', () => agent.executePage('({ ok: true, recovered: true })'));
      const hungResult = await stalled, next = await followup;
      const originalCapture = controller.webview.capturePage;
      controller.webview.capturePage = () => new Promise(() => {});
      const screenshot = await agent.enqueueAction('hung-capture', () => agent.screenshot(), { deadlineAt: Date.now() + 200 });
      controller.webview.capturePage = originalCapture;
      return { settled, settleMs, hungResult, next, screenshot };
    }, first.tabId);
    assert.ok(bounds.settleMs < 1200, JSON.stringify(bounds));
    assert.equal(bounds.hungResult.code, 'BROWSER_PAGE_TIMEOUT'); assert.equal(bounds.hungResult.uncertain, true);
    assert.equal(bounds.next.recovered, true); assert.equal(bounds.screenshot.code, 'BROWSER_PAGE_TIMEOUT');
    const late = await page.evaluate(async id => {
      const controller = getBrowserTabController(id), agent = controller.agent;
      const blocker = controller.webview.executeJavaScript('(() => { const end=Date.now()+350; while(Date.now()<end) {} return true; })()');
      await new Promise(resolve => setTimeout(resolve, 20));
      const result = await agent.enqueueAction('late-guest', () => agent.withAction(() => agent.executePage('(() => { window.__lateMutation=true; return { ok:true }; })()', { timeoutMs: 60 })));
      await blocker;
      const mutated = await controller.webview.executeJavaScript('window.__lateMutation === true');
      return { result, mutated };
    }, first.tabId);
    assert.equal(late.result.code, 'BROWSER_PAGE_TIMEOUT'); assert.equal(late.mutated, false, 'expired script cannot start a delayed mutation');
    await command(a, 'snapshot', { tab_id: first.tabId });
    const uncertain = await page.evaluate(async ({ session, tabId }) => {
      const controller = getBrowserTabController(tabId), agent = controller.agent;
      const originalExecute = controller.webview.executeJavaScript.bind(controller.webview);
      const params = { z_run_id: 'tabs-e2e-' + session, z_session_id: session, tab_id: tabId };
      let delayed, resolveDelayed;
      controller.webview.executeJavaScript = expression => expression.includes('__lateCancelledEffect')
        ? new Promise(resolve => { delayed = expression; resolveDelayed = resolve; }) : originalExecute(expression);
      const pending = agent.enqueueAction('late-cancelled-script', () => agent.withAction(() => agent.executePage('(() => { window.__lateCancelledEffect = 1; return { ok: true }; })()')));
      while (!delayed) await new Promise(resolve => setTimeout(resolve, 5));
      const queuedWrite = executeBrowserAgentCommand({ action: 'scroll', operationId: 'queued-after-uncertain', params: { ...params, direction: 'down' } });
      await new Promise(resolve => setTimeout(resolve, 10));
      await executeBrowserAgentCommand({ action: 'cancel', params: { ...params, operation_id: 'late-cancelled-script' } });
      const cancelled = await pending, blockedWrite = await queuedWrite;
      resolveDelayed(await originalExecute(delayed));
      controller.webview.executeJavaScript = originalExecute;
      const effect = await originalExecute('window.__lateCancelledEffect');
      const status = await executeBrowserAgentCommand({ action: 'status', params });
      const stillBlocked = await executeBrowserAgentCommand({ action: 'scroll', params: { ...params, direction: 'up' } });
      const urlBeforeOpen = controller.webview.getURL();
      const blockedOpen = await executeBrowserAgentCommand({ action: 'open', params: { ...params, url_or_path: urlBeforeOpen + '#must-not-navigate' } });
      const urlAfterOpen = controller.webview.getURL();
      const observed = await executeBrowserAgentCommand({ action: 'snapshot', params });
      const resumed = await executeBrowserAgentCommand({ action: 'scroll', params: { ...params, direction: 'up' } });
      return { cancelled, blockedWrite, effect, status, stillBlocked, blockedOpen, urlBeforeOpen, urlAfterOpen, observed: observed.ok, resumed: resumed.ok };
    }, { session: a, tabId: first.tabId });
    assert.equal(uncertain.cancelled.uncertain, true); assert.equal(uncertain.effect, 1, 'already dispatched guest work cannot be promised retracted');
    assert.equal(uncertain.blockedWrite.code, 'BROWSER_OBSERVATION_REQUIRED'); assert.equal(uncertain.status.needsFreshObservation, true);
    assert.equal(uncertain.stillBlocked.code, 'BROWSER_OBSERVATION_REQUIRED'); assert.equal(uncertain.observed, true); assert.equal(uncertain.resumed, true);
    assert.equal(uncertain.blockedOpen.code, 'BROWSER_OBSERVATION_REQUIRED'); assert.equal(uncertain.urlAfterOpen, uncertain.urlBeforeOpen, 'opening the uncertain existing tab cannot bypass fresh observation');
    const navigationFailure = await page.evaluate(async ({ session, tabId }) => {
      const controller = getBrowserTabController(tabId), originalReload = controller.webview.reload;
      controller.webview.reload = () => queueMicrotask(() => {
        const event = new Event('did-fail-load'); Object.assign(event, { isMainFrame: true, errorCode: -105, errorDescription: 'fixture navigation failure' }); controller.webview.dispatchEvent(event);
      });
      try { return await executeBrowserAgentCommand({ action: 'reload', params: { z_run_id: 'tabs-e2e-' + session, z_session_id: session, tab_id: tabId } }); }
      finally { controller.webview.reload = originalReload; }
    }, { session: a, tabId: first.tabId });
    assert.equal(navigationFailure.ok, false); assert.equal(navigationFailure.code, 'BROWSER_NAVIGATION_FAILED');
    const cancelClose = await page.evaluate(async ({ session, tabId }) => {
      const controller = getBrowserTabController(tabId), originalRelease = controller.agent.releaseActions.bind(controller.agent);
      let resume;
      controller.agent.releaseActions = () => new Promise(resolve => { resume = resolve; });
      const params = { z_run_id: 'tabs-e2e-' + session, z_session_id: session, tab_id: tabId };
      const pending = executeBrowserAgentCommand({ action: 'tabs', operationId: 'cancel-close-during-release', params: { ...params, action: 'close' } });
      while (!resume) await new Promise(resolve => setTimeout(resolve, 5));
      await executeBrowserAgentCommand({ action: 'cancel', params: { ...params, operation_id: 'cancel-close-during-release' } });
      resume({ ok: true }); const result = await pending;
      controller.agent.releaseActions = originalRelease;
      return { result, retained: browserTabControllers.has(tabId) };
    }, { session: a, tabId: first.tabId });
    assert.equal(cancelClose.result.code, 'BROWSER_ACTION_CANCELLED'); assert.equal(cancelClose.retained, true);
    await command(a, 'cancel', { operation_id: 'cancel-before-tab-create' });
    assert.equal((await command(a, 'tabs', { action: 'new', url_or_path: fixture }, 'cancel-before-tab-create')).code, 'BROWSER_ACTION_CANCELLED');
    checks.push('hidden requestAnimationFrame fallback, hung guest and capture deadlines, queue recovery, cross-tab cancellation');
    const expired = await command(a, 'open', { tab_id: first.tabId, url_or_path: `${fixture}?should-not-navigate`, z_deadline_at: Date.now() - 1 });
    assert.equal(expired.code, 'BROWSER_ACTION_TIMEOUT');
    const releasedAfterSwitch = await page.evaluate(async ({ session, other, firstId, secondId }) => {
      const runId = 'tabs-e2e-' + session;
      const pending = executeBrowserAgentCommand({ action: 'wait', operationId: 'release-after-chat-switch', params: { z_run_id: runId, z_session_id: session, tab_id: firstId, timeout_ms: 10000 } });
      await new Promise(resolve => setTimeout(resolve, 30));
      await loadSession(other);
      const released = await executeBrowserAgentCommand({ action: 'release', params: { z_run_id: runId } });
      const result = await pending;
      const controlled = [firstId, secondId].map(id => getBrowserTabController(id).agentControlActive);
      await loadSession(session);
      return { released, result, controlled };
    }, { session: a, other: b, firstId: first.tabId, secondId: second.tabId });
    assert.equal(releasedAfterSwitch.released.ok, true); assert.equal(releasedAfterSwitch.result.code, 'BROWSER_ACTION_CANCELLED');
    assert.deepEqual(releasedAfterSwitch.controlled, [false, false]);
    assert.equal((await command(a, 'tabs', { action: 'close', tab_id: first.tabId })).ok, true);
    assert.equal((await command(a, 'status')).tabId, second.tabId, 'closing one tab preserves other agent tabs and lease');
    assert.equal((await command(a, 'tabs', { action: 'list' })).tabs.length, 1);
    await command(a, 'release');
    assert.equal((await command(a, 'tabs', { action: 'list' })).tabs[0].controlled, false);
    checks.push('annotation tab confinement, early/late cancellation, uncertain writes require observation, failed navigation, cancelled close, release after chat switch');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, checks }));
  } finally {
    await app?.close().catch(() => {});
    // Only remove the verified, freshly-created isolated test directory.
    if (profile.startsWith(tempRoot + path.sep) && path.basename(profile).startsWith('z-browser-tabs-e2e-')) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
