'use strict';

// Real Electron and session IPC, disposable profile, no model requests.
// Clipboard and Explorer actions are captured without touching the desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-session-storage-location-'));
const output = path.join(appRoot, 'output', 'session-storage-location');
const report = { ok: false, checks: [], pageErrors: [] };
let application, page;
fs.mkdirSync(output, { recursive: true });

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    page = application.windows().find(window => /\/renderer\/index\.html/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page);
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), profile);
  await application.evaluate(({ shell }) => {
    globalThis.storageLocationShellCalls = [];
    shell.showItemInFolder = target => { globalThis.storageLocationShellCalls.push({ method: 'showItemInFolder', target }); };
    shell.openPath = async target => { globalThis.storageLocationShellCalls.push({ method: 'openPath', target }); return ''; };
  });
  await page.evaluate(() => {
    window.storageLocationCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.storageLocationCopies.push(String(text)); }
    } });
  });
}

async function uiSnapshot() {
  return page.evaluate(() => ({ id: state.currentSession?.id, workspace: state.currentSession?.workspace,
    messages: state.currentSession?.messages, model: state.currentSession?.modelSelection, loadToken: sessionLoadToken,
    draft: getComposerText(), active: [...state.activeRuns.keys()], queued: [...state.queuedTurns.keys()] }));
}
async function shownPath() {
  return page.locator('#sessionStoragePath').evaluate(element => String(element.value ?? element.textContent ?? '').trim());
}
async function openSidebar(id, via = 'right') {
  const row = page.locator(`.recent-session-list .session-item[data-id="${id}"]`);
  if (via === 'more') await row.locator('[data-session-menu-toggle]').click();
  else await row.click({ button: 'right' });
  await page.locator('.sidebar-context-menu').waitFor({ state: 'visible' });
  await page.locator('.sidebar-context-menu-item').filter({ hasText: '对话存储位置' }).click();
  await page.locator('#sessionStorageDialog').waitFor({ state: 'visible' });
}
async function openTop() {
  await page.locator('#taskBarMoreBtn').click();
  await page.locator('[data-task-action="storage-location"]').click();
  await page.locator('#sessionStorageDialog').waitFor({ state: 'visible' });
}
async function expectDialogPath(expected) {
  await page.waitForFunction(expected => {
    const element = document.querySelector('#sessionStoragePath');
    return String(element?.value ?? element?.textContent ?? '').trim() === expected;
  }, expected);
  assert.equal(await shownPath(), expected);
  assert.equal(await page.locator('#sessionStorageDialog').evaluate(dialog => dialog.tagName === 'DIALOG' && dialog.open), true);
}

