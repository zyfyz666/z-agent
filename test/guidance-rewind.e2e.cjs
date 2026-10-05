'use strict';

// Isolated Electron/main IPC/native kernel. All model traffic goes to the
// localhost fixture; no user conversations, settings, or live runs are touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { guidedHistory } = require('./fixtures/guidance-history.cjs');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-guidance-rewind-'));
const output = path.join(appRoot, 'output', 'guidance-rewind');
fs.mkdirSync(output, { recursive: true });
const modelId = 'guidance-rewind-fixture';
const report = { ok: false, checks: [], requests: [], pageErrors: [], fixtureErrors: [] };
let application;
let page;

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model' }] }));
  }
  let raw = '';
  request.on('data', value => { raw += value; });
  request.on('end', () => {
    let content = 'Fixture auxiliary response';
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
      const body = JSON.parse(raw);
      assert.equal(body.model, modelId);
      const payload = JSON.stringify(body);
      if (body.tools?.length && payload.includes('EDITED_GUIDANCE')) {
        for (const marker of ['BEFORE_FIRST', 'GUIDE_ONE', 'BETWEEN_GUIDES', 'KNOWN_TOOL_RESULT']) assert.ok(payload.includes(marker), marker);
        assert.doesNotMatch(payload, /FUTURE_TEXT|FUTURE_REASONING|FUTURE_FINAL|FUTURE_TOOL_RESULT|GUIDE_TWO|historyBoundary|NATIVE_BUFFER/);
        assert.ok(payload.indexOf('BEFORE_FIRST') < payload.indexOf('GUIDE_ONE'));
        assert.ok(payload.indexOf('GUIDE_ONE') < payload.indexOf('BETWEEN_GUIDES'));
        report.requests.push({ model: body.model, orderedContext: true, noDiscardedContent: true });
        content = 'GUIDANCE_REWIND_CONFIRMED';
      }
    } catch (error) { report.fixtureErrors.push(error.message); content = 'FIXTURE_ERROR'; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = { id: 'guidance-rewind-fixture', object: 'chat.completion.chunk', model: modelId,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
});

async function ready() {
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && state.currentSession && state.config);
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
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
    await ready();
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), profile);
    const selection = await page.evaluate(async ({ port, modelId }) => {
      const connection = await z.connectionsSave({ name: 'Guidance rewind fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!connection.ok) throw new Error(connection.error);
      await z.setConfig({ agent: { accessMode: 'full', workMode: 'normal' },
        permissions: { allowFileRead: true, allowFileWrite: true, allowNetwork: false } });
      state.config = await z.getConfig();
      return { providerId: connection.connection.providerId, supplierId: connection.connection.supplierId,
        modelId, modelType: 'text', name: modelId, capabilities: {} };
    }, { port: server.address().port, modelId });

    for (const legacy of [false, true]) {
      const fixture = guidedHistory({ legacy });
      for (const message of fixture.messages) {
        if (message.agentRun) Object.assign(message.agentRun, selection);
        if (message.liveGuidance?.historyBoundary) Object.assign(message.liveGuidance.historyBoundary.agentRun, selection);
      }
      fixture.messages[0].modelSelection = selection;
      const id = await page.evaluate(async ({ fixture, selection }) => {
        const session = await z.createSession(true);
        session.title = 'Guidance rewind fixture';
        session.messages = fixture.messages;
        session.modelSelection = selection;
        await z.saveSession(session);
        await refreshSessions();
        await loadSession(session.id);
        return session.id;
      }, { fixture, selection });
      const guide = page.locator('#messages > .msg.user').filter({ hasText: 'GUIDE_TWO' });
      await guide.locator('[data-act="rewind"]').click();
      await page.locator('#genericConfirmModal').waitFor({ state: 'visible' });
      assert.match(await page.locator('#genericConfirmModal').innerText(), /已经生成的回复与工具记录/);
      await page.locator('#genericConfirmAccept').click();
      await page.waitForFunction(id => state.currentSession?.id === id && state.currentSession.conversationRevision === 1
        && !sessionRewindRequests.has(id), id);
      assert.equal(await page.evaluate(() => getComposerText()), 'GUIDE_TWO');
      const retained = await page.evaluate(id => z.getSession(id), id);
      assert.equal(retained.messages.at(-1).agentRun.timeline[0].content, 'BEFORE_FIRST BETWEEN_GUIDES');
      assert.equal(retained.messages.at(-1).agentRun.timeline[4].status, 'incomplete');
      assert.doesNotMatch(JSON.stringify(retained.messages), /FUTURE_|GUIDE_TWO/);
      const backup = await page.evaluate(id => z.getSession(id), retained.rewindState.backupSessionId);
      assert.equal(backup.messages.at(-1).content, 'FUTURE_FINAL');

      for (const reload of [false, true]) {
        if (reload) {
          await page.reload(); await ready();
          await page.evaluate(id => loadSession(id), id);
        }
        const visible = await page.evaluate(() => {
          const messages = document.querySelector('#messages');
          return { text: messages.textContent, pending: [...messages.querySelectorAll('[data-tool="bash"]')]
            .map(element => element.dataset.toolState) };
        });
        assert.ok(visible.text.indexOf('BEFORE_FIRST') < visible.text.indexOf('GUIDE_ONE'));
        assert.ok(visible.text.indexOf('GUIDE_ONE') < visible.text.indexOf('BETWEEN_GUIDES'));
        assert.doesNotMatch(visible.text, /FUTURE_|GUIDE_TWO/);
        assert.ok(visible.pending.includes('interrupted'), JSON.stringify(visible.pending));
        assert.equal(visible.pending.includes('completed'), false, 'the incomplete tool is never shown as completed');
      }
      await page.evaluate(async () => { setComposerText('EDITED_GUIDANCE'); await sendMessage(); });
      await page.waitForFunction(id => !state.activeRuns.has(id)
        && state.currentSession?.messages.some(message => message.role === 'assistant'
          && message.content.includes('GUIDANCE_REWIND_CONFIRMED')), id, { timeout: 90_000 });
      report.checks.push(`${legacy ? 'legacy key boundary' : 'send-time snapshot'}: rewind UI, editable guidance, partial text and tool state, backup, reload, ordered model request`);
    }
    assert.equal(report.requests.length, 2);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.fixtureErrors, []);
    report.ok = true;
    await page.screenshot({ path: path.join(output, 'success.png') });
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ text: document.querySelector('#messages')?.textContent,
        sessionId: state.currentSession?.id, revision: state.currentSession?.conversationRevision,
        draft: getComposerText(), active: [...state.activeRuns.keys()] })).catch(() => null);
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
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
    assert.ok(path.basename(target).startsWith('z-guidance-rewind-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
