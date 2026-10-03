'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const appRoot = path.resolve(__dirname, '..');
const output = path.join(appRoot, 'output', 'z-observer-controls');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'z-observer-e2e-'));
const env = { ...process.env, YAN_E2E_MODE: '1', YAN_E2E_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(output, { recursive: true });
let application, page;
const errors = [];
const report = { ok: false, checks: [], screenshots: [], errors };
const key = entry => JSON.stringify([entry.providerId, entry.supplierId]);
const shot = async name => { const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file); };
async function launch() {
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && window.ZConnectionControls);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
}
async function open(mode) {
  await page.locator(mode === 'main' ? '#zApiPill' : '#zObserverPill').click();
  await page.waitForFunction(() => document.querySelector('#zConnectionDialog').open && !document.querySelector('#zConnectionSelect').disabled);
}
async function save() {
  await page.locator('#zConnectionSave').click();
  await page.waitForFunction(() => !document.querySelector('#zConnectionDialog').open);
}
async function publicState() { return page.evaluate(async () => {
  const cfg = await yan.getConfig(); return { agentModel: cfg.agentModel, observer: cfg.observer };
}); }
(async () => {
  try {
    await launch();
    await page.evaluate(() => applyTheme('dark'));
    assert.equal(await page.locator('#zApiPill').isVisible(), true);
    assert.equal(await page.locator('#zObserverPill').isVisible(), true);
    await open('observer');
    assert.equal(await page.locator('#zConnectionSelect').inputValue(), 'rules');
    assert.equal(await page.locator('#zConnectionModelField').isVisible(), false);
    await page.locator('#zConnectionCancel').click();
    const connections = await page.evaluate(async () => {
      const results = [];
      for (const name of ['Main API', 'Observer API']) {
        const result = await yan.connectionsSave({ name, preset: 'openai', apiFormat: 'openai', manualModelId: 'same-model', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'isolated-test-secret' });
        if (!result.ok) throw new Error(result.error || 'connection failed');
        results.push(result.connection);
      }
      state.config = await yan.getConfig(); renderModelBadge();
      return results;
    });
    const [main, observer] = connections;
    const safe = await page.evaluate(() => yan.listModelConnections());
    assert.doesNotMatch(JSON.stringify(safe), /isolated-test-secret|127\.0\.0\.1/);
    await open('main');
    await page.locator('#zConnectionSelect').selectOption(key(main));
    await save();
    assert.equal((await publicState()).agentModel.providerId, main.providerId);
    report.checks.push('composer API selection');
    await open('observer');
    await page.locator('#zConnectionSelect').selectOption(key(observer));
    await page.locator('#zObserverDetails summary').click();
    await page.locator('#zObserverEvery').fill('3');
    const centered = await page.locator('#zConnectionDialog').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 2 && Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < 2;
    });
    assert.ok(centered, 'settings dialog is centered');
    await shot('01-observer-details');
    await save();
    let cfg = await publicState();
    assert.equal(cfg.observer.model.providerId, observer.providerId);
    assert.equal(cfg.observer.judgeEvery, 3);
    assert.equal(cfg.agentModel.providerId, main.providerId);
    report.checks.push('independent model and interval');
    await open('main');
    await page.locator('#zConnectionSelect').selectOption(key(observer)); await save();
    assert.equal((await publicState()).observer.model.providerId, observer.providerId);
    await open('main'); await page.locator('#zConnectionSelect').selectOption(key(main)); await save();
    assert.equal((await publicState()).observer.judgeEvery, 3);
    await page.evaluate(() => applyLanguage('en'));
    await open('observer');
    assert.equal(await page.locator('#zConnectionTitle').innerText(), 'Observer settings');
    assert.equal(await page.locator('#zObserverDetails summary').innerText(), 'Details');
    assert.equal(await page.locator('#zConnectionSelect option').first().innerText(), 'Rules only (no model calls)');
    await shot('02-observer-english');
    await page.locator('#zConnectionCancel').click();
    await page.evaluate(() => applyLanguage('zh-CN'));
    await page.evaluate(() => {
      const session = state.currentSession;
      session.messages = [{ role: 'user', content: '检查项目', timestamp: Date.now() }]; renderMessages(session.messages); setEmptyState(false);
      const runCtx = createRunCtx(session.id, true, ''); initOpenCodeRunState(runCtx); runCtx.activeAgentRun.timeline = [];
      state.activeRuns.set(session.id, { sessionRef: session, runCtx, assistantEl: appendMessage('assistant', '正在检查。') });
      applyOpenCodeEvent(runCtx, { type: 'yan.thrash.watchdog.status', data: { enabled: true, phase: 'observing', judgeEvery: 3, observedSteps: 9, judgedSteps: 9, checks: 2, interventions: 0, events: [], updatedAt: Date.now(), model: { name: 'same-model', modelId: 'same-model', phase: 'reviewing', checks: 2 } } });
      updateTaskBar();
    });
    assert.match(await page.locator('.wd-model-state').innerText(), /正在判断/);
    await shot('03-composer-and-observer');
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.waitForFunction(() => {
      const rect = document.querySelector('#modelPill').getBoundingClientRect();
      return rect.bottom <= innerHeight;
    });
    for (const selector of ['#zApiPill', '#zObserverPill', '#modelPill']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 1000 && box.y + box.height <= 760, `${selector} remains inside the window`);
    }
    await shot('04-narrow');
    await page.locator('[data-observer-config]').click();
    await page.waitForFunction(() => document.querySelector('#zConnectionDialog').open);
    await page.locator('#zConnectionCancel').click();
    await page.evaluate(() => state.activeRuns.clear());
    await application.close(); application = null;
    await launch();
    cfg = await publicState();
    assert.equal(cfg.agentModel.providerId, main.providerId);
    assert.equal(cfg.observer.model.providerId, observer.providerId);
    assert.equal(cfg.observer.judgeEvery, 3);
    report.checks.push('restart persistence, localization and layout');
    for (const judgeEvery of [0, 101, 1.5]) {
      const result = await page.evaluate(args => yan.configureObserver(args), { judgeEvery, model: null });
      assert.ok(result.error);
    }
    await page.evaluate(id => yan.connectionsDelete(id), observer.id);
    const deleted = await page.evaluate(model => yan.configureObserver({ judgeEvery: 3, model }), { providerId: observer.providerId, supplierId: observer.supplierId, modelId: 'same-model' });
    assert.ok(deleted.error);
    await open('observer');
    assert.match(await page.locator('#zConnectionNotice').innerText(), /不可用/);
    await page.locator('#zConnectionSelect').selectOption('rules');
    await page.locator('#zObserverDetails').evaluate(node => node.open = true);
    await page.locator('#zObserverEvery').fill('1'); await save();
    cfg = await publicState();
    assert.equal(cfg.observer.model, null); assert.equal(cfg.observer.judgeEvery, 1);
    assert.equal(cfg.agentModel.providerId, main.providerId);
    report.checks.push('invalid input, deleted connection, rules-only mode');
    assert.deepEqual(errors, []);
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) await shot('failure').catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (application) await application.close();
    if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('z-observer-e2e-')) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
