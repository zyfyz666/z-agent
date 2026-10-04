'use strict';

// Real isolated Electron, main IPC and bundled OpenCode. Only the model is a
// localhost HTTP fixture; no user profile, external endpoint or file rollback.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-session-rewind-'));
const outputDir = path.join(appRoot, 'output', 'session-rewind');
const modelIds = { original: 'rewind-original-fixture', later: 'rewind-later-fixture' };
const cutoff = 53;
const markers = {
  prefix: 'REWIND_PREFIX_CONTEXT_8264', longEnd: 'REWIND_LONG_MESSAGE_END_8264',
  selected: 'REWIND_SELECTED_CONTEXT_8264', future: 'REWIND_FUTURE_CONTEXT_8264',
  handoff: 'REWIND_FUTURE_HANDOFF_8264', summary: 'REWIND_FUTURE_SUMMARY_8264',
  originalObserver: 'REWIND_ORIGINAL_OBSERVER_8264', futureObserver: 'REWIND_FUTURE_OBSERVER_8264',
  sourceDraft: 'REWIND_SOURCE_DRAFT_8264', otherDraft: 'REWIND_OTHER_DRAFT_8264',
  file: 'REWIND_CURRENT_FILE_MODIFIED_8264'
};
const report = { ok: false, checks: [], requests: [], pageErrors: [], fixtureErrors: [], consoleErrors: [],
  restoreChecks: [], uiDiagnostics: [], ipcDiagnostics: [] };
const runMarker = action => `REWIND_RUN_${action}_8264`;
let application;
let page;
let heldRun;
let compressionArmed = false;
let source;
let original;
let other;
let markerFile;
fs.mkdirSync(outputDir, { recursive: true });

