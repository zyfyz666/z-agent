'use strict';
// Real Electron UI and persistence. Observer verdicts are local IPC fixtures;
// kernel startup is disabled, so this test cannot call an external model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const tempRoot = fs.realpathSync.native(os.tmpdir());
const profile = fs.mkdtempSync(path.join(tempRoot, 'z-observer-session-e2e-'));
const output = path.join(root, 'output/observer-session-controls');
fs.mkdirSync(output, { recursive: true });
let app, page;
const report = { ok: false, checks: [], errors: [], screenshots: [] };
async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && window.zObserverCompletion);
  assert.equal(fs.realpathSync.native(await app.evaluate(({ app }) => app.getPath('userData'))), profile);
  await app.evaluate(({ ipcMain }) => {
    globalThis.__observerTestStarts = 0; globalThis.__observerTestReviews = 0;
    globalThis.__observerTestVerdict = { verdict: { verdict: 'continue', reason: 'Local fixture unfinished', unmet: ['fixture work'], evidence: [], followUp: 'Continue fixture work.', delayMinutes: 0 }, maxWakes: 3, model: 'Fixture observer' };
    ipcMain.removeHandler('opencode:start-run');
    ipcMain.handle('opencode:start-run', () => { globalThis.__observerTestStarts++; throw new Error('External models disabled in observer UI test'); });
    ipcMain.removeHandler('observer:review-completion');
    ipcMain.handle('observer:review-completion', () => {
      globalThis.__observerTestReviews++;
      if (globalThis.__observerTestDefer) return new Promise(resolve => { globalThis.__observerTestResolve = resolve; });
      return globalThis.__observerTestVerdict;
    });
  });
}
async function load(id) {
  await page.evaluate(async id => { await loadSession(id); openRightSidebarTool('watchdog'); renderWdMonitor(); }, id);
  await page.waitForFunction(id => document.querySelector('#rs-watchdog').dataset.wdSessionId === id, id);
}
async function toggle(expected) {
  await page.locator('#rs-watchdog [data-session-observer-toggle]').click();
  await page.waitForFunction(expected => state.currentSession.observerEnabled === expected && !sessionObserverUpdates.has(state.currentSession.id), expected);
}
async function shot(name) {
  const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file);
}

