'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-observer-history-e2e-'));
const outputDir = path.join(appRoot, 'output', 'observer-history');
const launchEnv = { ...process.env, YAN_E2E_MODE: '1', YAN_E2E_USER_DATA_DIR: userDataDir };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const report = { ok: false, checks: [], modelRequests: 0, pageErrors: [] };
const baseTime = Date.now() - 100_000;

function snapshot(label, checks, interventions = 1) {
  return {
    enabled: true, phase: 'completed', outcome: 'completed', judgeEvery: 6,
    observedSteps: checks * 6, judgedSteps: checks * 6, checks, interventions,
    streak: 1, updatedAt: baseTime + checks * 100,
    model: { name: `Observer model ${label}`, modelId: `fixture-${label}`, phase: 'stopped',
      checks, message: `Model observation ${label}`, error: '' },
    events: [{ id: `event-${label}`, ts: baseTime + checks * 100, step: checks * 6,
      action: 'remind', rules: ['R1_loop'], advisories: [], severity: 1,
      message: `History marker ${label}`, delivery: 'delivered' }]
  };
}

function turn(label, checks, interventions = 1) {
  const ts = baseTime + checks * 100;
  return [
    { role: 'user', content: `Request ${label}`, ts },
    { role: 'assistant', content: `Answer ${label}`, ts: ts + 1,
      agentRun: { runId: label, status: 'done', startedAt: ts, completedAt: ts + 1,
        durationMs: 1, timeline: [], watchdog: snapshot(label, checks, interventions) } }
  ];
}

