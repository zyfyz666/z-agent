'use strict';

// Real isolated Electron renderer/preload/IPC; kernel events and reply endpoints
// are fixtures, so this test never uses a model, user credentials or live app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-interaction-session-'));
const outputDir = path.join(appRoot, 'output', 'agent-interaction-session');
fs.mkdirSync(outputDir, { recursive: true });
const report = { ok: false, checks: [], pageErrors: [] };
let application;
let page;
let sessions;

async function launch() {
  const env = { ...process.env, YAN_E2E_MODE: '1', YAN_E2E_USER_DATA_DIR: profile, YAN_E2E_PARENT_PID: String(process.pid),
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
  await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSession && state.config
    && typeof requestAgentQuestion === 'function' && typeof createRunCtx === 'function');
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  await application.evaluate(({ ipcMain }) => {
    globalThis.interactionFixtureReplies = [];
    for (const [channel, kind] of [['opencode:question-reply', 'question'], ['opencode:permission-reply', 'permission'], ['opencode:cancel-run', 'cancel']]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, payload) => {
        globalThis.interactionFixtureReplies.push({ kind, payload });
        return { ok: true, settled: kind === 'cancel' };
      });
    }
  });
}

async function createContexts() {
  sessions = await page.evaluate(async () => {
    const created = [];
    window.interactionContexts = {};
    window.interactionResults = {};
    for (const label of ['A', 'B']) {
      const session = await yan.createSession(true);
      session.title = `Interaction ${label}`;
      session.messages = [{ role: 'user', content: `Keep isolated interaction ${label}`, ts: Date.now() }];
      await yan.saveSession(session);
      const runCtx = createRunCtx(session.id, false, session.workspace);
      runCtx.runId = `interaction-run-${label}`;
      runCtx.sessionRef = session;
      runCtx.accessMode = 'request';
      initOpenCodeRunState(runCtx);
      window.interactionContexts[label] = runCtx;
      state.activeRuns.set(session.id, { sessionRef: session, runCtx, assistantEl: null });
      created.push({ label, id: session.id, runId: runCtx.runId });
    }
    await refreshSessions(); renderSessionList();
    await loadSession(created[1].id);
    return created;
  });
}

