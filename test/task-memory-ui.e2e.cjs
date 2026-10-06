'use strict';

// Isolated Electron renderer/preload test. All memory IPC uses synthetic fixtures;
// the temporary profile contains no user conversations or model credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-task-memory-ui-'));
const output = path.join(appRoot, 'output', 'task-memory-ui');
const report = { ok: false, checks: [], pageErrors: [] };
let application, page;
fs.mkdirSync(output, { recursive: true });

async function snapshot() {
  return page.evaluate(() => ({ id: state.currentSession?.id, loadToken: sessionLoadToken, draft: getComposerText(),
    active: [...state.activeRuns.keys()], queued: [...state.queuedTurns.keys()] }));
}
async function openSidebar(id) {
  await page.locator(`.recent-session-list .session-item[data-id="${id}"]`).click({ button: 'right' });
  await page.locator('.sidebar-context-menu-item').filter({ hasText: '任务记忆' }).click();
  await page.locator('#taskMemoryDialog').waitFor({ state: 'visible' });
}
async function openTop() {
  await page.locator('#taskBarMoreBtn').click();
  await page.locator('[data-task-action="task-memory"]').click();
  await page.locator('#taskMemoryDialog').waitFor({ state: 'visible' });
}
async function loaded() {
  await page.waitForFunction(() => document.querySelector('#taskMemorySections')?.getAttribute('aria-busy') === 'false');
}
async function close() {
  await page.locator('#taskMemoryClose').click();
  await page.locator('#taskMemoryDialog').waitFor({ state: 'hidden' });
}
const card = id => page.locator(`.task-memory-card[data-memory-id="${id}"]:not([data-memory-usage])`);