function completion(response, text, model = modelIds.original) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const chunk = { id: 'rewind-fixture', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ object: 'list', data: Object.values(modelIds).map(id => ({ id, object: 'model' })) }));
  }
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(raw || '{}');
      assert.ok(Object.values(modelIds).includes(body.model));
      if (compressionArmed) {
        report.requests.push({ action: 'COMPACT', model: body.model, summary: markers.summary });
        return completion(response, `Earlier conversation summary: ${markers.future}; ${markers.handoff}; ${markers.summary}`, body.model);
      }
      const lastUser = JSON.stringify((body.messages || []).findLast(message => message.role === 'user')?.content || '');
      // A new native session embeds prior turns before the actual new prompt.
      const action = [...lastUser.matchAll(/REWIND_RUN_(SOURCE_SEED|FORGED|AFTER_REWIND|AFTER_UNDO|HOLD|QUEUED|STALE|STRESS_[0-3])_8264/g)].at(-1)?.[1];
      if (!action || !body.tools?.length) return completion(response, 'REWIND_AUXILIARY_OK', body.model);
      const fullPayload = JSON.stringify(body);
      const flags = Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, fullPayload.includes(marker)]));
      const previousRewoundTurn = fullPayload.includes(runMarker('AFTER_REWIND'));
      report.requests.push({ action, model: body.model, flags, previousRewoundTurn });
      assert.ok(report.requests.length <= 20, 'bounded real model requests');
      assert.notEqual(action, 'STALE', 'a stale revision must fail before any model request');
      if (['FORGED', 'AFTER_REWIND'].includes(action)) {
        assert.equal(body.model, modelIds.original, 'rewind restores the historical model');
        for (const name of ['prefix', 'longEnd', 'selected']) assert.equal(flags[name], true, `${action}: full retained ${name}`);
        for (const name of ['future', 'handoff', 'summary', 'futureObserver', 'sourceDraft']) {
          assert.equal(flags[name], false, `${action}: removed ${name} must not reach the real model`);
        }
      }
      if (action === 'AFTER_UNDO') {
        assert.equal(body.model, modelIds.later);
        assert.equal(flags.prefix, true, 'undo restores even the oldest original message');
        assert.equal(flags.future, true, 'undo restores the original later conversation');
        assert.equal(previousRewoundTurn, false, 'the alternate turn remains in its backup, not the restored conversation');
      }
      if (action === 'SOURCE_SEED') assert.equal(flags.future, true, 'the old real native session has future context');
      if (action === 'HOLD') {
        assert.ok(!heldRun);
        heldRun = { response, model: body.model, released: false, closedEarly: false };
        response.on('close', () => { if (!heldRun.released) heldRun.closedEarly = true; });
        return;
      }
      completion(response, `REWIND_REPLY_${action}_8264`, body.model);
    } catch (error) {
      report.fixtureErrors.push(error.message);
      completion(response, `REWIND_FIXTURE_ERROR: ${error.message}`);
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
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) report.consoleErrors.push(message.text());
  });
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  await application.evaluate(({ app }) => {
    const localRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/main.js`);
    const { OpenCodeSidecar } = localRequire('./lib/opencode-sidecar');
    const originalRun = OpenCodeSidecar.prototype.run;
    globalThis.rewindKernelInstances = new Set();
    OpenCodeSidecar.prototype.run = async function (...args) {
      try { return await originalRun.apply(this, args); }
      finally { if (this.client) globalThis.rewindKernelInstances.add(this); }
    };
  });
  await page.evaluate(() => {
    window.rewindUiDiagnostics = [];
    const describe = () => ({ id: state.currentSession?.id, revision: state.currentSession?.conversationRevision || 0,
      loadToken: sessionLoadToken, active: [...state.activeRuns.keys()], pending: [...sessionRewindRequests.keys()] });
    const originalApply = applySessionRewindResult;
    applySessionRewindResult = async function (result, source, token, ...rest) {
      const entry = { operation: 'apply', input: { ok: result?.ok, error: result?.error, code: result?.code,
        revision: result?.conversationRevision, sessionRevision: result?.session?.conversationRevision },
      before: describe(), sourceSame: state.currentSession === source, sourceRevision: source.conversationRevision || 0, token };
      window.rewindUiDiagnostics.push(entry);
      try { return await originalApply.call(this, result, source, token, ...rest); }
      catch (error) { entry.error = error.message; throw error; }
      finally { entry.after = describe(); }
    };
    const originalToast = toast;
    toast = function (message, ...rest) {
      window.rewindUiDiagnostics.push({ operation: 'toast', message, state: describe() });
      return originalToast.call(this, message, ...rest);
    };
  });
}

async function close() {
  if (page && !page.isClosed()) {
    report.uiDiagnostics.push(...await page.evaluate(() => window.rewindUiDiagnostics || []).catch(() => []));
    report.ipcDiagnostics.push(...await application.evaluate(() => globalThis.rewindTestGate?.restorations || []).catch(() => []));
  }
  await application?.close();
  application = null;
  page = null;
}

async function switchTo(id) {
  await page.evaluate(id => loadSession(id), id);
  await page.waitForFunction(id => state.currentSession?.id === id && !observerPendingSessionId, id);
}

async function readSession(id) { return page.evaluate(id => yan.getSession(id), id); }

function anchor(message) {
  return crypto.createHash('sha256').update(JSON.stringify([message.role ?? null, message.ts ?? null,
    message.id ?? null, message.content ?? '', message.attachments ?? [], message.agentRun?.runId ?? null])).digest('hex');
}

function boundary(session, index = cutoff) {
  return { sessionId: session.id, messageIndex: index, messageAnchor: anchor(session.messages[index]),
    conversationRevision: session.conversationRevision || 0 };
}

async function runDirect(session, action, extra = {}) {
  const runId = `rewind-direct-${action.toLowerCase()}`;
  await page.evaluate(({ session, action, runId, extra }) => {
    window.rewindDirectRuns ||= {};
    window.rewindDirectRuns[runId] = { pending: true };
    const stop = yan.onOpenCodeCompleted(detail => {
      if (detail.runId !== runId) return;
      window.rewindDirectRuns[runId] = detail.result;
      stop();
    });
    yan.openCodeStartRun({ runId, yanSessionId: session.id, utility: true,
      conversationRevision: session.conversationRevision || 0,
      openCodeSessionId: session.openCodeSessionId || '', history: session.messages,
      handoff: session.handoff || null, prompt: `REWIND_RUN_${action}_8264: Reply with the fixture confirmation.`,
      ...extra }).then(result => {
      if (!result.ok) { window.rewindDirectRuns[runId] = result; stop(); }
    }).catch(error => { window.rewindDirectRuns[runId] = { error: error.message }; stop(); });
  }, { session, action, runId, extra });
  await page.waitForFunction(id => !window.rewindDirectRuns?.[id]?.pending, runId, { timeout: 90_000 });
  const result = await page.evaluate(id => window.rewindDirectRuns[id], runId);
  assert.equal(result.status, 'done', result.error);
  assert.match(result.text, new RegExp(`REWIND_REPLY_${action}_8264`));
  return result;
}

async function inspectNative(session) {
  assert.ok(session.openCodeSessionId);
  return application.evaluate(async ({ app }, { session, profile, markers }) => {
    const path = process.getBuiltinModule('path');
    if (path.resolve(app.getPath('userData')) !== path.resolve(profile)) throw new Error('Unexpected Electron profile');
    for (const kernel of [...globalThis.rewindKernelInstances].reverse()) {
      if (!kernel.client || !kernel.server) continue;
      if (!path.resolve(kernel.dataDir).startsWith(path.resolve(profile) + path.sep)) throw new Error('Kernel is outside the isolated profile');
      const params = { sessionID: session.openCodeSessionId, directory: session.workspace };
      const found = await kernel.client.session.get(params);
      if (found.error || found.data?.id !== session.openCodeSessionId) continue;
      const history = await kernel.client.session.messages(params);
      if (history.error || !Array.isArray(history.data)) throw new Error('Cannot inspect real native history');
      const payload = JSON.stringify(history.data);
      return { messageCount: history.data.length,
        flags: Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, payload.includes(marker)])),
        summaryMessages: history.data.filter(message => message.info?.summary).length };
    }
    throw new Error('The isolated native session was not found');
  }, { session: { openCodeSessionId: session.openCodeSessionId, workspace: session.workspace }, profile, markers });
}

async function startUiRun(id, action) {
  await switchTo(id);
  await page.evaluate(action => {
    window.rewindSubmissions ||= {};
    submitMessage(`REWIND_RUN_${action}_8264: Reply with the fixture confirmation.`)
      .then(result => { window.rewindSubmissions[action] = result; })
      .catch(error => { window.rewindSubmissions[action] = { ok: false, error: error.message }; });
  }, action);
}

async function waitUiRun(action) {
  await page.waitForFunction(action => !!window.rewindSubmissions?.[action], action, { timeout: 90_000 });
  const result = await page.evaluate(action => window.rewindSubmissions[action], action);
  assert.equal(result.ok, true, result.error);
  assert.ok(report.requests.some(request => request.action === action), `${action} reaches the real model endpoint`);
}

async function installResponseGate() {
  await application.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('session:rewind');
    if (!original) throw new Error('session:rewind IPC handler is missing');
    const cancel = ipcMain._invokeHandlers.get('opencode:cancel-run');
    const restore = ipcMain._invokeHandlers.get('session:rewind-restore');
    globalThis.rewindTestGate = { hold: false, waiting: [], requests: [], cancellations: [], restorations: [] };
    ipcMain.removeHandler('session:rewind');
    ipcMain.handle('session:rewind', async (event, payload) => {
      globalThis.rewindTestGate.requests.push(payload);
      const result = await original(event, payload);
      if (globalThis.rewindTestGate.hold) await new Promise(resolve => globalThis.rewindTestGate.waiting.push({ resolve, result }));
      return result;
    });
    ipcMain.removeHandler('opencode:cancel-run');
    ipcMain.handle('opencode:cancel-run', (event, payload) => {
      globalThis.rewindTestGate.cancellations.push(payload);
      return cancel(event, payload);
    });
    ipcMain.removeHandler('session:rewind-restore');
    ipcMain.handle('session:rewind-restore', async (event, payload) => {
      const result = await restore(event, payload);
      globalThis.rewindTestGate.restorations.push({ payload, result: { ok: result?.ok,
        error: result?.error, code: result?.code, conversationRevision: result?.conversationRevision,
        id: result?.session?.id, backupSessionId: result?.backupSessionId } });
      return result;
    });
  });
}

async function waitGate() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await application.evaluate(() => globalThis.rewindTestGate.waiting.length)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Rewind response did not reach its controlled delay');
}

async function releaseGate() {
  return application.evaluate(() => {
    globalThis.rewindTestGate.hold = false;
    const waiting = globalThis.rewindTestGate.waiting.splice(0);
    for (const pending of waiting) pending.resolve();
    return waiting.map(pending => pending.result);
  });
}

async function clickSelectedRewind(twice = false) {
  const message = page.locator('#messages .msg').filter({ hasText: markers.selected });
  await message.waitFor();
  const button = message.locator('[data-act="rewind"]');
  assert.equal(await button.isEnabled(), true);
  await button.evaluate((node, twice) => { node.click(); if (twice) node.click(); }, twice);
  await page.locator('#genericConfirmModal').waitFor({ state: 'visible' });
  assert.match(await page.locator('#genericConfirmModal').innerText(), /文件/);
  await page.locator('#genericConfirmAccept').evaluate((node, twice) => { node.click(); if (twice) node.click(); }, twice);
}

async function restoreUi(expectedRevision, label) {
  const id = await page.evaluate(() => state.currentSession.id);
  await page.locator('#sessionRewindRestoreBtn').click();
  await page.locator('#genericConfirmModal').waitFor({ state: 'visible' });
  await page.locator('#genericConfirmAccept').click();
  await page.waitForFunction(id => !sessionRewindRequests.has(id), id);
  const persisted = await readSession(id);
  const ui = await page.evaluate(() => ({ id: state.currentSession?.id,
    revision: state.currentSession?.conversationRevision || 0, loadToken: sessionLoadToken }));
  const operation = await application.evaluate(() => globalThis.rewindTestGate.restorations.at(-1));
  report.restoreChecks.push({ label, expectedRevision, persistedRevision: persisted.conversationRevision || 0, ui, operation });
  assert.equal(persisted.conversationRevision, expectedRevision, `${label}: restore IPC ${JSON.stringify(operation)}`);
  assert.equal(ui.revision, expectedRevision, `${label}: UI must reload the new conversation revision`);
  return persisted;
}

function observerSnapshot(message, ts) {
  return { enabled: true, phase: 'completed', outcome: 'completed', judgeEvery: 6,
    observedSteps: 12, judgedSteps: 12, checks: 2, interventions: 1, streak: 1, updatedAt: ts,
    model: { name: 'Historical observer', modelId: 'rewind-observer-fixture', phase: 'stopped', checks: 2, message },
    events: [{ id: message, ts, step: 12, action: 'remind', rules: ['model_observer'], severity: 1,
      streak: 1, message, delivery: 'delivered' }] };
}

function assertFileUnchanged() {
  assert.equal(fs.readFileSync(markerFile, 'utf8'), markers.file, 'conversation rewind never rolls back current workspace files');
}

function historicalContent(messages) {
  return messages.map(message => ({ role: message.role, content: message.content, ts: message.ts,
    attachments: message.attachments, modelSelection: message.modelSelection,
    agentRun: message.agentRun ? { status: message.agentRun.status, textContent: message.agentRun.textContent,
      watchdog: message.agentRun.watchdog, timeline: message.agentRun.timeline,
      modelId: message.agentRun.modelId, providerId: message.agentRun.providerId,
      supplierId: message.agentRun.supplierId } : undefined }));
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    assert.equal(await page.evaluate(() => typeof yan.rewindSession), 'function');
    assert.equal(await page.evaluate(() => typeof yan.restoreSessionRewind), 'function');
    const selections = await page.evaluate(async ({ port, modelIds }) => {
      const saved = await yan.connectionsSave({ name: 'Session rewind fixture', preset: 'openai', apiFormat: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!saved.ok) throw new Error(saved.error);
      await yan.setConfig({ api: { reasoningSpeed: 'low' }, agent: { accessMode: 'full' } });
      state.config = await yan.getConfig(); renderModelBadge();
      return Object.fromEntries(Object.entries(modelIds).map(([name, modelId]) => [name,
        { providerId: saved.connection.providerId, supplierId: saved.connection.supplierId,
          modelId, modelType: 'text', name: modelId, capabilities: {} }]));
    }, { port: server.address().port, modelIds });
    const originalWatchdog = observerSnapshot(markers.originalObserver, 1_800_000_000_053);
    const laterWatchdog = observerSnapshot(markers.futureObserver, 1_800_000_000_111);
    ({ source, other } = await page.evaluate(async ({ markers, cutoff, originalWatchdog, laterWatchdog, selections }) => {
      const session = await yan.createSession(true);
      session.title = 'Rewind source fixture';
      session.messages = Array.from({ length: 112 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user',
        content: `Earlier rewind fixture message ${index}`, ts: 1_800_000_000_000 + index }));
      session.messages[0].content = markers.prefix;
      session.messages[7].content = 'Long retained fixture content. '.repeat(350) + markers.longEnd;
      session.messages[cutoff].content = markers.selected;
      session.messages[cutoff].modelSelection = selections.original;
      session.messages[cutoff].agentRun = { status: 'done', runId: 'rewind-earlier-run',
        textContent: markers.selected, timeline: [], watchdog: originalWatchdog, ...selections.original };
      session.messages[cutoff + 1].content = markers.future;
      session.messages[111].content = markers.future;
      session.messages[111].modelSelection = selections.later;
      session.messages[111].agentRun = { status: 'done', runId: 'rewind-later-run',
        textContent: markers.future, timeline: [], watchdog: laterWatchdog, ...selections.later };
      session.handoff = { id: 'rewind-future-handoff', context: markers.handoff,
        messages: [{ role: 'user', content: markers.future }], sourceSessionId: 'fixture-prior-source',
        sourceTitle: 'Earlier handoff', targetWorkspace: session.workspace };
      await yan.saveSession(session);
      const modelResult = await yan.setSessionModel(session.id, selections.later);
      if (!modelResult.ok) throw new Error(modelResult.error);
      await yan.setSessionPinned(session.id, true);
      const other = await yan.createSession(true);
      other.messages = [{ role: 'user', content: 'Other retained task context', ts: 1_800_000_001_000 },
        { role: 'assistant', content: 'Other completed task response', ts: 1_800_000_001_001 }];
      await yan.saveSession(other);
      await yan.renameSession(other.id, 'Independent navigation fixture');
      await refreshSessions();
      return { source: await yan.getSession(session.id), other };
    }, { markers, cutoff, originalWatchdog, laterWatchdog, selections }));
    assert.ok(path.resolve(source.workspace).startsWith(path.resolve(profile) + path.sep));
    markerFile = path.join(source.workspace, 'current-file-marker.txt');
    fs.writeFileSync(markerFile, markers.file);
    const seeded = await runDirect(source, 'SOURCE_SEED');
    source = await page.evaluate(async ({ id, nativeId }) => {
      const saved = await yan.getSession(id);
      saved.openCodeSessionId = nativeId;
      await yan.saveSession(saved);
      return yan.getSession(id);
    }, { id: source.id, nativeId: seeded.openCodeSessionId });
    compressionArmed = true;
    const compressed = await page.evaluate(id => yan.openCodeCompressSession(id), source.id);
    compressionArmed = false;
    assert.equal(compressed.ok, true, compressed.error);
    report.originalNative = await inspectNative(source);
    assert.equal(report.originalNative.flags.future, true);
    assert.equal(report.originalNative.flags.summary, true, 'old native context contains an actual compacted summary');
    assert.ok(report.originalNative.summaryMessages > 0);
    original = await readSession(source.id);

    await switchTo(other.id);
    await page.evaluate(text => setComposerText(text), markers.otherDraft);
    await switchTo(source.id);
    assert.equal(await page.evaluate(() => state.currentSession.messagesStart), 72);
    await page.evaluate(() => loadSessionHistoryBackwards(state.currentSession, { render: true, maxPages: 1 }));
    assert.equal(await page.evaluate(() => state.currentSession.messagesStart), 12);
    await page.evaluate(text => setComposerText(text), markers.sourceDraft);
    const staleTail = await page.evaluate(() => structuredClone(state.currentSession));
    await installResponseGate();
    const beforeCount = (await page.evaluate(() => yan.listSessions())).length;
    await application.evaluate(() => { globalThis.rewindTestGate.hold = true; });
    await clickSelectedRewind(true);
    await waitGate();
    const gate = await application.evaluate(() => ({ requests: globalThis.rewindTestGate.requests, waiting: globalThis.rewindTestGate.waiting.length }));
    assert.equal(gate.requests.length, 1, 'double click triggers one rewind');
    assert.equal(gate.requests[0].messageIndex, cutoff, 'the paginated message supplies its absolute position');
    assert.equal(gate.waiting, 1);
    await switchTo(other.id);
    const [rewound] = await releaseGate();
    assert.equal(rewound.ok, true, rewound.error);
    await page.waitForFunction(id => !sessionRewindRequests.has(id), source.id);
    assert.equal(await page.evaluate(() => state.currentSession.id), other.id, 'late rewind response does not steal navigation');
    assert.equal(await page.evaluate(() => getComposerText()), markers.otherDraft);
    assert.equal((await page.evaluate(() => yan.listSessions())).length, beforeCount + 1);
    source = await readSession(source.id);
    assert.equal(source.id, original.id);
    assert.equal(source.conversationRevision, 1);
    assert.equal(source.messages.length, cutoff + 1);
    assert.equal(source.messages[0].content, markers.prefix);
    assert.ok(source.messages[7].content.endsWith(markers.longEnd));
    assert.equal(source.messages.at(-1).content, markers.selected);
    assert.equal(source.workspace, original.workspace);
    assert.equal(source.title, original.title);
    assert.equal(source.pinned, true);
    assert.equal(source.openCodeSessionId || '', '');
    assert.equal(source.modelSelection.modelId, modelIds.original);
    assert.deepEqual(source.messages.at(-1).agentRun.watchdog, originalWatchdog);
    assert.doesNotMatch(JSON.stringify(source.messages), /REWIND_FUTURE_CONTEXT_8264|REWIND_FUTURE_OBSERVER_8264/);
    assert.equal(source.handoff, undefined);
    assert.equal(source.rewindState.backupSessionId, rewound.backupSessionId);
    const backup = await readSession(rewound.backupSessionId);
    assert.notEqual(backup.id, source.id);
    assert.deepEqual(historicalContent(backup.messages), historicalContent(original.messages), 'the backup retains the entire original conversation');
    assert.equal(backup.modelSelection.modelId, modelIds.later);
    assertFileUnchanged();
    await switchTo(source.id);
    assert.equal(await page.locator('#sessionRewindState').isVisible(), true);
    assert.equal(await page.locator('#modelPillName').textContent(), modelIds.original);
    assert.match(await page.locator('#rs-watchdog').innerText(), /REWIND_ORIGINAL_OBSERVER_8264/);
    assert.doesNotMatch(await page.locator('#rs-watchdog').innerText(), /REWIND_FUTURE_OBSERVER_8264/);
    await page.screenshot({ path: path.join(outputDir, 'rewound-history.png') });
    report.checks.push('absolute paginated cutoff, inclusive long prefix, same source ID, historical model and Observer, unchanged files, full backup, double-click deduplication and late navigation safety');

    for (const stale of [original, staleTail]) {
      const result = await page.evaluate(async stale => {
        try { return await yan.saveSession(stale); }
        catch (error) { return { error: error.message, code: error.code }; }
      }, stale);
      assert.ok(result.ok === false || result.error, 'stale save is explicitly rejected');
      assert.match(`${result.code || ''} ${result.error || ''}`, /SESSION_REVISION_CHANGED|对话.*变化|版本/);
      assert.equal((await readSession(source.id)).messages.length, cutoff + 1);
    }
    const requestsBeforeStale = report.requests.length;
    const staleStart = await page.evaluate(({ session, prompt }) => yan.openCodeStartRun({
      runId: 'rewind-stale-start', utility: true, yanSessionId: session.id,
      conversationRevision: session.conversationRevision || 0, openCodeSessionId: session.openCodeSessionId,
      history: session.messages, prompt
    }), { session: original, prompt: runMarker('STALE') });
    assert.equal(staleStart.ok, false);
    assert.equal(staleStart.code, 'SESSION_REVISION_CHANGED');
    assert.equal(report.requests.length, requestsBeforeStale);
    const forged = await runDirect(source, 'FORGED', { openCodeSessionId: original.openCodeSessionId,
      history: original.messages, handoff: original.handoff });
    assert.notEqual(forged.openCodeSessionId, original.openCodeSessionId);
    await startUiRun(source.id, 'AFTER_REWIND');
    await waitUiRun('AFTER_REWIND');
    source = await readSession(source.id);
    assert.notEqual(source.openCodeSessionId, original.openCodeSessionId);
    assert.ok(source.messages.some(message => message.content.includes('REWIND_REPLY_AFTER_REWIND_8264')));
    const afterRewind = source;
    assertFileUnchanged();
    report.checks.push('stale full/tail saves and model starts are rejected; real new native context ignores forged old native/history/handoff and excludes old compacted summary');

    source = await restoreUi(2, 'first actual run immediately followed by undo');
    assert.equal(source.id, original.id);
    assert.equal(source.conversationRevision, 2);
    assert.deepEqual(historicalContent(source.messages), historicalContent(original.messages));
    assert.equal(source.modelSelection.modelId, modelIds.later);
    assert.equal(source.openCodeSessionId || '', '');
    assert.deepEqual(source.messages.at(-1).agentRun.watchdog, laterWatchdog);
    const alternateBackup = await readSession(source.rewindState.backupSessionId);
    assert.deepEqual(historicalContent(alternateBackup.messages), historicalContent(afterRewind.messages), 'undo backs up the intervening alternate turn before restoring');
    assertFileUnchanged();
    const restored = source;
    await close();
    await launch();
    await switchTo(source.id);
    source = await readSession(source.id);
    assert.equal(source.conversationRevision, restored.conversationRevision);
    assert.deepEqual(source.messages, restored.messages);
    assert.deepEqual(source.modelSelection, restored.modelSelection);
    assert.deepEqual(source.rewindState, restored.rewindState);
    assert.deepEqual((await readSession(alternateBackup.id)).messages, alternateBackup.messages);
    assert.match(await page.locator('#rs-watchdog').innerText(), /REWIND_FUTURE_OBSERVER_8264/);
    await startUiRun(source.id, 'AFTER_UNDO');
    await waitUiRun('AFTER_UNDO');
    assertFileUnchanged();
    report.checks.push('undo restores the whole original conversation and model, backs up the alternate turn, survives full Electron restart, and reconstructs authoritative original history');

    await installResponseGate();
    await startUiRun(source.id, 'HOLD');
    const heldDeadline = Date.now() + 90_000;
    while (!heldRun && Date.now() < heldDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(heldRun, 'the actual native run is active');
    const activeRunId = await page.evaluate(id => getRunCtx(id).runId, source.id);
    const busySource = await readSession(source.id);
    const busy = await page.evaluate(payload => yan.rewindSession(payload), boundary(busySource));
    assert.equal(busy.ok, false);
    assert.equal(busy.code, 'SESSION_REWIND_BUSY');
    await page.evaluate(text => { setComposerText(text); updateSendState(); }, `${runMarker('QUEUED')}: Reply with the queued fixture confirmation.`);
    await page.locator('#queueTurnBtn').click();
    await page.waitForFunction(id => state.queuedTurns.has(id), source.id);
    const busyQueued = await page.evaluate(payload => yan.rewindSession(payload), boundary(busySource));
    assert.equal(busyQueued.ok, false);
    assert.equal(busyQueued.code, 'SESSION_REWIND_BUSY');
    assert.equal(await page.evaluate(({ id, runId }) => getRunCtx(id)?.runId === runId
      && !getRunCtx(id)?.runAbortController.signal.aborted, { id: source.id, runId: activeRunId }), true);
    assert.equal(heldRun.closedEarly, false);
    assert.deepEqual(await application.evaluate(() => globalThis.rewindTestGate.cancellations), []);
    heldRun.released = true;
    completion(heldRun.response, 'REWIND_REPLY_HOLD_8264', heldRun.model);
    await waitUiRun('HOLD');
    await page.waitForFunction(id => !state.activeRuns.has(id) && !state.queuedTurns.has(id)
      && state.currentSession.messages.some(message => message.content.includes('REWIND_REPLY_QUEUED_8264')), source.id,
    { timeout: 90_000 });
    assert.ok(report.requests.some(request => request.action === 'QUEUED'));
    source = await readSession(source.id);
    assert.equal(source.conversationRevision, 2, 'rejected rewinds never change the conversation revision');
    assert.ok(source.messages.some(message => message.content.includes('REWIND_REPLY_HOLD_8264')));
    assert.ok(source.messages.some(message => message.content.includes('REWIND_REPLY_QUEUED_8264')));
    assertFileUnchanged();
    other = await readSession(other.id);
    const queuedOnly = await page.evaluate(async ({ id, payload }) => {
      const result = await yan.yanCoreEnqueueIntent({ threadId: id, conversationRevision: 0, intentId: 'rewind-queued-only-fixture',
        intent: { prompt: 'A synthetic pending task with no active run', workMode: 'text' } });
      if (!result.ok) throw new Error(result.error);
      const rewind = await yan.rewindSession(payload);
      const deleted = await yan.yanCoreDeleteIntent('rewind-queued-only-fixture', 'fixture_finished');
      return { rewind, deleted };
    }, { id: other.id, payload: boundary(other, 0) });
    assert.equal(queuedOnly.rewind.ok, false);
    assert.equal(queuedOnly.rewind.code, 'SESSION_REWIND_BUSY', 'durable queued work alone prevents rewind');
    assert.deepEqual((await readSession(other.id)).messages, other.messages);
    report.checks.push('active and durable queued-only work reject rewind without cancellation; the actual held kernel and queued continuation both finish normally');

    // Exercise the run-completion/restore boundary repeatedly in the same
    // actual kernel, with no sleep to hide a late save or navigation race.
    for (let index = 0; index < 4; index++) {
      source = await readSession(source.id);
      const target = await readSession(source.rewindState.backupSessionId);
      const expected = target.messages.slice(0, target.rewindBackupOf.messageCount);
      await startUiRun(source.id, `STRESS_${index}`);
      await waitUiRun(`STRESS_${index}`);
      source = await restoreUi(source.conversationRevision + 1, `immediate run/undo stress ${index + 1}`);
      assert.deepEqual(historicalContent(source.messages), historicalContent(expected));
      assertFileUnchanged();
    }
    report.checks.push('four additional real model completions immediately followed by undo preserve expected revisions and snapshots without sleeps');
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.fixtureErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks, modelRequests: report.requests.length }));
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ sessionId: state.currentSession?.id,
        revision: state.currentSession?.conversationRevision, messagesStart: state.currentSession?.messagesStart,
        submissions: window.rewindSubmissions, directRuns: window.rewindDirectRuns,
        modal: document.querySelector('#genericConfirmModal')?.innerText,
        pendingRewinds: [...sessionRewindRequests.keys()], loadToken: sessionLoadToken })).catch(() => null);
      report.operations = await application.evaluate(() => globalThis.rewindTestGate).catch(() => null);
      if (source?.id) report.persisted = await readSession(source.id).catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (heldRun && !heldRun.released) { heldRun.released = true; heldRun.response.destroy(); }
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
    assert.ok(path.basename(target).startsWith('z-session-rewind-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