(async () => {
  let application;
  let page;
  let fixtures;
  const panel = () => page.locator('#rs-watchdog');
  const history = () => page.locator('select[data-observer-history]');
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readPanel = () => page.evaluate(() => ({
    sessionId: state.currentSession?.id,
    phase: document.querySelector('#rs-watchdog')?.dataset.wdState,
    mode: document.querySelector('#rs-watchdog .wd-mode')?.dataset.mode,
    title: document.querySelector('#rs-watchdog .wd-status-title')?.textContent || '',
    stats: [...document.querySelectorAll('#rs-watchdog .wd-stat dd')].map(node => node.textContent),
    messages: [...document.querySelectorAll('#rs-watchdog .wd-event-message')].map(node => node.textContent),
    model: document.querySelector('#rs-watchdog .wd-model-state')?.textContent || '',
    selectedKey: document.querySelector('select[data-observer-history]')?.value || '',
    options: [...document.querySelectorAll('select[data-observer-history] option')].map(node => node.value)
  }));
  const expectRecord = async (label, checks, interventions = 1, mode = 'history') => {
    await settle();
    const value = await readPanel();
    assert.equal(value.mode, mode, JSON.stringify(value));
    assert.deepEqual(value.stats, [String(checks), String(checks * 6), String(interventions)], JSON.stringify(value));
    assert.deepEqual(value.messages, [`History marker ${label}`], JSON.stringify(value));
    assert.match(value.model, new RegExp(`Observer model ${label}`));
    return value;
  };
  const load = async id => {
    await page.evaluate(async id => { await loadSession(id); }, id);
    await settle();
    assert.equal(await page.evaluate(() => state.currentSession?.id), id);
  };
  const select = async runId => {
    await history().selectOption(`run:${runId}`);
    await settle();
    assert.equal(await history().inputValue(), `run:${runId}`);
  };
  const launch = async () => {
    application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env: launchEnv });
    page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
      && typeof loadSession === 'function' && typeof applyOpenCodeEvent === 'function'
      && typeof window.ZWdMonitor?.availableRuns === 'function' && state.currentSession);
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(userDataDir),
      'the test must use its own isolated profile');
    // No real request is part of this test. Fail closed if a fixture accidentally
    // enters a provider path, instead of relying on absent account credentials.
    await application.evaluate(({ ipcMain }) => {
      globalThis.__observerHistoryModelRequests = 0;
      for (const channel of ['opencode:start-run', 'opencode:interject', 'opencode:compress-session']) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => {
          globalThis.__observerHistoryModelRequests += 1;
          throw new Error(`Unexpected model request during observer history test: ${channel}`);
        });
      }
    });
    await panel().locator('.wd-monitor').waitFor({ state: 'visible' });
  };
  const close = async () => {
    if (!application) return;
    report.modelRequests += await application.evaluate(() => globalThis.__observerHistoryModelRequests || 0);
    await application.close();
    application = null;
  };

  try {
    await launch();
    const messages = {
      a: [...turn('A1', 2), ...turn('A2', 5, 2)],
      b: turn('B1', 7, 3),
      long: Array.from({ length: 25 }, (_, i) => turn(`C${i + 1}`, i + 1)).flat(),
      missing: [...turn('D1', 3), { role: 'user', content: 'Legacy request without observer data', ts: Date.now() },
        { role: 'assistant', content: 'Legacy answer without observer data', ts: Date.now(),
          agentRun: { runId: 'D2', status: 'done', timeline: [] } }],
      empty: []
    };
    // Exercise the real session create/save IPC path; never seed or read the
    // user's live profile and never submit a conversation to a model.
    fixtures = await page.evaluate(async messages => {
      const sessions = {};
      for (const [name, rows] of Object.entries(messages)) {
        const session = await api.createSession(true, '');
        session.title = `Observer history fixture ${name}`;
        session.messages = rows;
        await saveCurrentSession(session);
        sessions[name] = session.id;
      }
      return sessions;
    }, messages);

    await load(fixtures.a);
    await expectRecord('A2', 5, 2);
    await select('A1');
    await expectRecord('A1', 2);
    await load(fixtures.b);
    await expectRecord('B1', 7, 3);
    await load(fixtures.a);
    await expectRecord('A1', 2);
    assert.equal(await history().inputValue(), 'run:A1', 'switching sessions should retain each session\'s chosen history');
    report.checks.push('session-scoped-history-selection');

    // A full Electron process restart proves the records came from session
    // persistence rather than the renderer's active-run cache or a page reload.
    await close();
    await launch();
    await load(fixtures.a);
    await select('A2');
    await expectRecord('A2', 5, 2);
    await select('A1');
    await expectRecord('A1', 2);
    fs.mkdirSync(outputDir, { recursive: true });
    const historyScreenshot = path.join(outputDir, 'history-after-restart.png');
    await panel().screenshot({ path: historyScreenshot });
    report.screenshots = [historyScreenshot];
    await load(fixtures.b);
    await expectRecord('B1', 7, 3);
    report.checks.push('records-survive-electron-restart');

    await load(fixtures.long);
    await expectRecord('C25', 25);
    const initialLong = await readPanel();
    assert.equal(initialLong.options.includes('run:C1'), false, 'the oldest fixture must initially be outside the 40-message tail');
    assert.equal(await page.evaluate(() => state.currentSession.messagesTruncated), true);
    await panel().locator('[data-observer-earlier]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('select[data-observer-history] option')]
      .some(option => option.value === 'run:C1'));
    await select('C1');
    await expectRecord('C1', 1);
    await page.evaluate(async () => { await saveCurrentSession(); });
    const longStored = JSON.parse(fs.readFileSync(path.join(userDataDir, 'YanData', 'sessions', `${fixtures.long}.json`), 'utf8'));
    assert.equal(longStored.messages.length, 50, 'saving the paged session must preserve every original message');
    assert.equal(longStored.messages[1].agentRun.watchdog.events[0].message, 'History marker C1');
    assert.equal(longStored.messages.at(-1).agentRun.watchdog.events[0].message, 'History marker C25');
    await load(fixtures.b);
    await load(fixtures.long);
    // The next load may return the tail again. Resolve the older page and prove
    // that the selected stable run key still identifies C1, not a shifted index.
    if (!(await readPanel()).options.includes('run:C1')) {
      await panel().locator('[data-observer-earlier]').click();
      await page.waitForFunction(() => [...document.querySelectorAll('select[data-observer-history] option')]
        .some(option => option.value === 'run:C1'));
    }
    await select('C1');
    await expectRecord('C1', 1);
    report.checks.push('earlier-records-and-tail-save');

    await load(fixtures.missing);
    const missing = await readPanel();
    assert.equal(missing.mode, 'history');
    assert.deepEqual(missing.stats, ['—', '—', '—']);
    assert.deepEqual(missing.messages, []);
    assert.match(missing.title, /没有.*记录/);
    await select('D1');
    await expectRecord('D1', 3);
    await load(fixtures.empty);
    const empty = await readPanel();
    assert.equal(empty.mode, 'empty');
    assert.deepEqual(empty.stats, ['—', '—', '—']);
    assert.deepEqual(empty.messages, []);
    report.checks.push('missing-and-empty-records-do-not-inherit-history');

    await load(fixtures.a);
    await select('A1');
    const liveA = { ...snapshot('A3', 9, 4), phase: 'observing', outcome: '',
      model: { ...snapshot('A3', 9, 4).model, phase: 'observing' } };
    const liveB = { ...snapshot('B2', 13, 5), phase: 'observing', outcome: '',
      model: { ...snapshot('B2', 13, 5).model, phase: 'observing' } };
    await page.evaluate(async ({ ids, liveA, liveB }) => {
      const makeLive = (session, runId, snapshot) => {
        const runCtx = createRunCtx(session.id, session.id === state.currentSession.id, '');
        runCtx.runId = runId;
        initOpenCodeRunState(runCtx);
        runCtx.activeAgentRun.timeline = [];
        runCtx.sessionRef = session;
        state.activeRuns.set(session.id, { sessionRef: session, runCtx, assistantEl: null });
        applyOpenCodeEvent(runCtx, { type: 'yan.thrash.watchdog.status', data: { ...snapshot, runID: runId } });
        return runCtx;
      };
      const runA = makeLive(state.currentSession, 'A3', liveA);
      const sessionB = await api.getSession(ids.b, { messageLimit: 40 });
      const runB = makeLive(sessionB, 'B2', liveB);
      window.__observerHistoryLive = { runA, runB };
    }, { ids: fixtures, liveA, liveB });
    await expectRecord('A1', 2);
    assert.equal(await history().inputValue(), 'run:A1', 'live updates must not override a chosen historical round');

    await page.evaluate(() => {
      const { runB } = window.__observerHistoryLive;
      applyOpenCodeEvent(runB, { type: 'yan.thrash.watchdog.status', data: {
        ...runB.activeAgentRun.watchdog, updatedAt: Date.now(), checks: 14, observedSteps: 84, judgedSteps: 84
      } });
    });
    await expectRecord('A1', 2);
    await select('A3');
    await expectRecord('A3', 9, 4, 'live');
    await load(fixtures.b);
    await select('B2');
    const currentB = await readPanel();
    assert.deepEqual(currentB.stats, ['14', '84', '5']);
    assert.deepEqual(currentB.messages, ['History marker B2']);
    await load(fixtures.a);
    await expectRecord('A3', 9, 4, 'live');
    await select('A1');
    await expectRecord('A1', 2);
    report.checks.push('live-and-parallel-runs-do-not-overwrite-selected-history');

    // Remove only synthetic in-memory runs before closing the isolated app.
    await page.evaluate(() => {
      state.activeRuns.clear();
      delete window.__observerHistoryLive;
      renderWdMonitor();
    });
    assert.deepEqual(report.pageErrors, []);
    await close();
    assert.equal(report.modelRequests, 0, 'the regression must never request a model');
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      fs.mkdirSync(outputDir, { recursive: true });
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
      report.panel = await readPanel().catch(() => null);
    }
    throw error;
  } finally {
    await close().catch(() => {});
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    const resolved = path.resolve(userDataDir);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('z-observer-history-e2e-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
