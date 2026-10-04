'use strict';

// Isolated Electron UI/preload/IPC and real Observer HTTP requests. Only the
// primary Agent sidecar is a fixture; no model service outside localhost is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-observer-reasoning-'));
const outputDir = path.join(appRoot, 'output', 'observer-reasoning');
const configFile = path.join(profile, 'ZData', 'config.json');
const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
const modelId = 'claude-opus-4-7';
const routes = [
  { id: 'chat', apiFormat: 'openai', endpoint: 'chat/completions' },
  { id: 'anthropic', apiFormat: 'anthropic', endpoint: 'messages' },
  { id: 'responses', apiFormat: 'responses', endpoint: 'responses' }
];
const report = { ok: false, isolation: 'temporary profile, primary sidecar fixture, real Observer HTTP to localhost',
  checks: [], requests: [], runs: [], pageErrors: [], fixtureErrors: [] };
const key = connection => JSON.stringify([connection.providerId, connection.supplierId]);
fs.mkdirSync(outputDir, { recursive: true });
let application;
let page;

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST', 'manual fixture models need no remote catalog');
      const route = routes.find(item => request.url === `/${item.id}/v1/${item.endpoint}`);
      assert.ok(route, `unexpected localhost request ${request.url}`);
      const body = JSON.parse(raw || '{}');
      assert.equal(body.model, modelId);
      const internalFields = ['reasoningEffort', 'reasoningSpeed', 'reasoningEffortAdjusted', 'reasoningResolution']
        .filter(field => Object.hasOwn(body, field));
      assert.deepEqual(internalFields, [], 'internal configuration fields never leak into protocol bodies');
      // Retain only protocol option fields, never prompts or credentials.
      report.requests.push({ route: route.id, model: body.model,
        thinking: body.thinking ?? null, output_config: body.output_config ?? null,
        reasoning: body.reasoning ?? null, reasoning_effort: body.reasoning_effort ?? null,
        max_tokens: body.max_tokens ?? null, max_output_tokens: body.max_output_tokens ?? null,
        max_completion_tokens: body.max_completion_tokens ?? null });
      assert.ok(report.requests.length <= 24, 'Observer calls are bounded');
      const text = JSON.stringify({ action: 'observe', message: '现有证据显示任务正常推进。', evidence: [] });
      const payload = route.apiFormat === 'anthropic' ? { content: [{ type: 'text', text }] }
        : route.apiFormat === 'responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
          : { choices: [{ message: { role: 'assistant', content: text } }] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch (error) {
      report.fixtureErrors.push(error.message);
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
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && state.currentSession && state.config && window.ZConnectionControls);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
}

async function close() {
  if (application) await application.close();
  application = null;
  page = null;
}

async function publicSettings() {
  return page.evaluate(async () => {
    const config = await z.getConfig();
    return { observer: config.observer, mainEffort: config.api.reasoningSpeed, mainModel: config.agentModel };
  });
}

async function openObserver() {
  await page.locator('#zObserverPill').click();
  await page.waitForFunction(() => document.querySelector('#zConnectionDialog').open
    && !document.querySelector('#zConnectionSelect').disabled);
}

async function saveObserver() {
  await page.locator('#zConnectionSave').click();
  await page.waitForFunction(() => !document.querySelector('#zConnectionDialog').open);
}

async function selectObserver(connection, effort) {
  await openObserver();
  await page.locator('#zConnectionSelect').selectOption(key(connection));
  assert.equal(await page.locator('#zObserverReasoning').isEnabled(), true);
  await page.locator('#zConnectionModel').selectOption(modelId);
  await page.locator('#zObserverReasoning').selectOption(effort);
  await page.locator('#zObserverDetails').evaluate(node => { node.open = true; });
  await page.locator('#zObserverEvery').fill('2');
  await saveObserver();
  const settings = await publicSettings();
  assert.equal(settings.observer.reasoningEffort, effort);
  assert.equal(settings.observer.model.providerId, connection.providerId);
  assert.equal(settings.observer.model.supplierId, connection.supplierId);
  assert.equal(settings.mainEffort, 'low', 'Observer effort never alters primary Agent effort');
}

