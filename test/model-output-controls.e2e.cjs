'use strict';

// Isolated UI / preload / IPC validation. No agent run or model completion is submitted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const tempRoot = fs.realpathSync.native(os.tmpdir());
const profile = fs.mkdtempSync(path.join(tempRoot, 'z-output-controls-e2e-'));
const output = path.join(appRoot, 'output', 'model-output-controls-e2e');
const modelId = 'claude-opus-4-7';
const contextSettings = { maxTokens: 1000000, compactionThreshold: 800000 };
const report = { ok: false, isolation: 'temporary Electron profile; local fixture connection; no model requests',
  checks: [], screenshots: [], requests: [], pageErrors: [] };
fs.mkdirSync(output, { recursive: true });
let application, page;
const server = http.createServer((request, response) => {
  report.requests.push({ method: request.method, path: request.url });
  response.writeHead(request.method === 'GET' ? 200 : 400, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: modelId, object: 'model' }] }
    : { error: { message: 'This UI test does not permit model completion requests.' } }));
});

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile,
    Z_E2E_PARENT_PID: String(process.pid), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  application.on('window', window => window.on('pageerror', error => report.pageErrors.push(error.message)));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    page = application.windows().find(window => /\/renderer\/index\.html/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'isolated main window exists');
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && state.currentSession && window.ZModelOutputLimits && window.ZConnectionControls);
  const actualProfile = await application.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(fs.realpathSync.native(actualProfile), fs.realpathSync.native(profile));
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getAppPath())), appRoot);
}