(async () => {
  try {
    await launch();
    const [a, b] = await page.evaluate(async () => {
      const ids = [];
      for (const title of ['Observer task A', 'Observer task B']) {
        const session = await z.createSession(true, '');
        session.messages = [{ role: 'user', content: 'Local fixture only.', ts: Date.now() },
          { role: 'assistant', content: 'Fixture answer', ts: Date.now(), agentRun: { runId: 'fixture-' + title, status: 'done', textContent: 'Fixture unfinished', timeline: [],
            watchdog: { enabled: true, phase: 'completed', checks: 1, observedSteps: 6, interventions: 0, observations: 1,
              events: [{ id: 'history-' + title, action: 'observe', ts: Date.now(), message: 'Retained observer history ' + title, delivery: 'not-needed' }] } } }];
        await z.saveSession(session); await z.renameSession(session.id, title); ids.push(session.id);
      }
      await refreshSessions(); return ids;
    });
    await load(a);
    const initial = await page.locator('[data-session-observer-toggle]').getAttribute('aria-checked'); assert.equal(initial, 'true');
    const history = await page.locator('.wd-event-message').allTextContents();
    await toggle(false);
    assert.equal(await page.locator('#rs-watchdog .wd-oracle').getAttribute('data-eye'), 'closed');
    assert.deepEqual(await page.locator('.wd-event-message').allTextContents(), history);
    assert.match(await page.locator('.z-session-observer-notice').innerText(), /仅此任务/);
    await shot('01-disabled-with-history');
    assert.equal((await page.evaluate(id => z.getSession(id), a)).observerEnabled, false);
    await load(b); assert.equal(await page.locator('[data-session-observer-toggle]').getAttribute('aria-checked'), 'true');
    await load(a); assert.equal(await page.locator('[data-session-observer-toggle]').getAttribute('aria-checked'), 'false');
    report.checks.push('A/B task isolation, immediate closed eye, retained history and durable switch');

    await page.locator('#zObserverPill').click();
    await page.waitForFunction(() => document.querySelector('#zConnectionDialog').open && !document.querySelector('#zConnectionSelect').disabled);
    assert.equal(await page.locator('#zSessionObserverEnabled').isChecked(), false);
    await page.locator('#zSessionObserverEnabled').check();
    await page.waitForFunction(() => !sessionObserverUpdates.has(state.currentSession.id));
    assert.equal((await page.evaluate(id => z.getSession(id), a)).observerEnabled, true, 'dialog toggle saves without global Save');
    await page.locator('#zSessionObserverEnabled').uncheck();
    await page.evaluate(id => loadSession(id), b);
    await page.waitForFunction(() => !document.querySelector('#zConnectionDialog').open);
    await page.waitForFunction(id => !sessionObserverUpdates.has(id), a);
    assert.equal(await page.evaluate(() => state.currentSession.id), b);
    assert.notEqual((await page.evaluate(id => z.getSession(id), b)).observerEnabled, false);
    assert.equal((await page.evaluate(id => z.getSession(id), a)).observerEnabled, false);
    report.checks.push('dialog switch is immediate and captured task ownership survives a task switch');

    await load(b);
    await page.evaluate(() => {
      state.config.observer = { ...(state.config.observer || {}), model: { name: 'Fixture observer' }, completion: { enabled: true } };
      const session = state.currentSession;
      state.activeRuns.set(session.id, { sessionRef: session, runCtx: { sessionId: session.id, runId: 'fixture-running', ui: true,
        sessionRef: session, agentState: { todos: [], status: 'working' }, activeAgentRun: { runId: 'fixture-running', status: 'working', timeline: [] } } });
      renderWdMonitor();
    });
    await toggle(false);
    assert.equal(await page.evaluate(() => state.activeRuns.has(state.currentSession.id)), true, 'closing Observer does not stop main Agent');
    assert.notEqual(await page.evaluate(() => getRunCtx(state.currentSession.id).shouldAbort), true);
    await page.evaluate(() => { state.activeRuns.delete(state.currentSession.id); renderWdMonitor(); });
    await toggle(true);
    await page.evaluate(() => zObserverCompletion.afterRun(state.currentSession));
    assert.equal(await page.evaluate(() => zObserverCompletion.recordFor(state.currentSession.id).status), 'pending');
    await toggle(false);
    assert.equal(await page.evaluate(() => zObserverCompletion.recordFor(state.currentSession.id).status), 'cancelled');
    await page.evaluate(() => zObserverCompletion.dispatch(state.currentSession.id));
    assert.equal(await app.evaluate(() => globalThis.__observerTestStarts), 0);
    await toggle(true);
    await app.evaluate(() => { globalThis.__observerTestDefer = true; });
    await page.evaluate(() => { globalThis.__lateObserverReview = zObserverCompletion.afterRun(state.currentSession); });
    await page.waitForFunction(() => zObserverCompletion.recordFor(state.currentSession.id)?.status === 'reviewing');
    await toggle(false);
    await app.evaluate(() => { globalThis.__observerTestResolve(globalThis.__observerTestVerdict); globalThis.__observerTestDefer = false; });
    await page.evaluate(() => globalThis.__lateObserverReview);
    assert.equal(await page.evaluate(() => zObserverCompletion.recordFor(state.currentSession.id)), null);
    assert.equal(await app.evaluate(() => globalThis.__observerTestStarts), 0);
    assert.equal((await page.evaluate(id => z.getSession(id), b)).observerEnabled, false);
    report.checks.push('running main Agent remains active; disabled countdown and late review never wake it');

    await page.locator('#zObserverPill').click();
    await page.waitForFunction(() => document.querySelector('#zConnectionDialog').open && !document.querySelector('#zConnectionSelect').disabled);
    await shot('02-disabled-dialog');
    await page.locator('#zConnectionCancel').click();
    await load(a); await toggle(true);
    await app.close(); app = null;
    await launch();
    await load(a); assert.equal(await page.locator('[data-session-observer-toggle]').getAttribute('aria-checked'), 'true');
    await load(b); assert.equal(await page.locator('[data-session-observer-toggle]').getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('#rs-watchdog .wd-oracle').getAttribute('data-eye'), 'closed');
    assert.ok((await page.locator('.wd-event-message').allTextContents()).some(text => text.includes('Retained observer history')));
    const emptyId = await page.evaluate(async () => { const session = await z.createSession(true, ''); await refreshSessions(); return session.id; });
    await load(emptyId); await toggle(false);
    assert.equal(await page.locator('#rs-watchdog .wd-oracle').getAttribute('data-eye'), 'closed', 'an empty disabled task also closes the eye');
    await shot('03-empty-disabled');
    report.checks.push('restart preserves independent settings and history; an empty disabled task closes its eye');
    assert.deepEqual(report.errors, []); report.ok = true;
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await app?.close().catch(() => {});
    if (profile.startsWith(tempRoot + path.sep) && path.basename(profile).startsWith('z-observer-session-e2e-')) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
