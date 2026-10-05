'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-session-model-isolation-'));
const outputDir = path.join(appRoot, 'output', 'session-model-isolation');
fs.mkdirSync(outputDir, { recursive: true });
const report = { ok: false, checks: [], pageErrors: [], requests: [] };
const fixtureErrors = [];
const sessionEfforts = new Map();
const modelIds = { a: ['route-a-one', 'route-a-two'], b: ['route-b-one'] };
const key = connection => JSON.stringify([connection.providerId, connection.supplierId]);
const identity = selection => [selection?.providerId || '', selection?.supplierId || '', selection?.modelId || '', selection?.modelType || 'text'];
let application;
let page;

function completion(response, model, text) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const payload = { id: 'session-model-fixture', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  payload.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end('data: [DONE]\n\n');
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      const match = request.url.match(/^\/([ab])\/v1\/(models|chat\/completions)$/);
      assert.ok(match, `unexpected fixture request: ${request.method} ${request.url}`);
      const gateway = match[1];
      assert.equal(request.headers.authorization, `Bearer local-fixture-key-${gateway}`, 'the selected supplier supplies its own credential');
      if (match[2] === 'models') {
        assert.equal(request.method, 'GET');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ object: 'list', data: modelIds[gateway].map(id => ({ id, object: 'model', name: id })) }));
      }
      assert.equal(request.method, 'POST');
      const body = JSON.parse(raw || '{}');
      assert.ok(modelIds[gateway].includes(body.model), `model ${body.model} was sent to the wrong supplier ${gateway}`);
      const userText = JSON.stringify((body.messages || []).findLast(message => message.role === 'user')?.content || '');
      const marker = userText.match(/SESSION_ROUTE_(?:A|B|BACKEND|SNAPSHOT)_4197/)?.[0] || '';
      report.requests.push({ gateway, model: body.model, marker, endpoint: request.url, reasoningEffort: body.reasoning_effort });
      assert.ok(report.requests.length <= 40, 'the fixture must not enter an unbounded loop');
      if (marker) {
        const expected = marker === 'SESSION_ROUTE_B_4197' ? 'route-b-one'
          : marker === 'SESSION_ROUTE_SNAPSHOT_4197' ? 'route-a-one' : 'route-a-two';
        assert.equal(body.model, expected, `${marker} retains the intended conversation model`);
        const effort = marker === 'SESSION_ROUTE_B_4197' ? 'low'
          : marker === 'SESSION_ROUTE_SNAPSHOT_4197' ? 'xhigh' : 'max';
        assert.equal(body.reasoning_effort, effort, `${marker} retains the intended conversation reasoning effort on the wire`);
      }
      // Keep auxiliary title/memory work on this fixture too. The test never
      // supplies remote endpoints or actual API keys to the isolated profile.
      completion(response, body.model, `MODEL_REPLY_${body.model}`);
    } catch (error) {
      fixtureErrors.push(error.message);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile,
    Z_E2E_PARENT_PID: String(process.pid), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    page = application.windows().find(window => /\/renderer\/index\.html/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'the isolated main window exists');
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  assert.equal(await page.evaluate(() => typeof z.setSessionModel), 'function');
}

async function openModelMenu({ models = false } = {}) {
  await page.locator('#modelPill').click();
  await page.waitForFunction(() => !document.querySelector('#modelQuickMenu').classList.contains('hidden')
    && document.querySelector('#modelQuickMenu').getAttribute('aria-busy') === 'false');
  if (models && !await page.locator('#modelQuickModelsView').isVisible()) await page.locator('#modelQuickModelRoute').click();
}

