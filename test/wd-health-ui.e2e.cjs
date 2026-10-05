'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-health-ui-e2e-'));
const output = path.join(root, 'output/wd-health-ui');
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, checks: [], errors: [], modelOrStopCalls: 0 };
const base = Date.now() - 8 * 3_600_000;
let app, page, fixtures;
const health = (state, extra = {}) => ({ state, checkedAt: base + 8 * 3_600_000, lastProgressAt: base,
  message: '', waitingPermissions: 0, waitingQuestions: 0,
  tool: { callId: 'shell-1', name: 'run_command', startedAt: base, timeoutMs: 10_000,
    deadlineAt: base + 10_000, lastProgressAt: base, status: 'running' }, ...extra });
const snapshot = value => ({ enabled: true, phase: 'observing', judgeEvery: 6, observedSteps: 8,
  judgedSteps: 6, checks: 1, interventions: 0, updatedAt: value.checkedAt, health: value,
  events: [], healthEvents: [
    { id: 'working', ts: base, ...health('working', { checkedAt: base }) },
    { id: 'state-change', ts: value.checkedAt, ...value }
  ] });
const messages = (id, value, done = false) => [{ role: 'user', content: `Fixture ${id}`, ts: base },
  { role: 'assistant', content: 'Stored result', ts: base + 1, agentRun: {
    runId: id, status: done ? 'done' : 'interrupted', startedAt: base, completedAt: base + 1,
    timeline: [], watchdog: snapshot(value) } }];
async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession);
  await app.evaluate(({ ipcMain }) => {
    globalThis.__healthUiUnwantedCalls = 0;
    for (const channel of ['opencode:start-run', 'opencode:interject', 'opencode:cancel-run']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => { globalThis.__healthUiUnwantedCalls++; throw new Error('Unexpected runtime mutation from health UI'); });
    }
  });
}
async function close() {
  if (!app) return;
  report.modelOrStopCalls += await app.evaluate(() => globalThis.__healthUiUnwantedCalls);
  await app.close(); app = null;
}
const panel = () => page.locator('#rs-watchdog .wd-health');
const load = id => page.evaluate(id => loadSession(id), id);
async function expectState(state, title) {
  await panel().waitFor({ state: 'visible' });
  assert.equal(await panel().getAttribute('data-state'), state);
  assert.equal(await panel().locator('.wd-health-title').innerText(), title);
}
(async () => {
  try {
    await launch();
    fixtures = await page.evaluate(async rows => {
      const result = {};
      for (const [key, messages] of Object.entries(rows)) {
        const session = await api.createSession(true, '');
        await api.renameSession(session.id, `Runtime health ${key}`);
        session.messages = messages;
        await api.saveSession(session);
        result[key] = session.id;
      }
      return result;
    }, { a: [...messages('old-overdue', health('overdue')), ...messages('new-done', health('completed', { tool: null }), true)],
      b: messages('user-wait', health('waiting_user', { waitingQuestions: 1 })),
      c: [{ role: 'user', content: 'Legacy record', ts: base }, { role: 'assistant', content: 'Old result',
        agentRun: { runId: 'legacy', status: 'done', timeline: [], watchdog: { checks: 2 } } }] });
    await load(fixtures.a);
    await expectState('completed', '本轮已结束');
    await page.locator('select[data-observer-history]').selectOption('run:old-overdue');
    await expectState('overdue', '工具等待超出声明时限');
    assert.match(await panel().innerText(), /10 秒/);
    assert.match(await panel().innerText(), /8 小时/);
    assert.match(await panel().innerText(), /最近实际进展/);
    assert.deepEqual(await page.locator('.wd-stat dd').allTextContents(), ['1', '8', '0']);
    assert.equal(await panel().locator('button').count(), 0);
    assert.equal(await panel().locator('.wd-delivery').count(), 0);
    await panel().locator('summary').click();
    assert.equal(await panel().locator('.wd-health-event').count(), 2);
    await page.evaluate(() => renderWdMonitor());
    assert.equal(await panel().locator('details').evaluate(node => node.open), true);
    await page.screenshot({ path: path.join(output, 'overdue-history.png') });
    report.checks.push('declared 10-second tool timeout and eight-hour wait are visible separately from semantic check/intervention counts; history stays expanded across refresh');

    await load(fixtures.b);
    await expectState('waiting_user', '等待用户回复');
    assert.equal(await panel().locator('.wd-health-caution').count(), 0);
    assert.equal(await panel().locator('details').evaluate(node => node.open), false);
    await load(fixtures.a);
    await expectState('overdue', '工具等待超出声明时限');
    const synthetic = snapshot(health('working', { checkedAt: base + 5_000 }));
    await page.evaluate(({ value, id }) => {
      const runCtx = createRunCtx(id, true, state.currentSession.workspace);
      runCtx.runId = 'live-new';
      runCtx.openCodeSessionId = 'kernel-new';
      initOpenCodeRunState(runCtx);
      state.activeRuns.set(id, { runCtx, sessionRef: state.currentSession });
      applyOpenCodeEvent(runCtx, { type: 'z.thrash.watchdog.status', data: { ...value, runID: 'live-new', sessionID: 'kernel-new' } });
      observerHistorySelection.delete(id);
      renderWdMonitor();
    }, { value: synthetic, id: fixtures.a });
    await expectState('working', '等待工具返回');
    await page.evaluate(({ value, id }) => {
      applyOpenCodeEvent(getRunCtx(id), { type: 'z.thrash.watchdog.status', data: { ...value, runID: 'old-overdue', sessionID: 'kernel-old' } });
    }, { value: snapshot(health('overdue')), id: fixtures.a });
    await expectState('working', '等待工具返回');
    await page.locator('select[data-observer-history]').selectOption('run:old-overdue');
    await expectState('overdue', '工具等待超出声明时限');
    await page.evaluate(id => state.activeRuns.delete(id), fixtures.a);
    report.checks.push('waiting user, old history and current tool wait remain distinct across conversation switches and late old-run events');

    await close();
    await launch();
    await load(fixtures.a);
    await page.locator('select[data-observer-history]').selectOption('run:old-overdue');
    await expectState('overdue', '工具等待超出声明时限');
    assert.equal(await panel().locator('.wd-health-event').count(), 2);
    await page.evaluate(() => { state.config.language = 'en'; window.ZI18n.apply('en'); });
    await page.waitForFunction(() => document.querySelector('.wd-health-title')?.textContent === 'Tool wait exceeds its declared timeout');
    assert.doesNotMatch(await panel().innerText(), /[\u3400-\u9fff]/u);
    await page.screenshot({ path: path.join(output, 'english-after-restart.png') });
    await page.evaluate(() => { state.config.language = 'zh-CN'; window.ZI18n.apply('zh-CN'); });
    await load(fixtures.c);
    await expectState('unrecorded', '此轮没有运行巡检记录');
    report.checks.push('full restart preserves separate health history; legacy records remain explicitly unrecorded; all UI labels localize');
    assert.deepEqual(report.errors, []);
    await close();
    assert.equal(report.modelOrStopCalls, 0);
    report.ok = true;
  } finally {
    await close().catch(() => {});
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    const resolved = path.resolve(profile);
    assert.ok(resolved.startsWith(temporaryRoot + path.sep) && path.basename(resolved).startsWith('z-health-ui-e2e-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