(async () => {
  try {
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
    const [a, b] = await page.evaluate(async () => {
      const sessions = [];
      for (const title of ['Memory task A', 'Memory task B']) {
        const session = await z.createSession(true);
        session.title = title; session.messages = [{ role: 'user', content: title + ' synthetic history', ts: Date.now() }];
        await z.saveSession(session); await z.renameSession(session.id, title); sessions.push(await z.getSession(session.id));
      }
      await refreshSessions(); await loadSession(sessions[0].id);
      setComposerText('TASK_MEMORY_UNSENT_DRAFT'); captureComposerDraftForSession();
      return sessions;
    });
    await application.evaluate(({ ipcMain }, { a, b, profile }) => {
      const source = { sessionId: b.id, runId: 'run_fixture', conversationRevision: 3 };
      const progress = { id: 'progress_b', scope: 'task', type: 'work_state', status: 'active', content: 'B progress: preserve the task boundary.', source, sourceTitle: b.title, evidence: 'Synthetic tool result', updatedAt: Date.now() };
      globalThis.taskMemoryFixture = {
        calls: [], items: { [a.id]: [{ id: 'progress_a', scope: 'task', type: 'work_state', status: 'active', content: 'A progress only', source: { sessionId: a.id }, sourceTitle: a.title }],
          [b.id]: [progress, { id: 'shared_b', scope: 'workspace', type: 'decision', status: 'active', content: 'Needle reusable knowledge <img src=x onerror="window.memoryInjected=true">', source, sourceTitle: b.title },
            { id: 'machine_b', scope: 'machine', type: 'environment', status: 'disabled', content: 'Device fixture', source },
            { id: 'global_b', scope: 'global', type: 'preference', status: 'active', content: 'Global fixture', source }] },
        usage: { [b.id]: { items: [JSON.parse(JSON.stringify(progress))], runId: 'run_fixture' } }, holdQuery: null, holdSession: null
      };
      for (const name of ['memory:task-list', 'memory:task-update', 'memory:task-delete']) ipcMain.removeHandler(name);
      ipcMain.handle('memory:task-list', async (_event, request) => {
        const f = globalThis.taskMemoryFixture; f.calls.push({ action: 'list', ...request });
        const query = String(request.query || '').toLowerCase();
        const result = { ok: true, sessionId: request.sessionId, conversationRevision: 3,
          items: (f.items[request.sessionId] || []).filter(item => item.status !== 'deleted' && (!query || item.content.toLowerCase().includes(query))),
          usage: f.usage[request.sessionId] || { items: [] }, storage: { path: profile + '/ZData/memory.sqlite' } };
        const copy = JSON.parse(JSON.stringify(result));
        if (f.holdQuery === query || f.holdSession === request.sessionId) {
          f.holdQuery = null; f.holdSession = null;
          await new Promise(resolve => { f.release = resolve; });
        }
        return copy;
      });
      ipcMain.handle('memory:task-update', (_event, request) => {
        const f = globalThis.taskMemoryFixture; f.calls.push({ action: 'update', ...request });
        const item = (f.items[request.sessionId] || []).find(item => item.id === request.id);
        if (!item || request.conversationRevision !== 3) return { ok: false, error: 'Wrong task or stale revision' };
        for (const key of ['content', 'status']) if (key in request) item[key] = request[key];
        return { ok: true };
      });
      ipcMain.handle('memory:task-delete', (_event, request) => {
        const f = globalThis.taskMemoryFixture; f.calls.push({ action: 'delete', ...request });
        const item = (f.items[request.sessionId] || []).find(item => item.id === request.id);
        if (!item || request.conversationRevision !== 3) return { ok: false, error: 'Wrong task or stale revision' };
        item.status = 'deleted'; return { ok: true };
      });
    }, { a, b, profile });

    const before = await snapshot();
    await openSidebar(b.id); await loaded();
    assert.equal(await page.locator('#taskMemoryTaskName').innerText(), b.title);
    assert.equal(await card('progress_b').count(), 1);
    assert.equal(await card('progress_a').count(), 0);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await page.locator('.task-memory-card[data-memory-usage] [data-memory-action="edit"]').count(), 0);
    assert.equal(await page.locator('#taskMemoryDialog img').count(), 0);
    assert.equal(await page.evaluate(() => window.memoryInjected), undefined);
    report.checks.push('Background task B shows its task/shared memory and immutable usage snapshot while task A and its draft stay unchanged; memory HTML stays plain text');

    await card('progress_b').locator('[data-memory-action="edit"]').click();
    await card('progress_b').locator('textarea').fill('');
    await card('progress_b').locator('[data-memory-action="save"]').click();
    assert.match(await page.locator('#taskMemoryStatus').innerText(), /不能为空/);
    assert.equal(await application.evaluate(() => globalThis.taskMemoryFixture.calls.filter(call => call.action === 'update').length), 0);
    await card('progress_b').locator('textarea').fill('B updated progress');
    await card('progress_b').locator('[data-memory-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('.task-memory-card[data-memory-id="progress_b"]:not([data-memory-usage]) .task-memory-content')?.textContent === 'B updated progress');
    await card('machine_b').locator('[data-memory-action="toggle"]').click();
    await page.waitForFunction(() => document.querySelector('.task-memory-card[data-memory-id="machine_b"] .task-memory-state')?.textContent === '使用中');
    await card('machine_b').locator('[data-memory-action="toggle"]').click();
    await page.waitForFunction(() => document.querySelector('.task-memory-card[data-memory-id="machine_b"] .task-memory-state')?.textContent === '已停用');
    await card('global_b').locator('[data-memory-action="delete"]').click();
    assert.equal(await application.evaluate(() => globalThis.taskMemoryFixture.calls.filter(call => call.action === 'delete').length), 0);
    await card('global_b').locator('[data-memory-action="cancel-delete"]').click();
    assert.equal(await card('global_b').count(), 1);
    await card('global_b').locator('[data-memory-action="delete"]').click();
    await card('global_b').locator('[data-memory-action="confirm-delete"]').click();
    await card('global_b').waitFor({ state: 'detached' });
    const writes = await application.evaluate(() => globalThis.taskMemoryFixture.calls.filter(call => call.action !== 'list'));
    assert.deepEqual(writes.map(call => [call.action, call.sessionId, call.conversationRevision, call.status || call.content || '']), [
      ['update', b.id, 3, 'B updated progress'], ['update', b.id, 3, 'active'], ['update', b.id, 3, 'disabled'], ['delete', b.id, 3, '']
    ]);
    assert.deepEqual(await snapshot(), before);
    report.checks.push('Edit, enable, disable and confirmed deletion carry B and its revision; empty edits and unconfirmed deletion never mutate; A is untouched');

    await application.evaluate(() => { globalThis.taskMemoryFixture.holdQuery = 'old'; });
    await page.locator('#taskMemorySearch').fill('old');
    await page.waitForTimeout(250);
    await page.locator('#taskMemorySearch').fill('needle');
    await page.waitForFunction(() => document.querySelectorAll('.task-memory-card:not([data-memory-usage])').length === 1 && document.querySelector('.task-memory-card:not([data-memory-usage])')?.dataset.memoryId === 'shared_b');
    await application.evaluate(() => { globalThis.taskMemoryFixture.release(); delete globalThis.taskMemoryFixture.release; });
    await page.waitForTimeout(100);
    assert.equal(await card('shared_b').count(), 1);
    assert.equal(await card('progress_b').count(), 0);
    await close();
    await application.evaluate((_electron, id) => { globalThis.taskMemoryFixture.holdSession = id; }, b.id);
    await openSidebar(b.id);
    await close();
    await openTop(); await loaded();
    assert.equal(await card('progress_a').count(), 1);
    await application.evaluate(() => { globalThis.taskMemoryFixture.release(); delete globalThis.taskMemoryFixture.release; });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#taskMemoryDialog').getAttribute('data-session-id'), a.id);
    assert.equal(await card('progress_a').count(), 1);
    assert.equal(await card('progress_b').count(), 0);
    await page.keyboard.press('Escape');
    await page.locator('#taskMemoryDialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await snapshot(), before);
    report.checks.push('Later search results win over older replies; closing B and opening A discards late B results; Escape dismisses without switching tasks');

    await openSidebar(b.id); await loaded();
    await card('progress_b').locator('summary').click();
    assert.match(await card('progress_b').innerText(), /run_fixture/);
    await page.screenshot({ path: path.join(output, 'task-memory-desktop.png') });
    await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(item => /\/renderer\/index\.html/.test(item.webContents.getURL()));
      win.unmaximize(); win.setMinimumSize(360, 300); win.setBounds({ width: 540, height: 600 });
    });
    await page.waitForFunction(() => window.innerWidth <= 560);
    const layout = await page.locator('#taskMemoryDialog').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight, scroll: dialog.scrollWidth, client: dialog.clientWidth };
    });
    assert.ok(layout.left >= 0 && layout.top >= 0 && layout.right <= layout.width && layout.bottom <= layout.height && layout.scroll <= layout.client, JSON.stringify(layout));
    await page.screenshot({ path: path.join(output, 'task-memory-narrow.png') });
    await card('progress_b').locator('[data-memory-action="source"]').click();
    await page.waitForFunction(id => state.currentSession?.id === id, b.id);
    assert.equal(await page.locator('#taskMemoryDialog').count(), 0);
    report.checks.push('Details show evidence and provenance; narrow dialog fits without horizontal overflow; only explicit Open source navigates to task B');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await application?.close().catch(() => {});
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-task-memory-ui-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