async function selectModel(sessionId, connection, modelId) {
  await page.evaluate(id => loadSession(id), sessionId);
  await openModelMenu({ models: true });
  await page.locator('#modelQuickSupplier').selectOption(key(connection));
  await page.locator(`#modelQuickList [data-model-picker-model="${modelId}"]`).click();
  await page.waitForFunction(expected => !modelPickerSaving && state.currentSession.id === expected.sessionId
    && state.currentSession.modelSelection?.providerId === expected.providerId
    && state.currentSession.modelSelection?.modelId === expected.modelId,
  { sessionId, providerId: connection.providerId, modelId });
  assert.equal(await page.locator('#modelPillName').textContent(), modelId);
  await page.keyboard.press('Escape');
  const saved = await page.evaluate(id => z.getSession(id), sessionId);
  assert.deepEqual(identity(saved.modelSelection), [connection.providerId, connection.supplierId, modelId, 'text']);
}

async function verifySelected(sessionId, connection, modelId) {
  await page.evaluate(id => loadSession(id), sessionId);
  await page.waitForFunction(model => document.querySelector('#modelPillName').textContent === model, modelId);
  assert.deepEqual(identity(await page.evaluate(() => getAgentModelSelection())),
    [connection.providerId, connection.supplierId, modelId, 'text']);
  const effort = sessionEfforts.get(sessionId);
  if (effort) {
    assert.equal(await page.evaluate(() => getReasoningSpeedMode()), effort);
    assert.equal(await page.locator('#modelPill').getAttribute('data-reasoning-mode'), effort);
  }
  await openModelMenu({ models: true });
  assert.equal(await page.locator('#modelQuickSupplier').inputValue(), key(connection));
  const selected = page.locator('#modelQuickList [aria-selected="true"]');
  assert.equal(await selected.count(), 1);
  assert.equal(await selected.getAttribute('data-model-picker-model'), modelId);
  await page.keyboard.press('Escape');
}

