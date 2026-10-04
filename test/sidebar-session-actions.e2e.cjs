'use strict';

// Real Electron renderer + session IPC in a disposable profile. No model runs
// or user profile access are needed to exercise sidebar naming/navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-sidebar-session-actions-'));
const outputDir = path.join(appRoot, 'output', 'sidebar-session-actions');
const workspaces = ['project-alpha', 'project-beta', 'project-gamma'].map(name => path.join(profile, name));
const draftMarker = 'SIDEBAR_DRAFT_KEEP_5389';
const report = { ok: false, checks: [], pageErrors: [], consoleErrors: [] };
let application;
let page;
let sessions;
fs.mkdirSync(outputDir, { recursive: true });
workspaces.forEach(workspace => fs.mkdirSync(workspace, { recursive: true }));

async function launch() {
  const env = { ...process.env, YAN_E2E_MODE: '1', YAN_E2E_USER_DATA_DIR: profile,
    YAN_E2E_PARENT_PID: String(process.pid), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    page = application.windows().find(window => /\/renderer\/index\.html/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'the real app renderer is available');
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) report.consoleErrors.push(message.text());
  });
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), profile);
}

async function close() {
  await application?.close();
  application = null;
  page = null;
}

async function switchTo(id) {
  await page.evaluate(id => loadSession(id), id);
  await page.waitForFunction(id => state.currentSession?.id === id && !observerPendingSessionId, id);
}

async function readSession(id) { return page.evaluate(id => yan.getSession(id), id); }

async function preservedUi() {
  return page.evaluate(() => ({ id: state.currentSession?.id, workspace: state.currentSession?.workspace,
    modelSelection: state.currentSession?.modelSelection, loadToken: sessionLoadToken, draft: getComposerText(),
    draftRecord: state.composerDrafts.get(state.currentSession?.id), messages: state.currentSession?.messages,
    activeRuns: [...state.activeRuns.keys()], queuedTurns: [...state.queuedTurns.keys()] }));
}

async function recentIds() {
  return page.locator('.recent-session-list .session-item').evaluateAll(rows => rows.map(row => row.dataset.id));
}

async function expectedRecent(limit = 10) {
  return page.evaluate(limit => state.sessions.filter(session => session.pinned || !workspaceSidebarMeta[workspaceGroupKey(session)]?.hidden)
    .slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)).slice(0, limit).map(session => session.id), limit);
}

async function openRowMenu(id, section = '.recent-session-list', via = 'right') {
  const row = page.locator(`${section} .session-item[data-id="${id}"]`);
  if (via === 'more') await row.locator('[data-session-menu-toggle]').click();
  else await row.click({ button: 'right' });
  await page.locator('.sidebar-context-menu').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.sidebar-context-menu-item').first().innerText(), '重命名');
  assert.match(await page.locator('.sidebar-context-menu').innerText(), /(?:取消置顶|置顶)任务/);
  assert.match(await page.locator('.sidebar-context-menu').innerText(), /移除任务/);
}

async function openRename(id, section = '.recent-session-list', via = 'right') {
  await openRowMenu(id, section, via);
  await page.locator('.sidebar-context-menu-item').first().click();
  await page.locator('#renameTaskModal').waitFor({ state: 'visible' });
}

async function saveRename(id, title) {
  await page.locator('#renameTaskInput').fill(title);
  await page.locator('#renameTaskConfirm').click();
  await page.locator('#renameTaskModal').waitFor({ state: 'hidden' });
  await page.waitForFunction(({ id, title }) => state.sessions.find(session => session.id === id)?.title === title, { id, title });
  assert.equal((await readSession(id)).title, title);
}