(async () => {
  try {
    await launch();
    const [a, b] = await page.evaluate(async () => {
      const sessions = [];
      for (const name of ['Storage location A', 'Storage location B']) {
        const session = await z.createSession(true);
        session.title = name;
        session.messages = [{ role: 'user', content: `${name} fixture history`, ts: Date.now() }];
        await z.saveSession(session);
        sessions.push(await z.getSession(session.id));
      }
      await refreshSessions();
      await loadSession(sessions[0].id);
      setComposerText('STORAGE_LOCATION_UNSENT_DRAFT_5186'); captureComposerDraftForSession();
      return sessions;
    });
    const pathA = path.join(profile, 'ZData', 'sessions', `${a.id}.json`);
    const pathB = path.join(profile, 'ZData', 'sessions', `${b.id}.json`);
    for (const [id, file] of [[a.id, pathA], [b.id, pathB]]) {
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).id, id, 'expected path is the actual persisted session JSON');
    }
    const beforeFiles = [pathA, pathB].map(file => fs.readFileSync(file, 'utf8'));
    const beforeUi = await uiSnapshot();

    await openSidebar(b.id);
    await expectDialogPath(pathB);
    assert.deepEqual(await uiSnapshot(), beforeUi, 'opening B storage from A does not navigate or change the draft');
    const backend = await page.evaluate(id => z.getSessionStorageLocation(id), b.id);
    assert.deepEqual(backend, { ok: true, id: b.id, path: pathB, directory: path.dirname(pathB), fileName: path.basename(pathB) });
    await page.locator('#sessionStorageCopy').click();
    await page.waitForFunction(expected => window.storageLocationCopies.at(-1) === expected, pathB);
    await page.locator('#sessionStorageReveal').click();
    const revealDeadline = Date.now() + 5000;
    let calls;
    do {
      calls = await application.evaluate(() => globalThis.storageLocationShellCalls);
      if (calls.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < revealDeadline);
    assert.deepEqual(calls, [{ method: 'showItemInFolder', target: pathB }], 'backend reveals the requested JSON, not its workspace or current task');
    assert.deepEqual(await uiSnapshot(), beforeUi);
    await page.screenshot({ path: path.join(output, 'background-session.png') });
    await page.locator('#sessionStorageClose').click();
    await page.locator('#sessionStorageDialog').waitFor({ state: 'hidden' });
    report.checks.push('B right-click shows its real JSON while A stays current; Copy and Explorer receive the exact B path without touching desktop services');

    await openSidebar(b.id, 'more');
    await expectDialogPath(pathB);
    await page.keyboard.press('Escape');
    await page.locator('#sessionStorageDialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await uiSnapshot(), beforeUi);
    await openTop();
    await expectDialogPath(pathA);
    await page.locator('#sessionStorageCopy').click();
    await page.waitForFunction(expected => window.storageLocationCopies.at(-1) === expected, pathA);
    await page.locator('#sessionStorageClose').click();
    await page.locator('#sessionStorageDialog').waitFor({ state: 'hidden' });
    report.checks.push('sidebar ellipsis targets B, the top menu targets A, and Close/Escape dismiss the native dialog without switching tasks');

    await application.evaluate(({ ipcMain }, delayedId) => {
      const original = ipcMain._invokeHandlers.get('session:storage-location');
      let delayNext = true;
      ipcMain.removeHandler('session:storage-location');
      ipcMain.handle('session:storage-location', async (event, id) => {
        const location = await original(event, id);
        if (id === delayedId && delayNext) {
          delayNext = false;
          await new Promise(resolve => { globalThis.storageLocationHeldResponse = resolve; });
        }
        return location;
      });
    }, b.id);
    await openSidebar(b.id);
    assert.equal(await page.locator('#sessionStorageCopy').isDisabled(), true);
    assert.equal(await page.locator('#sessionStorageReveal').isDisabled(), true);
    const heldDeadline = Date.now() + 5000;
    while (!await application.evaluate(() => typeof globalThis.storageLocationHeldResponse === 'function')) {
      assert.ok(Date.now() < heldDeadline, 'the original B storage reply is held');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await page.locator('#sessionStorageClose').click();
    await page.locator('#sessionStorageDialog').waitFor({ state: 'hidden' });
    await openTop();
    await expectDialogPath(pathA);
    await application.evaluate(() => { globalThis.storageLocationHeldResponse(); delete globalThis.storageLocationHeldResponse; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#sessionStorageDialog').count(), 1);
    assert.equal(await shownPath(), pathA, 'the closed B dialog response cannot replace the new A path');
    assert.equal(await page.locator('#sessionStorageDialog').getAttribute('data-session-id'), a.id);
    await page.keyboard.press('Escape');
    await page.locator('#sessionStorageDialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await uiSnapshot(), beforeUi);
    report.checks.push('a delayed real B path reply is discarded after closing its dialog and opening A; it neither reopens B nor overwrites A');

    // Open at the normal desktop width, then resize the dialog. The existing
    // compact layout intentionally hides the top task toolbar below 650px.
    await openTop();
    await expectDialogPath(pathA);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => /\/renderer\/index\.html/.test(window.webContents.getURL()));
      window.unmaximize(); window.setMinimumSize(360, 300); window.setBounds({ width: 560, height: 440 });
    });
    await page.waitForFunction(() => window.innerWidth < 650);
    await expectDialogPath(pathA);
    const layout = await page.locator('#sessionStorageDialog').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      const field = document.querySelector('#sessionStoragePath');
      let selected;
      if (typeof field.select === 'function') {
        field.select(); selected = field.value.slice(field.selectionStart, field.selectionEnd);
      } else {
        const range = document.createRange(); range.selectNodeContents(field);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); selected = selection.toString();
      }
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight, selected,
        textOverflow: getComputedStyle(field).textOverflow, pathWidth: field.getBoundingClientRect().width };
    });
    assert.ok(layout.left >= 0 && layout.top >= 0 && layout.right <= layout.viewportWidth && layout.bottom <= layout.viewportHeight,
      `narrow dialog fits viewport: ${JSON.stringify(layout)}`);
    assert.equal(layout.selected.trim(), pathA, 'the complete long path remains selectable at a narrow width');
    assert.notEqual(layout.textOverflow, 'ellipsis');
    assert.ok(layout.pathWidth <= layout.viewportWidth);
    await page.locator('#sessionStorageCopy').click();
    assert.equal(await page.evaluate(() => window.storageLocationCopies.at(-1)), pathA);
    await page.screenshot({ path: path.join(output, 'narrow-dialog.png') });
    await page.keyboard.press('Escape');
    await page.locator('#sessionStorageDialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await uiSnapshot(), beforeUi);
    assert.deepEqual([pathA, pathB].map(file => fs.readFileSync(file, 'utf8')), beforeFiles, 'viewing storage writes neither session file');
    assert.deepEqual(report.pageErrors, []);
    report.checks.push('a 560px window keeps the complete path selectable and copyable; viewing storage leaves both JSON files and current-task state unchanged');
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks }));
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ current: state.currentSession?.id,
        dialog: document.querySelector('#sessionStorageDialog')?.outerHTML,
        topMenu: document.querySelector('#taskActionsMenu')?.outerHTML })).catch(() => null);
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await application?.close().catch(() => {});
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-session-storage-location-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