async function installPrimaryAgentFixture() {
  await application.evaluate(({ app }) => {
    const localRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/main.js`);
    const { OpenCodeSidecar } = localRequire('./lib/opencode-sidecar');
    const { ModelObserver } = localRequire('./lib/observer-model');
    globalThis.observerReasoningRuns = [];
    OpenCodeSidecar.prototype.run = async function (request) {
      if (!request.runId.startsWith('observer-reasoning-')) throw new Error('Unexpected primary Agent request');
      const connection = request.observerConnection;
      if (!connection || connection.unavailable) throw new Error('Observer connection was not resolved by main IPC');
      if (new URL(connection.baseUrl).hostname !== '127.0.0.1') throw new Error('Fixture must use localhost only');
      const mainOptions = request.openCodeConfig.provider[request.providerId].models[request.modelId].options;
      const states = [];
      const observer = new ModelObserver({ connection, goal: 'Inspect the isolated fixture without making changes.',
        judgeEvery: request.observerJudgeEvery, onState: state => states.push(state.phase),
        onGuidance: () => { throw new Error('Normal fixture work must not request guidance'); } });
      observer.observe([{ op: 'read', target: 'fixture.txt', plan: 'Read the fixture', mutated: false }]);
      if (observer.pending) throw new Error('Observer ignored configured two-action cadence');
      observer.observe([
        { op: 'read', target: 'fixture.txt', plan: 'Read the fixture', mutated: false },
        { op: 'verify', target: 'fixture.txt', plan: 'Check expected text', verify: 'passed', mutated: false }
      ]);
      await observer.pending;
      if (observer.state.checks !== 1 || observer.state.phase !== 'observing') {
        throw new Error(observer.state.error || 'The real Observer HTTP request did not complete');
      }
      globalThis.observerReasoningRuns.push({ runId: request.runId, model: connection.modelId,
        apiFormat: connection.apiFormat, observerEffort: connection.reasoningEffort,
        mainEffort: mainOptions.reasoningEffort || mainOptions.effort,
        capabilitiesSupplied: !!connection.capabilities, judgeEvery: request.observerJudgeEvery,
        checks: observer.state.checks, phases: states });
      observer.stop();
      return { status: 'done', text: 'OBSERVER_REASONING_FIXTURE_OK', reasoning: '',
        toolCalls: [], todos: [], changes: [], usage: { input: 0, output: 0, cost: 0 } };
    };
  });
}

async function runThroughMain(route, effort) {
  const runId = `observer-reasoning-${route}-${effort}`;
  await page.evaluate(({ runId }) => {
    window.observerReasoningCompleted ||= {};
    window.observerReasoningCompleted[runId] = { pending: true };
    const dispose = z.onOpenCodeCompleted(detail => {
      if (detail.runId !== runId) return;
      window.observerReasoningCompleted[runId] = detail.result;
      dispose();
    });
    z.openCodeStartRun({ runId, zSessionId: state.currentSession.id, utility: true,
      prompt: 'Exercise the isolated Observer request fixture.' }).then(result => {
      if (!result.ok) { window.observerReasoningCompleted[runId] = { error: result.error }; dispose(); }
    }).catch(error => { window.observerReasoningCompleted[runId] = { error: error.message }; dispose(); });
  }, { runId });
  await page.waitForFunction(id => !window.observerReasoningCompleted?.[id]?.pending, runId, { timeout: 30_000 });
  const result = await page.evaluate(id => window.observerReasoningCompleted[id], runId);
  assert.equal(result.status, 'done', result.error);
  assert.equal(result.text, 'OBSERVER_REASONING_FIXTURE_OK');
}

function assertWire(wire, route, effort) {
  assert.equal(wire.route, route);
  assert.equal(wire.model, modelId);
  if (route === 'anthropic') {
    assert.deepEqual(wire.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(wire.output_config, { effort });
    assert.equal(wire.reasoning, null);
    assert.equal(wire.reasoning_effort, null);
  } else if (route === 'responses') {
    assert.deepEqual(wire.reasoning, { effort });
    assert.equal(wire.thinking, null);
    assert.equal(wire.output_config, null);
    assert.equal(wire.reasoning_effort, null);
  } else {
    assert.equal(wire.reasoning_effort, effort);
    assert.equal(wire.thinking, null);
    assert.equal(wire.output_config, null);
    assert.equal(wire.reasoning, null);
  }
  const outputLimit = wire.max_tokens ?? wire.max_output_tokens ?? wire.max_completion_tokens;
  assert.equal(outputLimit, 32_768, 'Observer output budget leaves room for reasoning and final JSON');
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    await page.evaluate(() => z.setConfig({ api: { reasoningSpeed: 'low' } }));
    await close();
    assert.ok(path.resolve(configFile).startsWith(path.resolve(profile) + path.sep));
    const legacy = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    legacy.observer = { ...(legacy.observer || {}), model: null, judgeEvery: 2 };
    delete legacy.observer.reasoningEffort;
    fs.writeFileSync(configFile, JSON.stringify(legacy, null, 2));
    await launch();
    let settings = await publicSettings();
    assert.equal(settings.mainEffort, 'low');
    assert.equal(settings.observer.reasoningEffort, 'max', 'existing profiles without the field default to max');
    assert.equal((await page.evaluate(() => z.listModelConnections())).observer.reasoningEffort, 'max');
    await openObserver();
    assert.equal(await page.locator('#zObserverReasoning').inputValue(), 'max');
    assert.equal(await page.locator('#zObserverReasoning').isDisabled(), true);
    assert.deepEqual(await page.locator('#zObserverReasoning option').evaluateAll(nodes => nodes.map(node => node.value)), levels);
    assert.match(await page.locator('#zObserverReasoningHint').innerText(), /规则模式/);
    await page.locator('#zConnectionCancel').click();
    report.checks.push('old profile migration and public IPC default to max; rules-only mode disables all five-level selection');

    const connections = await page.evaluate(async ({ port, routes, modelId }) => {
      const savedConnections = {};
      for (const route of routes) {
        const saved = await z.connectionsSave({ name: `Observer fixture ${route.id}`,
          preset: route.apiFormat === 'anthropic' ? 'anthropic' : 'openai', apiFormat: route.apiFormat,
          manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/${route.id}/v1`, apiKey: 'local-fixture-only' });
        if (!saved.ok) throw new Error(saved.error || 'Cannot save fixture connection');
        savedConnections[route.id] = saved.connection;
      }
      state.config = await z.getConfig();
      const selected = await z.setSessionModel(state.currentSession.id, state.config.agentModel);
      if (!selected.ok) throw new Error(selected.error || 'Cannot select the fixture Agent model');
      state.currentSession.modelSelection = selected.modelSelection;
      renderModelBadge();
      return savedConnections;
    }, { port: server.address().port, routes, modelId });
    const mainModel = (await publicSettings()).mainModel;
    await selectObserver(connections.anthropic, 'high');
    await openObserver();
    assert.match(await page.locator('#zObserverReasoningHint').innerText(), /与主模型独立/);
    await page.locator('#zObserverReasoning').selectOption('xhigh');
    await page.locator('#zConnectionSelect').selectOption('rules');
    assert.equal(await page.locator('#zObserverReasoning').isDisabled(), true);
    assert.equal(await page.locator('#zObserverReasoning').inputValue(), 'xhigh');
    await page.locator('#zConnectionSelect').selectOption(key(connections.responses));
    assert.equal(await page.locator('#zObserverReasoning').isEnabled(), true);
    assert.equal(await page.locator('#zObserverReasoning').inputValue(), 'xhigh');
    await page.locator('#zConnectionCancel').click();
    assert.equal((await publicSettings()).observer.reasoningEffort, 'high', 'cancelling leaves the saved effort intact');
    await openObserver();
    await page.locator('#zConnectionSelect').selectOption('rules');
    await saveObserver();
    settings = await publicSettings();
    assert.equal(settings.observer.model, null);
    assert.equal(settings.observer.reasoningEffort, 'high', 'rules mode retains the independent effort');
    await selectObserver(connections.anthropic, 'high');
    assert.deepEqual((await publicSettings()).mainModel, mainModel, 'Observer model changes do not change the Agent model');
    report.checks.push('Observer model/effort and primary Agent model/effort remain independent; rules toggle retains drafts; cancel does not save');

    await page.evaluate(() => applyLanguage('en'));
    await openObserver();
    assert.equal(await page.locator('label[for="zObserverReasoning"]').innerText(), 'Observer reasoning strength');
    await page.screenshot({ path: path.join(outputDir, 'observer-effort-english.png') });
    await page.locator('#zConnectionCancel').click();
    await page.evaluate(() => applyLanguage('zh-CN'));
    await close();
    await launch();
    settings = await publicSettings();
    assert.equal(settings.observer.reasoningEffort, 'high');
    assert.equal(settings.observer.model.providerId, connections.anthropic.providerId);
    assert.equal(settings.observer.judgeEvery, 2);
    assert.equal(settings.mainEffort, 'low');
    await openObserver();
    assert.equal(await page.locator('#zObserverReasoning').inputValue(), 'high');
    assert.equal(await page.locator('#zConnectionSelect').inputValue(), key(connections.anthropic));
    await page.screenshot({ path: path.join(outputDir, 'observer-effort-restored.png') });
    await page.locator('#zConnectionCancel').click();
    report.checks.push('Observer model, cadence, effort and separate Agent effort survive restart; control is localized');

    await installPrimaryAgentFixture();
    for (const route of routes) {
      for (const effort of levels) {
        await selectObserver(connections[route.id], effort);
        const previousRequests = report.requests.length;
        await runThroughMain(route.id, effort);
        assert.equal(report.requests.length, previousRequests + 1, 'two actions trigger exactly one real Observer HTTP call');
        assertWire(report.requests.at(-1), route.id, effort);
      }
    }
    report.runs = await application.evaluate(() => globalThis.observerReasoningRuns);
    assert.equal(report.runs.length, 15);
    for (const run of report.runs) {
      assert.equal(run.mainEffort, 'low');
      assert.equal(run.capabilitiesSupplied, true);
      assert.equal(run.checks, 1);
      assert.equal(run.judgeEvery, 2);
      assert.deepEqual(run.phases, ['reviewing', 'observing', 'stopped']);
      assert.equal(run.observerEffort, run.runId.split('-').at(-1));
    }
    assert.equal((await publicSettings()).mainEffort, 'low');
    report.checks.push('all 15 saved effort/protocol combinations propagate through real main IPC into ModelObserver and real localhost HTTP; main effort remains low');

    const { reviewWithModel, observerInput } = require('../lib/observer-model');
    for (const route of routes) {
      const before = report.requests.length;
      const verdict = await reviewWithModel({ baseUrl: `http://127.0.0.1:${server.address().port}/${route.id}/v1`,
        apiKey: 'local-fixture-only', apiFormat: route.apiFormat, modelId },
      observerInput('Check the isolated fixture.', [{ op: 'read', target: 'fixture.txt' }], null));
      assert.equal(verdict.action, 'observe');
      assert.equal(report.requests.length, before + 1);
      assertWire(report.requests.at(-1), route.id, 'max');
    }
    report.checks.push('direct legacy Observer connections without reasoningEffort send max on Anthropic 4.7, Responses and Chat');
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.fixtureErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, runs: report.runs.length, requests: report.requests.length }));
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    await close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    const target = path.resolve(profile);
    if (path.dirname(target) === temporaryRoot && path.basename(target).startsWith('z-observer-reasoning-')) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