const session = label => sessions.find(item => item.label === label);
async function switchTo(label) {
  await page.evaluate(id => loadSession(id), session(label).id);
  assert.equal(await page.evaluate(() => state.currentSession.id), session(label).id);
}
async function ask(label, requestId, questions) {
  await page.evaluate(({ label, requestId, questions }) => {
    applyOpenCodeEvent(window.interactionContexts[label], { type: 'question.asked', data: { id: requestId, questions } });
  }, { label, requestId, questions });
}
async function permit(label, requestId) {
  await page.evaluate(({ label, requestId }) => {
    applyOpenCodeEvent(window.interactionContexts[label], { type: 'permission.asked', data: {
      id: requestId, permission: 'read', patterns: [`${label}-private-fixture.txt`]
    } });
  }, { label, requestId });
}
async function visibleQuestion(requestId, index) {
  await page.waitForFunction(expected => agentQuestionRequest?.requestId === expected.requestId
    && agentQuestionRequest.currentIndex === expected.index
    && !document.querySelector('#agentPermissionPanel').classList.contains('hidden'), { requestId, index });
  assert.equal(await page.locator('#agentPermissionPanel').getAttribute('data-mode'), 'question');
}
async function custom(text) {
  if (!await page.locator('#agentQuestionCustomInput').isVisible()) await page.locator('#agentQuestionCustomToggle').click();
  await page.locator('#agentQuestionCustomInput').fill(text);
}
async function replies() { return application.evaluate(() => globalThis.interactionFixtureReplies); }
async function reply(kind, requestId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = (await replies()).find(item => item.kind === kind && item.payload?.requestId === requestId);
    if (found) return found.payload;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Missing ${kind} reply ${requestId}`);
}
async function queueIds(label) {
  return page.evaluate(id => (agentInteractionQueues.get(id) || []).map(item => item.requestId), session(label).id);
}
async function remoteReply(label, requestId, kind = 'question') {
  await page.evaluate(({ label, requestId, kind }) => {
    applyOpenCodeEvent(window.interactionContexts[label], { type: `${kind}.replied`, data: { requestID: requestId, answers: [['Remote']] } });
  }, { label, requestId, kind });
}

(async () => {
  try {
    await launch();
    await createContexts();
    await ask('A', 'question-A-main', [
      { question: 'A first question', options: [{ label: 'A keep' }, { label: 'A alternate' }] },
      { question: 'A second question', multiple: true, options: [{ label: 'A scope one' }, { label: 'A scope two' }], custom: true },
      { question: 'A final question', options: [], custom: true }
    ]);
    assert.equal(await page.locator('#agentPermissionPanel').isVisible(), false, 'background A cannot open a panel over B');
    assert.deepEqual(await replies(), [], 'background requests are not silently cancelled');
    await switchTo('A');
    await visibleQuestion('question-A-main', 0);
    await page.locator('.agent-question-option').nth(1).click();
    await visibleQuestion('question-A-main', 1);
    await custom('A custom draft 4197');
    await switchTo('B');
    assert.equal(await page.locator('#agentPermissionPanel').isVisible(), false);
    await ask('B', 'question-B-main', [
      { question: 'B first question', options: [{ label: 'B keep' }, { label: 'B alternate' }] },
      { question: 'B final question', options: [], custom: true }
    ]);
    await visibleQuestion('question-B-main', 0);
    await page.locator('.agent-question-option').first().click();
    await visibleQuestion('question-B-main', 1);
    await custom('B custom draft 4197');
    await permit('A', 'permission-A-after-question');
    await ask('A', 'question-A-remote', [{ question: 'A remote question', options: [{ label: 'Remote' }] }]);
    await visibleQuestion('question-B-main', 1);
    assert.equal(await page.locator('#agentQuestionCustomInput').inputValue(), 'B custom draft 4197');
    assert.deepEqual(await queueIds('A'), ['question-A-main', 'permission-A-after-question', 'question-A-remote']);
    assert.deepEqual(await queueIds('B'), ['question-B-main']);
    assert.deepEqual(await replies(), []);
    report.checks.push('background questions do not replace the current conversation; concurrent questions and permissions queue without cancellation');

    await switchTo('A');
    await visibleQuestion('question-A-main', 1);
    assert.equal(await page.locator('#agentQuestionCustomInput').isVisible(), true);
    assert.equal(await page.locator('#agentQuestionCustomInput').inputValue(), 'A custom draft 4197');
    await page.locator('#agentQuestionHeaderPrev').click();
    await visibleQuestion('question-A-main', 0);
    assert.equal(await page.locator('.agent-question-option input').nth(1).isChecked(), true);
    await page.locator('#agentQuestionHeaderNext').click();
    await visibleQuestion('question-A-main', 1);
    assert.equal(await page.locator('#agentQuestionCustomInput').inputValue(), 'A custom draft 4197');
    await page.locator('#agentQuestionCustomInput').press('Enter');
    await visibleQuestion('question-A-main', 2);
    await custom('A final draft 4197');
    await page.locator('#agentQuestionCustomInput').press('Enter');
    assert.deepEqual(await reply('question', 'question-A-main'), {
      runId: session('A').runId, requestId: 'question-A-main',
      answers: [['A alternate'], ['A custom draft 4197'], ['A final draft 4197']], reject: false
    });
    await page.waitForFunction(() => agentPermissionRequest?.requestId === 'permission-A-after-question');
    assert.equal(await page.locator('#agentPermissionPanel').getAttribute('data-mode'), 'permission');
    await page.locator('#agentPermissionOnce').click();
    assert.deepEqual(await reply('permission', 'permission-A-after-question'), {
      runId: session('A').runId, requestId: 'permission-A-after-question', reply: 'once'
    });
    await visibleQuestion('question-A-remote', 0);
    await switchTo('B');
    await visibleQuestion('question-B-main', 1);
    assert.equal(await page.locator('#agentQuestionCustomInput').inputValue(), 'B custom draft 4197');
    await remoteReply('A', 'question-A-remote');
    assert.deepEqual(await queueIds('A'), []);
    assert.ok(!(await replies()).some(item => item.payload?.requestId === 'question-A-remote'), 'a remote answer causes no second local reply');
    await visibleQuestion('question-B-main', 1);
    report.checks.push('selection, custom answers and page restore per conversation; replies carry exact run/request IDs and hidden remote replies clear only their request');

    // Vision relay choices belong to each permission request, not the shared checkbox.
    await page.evaluate(({ aId, bId }) => {
      for (const [label, id, checked] of [['A', aId, true], ['B', bId, false]]) {
        const requestId = `vision-${label}`;
        requestAgentPermission({ requestId, sessionId: id, title: `Vision permission ${label}`, detail: `${label} fixture`,
          visionRelay: { show: true, checked } }, window.interactionContexts[label])
          .then(result => { window.interactionResults[requestId] = result; });
      }
    }, { aId: session('A').id, bId: session('B').id });
    await visibleQuestion('question-B-main', 1);
    await page.locator('#agentQuestionCustomInput').press('Enter');
    assert.deepEqual(await reply('question', 'question-B-main'), {
      runId: session('B').runId, requestId: 'question-B-main', answers: [['B keep'], ['B custom draft 4197']], reject: false
    });
    await page.waitForFunction(() => agentPermissionRequest?.requestId === 'vision-B');
    assert.equal(await page.locator('#agentPermissionVisionRelayCheck').isChecked(), false);
    await page.locator('#agentPermissionVisionRelayCheck').check();
    await switchTo('A');
    await page.waitForFunction(() => agentPermissionRequest?.requestId === 'vision-A');
    assert.equal(await page.locator('#agentPermissionVisionRelayCheck').isChecked(), true);
    await page.locator('#agentPermissionVisionRelayCheck').uncheck();
    await switchTo('B');
    assert.equal(await page.locator('#agentPermissionVisionRelayCheck').isChecked(), true);
    await switchTo('A');
    assert.equal(await page.locator('#agentPermissionVisionRelayCheck').isChecked(), false);
    await page.locator('#agentPermissionOnce').click();
    await page.waitForFunction(() => window.interactionResults['vision-A']);
    assert.deepEqual(await page.evaluate(() => window.interactionResults['vision-A']), { decision: 'once', useVisionRelay: false });
    await switchTo('B');
    assert.equal(await page.locator('#agentPermissionVisionRelayCheck').isChecked(), true);
    await page.locator('#agentPermissionOnce').click();
    await page.waitForFunction(() => window.interactionResults['vision-B']);
    assert.deepEqual(await page.evaluate(() => window.interactionResults['vision-B']), { decision: 'once', useVisionRelay: true });
    report.checks.push('question/permission transitions are independent and vision relay checkboxes retain per-request choices');

    await ask('A', 'question-A-stop', [{ question: 'Hidden A waiting to stop', options: [{ label: 'A answer' }] }]);
    await permit('A', 'permission-A-stop');
    await ask('B', 'question-B-stop-safe', [
      { question: 'B stays here', options: [], custom: true },
      { question: 'B must not advance', options: [], custom: true }
    ]);
    await visibleQuestion('question-B-stop-safe', 0);
    await custom('B draft survives A stop');
    await page.evaluate(id => abortSessionById(id), session('A').id);
    assert.deepEqual(await queueIds('A'), []);
    await visibleQuestion('question-B-stop-safe', 0);
    assert.equal(await page.locator('#agentQuestionCustomInput').inputValue(), 'B draft survives A stop');
    assert.ok(!(await replies()).some(item => item.kind === 'question' && item.payload?.requestId === 'question-A-stop'));
    const stoppedPermission = (await replies()).find(item => item.kind === 'permission' && item.payload?.requestId === 'permission-A-stop');
    if (stoppedPermission) assert.equal(stoppedPermission.payload.reply, 'reject');
    assert.ok((await replies()).some(item => item.kind === 'cancel' && item.payload === session('A').runId));
    report.checks.push('stopping hidden A drains only A interactions and preserves the visible B answer draft');

    await page.evaluate(aId => {
      const current = state.activeRuns.get(aId);
      const runCtx = createRunCtx(aId, false, current.sessionRef.workspace);
      runCtx.runId = 'interaction-run-A-race';
      runCtx.sessionRef = current.sessionRef;
      runCtx.accessMode = 'request';
      initOpenCodeRunState(runCtx);
      window.interactionContexts.A = runCtx;
      state.activeRuns.set(aId, { sessionRef: current.sessionRef, runCtx, assistantEl: null });
    }, session('A').id);
    await ask('A', 'question-A-race', [
      { question: 'A fast choice', options: [{ label: 'Fast A choice' }, { label: 'Other A choice' }] },
      { question: 'A race final', options: [], custom: true }
    ]);
    await switchTo('A');
    await visibleQuestion('question-A-race', 0);
    // Click and switch in the same renderer turn, inside the 90 ms auto-next window.
    await page.evaluate(async bId => {
      document.querySelector('.agent-question-option input').click();
      await loadSession(bId);
      await new Promise(resolve => setTimeout(resolve, 160));
    }, session('B').id);
    await visibleQuestion('question-B-stop-safe', 0);
    assert.equal(await page.locator('#agentQuestionCustomInput').inputValue(), 'B draft survives A stop');
    await switchTo('A');
    await visibleQuestion('question-A-race', 0);
    assert.equal(await page.locator('.agent-question-option input').first().isChecked(), true);
    await page.locator('#agentQuestionHeaderNext').click();
    await visibleQuestion('question-A-race', 1);
    await custom('A race done');
    await page.locator('#agentQuestionCustomInput').press('Enter');
    assert.deepEqual(await reply('question', 'question-A-race'), {
      runId: 'interaction-run-A-race', requestId: 'question-A-race', answers: [['Fast A choice'], ['A race done']], reject: false
    });
    await permit('A', 'permission-A-remote');
    await switchTo('B');
    await remoteReply('A', 'permission-A-remote', 'permission');
    assert.deepEqual(await queueIds('A'), []);
    assert.ok(!(await replies()).some(item => item.payload?.requestId === 'permission-A-remote'));
    await visibleQuestion('question-B-stop-safe', 0);
    await page.screenshot({ path: path.join(outputDir, 'isolated-question.png') });
    await remoteReply('B', 'question-B-stop-safe');
    assert.deepEqual(await queueIds('B'), []);
    assert.equal(await page.locator('#agentPermissionPanel').isVisible(), false);
    report.checks.push('fast selection then switching cannot advance another request; hidden permission replies also clear without a duplicate local answer');
    report.replies = await replies();
    assert.ok(!report.replies.some(item => ['question-A-remote', 'permission-A-remote', 'question-B-stop-safe']
      .includes(item.payload?.requestId)), 'remote completions never send a later duplicate local reply');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ currentSessionId: state.currentSession?.id,
        question: agentQuestionRequest && { requestId: agentQuestionRequest.requestId, currentIndex: agentQuestionRequest.currentIndex, drafts: agentQuestionRequest.drafts },
        permission: agentPermissionRequest && { requestId: agentPermissionRequest.requestId },
        queues: typeof agentInteractionQueues !== 'undefined' ? [...agentInteractionQueues].map(([id, queue]) => ({ id, requests: queue.map(item => item.requestId) })) : null,
        panel: document.querySelector('#agentPermissionPanel')?.outerHTML })).catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    report.replies = await replies().catch(() => []);
    throw error;
  } finally {
    await page?.evaluate(() => { state.activeRuns.clear(); }).catch(() => {});
    await application?.close().catch(() => {});
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-interaction-session-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
