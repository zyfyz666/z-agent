'use strict';

// Real Electron UI, main IPC and bundled OpenCode kernel. The only model is a
// localhost streaming fixture; the test never loads a live user profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-session-fork-'));
const outputDir = path.join(appRoot, 'output', 'session-fork');
const modelId = 'session-fork-fixture';
const cutoff = 53;
const markers = {
  prefix: 'FORK_PREFIX_CONTEXT_5731', longEnd: 'FORK_LONG_MESSAGE_END_5731', selected: 'FORK_SELECTED_CONTEXT_5731',
  future: 'FORK_FUTURE_CONTEXT_5731', handoff: 'FORK_FUTURE_HANDOFF_5731',
  originalObserver: 'FORK_ORIGINAL_OBSERVER_5731', futureObserver: 'FORK_FUTURE_OBSERVER_5731',
  sourceDraft: 'FORK_SOURCE_DRAFT_5731', branchDraft: 'FORK_BRANCH_DRAFT_5731'
};
const report = { ok: false, checks: [], requests: [], pageErrors: [], fixtureErrors: [] };
const runMarker = action => `FORK_RUN_${action}_5731`;
let application;
let page;
let heldSource;
let source;
let branch;
let delayedBranch;
fs.mkdirSync(outputDir, { recursive: true });