async function selectEffort(sessionId, effort) {
  await page.evaluate(id => loadSession(id), sessionId);
  await openModelMenu();
  await page.locator('#reasoningSpeedSlider').evaluate((slider, value) => {
    slider.value = String(value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }, ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(effort) * 25);
  await page.waitForFunction(value => !modelQuickSaving && state.currentSession.modelSelection.reasoningSpeed === value, effort);
  assert.equal((await page.evaluate(id => z.getSession(id), sessionId)).modelSelection.reasoningSpeed, effort);
  sessionEfforts.set(sessionId, effort);
  await page.keyboard.press('Escape');
}

async function runBackend(sessionId, marker, modelSelection) {
  const runId = `session-model-${marker.toLowerCase()}`;
  await page.evaluate(({ sessionId, marker, runId, modelSelection }) => {
    window.sessionModelDirectRuns ||= {};
    const stop = z.onOpenCodeCompleted(detail => {
      if (detail.runId !== runId) return;
      window.sessionModelDirectRuns[runId] = { result: detail.result };
      stop();
    });
    window.sessionModelDirectRuns[runId] = { pending: true };
    z.openCodeStartRun({ runId, zSessionId: sessionId, utility: true, prompt: `${marker}: Reply with the model fixture result.`,
      ...(modelSelection ? { modelSelection } : {}) }).then(started => {
      if (!started.ok) { window.sessionModelDirectRuns[runId] = { error: started.error }; stop(); }
    }).catch(error => { window.sessionModelDirectRuns[runId] = { error: error.message }; stop(); });
  }, { sessionId, marker, runId, modelSelection });
  await page.waitForFunction(id => !window.sessionModelDirectRuns?.[id]?.pending, runId, { timeout: 90_000 });
  const completed = await page.evaluate(id => window.sessionModelDirectRuns[id], runId);
  assert.equal(completed.error, undefined, completed.error);
  assert.equal(completed.result.status, 'done', completed.result.error);
  return completed.result;
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    const connections = await page.evaluate(async port => {
      const result = [];
      for (const gateway of ['a', 'b']) {
        const saved = await z.connectionsSave({ name: `Fixture ${gateway.toUpperCase()}`, preset: 'openai', apiFormat: 'openai',
          baseUrl: `http://127.0.0.1:${port}/${gateway}/v1`, apiKey: `local-fixture-key-${gateway}`, streamEnabled: true });
        if (!saved.ok) throw new Error(saved.error || 'Fixture connection could not be saved');
        result.push(saved.connection);
      }
      state.config = await z.getConfig();
      renderModelBadge();
      return result;
    }, server.address().port);
    const [aConnection, bConnection] = connections;
    const globalDefault = await page.evaluate(() => z.getConfig().then(config => config.agentModel));
    assert.deepEqual(identity(globalDefault), [aConnection.providerId, aConnection.supplierId, 'route-a-one', 'text']);
    const sessions = await page.evaluate(async () => {
      const result = [];
      for (const name of ['Conversation A', 'Conversation B']) {
        const session = await z.createSession(true);
        session.title = name;
        session.messages = [{ role: 'user', content: `Keep ${name} for model isolation`, ts: Date.now() }];
        await z.saveSession(session);
        result.push(session);
      }
      await refreshSessions(); renderSessionList();
      return result;
    });
    const [sessionA, sessionB] = sessions;
    for (const session of sessions) {
      assert.deepEqual(identity(session.modelSelection), identity(globalDefault));
      assert.ok(path.resolve(session.workspace).startsWith(path.resolve(profile) + path.sep));
    }
    await selectModel(sessionA.id, aConnection, 'route-a-two');
    await selectModel(sessionB.id, bConnection, 'route-b-one');
    const globalEffort = await page.evaluate(() => z.getConfig().then(config => config.api.reasoningSpeed));
    await selectEffort(sessionA.id, 'max');
    await selectEffort(sessionB.id, 'low');
    for (let index = 0; index < 2; index++) {
      await verifySelected(sessionA.id, aConnection, 'route-a-two');
      await verifySelected(sessionB.id, bConnection, 'route-b-one');
    }
    assert.deepEqual(identity(await page.evaluate(() => z.getConfig().then(config => config.agentModel))), identity(globalDefault));
    report.checks.push('A/B menus, supplier selection and badges remain independent through repeated navigation');
    assert.equal(await page.evaluate(() => z.getConfig().then(config => config.api.reasoningSpeed)), globalEffort);
    report.checks.push('A/B reasoning sliders persist max/low independently and leave the new-conversation default unchanged');

    await selectModel(sessionA.id, aConnection, 'route-a-one');
    await verifySelected(sessionB.id, bConnection, 'route-b-one');
    await selectModel(sessionA.id, aConnection, 'route-a-two');
    assert.deepEqual(identity(await page.evaluate(() => z.getConfig().then(config => config.agentModel))), identity(globalDefault));
    report.checks.push('changing A affects neither B nor the global new-conversation default');

    const snapshotSession = await page.evaluate(() => z.createSession(true));
    assert.deepEqual(identity(snapshotSession.modelSelection), identity(globalDefault));
    assert.equal(snapshotSession.modelSelection.reasoningSpeed, globalEffort);
    await page.evaluate(connection => z.setModelRole(connection.providerId, 'route-b-one', 'text', connection.supplierId), bConnection);
    const snapshotStill = await page.evaluate(id => z.getSession(id), snapshotSession.id);
    assert.deepEqual(identity(snapshotStill.modelSelection), identity(globalDefault));
    const newerSession = await page.evaluate(() => z.createSession(true));
    assert.deepEqual(identity(newerSession.modelSelection), [bConnection.providerId, bConnection.supplierId, 'route-b-one', 'text']);
    await verifySelected(sessionA.id, aConnection, 'route-a-two');
    await page.evaluate(connection => z.setModelRole(connection.providerId, 'route-a-one', 'text', connection.supplierId), aConnection);
    report.checks.push('new conversations take a one-time default snapshot, unaffected by later global changes');

    await application.close(); application = null; page = null;
    await launch();
    await verifySelected(sessionA.id, aConnection, 'route-a-two');
    await verifySelected(sessionB.id, bConnection, 'route-b-one');
    assert.deepEqual(identity(await page.evaluate(() => z.getConfig().then(config => config.agentModel))), identity(globalDefault));
    report.checks.push('conversation model choices and global default survive a full app restart');

    // Submit A from the background while B is selected. Neither call passes an
    // explicit model override: each must freeze its own session's selection.
    await page.evaluate(async ({ aId, bId }) => {
      const a = await z.getSession(aId);
      const b = state.currentSession;
      if (b.id !== bId) throw new Error('Conversation B must be visible');
      window.sessionModelSubmissions = {};
      for (const [label, session] of [['A', a], ['B', b]]) {
        submitMessage(`SESSION_ROUTE_${label}_4197: Reply with the model fixture result.`, [], [], { session })
          .then(result => { window.sessionModelSubmissions[label] = result; })
          .catch(error => { window.sessionModelSubmissions[label] = { ok: false, error: error.message }; });
      }
    }, { aId: sessionA.id, bId: sessionB.id });
    await page.waitForFunction(() => window.sessionModelSubmissions?.A && window.sessionModelSubmissions?.B, null, { timeout: 120_000 });
    const submissions = await page.evaluate(() => window.sessionModelSubmissions);
    assert.equal(submissions.A.ok, true, submissions.A.error);
    assert.equal(submissions.B.ok, true, submissions.B.error);
    assert.ok(report.requests.some(item => item.marker === 'SESSION_ROUTE_A_4197' && item.gateway === 'a' && item.model === 'route-a-two'));
    assert.ok(report.requests.some(item => item.marker === 'SESSION_ROUTE_B_4197' && item.gateway === 'b' && item.model === 'route-b-one'));
    for (const [session, model] of [[sessionA, 'route-a-two'], [sessionB, 'route-b-one']]) {
      const saved = await page.evaluate(id => z.getSession(id), session.id);
      assert.equal(saved.modelSelection.modelId, model);
      assert.ok(saved.messages.some(message => message.role === 'assistant' && message.content.includes(`MODEL_REPLY_${model}`)));
      assert.equal(saved.messages.findLast(message => message.role === 'user').modelSelection.modelId, model);
      assert.equal(saved.messages.findLast(message => message.role === 'user').modelSelection.reasoningSpeed, sessionEfforts.get(session.id));
    }
    report.checks.push('concurrent real OpenCode turns use each conversation supplier, credential and model');

    const backend = await runBackend(sessionA.id, 'SESSION_ROUTE_BACKEND_4197');
    assert.match(backend.text, /MODEL_REPLY_route-a-two/);
    const frozen = { ...globalDefault, modelId: 'route-a-one', modelType: 'text', reasoningSpeed: 'xhigh' };
    const snapshot = await runBackend(sessionA.id, 'SESSION_ROUTE_SNAPSHOT_4197', frozen);
    assert.match(snapshot.text, /MODEL_REPLY_route-a-one/);
    await verifySelected(sessionA.id, aConnection, 'route-a-two');
    await verifySelected(sessionB.id, bConnection, 'route-b-one');
    assert.deepEqual(identity(await page.evaluate(() => z.getConfig().then(config => config.agentModel))), identity(globalDefault));
    report.checks.push('backend session routing and a frozen per-turn override do not mutate saved or global choices');
    assert.deepEqual(fixtureErrors, []);
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error.stack || error.message;
    report.fixtureErrors = fixtureErrors;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ model: state.currentSession?.modelSelection, badge: document.querySelector('#modelPillName')?.textContent,
        menuNotice: document.querySelector('#modelPickerMenuNotice')?.textContent, submissions: window.sessionModelSubmissions })).catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    // Shut down only this launch, never another desktop app or kernel process.
    if (page && !page.isClosed()) await page.evaluate(async () => {
      const runs = await z.openCodeSyncActiveRuns();
      for (const run of runs?.runs || []) await z.openCodeCancelRun(run.runId).catch(() => {});
    }).catch(() => {});
    await application?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-session-model-isolation-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
