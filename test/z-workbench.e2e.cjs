'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const outputDir = path.join(appRoot, 'output', 'z-workbench');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-workbench-e2e-'));
const launchEnv = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: userDataDir };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const errors = [];
const report = { ok: false, modelRequests: 0, checks: {}, screenshots: [], pageErrors: errors };
fs.mkdirSync(outputDir, { recursive: true });

(async () => {
  let application;
  let page;
  const shot = async name => {
    const file = path.join(outputDir, name);
    await page.screenshot({ path: file });
    report.screenshots.push(file);
    console.log(`SCREENSHOT ${file}`);
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const ready = () => page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && typeof createRunCtx === 'function' && typeof applyOpenCodeEvent === 'function' && window.ZWdMonitor && state.currentSession);
  const expectObserverOpen = async () => {
    await page.locator('#rs-watchdog .wd-monitor').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => activeRightSidebarTab), 'watchdog');
    assert.equal((await page.locator('#wdMonitorNavBtn').innerText()).trim(), '观察者');
    assert.equal(await page.locator('[data-rs-tab="watchdog"] .rs-work-tab-label').innerText(), '观察者');
    assert.equal(await page.locator('.wd-eyebrow').innerText(), '观察者 / 运行状态');
    assert.doesNotMatch(await page.locator('#rs-watchdog').innerText(), /\bWD\b/, 'visible monitor content uses the Observer name');
  };
  const readPanel = () => page.evaluate(() => ({
    phase: document.querySelector('#rs-watchdog')?.dataset.wdState,
    mode: document.querySelector('.wd-mode')?.dataset.mode,
    title: document.querySelector('.wd-status-title')?.textContent,
    stats: [...document.querySelectorAll('.wd-stat dd')].map(el => el.textContent),
    eventCount: document.querySelectorAll('.wd-event').length,
    delivery: document.querySelector('.wd-delivery')?.textContent || '',
    emptyTitle: document.querySelector('.wd-empty-title')?.textContent || '',
    currentSession: state.currentSession?.id,
    activeTab: activeRightSidebarTab
  }));
  try {
    application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env: launchEnv });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15_000);
    await ready();
    const profile = await application.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath('userData') }));
    assert.equal(profile.name, 'Z');
    assert.equal(path.resolve(profile.userData), path.resolve(userDataDir), 'test must use only its isolated profile');
    report.checks.isolatedProfile = profile;
    // Assert the real startup state before clicking a control or opening a panel.
    await expectObserverOpen();
    report.checks.defaultExpanded = true;
    await page.evaluate(() => applyTheme('dark'));
    await settle();
    assert.equal(await page.title(), 'Z');
    assert.equal(await page.locator('.sidebar-brand').getAttribute('aria-label'), 'Z');
    assert.equal(await page.locator('#greeting').innerText(), '下一步，交给 Z。');
    assert.equal(await page.locator('.z-hero-emblem').isVisible(), true);
    await shot('01-home-dark.png');
    report.checks.brand = true;

    report.checks.empty = await readPanel();
    assert.equal(report.checks.empty.activeTab, 'watchdog');
    assert.equal(report.checks.empty.mode, 'empty');
    assert.deepEqual(report.checks.empty.stats, ['—', '—', '—']);
    assert.equal(report.checks.empty.eventCount, 0, 'empty view must not invent monitor events');
    await shot('02-wd-empty-dark.png');

    await page.evaluate(() => applyLanguage('en'));
    await settle();
    assert.equal((await page.locator('#wdMonitorNavBtn').innerText()).trim(), 'Observer');
    assert.equal(await page.locator('[data-rs-tab="watchdog"] .rs-work-tab-label').innerText(), 'Observer');
    assert.match(await page.locator('.wd-eyebrow').innerText(), /^Observer\s*\//);
    report.checks.observerEnglish = true;
    await page.evaluate(() => applyLanguage('zh-CN'));
    await settle();
    await expectObserverOpen();

    await page.evaluate(() => {
      const session = state.currentSession;
      session.title = '观察者 UI 验收（隔离测试）';
      session.messages = [{ role: 'user', content: '复核重试策略并检查修改结果。', timestamp: Date.now() - 30_000 }];
      renderMessages(session.messages);
      setEmptyState(false);
      const runCtx = createRunCtx(session.id, true, '');
      initOpenCodeRunState(runCtx);
      runCtx.activeAgentRun.timeline = [];
      const assistantEl = appendMessage('assistant', '正在检查执行结果。');
      state.activeRuns.set(session.id, { sessionRef: session, runCtx, assistantEl });
      const ts = Date.now();
      const event = {
        id: 'z-ui-intervention-1', ts, step: 36, action: 'remind',
        rules: ['R1_loop'], advisories: ['R5_stale_verification'], streak: 1,
        message: '刚才的操作多次重复。先运行一次最小验证，再决定下一步。', delivery: 'delivered'
      };
      const statusEvent = { type: 'z.thrash.watchdog.status', data: {
        enabled: true, phase: 'observing', judgeEvery: 6,
        observedSteps: 36, judgedSteps: 36, checks: 6, interventions: 1, streak: 1,
        updatedAt: ts, events: [event]
      } };
      applyOpenCodeEvent(runCtx, statusEvent);
      window.__zWorkbench = { runCtx, session, event, statusEvent };
      updateTaskBar();
    });
    await settle();
    report.checks.running = await readPanel();
    assert.equal(report.checks.running.mode, 'live');
    assert.equal(report.checks.running.phase, 'observing');
    assert.deepEqual(report.checks.running.stats, ['6', '36', '1']);
    assert.equal(report.checks.running.eventCount, 1);
    assert.equal(report.checks.running.delivery, '提醒已送达模型');
    await shot('03-wd-running-dark.png');

    await page.evaluate(() => {
      const { runCtx, event, statusEvent } = window.__zWorkbench;
      applyOpenCodeEvent(runCtx, statusEvent);
      applyOpenCodeEvent(runCtx, { type: 'z.thrash.watchdog', data: event });
      applyOpenCodeEvent(runCtx, { type: 'z.thrash.watchdog', data: event });
    });
    report.checks.replay = await readPanel();
    assert.deepEqual(report.checks.replay.stats, ['6', '36', '1']);
    assert.equal(report.checks.replay.eventCount, 1, 'replaying status/events must not double count');

    await page.locator('[data-rs-close-tab="watchdog"]').click();
    assert.equal(await page.locator('#rs-watchdog').isVisible(), false);
    await page.evaluate(() => {
      const { runCtx, event, statusEvent } = window.__zWorkbench;
      applyOpenCodeEvent(runCtx, statusEvent);
      applyOpenCodeEvent(runCtx, { type: 'z.thrash.watchdog', data: event });
      updateTaskBar();
    });
    await settle();
    assert.equal(await page.locator('#rs-watchdog').isVisible(), false, 'monitor events must not reopen a panel the user closed');
    report.checks.staysClosedOnEvents = true;
    await page.evaluate(async () => {
      await saveCurrentSession(window.__zWorkbench.session);
      await newSession();
    });
    assert.notEqual(await page.evaluate(() => state.currentSession.id), report.checks.running.currentSession);
    assert.equal(await page.locator('#rs-watchdog').isVisible(), false, 'new task must respect the manually closed panel');
    await page.evaluate(async () => { await loadSession(window.__zWorkbench.session.id); });
    assert.equal(await page.locator('#rs-watchdog').isVisible(), false, 'switching back to an active task must not reopen the panel');
    report.checks.staysClosedOnTaskSwitch = true;
    await page.locator('#wdMonitorNavBtn').click();
    await expectObserverOpen();
    assert.deepEqual((await readPanel()).stats, ['6', '36', '1']);
    report.checks.closeReopen = true;

    await page.evaluate(async () => {
      const { runCtx, session } = window.__zWorkbench;
      const savedRun = { ...runCtx.activeAgentRun, status: 'done',
        watchdog: ZWdMonitor.finish(runCtx.activeAgentRun.watchdog, 'done') };
      session.messages.push({ role: 'assistant', content: '隔离测试记录已保存。', timestamp: Date.now(), agentRun: savedRun });
      state.activeRuns.delete(session.id);
      await saveCurrentSession(session);
      await newSession();
    });
    report.checks.switched = await readPanel();
    assert.notEqual(report.checks.switched.currentSession, report.checks.running.currentSession);
    assert.equal(report.checks.switched.mode, 'empty');
    assert.deepEqual(report.checks.switched.stats, ['—', '—', '—']);
    assert.equal(report.checks.switched.eventCount, 0);
    await page.evaluate(async () => { await loadSession(window.__zWorkbench.session.id); });
    report.checks.history = await readPanel();
    assert.equal(report.checks.history.mode, 'history');
    assert.equal(report.checks.history.phase, 'completed');
    assert.deepEqual(report.checks.history.stats, ['6', '36', '1']);
    assert.equal(report.checks.history.eventCount, 1);
    await shot('04-wd-history-dark.png');

    await page.evaluate(() => applyTheme('light'));
    await settle();
    await shot('05-wd-history-light.png');
    report.checks.light = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
      foreground: getComputedStyle(document.querySelector('.wd-monitor')).color,
      background: getComputedStyle(document.querySelector('.wd-status')).backgroundColor }));
    assert.equal(report.checks.light.theme, 'light');
    assert.notEqual(report.checks.light.foreground, report.checks.light.background);

    const nativeWindow = await application.browserWindow(page);
    const normalBounds = await nativeWindow.evaluate(window => window.getBounds());
    report.checks.narrowWindow = await nativeWindow.evaluate(window => {
      window.setSize(940, 690);
      return { bounds: window.getBounds(), contentBounds: window.getContentBounds(), minimumSize: window.getMinimumSize() };
    });
    await settle();
    // The workbench collapses its side rail after a narrow resize. Exercise
    // the real navigation control again, as a user opening WD would do.
    if (!await page.locator('#rs-watchdog').isVisible()) await page.locator('#wdMonitorNavBtn').click();
    await page.locator('#rs-watchdog .wd-monitor').waitFor({ state: 'visible' });
    await settle();
    await shot('06-wd-narrow-light.png');
    report.checks.narrow = await page.evaluate(() => {
      const host = document.querySelector('#rs-watchdog');
      const stats = [...host.querySelectorAll('.wd-stat')].map(el => el.getBoundingClientRect().toJSON());
      return { width: innerWidth, hostWidth: host.clientWidth, contentWidth: host.scrollWidth,
        bodyWidth: document.documentElement.scrollWidth, stats };
    });
    assert.ok(report.checks.narrow.hostWidth >= 260, 'WD panel remains readable at narrow width');
    // Windows may round the outer bounds by 1–2 logical pixels at fractional
    // display scaling. The captured viewport must still match real content.
    assert.ok(Math.abs(report.checks.narrowWindow.bounds.width - 940) <= 2,
      'narrow screenshot must use a native window near the requested 940px width');
    assert.ok(report.checks.narrowWindow.bounds.width >= report.checks.narrowWindow.minimumSize[0]);
    assert.ok(Math.abs(report.checks.narrow.width - 940) <= 4, 'actual renderer viewport stays near 940px');
    assert.equal(report.checks.narrow.width, report.checks.narrowWindow.contentBounds.width, 'renderer viewport must match the native content bounds');
    assert.ok(report.checks.narrow.contentWidth <= report.checks.narrow.hostWidth + 1, 'WD panel must not overflow horizontally');
    assert.ok(report.checks.narrow.stats.every(rect => rect.width > 50), 'each metric stays legible');

    await nativeWindow.evaluate((window, bounds) => window.setSize(bounds.width, bounds.height), normalBounds);
    await page.evaluate(async () => { applyTheme('dark'); await newSession(); });
    await page.reload();
    await ready();
    await expectObserverOpen();
    report.checks.refreshDefaultExpanded = true;

    // A new app launch opens Observer even when the previous launch ended
    // with the panel manually closed. Reuse only this test's own profile.
    await page.locator('[data-rs-close-tab="watchdog"]').click();
    assert.equal(await page.locator('#rs-watchdog').isVisible(), false);
    await application.close();
    application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env: launchEnv });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15_000);
    await ready();
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(userDataDir));
    await expectObserverOpen();
    report.checks.restartDefaultExpanded = true;
    await page.evaluate(async () => { applyTheme('dark'); await newSession(); });
    await settle();
    await expectObserverOpen();
    assert.equal(await page.locator('.z-hero-emblem').isVisible(), true);
    await shot('z-observer-default.png');
    assert.deepEqual(errors, [], 'renderer must not emit page errors');
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: Object.keys(report.checks), screenshots: report.screenshots, pageErrors: errors }));
  } catch (error) {
    report.error = error.stack || String(error);
    if (page && !page.isClosed()) await shot('failure.png').catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    if (application) await application.close();
    // Remove only the exact directory made by this test, never a live profile.
    const resolved = path.resolve(userDataDir);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('z-workbench-e2e-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