function completion(response, text) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const chunk = { id: 'fork-fixture', object: 'chat.completion.chunk', model: modelId,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(raw || '{}');
      assert.equal(body.model, modelId);
      const lastUser = JSON.stringify((body.messages || []).findLast(message => message.role === 'user')?.content || '');
      // Rebuilt native sessions replay prior child prompts in the same input;
      // the actual new request follows that history envelope.
      const action = [...lastUser.matchAll(/FORK_RUN_(SOURCE_SEED|SOURCE_HOLD|BRANCH_ONE|SOURCE_NEXT|BRANCH_TWO|PREFLIGHT|FORGED|REBUILT|AFTER_DELETE)_5731/g)].at(-1)?.[1];
      if (!action || !body.tools?.length) return completion(response, 'FORK_AUXILIARY_OK');
      const fullPayload = JSON.stringify(body);
      const flags = Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, fullPayload.includes(marker)]));
      const priorRuns = Object.fromEntries(['SOURCE_HOLD', 'BRANCH_ONE', 'SOURCE_NEXT', 'BRANCH_TWO'].map(name => [name, fullPayload.includes(runMarker(name))]));
      const priorReplies = Object.fromEntries(['BRANCH_ONE', 'BRANCH_TWO'].map(name => [name, fullPayload.includes(`FORK_REPLY_${name}_5731`)]));
      report.requests.push({ action, model: body.model, flags, priorRuns, priorReplies });
      assert.ok(report.requests.length <= 18, 'bounded model requests');
      assert.notEqual(action, 'PREFLIGHT', 'an oversized initial branch must fail before any model HTTP call');
      if (['BRANCH_ONE', 'BRANCH_TWO', 'FORGED', 'REBUILT', 'AFTER_DELETE'].includes(action)) {
        assert.equal(flags.prefix, true, `${action}: the first message survives a fork longer than 24 messages`);
        assert.equal(flags.longEnd, true, `${action}: the end of a message longer than 6000 characters survives`);
        assert.equal(flags.selected, true, `${action}: the selected message is included`);
        for (const name of ['future', 'handoff', 'futureObserver', 'sourceDraft']) {
          assert.equal(flags[name], false, `${action}: no post-cutoff ${name} reaches the real model`);
        }
        assert.equal(priorRuns.SOURCE_HOLD, false, `${action}: a later source run never enters the branch`);
        assert.equal(priorRuns.SOURCE_NEXT, false, `${action}: later source continuation never enters the branch`);
      }
      if (action === 'SOURCE_NEXT') {
        assert.equal(flags.future, true, 'the source retains its original later history');
        assert.equal(priorRuns.SOURCE_HOLD, true, 'the source continues its own native context');
        assert.equal(priorRuns.BRANCH_ONE, false, 'branch continuation does not contaminate the source');
      }
      if (['BRANCH_TWO', 'REBUILT', 'AFTER_DELETE'].includes(action)) assert.equal(priorRuns.BRANCH_ONE, true);
      if (['REBUILT', 'AFTER_DELETE'].includes(action)) {
        assert.equal(priorRuns.BRANCH_TWO, true);
        assert.equal(priorReplies.BRANCH_ONE, true, 'restored native history includes earlier child replies');
        assert.equal(priorReplies.BRANCH_TWO, true, 'restored native history includes the latest child reply');
      }
      if (action === 'SOURCE_HOLD') {
        assert.ok(!heldSource, 'only one source run is held');
        heldSource = { response, released: false, closedEarly: false };
        response.on('close', () => { if (!heldSource.released) heldSource.closedEarly = true; });
        return;
      }
      completion(response, `FORK_REPLY_${action}_5731`);
    } catch (error) {
      report.fixtureErrors.push(error.message);
      completion(response, `FORK_FIXTURE_ERROR: ${error.message}`);
    }
  });
});

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
  assert.ok(page);
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  await application.evaluate(({ app }) => {
    const localRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/main.js`);
    const { OpenCodeSidecar } = localRequire('./lib/opencode-sidecar');
    const originalRun = OpenCodeSidecar.prototype.run;
    globalThis.forkKernelInstances = new Set();
    // Observe only: every call still runs through the real pooled sidecar.
    OpenCodeSidecar.prototype.run = async function (...args) {
      try { return await originalRun.apply(this, args); }
      finally { if (this.client) globalThis.forkKernelInstances.add(this); }
    };
  });
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

async function runDirect(session, action, extra = {}, expectFailure = false) {
  const runId = `fork-direct-${action.toLowerCase()}`;
  await page.evaluate(({ session, action, runId, extra }) => {
    window.forkDirectRuns ||= {};
    window.forkDirectRuns[runId] = { pending: true };
    const stop = yan.onOpenCodeCompleted(detail => {
      if (detail.runId !== runId) return;
      window.forkDirectRuns[runId] = detail.result;
      stop();
    });
    yan.openCodeStartRun({ runId, yanSessionId: session.id, utility: true,
      openCodeSessionId: session.openCodeSessionId || '', history: session.messages,
      prompt: `FORK_RUN_${action}_5731: Reply with the fixture confirmation.`, ...extra }).then(result => {
      if (!result.ok) { window.forkDirectRuns[runId] = { error: result.error }; stop(); }
    }).catch(error => { window.forkDirectRuns[runId] = { error: error.message }; stop(); });
  }, { session, action, runId, extra });
  await page.waitForFunction(id => !window.forkDirectRuns?.[id]?.pending, runId, { timeout: 90_000 });
  const result = await page.evaluate(id => window.forkDirectRuns[id], runId);
  if (expectFailure) {
    assert.equal(result.status, 'error', 'the initial branch exceeds its configured context budget');
    assert.match(result.error, /FORK_CONTEXT_TOO_LARGE|超过.*上下文上限/);
    return result;
  }
  assert.equal(result.status, 'done', result.error);
  assert.match(result.text, new RegExp(`FORK_REPLY_${action}_5731`));
  return result;
}

async function nativeSessionAction(session, action) {
  assert.ok(session.openCodeSessionId);
  return application.evaluate(async ({ app }, { session, action, profile }) => {
    const path = process.getBuiltinModule('path');
    if (path.resolve(app.getPath('userData')) !== path.resolve(profile)) throw new Error('Unexpected Electron profile');
    for (const kernel of [...globalThis.forkKernelInstances].reverse()) {
      if (!kernel.client || !kernel.server) continue;
      if (!path.resolve(kernel.dataDir).startsWith(path.resolve(profile) + path.sep)) throw new Error('Kernel is outside the isolated profile');
      const params = { sessionID: session.openCodeSessionId, directory: session.workspace };
      const found = await kernel.client.session.get(params);
      if (found.error || found.data?.id !== session.openCodeSessionId) continue;
      const history = await kernel.client.session.messages(params);
      if (history.error || !Array.isArray(history.data)) throw new Error('Cannot inspect the real native history');
      if (action === 'inspect') return { messageCount: history.data.length };
      if (action !== 'delete') throw new Error('Unknown native fixture action');
      // Delete only this explicit synthetic native session, preserving the Z
      // conversation record so its reconstruction path is exercised for real.
      const removed = await kernel.client.session.delete(params);
      if (removed.error) throw new Error('Could not delete isolated native session');
      const after = await kernel.client.session.get(params);
      return { messageCount: history.data.length, deleted: !removed.error, existsAfter: !!after.data?.id };
    }
    throw new Error('The isolated native session was not found');
  }, { session: { openCodeSessionId: session.openCodeSessionId, workspace: session.workspace }, action, profile });
}

async function startUiRun(sessionId, action) {
  await switchTo(sessionId);
  await page.evaluate(({ action }) => {
    window.forkSubmissions ||= {};
    const promise = submitMessage(`FORK_RUN_${action}_5731: Reply with the fixture confirmation.`);
    promise.then(result => { window.forkSubmissions[action] = result; })
      .catch(error => { window.forkSubmissions[action] = { ok: false, error: error.message }; });
  }, { action });
}

async function waitUiRun(action) {
  await page.waitForFunction(action => !!window.forkSubmissions?.[action], action, { timeout: 90_000 });
  const result = await page.evaluate(action => window.forkSubmissions[action], action);
  assert.equal(result.ok, true, result.error);
  assert.ok(report.requests.some(request => request.action === action), `${action} reached the actual model endpoint`);
}

async function installResponseGate() {
  await application.evaluate(({ ipcMain }) => {
    const fork = ipcMain._invokeHandlers.get('session:fork');
    if (!fork) throw new Error('session:fork IPC handler is missing');
    const cancel = ipcMain._invokeHandlers.get('opencode:cancel-run');
    globalThis.forkTestGate = { hold: false, waiting: [], requests: [], cancellations: [] };
    ipcMain.removeHandler('session:fork');
    ipcMain.handle('session:fork', async (event, payload) => {
      globalThis.forkTestGate.requests.push({ sessionId: payload.sessionId, messageIndex: payload.messageIndex });
      const result = await fork(event, payload);
      if (globalThis.forkTestGate.hold) await new Promise(resolve => globalThis.forkTestGate.waiting.push({ resolve, result }));
      return result;
    });
    ipcMain.removeHandler('opencode:cancel-run');
    ipcMain.handle('opencode:cancel-run', (event, payload) => {
      globalThis.forkTestGate.cancellations.push(payload);
      return cancel(event, payload);
    });
  });
}

async function waitForkGate() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const waiting = await application.evaluate(() => globalThis.forkTestGate.waiting.length);
    if (waiting) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Fork response did not reach the controlled delay');
}

async function releaseForkGate() {
  return application.evaluate(() => {
    globalThis.forkTestGate.hold = false;
    const waiting = globalThis.forkTestGate.waiting.splice(0);
    for (const pending of waiting) pending.resolve();
    return waiting.map(pending => pending.result);
  });
}

async function clickSelectedFork(twice = false) {
  const message = page.locator('#messages .msg').filter({ hasText: markers.selected });
  await message.waitFor();
  const button = message.locator('[data-act="fork"]');
  assert.equal(await button.isEnabled(), true, 'persisted completed history can be branched');
  await button.evaluate((node, twice) => { node.click(); if (twice) node.click(); }, twice);
}

function observerSnapshot(message, ts) {
  return { enabled: true, phase: 'completed', outcome: 'completed', judgeEvery: 6,
    observedSteps: 12, judgedSteps: 12, checks: 2, interventions: 1, streak: 1, updatedAt: ts,
    model: { name: 'Original observer model', modelId: 'observer-history-fixture', phase: 'stopped', checks: 2, message },
    events: [{ id: message, ts, step: 12, action: 'remind', rules: ['model_observer'], severity: 1,
      streak: 1, message, delivery: 'delivered' }] };
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    assert.equal(await page.evaluate(() => typeof yan.forkSession), 'function');
    await page.evaluate(async ({ port, modelId }) => {
      const saved = await yan.connectionsSave({ name: 'Session fork fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!saved.ok) throw new Error(saved.error);
      await yan.setConfig({ api: { reasoningSpeed: 'low' }, agent: { accessMode: 'full' } });
      state.config = await yan.getConfig();
      renderModelBadge();
    }, { port: server.address().port, modelId });
    const originalWatchdog = observerSnapshot(markers.originalObserver, 1_800_000_000_053);
    const laterWatchdog = observerSnapshot(markers.futureObserver, 1_800_000_000_111);
    source = await page.evaluate(async ({ markers, cutoff, originalWatchdog, laterWatchdog }) => {
      const session = await yan.createSession(true);
      session.title = 'Fork source fixture';
      session.messages = Array.from({ length: 112 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user',
        content: `Earlier fixture message ${index}`, ts: 1_800_000_000_000 + index }));
      session.messages[0].content = markers.prefix;
      session.messages[7].content = 'Long earlier fixture content. '.repeat(350) + markers.longEnd;
      session.messages[cutoff].content = markers.selected;
      session.messages[cutoff].agentRun = { status: 'done', runId: 'earlier-source-run',
        openCodeSessionId: 'stale-source-native-id', textContent: markers.selected, timeline: [], watchdog: originalWatchdog };
      session.messages[cutoff + 1].content = markers.future;
      session.messages[111].content = markers.future;
      session.messages[111].agentRun = { status: 'done', runId: 'later-source-run',
        openCodeSessionId: 'stale-source-native-id', textContent: markers.future, timeline: [], watchdog: laterWatchdog };
      session.handoff = { id: 'source-future-handoff', context: markers.handoff, messages: [{ role: 'user', content: markers.future }],
        sourceSessionId: 'fixture-prior-source', sourceTitle: 'Earlier handoff', targetWorkspace: session.workspace };
      await yan.saveSession(session);
      await refreshSessions();
      return yan.getSession(session.id);
    }, { markers, cutoff, originalWatchdog, laterWatchdog });
    const seeded = await runDirect(source, 'SOURCE_SEED');
    assert.ok(seeded.openCodeSessionId);
    source = await page.evaluate(async ({ id, nativeId }) => {
      const saved = await yan.getSession(id);
      saved.openCodeSessionId = nativeId;
      await yan.saveSession(saved);
      return yan.getSession(id);
    }, { id: source.id, nativeId: seeded.openCodeSessionId });
    await switchTo(source.id);
    assert.equal(await page.evaluate(() => state.currentSession.messagesStart), 72);
    await page.evaluate(() => loadSessionHistoryBackwards(state.currentSession, { render: true, maxPages: 1 }));
    assert.equal(await page.evaluate(() => state.currentSession.messagesStart), 12);
    await page.evaluate(text => setComposerText(text), markers.sourceDraft);
    await installResponseGate();
    const beforeCount = (await page.evaluate(() => yan.listSessions())).length;
    await application.evaluate(() => { globalThis.forkTestGate.hold = true; });
    await clickSelectedFork(true);
    await waitForkGate();
    const gate = await application.evaluate(() => ({ requests: globalThis.forkTestGate.requests, waiting: globalThis.forkTestGate.waiting.length }));
    assert.deepEqual(gate.requests, [{ sessionId: source.id, messageIndex: cutoff }]);
    assert.equal(gate.waiting, 1, 'double click creates only one branch');
    const [forked] = await releaseForkGate();
    assert.equal(forked.ok, true, forked.error);
    branch = forked.session;
    await page.waitForFunction(id => state.currentSession?.id === id, branch.id);
    assert.equal((await page.evaluate(() => yan.listSessions())).length, beforeCount + 1);
    branch = await readSession(branch.id);
    assert.equal(branch.messages.length, cutoff + 1);
    assert.equal(branch.messages[0].content, markers.prefix);
    assert.ok(branch.messages[7].content.endsWith(markers.longEnd));
    assert.equal(branch.messages.at(-1).content, markers.selected);
    assert.equal(branch.openCodeSessionId || '', '');
    assert.equal(branch.forkedFrom.sessionId, source.id);
    assert.equal(branch.forkedFrom.messageIndex, cutoff);
    assert.deepEqual(branch.modelSelection, source.modelSelection);
    assert.deepEqual(branch.messages.at(-1).agentRun.watchdog, originalWatchdog);
    assert.deepEqual((await readSession(source.id)).messages, source.messages, 'forking never edits source history');
    assert.doesNotMatch(JSON.stringify(branch), /FORK_FUTURE_CONTEXT_5731|FORK_FUTURE_HANDOFF_5731|FORK_FUTURE_OBSERVER_5731|stale-source-native-id/);
    assert.equal(await page.evaluate(() => getComposerText()), '');
    assert.equal(await page.locator('#sessionForkOrigin').isVisible(), true);
    assert.match(await page.locator('#rs-watchdog').innerText(), /FORK_ORIGINAL_OBSERVER_5731/);
    assert.doesNotMatch(await page.locator('#rs-watchdog').innerText(), /FORK_FUTURE_OBSERVER_5731/);
    await page.screenshot({ path: path.join(outputDir, 'forked-history.png') });
    report.checks.push('paginated global cutoff, double-click deduplication, exact 54-message prefix, long message, model and Observer history inheritance, no native/handoff leakage');

    await page.evaluate(text => setComposerText(text), markers.branchDraft);
    await page.locator('#sessionForkSourceBtn').click();
    await page.waitForFunction(id => state.currentSession?.id === id, source.id);
    assert.equal(await page.evaluate(() => getComposerText()), markers.sourceDraft);
    await switchTo(branch.id);
    assert.equal(await page.evaluate(() => getComposerText()), markers.branchDraft);
    await switchTo(source.id);
    await startUiRun(source.id, 'SOURCE_HOLD');
    const heldDeadline = Date.now() + 90_000;
    while (!heldSource && Date.now() < heldDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(heldSource, 'the actual source kernel is active');
    assert.equal(await page.evaluate(id => state.activeRuns.has(id), source.id), true);
    const activeRunId = await page.evaluate(id => getRunCtx(id).runId, source.id);
    await application.evaluate(() => { globalThis.forkTestGate.hold = true; });
    await clickSelectedFork();
    await waitForkGate();
    await switchTo(branch.id);
    const [lateResult] = await releaseForkGate();
    assert.equal(lateResult.ok, true, lateResult.error);
    delayedBranch = lateResult.session;
    await page.waitForFunction(id => !sessionForkRequests.has(id), source.id);
    assert.equal(await page.evaluate(() => state.currentSession.id), branch.id, 'late fork response does not steal focus');
    assert.equal(await page.evaluate(() => getComposerText()), markers.branchDraft);
    assert.equal(await page.evaluate(({ id, runId }) => getRunCtx(id)?.runId === runId && !getRunCtx(id)?.runAbortController.signal.aborted,
      { id: source.id, runId: activeRunId }), true);
    assert.equal(heldSource.closedEarly, false);
    assert.deepEqual(await application.evaluate(() => globalThis.forkTestGate.cancellations), []);
    heldSource.released = true;
    completion(heldSource.response, 'FORK_REPLY_SOURCE_HOLD_5731');
    await waitUiRun('SOURCE_HOLD');
    report.checks.push('source/branch drafts survive navigation; a delayed fork cannot steal focus or stop/pause the running source kernel');

    await startUiRun(branch.id, 'BRANCH_ONE');
    await waitUiRun('BRANCH_ONE');
    branch = await readSession(branch.id);
    source = await readSession(source.id);
    assert.ok(branch.openCodeSessionId);
    assert.notEqual(branch.openCodeSessionId, source.openCodeSessionId, 'the branch owns a distinct native context');
    await startUiRun(source.id, 'SOURCE_NEXT');
    await waitUiRun('SOURCE_NEXT');
    await startUiRun(branch.id, 'BRANCH_TWO');
    await waitUiRun('BRANCH_TWO');
    branch = await readSession(branch.id);
    source = await readSession(source.id);
    assert.doesNotMatch(JSON.stringify(branch.messages), /FORK_RUN_SOURCE_HOLD_5731|FORK_RUN_SOURCE_NEXT_5731/);
    assert.doesNotMatch(JSON.stringify(source.messages), /FORK_RUN_BRANCH_ONE_5731|FORK_RUN_BRANCH_TWO_5731/);
    const normalContext = await page.evaluate(() => yan.getConfig().then(config => config.context));
    await page.evaluate(() => yan.setConfig({ context: { maxTokens: 1024, compactionThreshold: 800 } }));
    const requestsBeforeFailure = report.requests.length;
    await runDirect(delayedBranch, 'PREFLIGHT', {}, true);
    assert.equal(report.requests.length, requestsBeforeFailure, 'context preflight fails before sending a model request');
    delayedBranch = await readSession(delayedBranch.id);
    assert.ok(delayedBranch.openCodeSessionId, 'the first failed attempt already created and bound a native session');
    const failedNativeId = delayedBranch.openCodeSessionId;
    assert.deepEqual(await nativeSessionAction(delayedBranch, 'inspect'), { messageCount: 0 }, 'the bound native session has never received its prefix');
    await page.evaluate(context => yan.setConfig({ context }), normalContext);
    const forged = await runDirect(delayedBranch, 'FORGED', { openCodeSessionId: source.openCodeSessionId,
      history: source.messages, handoff: source.handoff });
    assert.notEqual(forged.openCodeSessionId, source.openCodeSessionId);
    assert.equal(forged.openCodeSessionId, failedNativeId, 'retry restores the existing empty native context instead of silently losing its prefix');
    report.checks.push('real model sees the whole prefix and no future context; source/branch native turns remain independent; main rejects stale source ID/history/handoff');
    report.checks.push('an initial preflight failure leaves an empty bound native session; retry with a normal budget restores the full prefix before the actual model call');

    const previousNativeId = branch.openCodeSessionId;
    const beforeRebuildMessages = branch.messages;
    const removed = await nativeSessionAction(branch, 'delete');
    assert.ok(removed.messageCount > 0);
    assert.equal(removed.deleted, true);
    assert.equal(removed.existsAfter, false);
    assert.deepEqual((await readSession(branch.id)).messages, beforeRebuildMessages, 'deleting native storage does not alter authoritative Z history');
    await startUiRun(branch.id, 'REBUILT');
    await waitUiRun('REBUILT');
    branch = await readSession(branch.id);
    assert.ok(branch.openCodeSessionId);
    assert.notEqual(branch.openCodeSessionId, previousNativeId, 'missing native storage is recreated with a new identity');
    report.checks.push('after actual native-session deletion, the kernel reconstructs complete current branch history including later child requests/replies and no source future');

    const persistedBranch = await readSession(branch.id);
    await close();
    await launch();
    await switchTo(branch.id);
    const restartedBranch = await readSession(branch.id);
    assert.equal(restartedBranch.openCodeSessionId, persistedBranch.openCodeSessionId);
    assert.deepEqual(restartedBranch.forkedFrom, persistedBranch.forkedFrom);
    assert.deepEqual(restartedBranch.modelSelection, persistedBranch.modelSelection);
    assert.deepEqual(restartedBranch.messages, persistedBranch.messages);
    const deleted = await page.evaluate(id => yan.deleteSession(id, true), source.id);
    assert.equal(deleted.ok, true, deleted.error);
    assert.equal(await readSession(source.id), null);
    await page.evaluate(async () => { await refreshSessions(); renderSessionList(); });
    await page.locator('#sessionForkSourceBtn').click();
    await page.getByText('原对话已不存在，当前分支仍可继续', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => state.currentSession.id), branch.id, 'a deleted source link leaves the branch usable');
    await startUiRun(branch.id, 'AFTER_DELETE');
    await waitUiRun('AFTER_DELETE');
    branch = await readSession(branch.id);
    assert.ok(branch.messages.some(message => message.content.includes('FORK_REPLY_AFTER_DELETE_5731')));
    report.checks.push('fork metadata, model, messages, Observer history and native context survive restart; deleting the source does not prevent branch continuation');
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.fixtureErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks, modelRequests: report.requests.length }));
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ sessionId: state.currentSession?.id, messagesStart: state.currentSession?.messagesStart,
        submissions: window.forkSubmissions, directRuns: window.forkDirectRuns })).catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (heldSource && !heldSource.released) { heldSource.released = true; heldSource.response.destroy(); }
    if (page && !page.isClosed()) await page.evaluate(async () => {
      const active = await yan.openCodeSyncActiveRuns();
      for (const run of active?.runs || []) await yan.openCodeCancelRun(run.runId).catch(() => {});
    }).catch(() => {});
    await close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-session-fork-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