async function openMenu(sessionId) {
  await page.evaluate(id => loadSession(id), sessionId);
  assert.equal(await page.evaluate(() => state.currentSession?.id), sessionId, 'target conversation loaded');
  await page.locator('#modelPill').click();
  await page.waitForFunction(() => !document.querySelector('#modelQuickMenu').classList.contains('hidden')
    && document.querySelector('#modelQuickMenu').getAttribute('aria-busy') === 'false');
}
async function closeMenu() { await page.keyboard.press('Escape'); }
async function openObserver() {
  await page.locator('#zObserverPill').click();
  await page.waitForFunction(() => document.querySelector('#zConnectionDialog').open
    && !document.querySelector('#zConnectionSelect').disabled);
}
async function snapshot(name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled' });
  report.screenshots.push(file);
}
async function sessionCap(id) {
  return page.evaluate(id => z.getSession(id).then(session => Number(session.modelSelection?.maxOutputTokens) || 0), id);
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await launch();
    const setup = await page.evaluate(async ({ port, modelId, contextSettings }) => {
      await z.setConfig({ context: contextSettings });
      const saved = await z.connectionsSave({ name: 'Output test', preset: 'anthropic', apiFormat: 'anthropic',
        manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'isolated-local-fixture' });
      if (!saved.ok) throw new Error(saved.error || 'Fixture connection failed');
      state.config = await z.getConfig();
      const sessions = [];
      for (const title of ['输出额度 A', '输出额度 B']) {
        const session = await z.createSession(true);
        session.title = title;
        session.messages = [{ role: 'user', content: `${title}：用于验证会话设置，不执行模型。`, ts: Date.now() }];
        await z.saveSession(session);
        await z.renameSession(session.id, title);
        const selected = await z.setSessionModel(session.id, {
          providerId: saved.connection.providerId, supplierId: saved.connection.supplierId,
          modelId, name: modelId, modelType: 'text', maxOutputTokens: 0
        });
        if (!selected.ok) throw new Error(selected.error || 'Fixture model selection failed');
        sessions.push(session.id);
      }
      await refreshSessions();
      renderSessionList();
      applyTheme('dark');
      applyLanguage('zh-CN');
      return { connection: saved.connection, sessions };
    }, { port: server.address().port, modelId, contextSettings });
    const [a, b] = setup.sessions;

    await openMenu(a);
    assert.equal(await page.locator('#chatScrollResumeHost').evaluate(element => getComputedStyle(element).visibility), 'hidden');
    assert.equal(await page.locator('#modelQuickOutputTokens').inputValue(), '');
    assert.match(await page.locator('#modelQuickOutputSummary').innerText(), /自动.*128,000.*官方资料/);
    await snapshot('01-main-auto');
    await page.locator('#modelQuickOutputTokens').fill('48000');
    await page.locator('#modelQuickOutputSave').click();
    await page.waitForFunction(() => !modelPickerSaving && state.currentSession.modelSelection.maxOutputTokens === 48000);
    assert.equal(await sessionCap(a), 48000);
    assert.match(await page.locator('#modelQuickOutputSummary').innerText(), /手动.*48,000/);
    await snapshot('02-main-manual');
    await closeMenu();
    assert.equal(await page.locator('#chatScrollResumeHost').evaluate(element => getComputedStyle(element).visibility), 'visible');
    await openMenu(b);
    assert.equal(await page.locator('#modelQuickOutputTokens').inputValue(), '');
    assert.match(await page.locator('#modelQuickOutputSummary').innerText(), /128,000/);
    assert.equal(await sessionCap(b), 0);
    await snapshot('03-other-conversation-auto');
    await closeMenu();
    await openMenu(a);
    assert.equal(await page.locator('#modelQuickOutputTokens').inputValue(), '48000');
    await page.locator('#modelQuickOutputTokens').fill('128001');
    assert.equal(await page.locator('#modelQuickOutputSave').isDisabled(), true);
    assert.match(await page.locator('#modelQuickOutputSummary').innerText(), /不能超过/);
    await page.locator('#modelQuickOutputTokens').fill('48000');
    await closeMenu();
    report.checks.push('Claude4.7 automatic128000; manual48000 persists only in A; B remains automatic; oversized input is blocked');

    await openObserver();
    assert.equal(await page.locator('#zObserverOutputTokens').isDisabled(), true);
    await page.locator('#zConnectionSelect').selectOption(JSON.stringify([setup.connection.providerId, setup.connection.supplierId]));
    await page.locator('#zConnectionModel').selectOption(modelId);
    await page.locator('#zObserverOutputTokens').fill('12000');
    await page.locator('#zConnectionSave').click();
    await page.waitForFunction(() => !document.querySelector('#zConnectionDialog').open);
    const config = await page.evaluate(() => z.getConfig());
    assert.equal(config.observer.maxOutputTokens, 12000);
    assert.equal(await sessionCap(a), 48000);
    assert.equal(await sessionCap(b), 0);
    assert.deepEqual(config.context, contextSettings);
    await openObserver();
    assert.equal(await page.locator('#zObserverOutputTokens').inputValue(), '12000');
    assert.match(await page.locator('#zObserverOutputSummary').innerText(), /手动.*12,000/);
    await snapshot('04-observer-independent');
    await page.locator('#zConnectionCancel').click();
    report.checks.push('Observer12000 is independent; rule mode disables its input; 1M context and800K compaction unchanged');

    await application.close(); application = null; page = null;
    await launch();
    await openMenu(a);
    assert.equal(await page.locator('#modelQuickOutputTokens').inputValue(), '48000');
    await closeMenu();
    await openMenu(b);
    assert.equal(await page.locator('#modelQuickOutputTokens').inputValue(), '');
    await closeMenu();
    await openObserver();
    assert.equal(await page.locator('#zObserverOutputTokens').inputValue(), '12000');
    const restored = await page.evaluate(() => z.getConfig());
    assert.deepEqual(restored.context, contextSettings);
    await snapshot('05-restored-after-restart');
    report.checks.push('Both session caps, observer cap, and context settings survive a full isolated restart');
    assert.deepEqual(report.pageErrors, []);
    assert.equal(report.requests.some(request => request.method !== 'GET'), false, 'no model generation request occurred');
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page && !page.isClosed()) await snapshot('failure').catch(() => {});
    throw error;
  } finally {
    await application?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith('z-output-controls-e2e-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
