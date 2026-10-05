'use strict';

// Real isolated Electron, main IPC and bundled kernel. The model is a held
// localhost stream, so running/queued config snapshots can be inspected safely.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-session-context-threshold-'));
const output = path.join(appRoot, 'output', 'session-context-threshold');
const modelId = 'context-threshold-fixture';
const report = { ok: false, checks: [], requests: [], nativeConfigs: [], pageErrors: [], fixtureErrors: [] };
const marker = action => `CTX_THRESHOLD_${action}_8021`;
let application;
let page;
let held;
let highUsageSent = false;
fs.mkdirSync(output, { recursive: true });

function emit(response, content, finish = false, inputTokens = 1000) {
  const chunk = { id: 'context-threshold-fixture', object: 'chat.completion.chunk', model: modelId,
    choices: [{ index: 0, delta: finish ? {} : { role: 'assistant', content }, finish_reason: finish ? 'stop' : null }] };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (finish) {
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [],
      usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model' }] }));
  }
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
      const body = JSON.parse(raw);
      assert.equal(body.model, modelId);
      const prompt = JSON.stringify((body.messages || []).findLast(message => message.role === 'user')?.content || '');
      const action = body.tools?.length ? [...prompt.matchAll(/CTX_THRESHOLD_(HOLD|QUEUED|NEXT|DEFAULT)_8021/g)].at(-1)?.[1] : '';
      report.requests.push({ action: action || 'auxiliary', model: body.model });
      assert.ok(report.requests.length <= 30, 'bounded localhost model work');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.flushHeaders();
      if (action === 'HOLD') {
        assert.ok(!held, 'only one held run');
        held = { response, released: false };
        emit(response, 'Threshold fixture is waiting.');
        return;
      }
      const inputTokens = action === 'NEXT' && !highUsageSent ? 600_000 : 1000;
      if (inputTokens === 600_000) highUsageSent = true;
      emit(response, action ? `CTX_REPLY_${action}_8021` : 'CTX_COMPACT_SUMMARY_8021: Keep the original goal and continue only when asked.');
      emit(response, '', true, inputTokens);
    } catch (error) {
      report.fixtureErrors.push(error.message);
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
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
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), profile);
  await application.evaluate(({ app }) => {
    const localRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/main.js`);
    const { OpenCodeSidecar } = localRequire('./lib/opencode-sidecar');
    const original = OpenCodeSidecar.prototype.run;
    globalThis.contextThresholdRuns = [];
    OpenCodeSidecar.prototype.run = async function (request = {}, onEvent = () => {}) {
      const action = [...String(request.prompt || '').matchAll(/CTX_THRESHOLD_(HOLD|QUEUED|NEXT|DEFAULT)_8021/g)].at(-1)?.[1];
      if (!action || this.kernelPoolingEnabled) return original.call(this, request, onEvent);
      const record = { action, runId: request.runId, requestThreshold: request.openCodeConfig?.compaction?.threshold, compressions: [] };
      globalThis.contextThresholdRuns.push(record);
      let inspection;
      try {
        return await original.call(this, request, event => {
          if (event?.type === 'z.opencode.started' && !inspection) {
            inspection = this.client.config.get({ directory: request.workspace }).then(result => {
              if (result.error) throw new Error(JSON.stringify(result.error));
              record.nativeThreshold = result.data?.compaction?.threshold;
              record.nativeCompaction = result.data?.compaction || null;
              record.nativeConfigurationReady = true;
            }).catch(error => { record.error = error.message; });
          }
          if (event?.type === 'z.context.budget') {
            record.effectiveThreshold = event.data?.softThreshold;
            record.contextWindow = event.data?.contextWindow;
          }
          if (event?.type?.startsWith('z.context.compression.')) {
            const data = event.data || {};
            record.compressions.push({ type: event.type, beforeTokens: data.beforeTokens, afterTokens: data.afterTokens,
              threshold: data.threshold, automatic: data.automatic, message: data.message });
            if (event.type === 'z.context.compression.completed') {
              inspection = Promise.resolve(inspection).then(async () => {
                const history = await this.client.session.messages({ sessionID: data.sessionID, directory: request.workspace });
                if (history.error) throw new Error(JSON.stringify(history.error));
                record.nativeSummaries = (history.data || []).filter(message => message.info?.summary
                  && message.parts?.some(part => part.type === 'text' && part.text?.includes('CTX_COMPACT_SUMMARY_8021'))).length;
              }).catch(error => { record.error = error.message; });
            }
          }
          return onEvent(event);
        });
      } finally { if (inspection) await inspection; }
    };
  });
}

async function switchTo(id) {
  await page.evaluate(id => loadSession(id), id);
  await page.waitForFunction(id => state.currentSession?.id === id && !observerPendingSessionId, id);
}

async function openEditor(id) {
  if (id) await switchTo(id);
  if (!await page.locator('#contextRingPanel').isVisible()) await page.locator('#contextRingBtn').click();
  await page.locator('#contextRingPanel:not(.hidden)').waitFor();
  const toggle = page.locator('#contextThresholdToggle');
  assert.equal(await toggle.getAttribute('aria-controls'), 'contextThresholdEditor');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('#contextThresholdEditor:not(.hidden)').waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
}

async function saveThreshold(id, thousands) {
  await openEditor(id);
  await page.locator('#contextQuickThresholdInput').fill(String(thousands));
  await page.locator('#contextQuickThresholdSave').click();
  const tokens = Math.round(Number(thousands) * 1000);
  await page.waitForFunction(async ({ id, tokens }) => {
    const saved = await z.getSession(id);
    return saved?.modelSelection?.compactionThreshold === tokens
      && state.currentSession?.id === id && state.currentSession.modelSelection?.compactionThreshold === tokens;
  }, { id, tokens });
  return tokens;
}

async function verifyThreshold(id, tokens) {
  await openEditor(id);
  assert.equal(Number(await page.locator('#contextQuickThresholdInput').inputValue()), tokens / 1000);
  const percent = parseFloat(await page.locator('#contextQuickThresholdPercent').textContent());
  assert.ok(Math.abs(percent - tokens / 10_000) < 0.051, `percentage ${percent} must represent ${tokens} / 1M`);
  assert.equal((await page.evaluate(id => z.getSession(id), id)).modelSelection.compactionThreshold, tokens);
}

async function startRun(id, action) {
  await switchTo(id);
  await page.evaluate(({ id, action }) => {
    window.contextThresholdSubmissions ||= {};
    submitMessage(`CTX_THRESHOLD_${action}_8021: Reply only with the fixture confirmation.`, [], [], { session: state.currentSession })
      .then(result => { window.contextThresholdSubmissions[action] = result; })
      .catch(error => { window.contextThresholdSubmissions[action] = { ok: false, error: error.message }; });
  }, { id, action });
}

async function nativeConfig(action, expected) {
  const deadline = Date.now() + 20_000;
  let record;
  while (Date.now() < deadline) {
    record = await application.evaluate((_electron, action) => globalThis.contextThresholdRuns.find(record => record.action === action), action);
    if ((record?.effectiveThreshold && record?.nativeConfigurationReady) || record?.error) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(record, `${action}: real native run recorded`);
  assert.equal(record.error, undefined, record.error);
  assert.equal(record.requestThreshold, expected, `${action}: main supplies the submitted threshold`);
  assert.equal(record.effectiveThreshold, expected, `${action}: the real running sidecar reports its effective compaction threshold`);
  assert.equal(record.contextWindow, 1_000_000);
  // Z applies its threshold through the sidecar compaction policy. Stock
  // OpenCode filters that extension out of /config, but must keep compaction
  // enabled; the real emitted budget is what drives the running policy.
  assert.equal(record.nativeCompaction.auto, true);
  if (record.nativeThreshold !== undefined) assert.equal(record.nativeThreshold, expected);
  return record;
}

async function waitFinished(id, action) {
  await page.waitForFunction(({ id, action }) => !state.activeRuns.has(id)
    && state.currentSession?.messages.some(message => message.role === 'assistant'
      && message.content.includes(`CTX_REPLY_${action}_8021`)), { id, action }, { timeout: 90_000 });
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    const sessions = await page.evaluate(async ({ port, modelId }) => {
      const saved = await z.connectionsSave({ name: 'Context threshold fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!saved.ok) throw new Error(saved.error);
      await z.setConfig({ context: { maxTokens: 1_000_000, compactionThreshold: 800_000 },
        agent: { accessMode: 'full', workMode: 'normal' } });
      state.config = await z.getConfig();
      const records = [];
      for (const title of ['Threshold A', 'Threshold B']) {
        const session = await z.createSession(true);
        session.title = title;
        session.messages = [{ role: 'user', content: `Retain ${title}`, ts: Date.now() }];
        await z.saveSession(session); records.push(session);
      }
      await refreshSessions();
      return records;
    }, { port: server.address().port, modelId });
    const [a, b] = sessions;
    await openEditor(a.id);
    await page.locator('#contextThresholdToggle').click();
    assert.equal(await page.locator('#contextThresholdToggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#contextThresholdEditor').isVisible(), false);
    await openEditor();
    await page.locator('#contextQuickThresholdRange').evaluate(range => {
      range.value = '33'; range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(Number(await page.locator('#contextQuickThresholdInput').inputValue()), 330);
    assert.equal(parseFloat(await page.locator('#contextQuickThresholdPercent').textContent()), 33);
    await saveThreshold(a.id, 250.5);
    await verifyThreshold(a.id, 250_500);
    report.checks.push('title arrow expands/collapses the editor; percentage slider and decimal K input agree and persist');

    for (const invalid of ['0', '1000', '1000.1']) {
      await page.locator('#contextQuickThresholdInput').fill(invalid);
      const save = page.locator('#contextQuickThresholdSave');
      if (await save.isEnabled()) await save.click();
      assert.equal((await page.evaluate(id => z.getSession(id), a.id)).modelSelection.compactionThreshold, 250_500);
      assert.ok((await save.isDisabled()) || String(await page.locator('#contextQuickThresholdNotice').textContent()).trim(),
        `${invalid}K must be rejected with disabled saving or an explanatory notice`);
    }
    await verifyThreshold(b.id, 800_000);
    await verifyThreshold(a.id, 250_500);
    const global = await page.evaluate(() => z.getConfig().then(config => config.context));
    assert.equal(global.maxTokens, 1_000_000);
    assert.equal(global.compactionThreshold, 800_000);
    report.checks.push('out-of-range values are rejected; A/B selections are independent and global 1M/800K settings stay unchanged');

    await application.close(); application = null; page = null;
    await launch();
    await verifyThreshold(a.id, 250_500);
    await verifyThreshold(b.id, 800_000);
    report.checks.push('per-conversation thresholds survive a full isolated application restart');

    await startRun(a.id, 'HOLD');
    const holdDeadline = Date.now() + 60_000;
    while (!held && Date.now() < holdDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(held, 'the live model stream reached the localhost server');
    await nativeConfig('HOLD', 250_500);
    await saveThreshold(a.id, 400);
    const active = await page.evaluate(() => ({
      threshold: getRunCtx(state.currentSession.id)?.runBudget?.compressSoftThreshold,
      aria: document.querySelector('#contextRingBtn').getAttribute('aria-valuetext'),
      hint: document.querySelector('#contextQuickThresholdHint').textContent
    }));
    assert.equal(active.threshold, 250_500, 'changing preference leaves the live turn budget frozen');
    assert.match(active.aria, /250(?:\.5)?K|251K/);
    assert.match(active.hint, /下(?:次|轮)|本轮|当前/);
    assert.match(active.hint, /250(?:\.5)?|251|400/);
    await page.locator('#composerInput').fill('CTX_THRESHOLD_QUEUED_8021: Reply only with the fixture confirmation.');
    await page.locator('#queueTurnBtn').click();
    await page.waitForFunction(id => state.queuedTurns.get(id)?.modelSelection?.compactionThreshold === 400_000, a.id);
    await page.waitForFunction(async id => Object.values((await z.zCoreGetState()).intents || {}).some(intent =>
      intent.threadId === id && intent.intent?.prompt?.includes('CTX_THRESHOLD_QUEUED_8021')
      && intent.intent.modelSelection?.compactionThreshold === 400_000), a.id);
    await saveThreshold(a.id, 500);
    await verifyThreshold(b.id, 800_000);
    await openEditor(a.id);
    assert.equal(Number(await page.locator('#contextQuickThresholdInput').inputValue()), 500);
    assert.equal(await page.evaluate(() => getRunCtx(state.currentSession.id).runBudget.compressSoftThreshold), 250_500);
    await nativeConfig('HOLD', 250_500);
    held.released = true;
    emit(held.response, 'CTX_REPLY_HOLD_8021'); emit(held.response, '', true);
    await waitFinished(a.id, 'QUEUED');
    await nativeConfig('QUEUED', 400_000);
    await verifyThreshold(a.id, 500_000);
    const lowRuns = await application.evaluate(() => globalThis.contextThresholdRuns.filter(record => ['HOLD', 'QUEUED'].includes(record.action)));
    assert.ok(lowRuns.every(record => record.compressions.length === 0), 'below-threshold actual turns do not request compaction');
    report.checks.push('active native turn stays at 250.5K; queued turn freezes 400K while current preference advances independently to 500K');

    await startRun(a.id, 'NEXT');
    await waitFinished(a.id, 'NEXT');
    const nextRun = await nativeConfig('NEXT', 500_000);
    const compressed = nextRun.compressions.filter(event => event.type === 'z.context.compression.completed');
    assert.equal(compressed.length, 1, JSON.stringify(nextRun.compressions));
    assert.equal(compressed[0].threshold, 500_000);
    assert.equal(compressed[0].automatic, true);
    assert.ok(compressed[0].beforeTokens >= 600_000 && compressed[0].beforeTokens < 976_000,
      'reported occupancy exceeds the session threshold while staying below the native safety line');
    assert.ok(compressed[0].afterTokens > 0 && compressed[0].afterTokens < compressed[0].beforeTokens);
    assert.ok(nextRun.nativeSummaries >= 1, 'the actual native session persists the new summary');
    const compressedSession = await page.evaluate(id => z.getSession(id), a.id);
    assert.equal(compressedSession.contextCompressionCount, 1);
    report.checks.push('500K threshold triggers one real automatic summary at 600K provider usage; occupancy drops and native history saves the summary, while lower-usage turns never compact');
    await openEditor(a.id);
    await page.locator('#contextQuickThresholdReset').click();
    await page.waitForFunction(async id => (await z.getSession(id)).modelSelection.compactionThreshold === 800_000, a.id);
    await verifyThreshold(a.id, 800_000);
    await startRun(a.id, 'DEFAULT');
    await waitFinished(a.id, 'DEFAULT');
    await nativeConfig('DEFAULT', 800_000);
    assert.equal((await page.evaluate(() => z.getConfig())).context.maxTokens, 1_000_000);
    assert.equal((await page.evaluate(() => z.getConfig())).context.compactionThreshold, 800_000);
    report.checks.push('fresh turns use 500K; restore-default stores 800K and the following real native kernel uses that default');
    report.nativeConfigs = await application.evaluate(() => globalThis.contextThresholdRuns);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.fixtureErrors, []);
    report.ok = true;
    await openEditor(a.id);
    for (const [name, size] of [['desktop', { width: 1280, height: 820 }], ['narrow', { width: 860, height: 560 }]]) {
      await page.setViewportSize(size);
      await openEditor();
      const geometry = await page.locator('#contextRingPanel').evaluate(panel => {
        const box = panel.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight };
      });
      assert.ok(geometry.left >= -1 && geometry.top >= -1 && geometry.right <= geometry.width + 1
        && geometry.bottom <= geometry.height + 1, `${name}: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: path.join(output, `${name}.png`) });
    }
    report.checks.push('expanded context settings stay fully on-screen at 1280×820 and 860×560');
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error.stack;
    if (application) report.nativeConfigs = await application.evaluate(() => globalThis.contextThresholdRuns || []).catch(() => []);
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ id: state.currentSession?.id, threshold: state.currentSession?.modelSelection?.compactionThreshold,
        editor: document.querySelector('#contextThresholdEditor')?.textContent,
        input: document.querySelector('#contextQuickThresholdInput')?.value,
        hint: document.querySelector('#contextQuickThresholdHint')?.textContent,
        notice: document.querySelector('#contextQuickThresholdNotice')?.textContent,
        active: [...state.activeRuns.keys()], queued: [...state.queuedTurns.keys()] })).catch(() => null);
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (held && !held.released) { held.released = true; held.response.destroy(); }
    if (page && !page.isClosed()) await page.evaluate(async () => {
      const active = await z.openCodeSyncActiveRuns();
      for (const run of active?.runs || []) await z.openCodeCancelRun(run.runId).catch(() => {});
    }).catch(() => {});
    await application?.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-session-context-threshold-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