(async () => {
  try {
    await launch();
    sessions = await page.evaluate(async workspaces => {
      const initialId = state.currentSession.id;
      const results = [];
      for (let index = 0; index < 13; index++) {
        const session = await yan.createSession(true, workspaces[index % workspaces.length]);
        session.messages = [{ role: 'user', content: `Sidebar saved prompt ${index}`, ts: 1_800_000_000_000 + index },
          { role: 'assistant', content: `Sidebar saved answer ${index}`, ts: 1_800_000_001_000 + index }];
        const saved = await yan.saveSession(session);
        if (saved.ok === false) throw new Error(saved.error);
        await yan.renameSession(session.id, `Sidebar fixture ${String(index).padStart(2, '0')}`);
        if (index === 5) await yan.setSessionPinned(session.id, true);
        results.push(await yan.getSession(session.id));
      }
      const removed = await yan.deleteSession(initialId, true);
      if (removed.ok === false) throw new Error(removed.error);
      await refreshSessions();
      return results;
    }, workspaces);
    await switchTo(sessions[0].id);
    await page.evaluate(marker => { setComposerText(marker); captureComposerDraftForSession(); }, draftMarker);
    const uiBefore = await preservedUi();
    assert.equal(uiBefore.draft, draftMarker);
    assert.equal(await page.locator('.recent-section').count(), 1);
    assert.equal(await page.locator('#recentSessionList').isVisible(), true, 'recent starts expanded');
    assert.deepEqual(await recentIds(), await expectedRecent());
    assert.equal((await recentIds()).length, 10);
    assert.ok((await recentIds()).includes(sessions[5].id), 'pinned tasks are also in Recent');
    assert.equal(await page.locator('.pinned-session-list .session-item').count(), 1);
    assert.equal(await page.locator('.projects-section .workspace-group').count(), 3);
    report.checks.push('Recent starts expanded with the newest 10 conversations across three workspaces, including pinned tasks; existing sections remain');

    const target = sessions[10];
    const stale = await readSession(target.id);
    await openRename(target.id);
    assert.deepEqual(await preservedUi(), uiBefore, 'right-clicking a background task does not navigate or clear the composer');
    assert.equal(await page.locator('#renameTaskInput').inputValue(), target.title);
    await page.locator('#renameTaskInput').fill('Cancelled sidebar rename');
    await page.locator('#renameTaskCancel').click();
    assert.equal((await readSession(target.id)).title, target.title);
    assert.deepEqual(await preservedUi(), uiBefore);
    report.checks.push('Right-click opens Rename for an unopened task without changing the current conversation, workspace, model, history or draft; Cancel writes nothing');

    await openRename(target.id);
    const title = '侧栏 <测试> & "同一对话"';
    await saveRename(target.id, title);
    assert.deepEqual(await preservedUi(), uiBefore, 'background rename preserves all current conversation state');
    const duplicateTitles = await page.locator(`.session-item[data-id="${target.id}"] .session-title-text`).allTextContents();
    assert.deepEqual(duplicateTitles, [title, title], 'Recent and Projects show the same newly persisted title');
    assert.equal((await recentIds())[0], target.id, 'renamed task receives its updated timestamp');
    assert.deepEqual(await recentIds(), await expectedRecent());
    report.checks.push('Confirmed background rename persists and synchronizes Recent and Projects immediately; special characters remain plain text');

    stale.messages.push({ role: 'assistant', content: 'Continuation saved from a pre-rename session snapshot', ts: Date.now() });
    const staleSave = await page.evaluate(session => yan.saveSession(session), stale);
    assert.notEqual(staleSave.ok, false, 'the ordinary continuation still persists');
    const afterStaleSave = await readSession(target.id);
    assert.equal(afterStaleSave.title, title, 'an in-flight pre-rename save cannot restore the old title');
    assert.equal(afterStaleSave.messages.at(-1).content, stale.messages.at(-1).content);
    await page.evaluate(() => refreshSessions());
    assert.deepEqual(await preservedUi(), uiBefore);
    report.checks.push('A real IPC save from a pre-rename session snapshot keeps the user title while retaining newly saved conversation content');

    await openRename(target.id, '.projects-section', 'more');
    assert.equal(await page.locator('#renameTaskInput').inputValue(), title);
    await page.locator('#renameTaskInput').fill('   ');
    await page.locator('#renameTaskConfirm').click();
    assert.equal(await page.locator('#renameTaskModal').isVisible(), true);
    assert.equal((await readSession(target.id)).title, title);
    await page.locator('#renameTaskCancel').click();
    assert.deepEqual(await preservedUi(), uiBefore);
    report.checks.push('The existing ellipsis menu also renames unopened tasks; blank titles leave the dialog open without changing the saved name');

    await openRename(sessions[5].id, '.pinned-session-list');
    await saveRename(sessions[5].id, 'Pinned sidebar fixture renamed');
    assert.equal((await readSession(sessions[5].id)).pinned, true);
    assert.equal(await page.locator(`.session-item[data-id="${sessions[5].id}"] .session-title-text`).count(), 2);
    assert.deepEqual(await preservedUi(), uiBefore);
    report.checks.push('Pinned conversations support the same direct rename and stay pinned, with Recent updated too');

    await page.locator('[data-recent-action="more"]').click();
    assert.equal((await recentIds()).length, 13);
    assert.deepEqual(await recentIds(), await expectedRecent(20));
    assert.equal(await page.locator('[data-recent-action="more"]').count(), 0);
    assert.deepEqual(await preservedUi(), uiBefore);
    report.checks.push('Show more reveals the remaining conversations in activity order without switching the active task');

    // Use the actual native window bounds so the menu must fit a compact view.
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => /\/renderer\/index\.html/.test(window.webContents.getURL()));
      window.unmaximize(); window.setBounds({ width: 960, height: 700 });
    });
    await page.waitForFunction(() => window.innerHeight < 750);
    for (const point of ['bottom-right', 'top-left']) {
      await page.locator(`.recent-session-list .session-item[data-id="${target.id}"]`).evaluate((row, point) => {
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2,
          clientX: point === 'bottom-right' ? window.innerWidth - 2 : 1,
          clientY: point === 'bottom-right' ? window.innerHeight - 2 : 1 }));
      }, point);
      await page.locator('.sidebar-context-menu').waitFor({ state: 'visible' });
      const bounds = await page.locator('.sidebar-context-menu').evaluate(menu => {
        const rect = menu.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
      });
      assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height,
        `${point} menu stays within the viewport: ${JSON.stringify(bounds)}`);
      await page.keyboard.press('Escape');
      await page.locator('.sidebar-context-menu').waitFor({ state: 'hidden' });
    }
    assert.deepEqual(await preservedUi(), uiBefore);
    report.checks.push('The context menu stays inside a compact viewport at either corner and Escape dismisses it');

    await page.locator(`.recent-session-list .session-item[data-id="${target.id}"] .session-title-text`).click();
    await page.waitForFunction(id => state.currentSession?.id === id && !observerPendingSessionId, target.id);
    assert.equal((await preservedUi()).workspace, target.workspace);
    assert.equal(await page.evaluate(id => state.composerDrafts.get(id)?.text, sessions[0].id), draftMarker);
    await page.locator(`.recent-session-list .session-item[data-id="${sessions[0].id}"] .session-title-text`).click();
    await page.waitForFunction(id => state.currentSession?.id === id && !observerPendingSessionId, sessions[0].id);
    assert.equal((await preservedUi()).draft, draftMarker);
    report.checks.push('Clicking a Recent entry opens that conversation and its workspace; returning restores the previous draft');

    const beforeCurrentRename = await preservedUi();
    const currentRow = page.locator(`.recent-session-list .session-item[data-id="${sessions[0].id}"]`);
    await currentRow.focus();
    await currentRow.press('Shift+F10');
    await page.locator('.sidebar-context-menu').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('.sidebar-context-menu-item'));
    await page.keyboard.press('End');
    assert.match(await page.evaluate(() => document.activeElement?.textContent), /移除任务/);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement?.textContent), /置顶任务/);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.locator('#renameTaskModal').waitFor({ state: 'visible' });
    await saveRename(sessions[0].id, '当前会话已从侧栏重命名');
    assert.deepEqual(await preservedUi(), beforeCurrentRename);
    assert.equal(await page.locator('#taskBarTitle').textContent(), '当前会话已从侧栏重命名');
    report.checks.push('Keyboard context-menu navigation also renames the current task, updates its title bar, and preserves its draft and loaded history');

    await page.locator('[data-project-view-action="toggle"]').click();
    assert.equal(await page.locator('.projects-section .workspace-group:not(.is-collapsed)').count(), 0);
    assert.equal(await page.locator('#recentSessionList').isVisible(), true);
    assert.deepEqual(await recentIds(), await expectedRecent(20));
    report.checks.push('Collapsing project groups leaves the independent Recent list available');

    await page.locator('[data-recent-action="toggle"]').click();
    assert.equal(await page.locator('#recentSessionList').isVisible(), false);
    assert.equal(await page.locator('.projects-section').isVisible(), true);
    await page.screenshot({ path: path.join(outputDir, 'recent-collapsed.png') });
    await close();
    await launch();
    assert.equal(await page.locator('#recentSessionList').isVisible(), false, 'Recent collapse preference survives application restart');
    await page.locator('[data-recent-action="toggle"]').click();
    assert.equal(await page.locator('#recentSessionList').isVisible(), true);
    assert.deepEqual(await recentIds(), await expectedRecent());
    assert.equal((await readSession(target.id)).title, title);
    assert.equal((await readSession(sessions[5].id)).title, 'Pinned sidebar fixture renamed');
    await page.screenshot({ path: path.join(outputDir, 'recent-expanded.png') });
    report.checks.push('Recent collapse preference and both renamed titles survive a complete app restart');

    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks, modelRequests: 0 }));
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) {
      report.ui = await preservedUi().catch(() => null);
      report.sidebar = await page.locator('#sessionList').innerText().catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await close().catch(() => {});
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-sidebar-session-actions-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
