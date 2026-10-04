'use strict';

// All crashes and model traffic in this test belong to its isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron: electron } = require('playwright');
const appRoot = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'z-renderer-recovery-'));
const output = path.join(appRoot, 'output', 'renderer-recovery');
fs.mkdirSync(output, { recursive: true });
const marker = 'Z_CRASH_RECOVERY_LOCAL_FIXTURE_20261005';
const report = { ok: false, checks: [], requests: 0 };
let application, page, heldStream;
const streams = new Set();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeChunk(response, content, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: 'z-recovery', object: 'chat.completion.chunk', model: 'z-recovery-fixture',
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`);
}
const server = http.createServer((request, response) => {
  let raw = '';
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw);
      assert.equal(body.model, 'z-recovery-fixture');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.flushHeaders();
      if (body.tools?.length && JSON.stringify(body.messages).includes(marker)) {
        report.requests++;
        assert.equal(report.requests, 1, 'recovering the view cannot submit another model request');
        heldStream = response;
        streams.add(response);
        response.once('close', () => streams.delete(response));
        writeChunk(response, 'RECOVERY_STREAM_BEFORE_1832');
      } else {
        writeChunk(response, 'Fixture response', 'stop');
        response.end('data: [DONE]\n\n');
      }
    } catch (error) {
      report.fixtureError = error.message;
      response.end();
    }
  });
});
async function until(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (error) { lastError = error; }
    await wait(100);
  }
  throw new Error(`State timed out${lastError ? `: ${lastError.message}` : ''}`);
}
async function ready() {
  await until(async () => {
    page = application.windows().find(candidate => /\/renderer\/index\.html/.test(candidate.url()));
    return page && await evaluateUi(() => typeof quickInputHandlerReady !== 'undefined'
      && quickInputHandlerReady && state.currentSession && state.config);
  });
}
// Playwright keeps a crashed Page marked as crashed after Chromium recovers its
// render process. Inspect the same real webContents through Electron instead.
async function evaluateUi(callback, argument) {
  return application.evaluate(({ BrowserWindow }, { source, argument }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return Promise.race([
      contents.executeJavaScript(`(${source})(${JSON.stringify(argument ?? null)})`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('renderer evaluation timeout')), 3000))
    ]);
  }, { source: String(callback), argument });
}
async function screenshot(filename) {
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(output, filename), Buffer.from(png, 'base64'));
}
async function crash() {
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => /\/renderer\/index\.html/.test(candidate.webContents.getURL()));
    if (!window) throw new Error('isolated main window missing');
    window.webContents.forcefullyCrashRenderer();
  });
}
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
      OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
    await ready();
    const mainPid = application.process().pid;
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile);
    report.gpuFeatures = await application.evaluate(({ app }) => app.getGPUFeatureStatus());
    assert.match(report.gpuFeatures.gpu_compositing, /disabled|unavailable/);
    report.checks.push('the real application starts with software compositing');
    const sessionId = await page.evaluate(async port => {
      const result = await z.connectionsSave({ name: 'Local recovery fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: 'z-recovery-fixture', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!result.ok) throw new Error(result.error);
      await z.setConfig({ agent: { accessMode: 'full', workMode: 'normal' }, permissions: { allowNetwork: false } });
      state.config = await z.getConfig();
      const session = await z.createSession(true);
      session.title = 'Renderer recovery fixture';
      session.messages = [{ role: 'user', content: 'Keep the isolated recovery fixture', ts: Date.now() }];
      await z.saveSession(session);
      await refreshSessions();
      renderSessionList();
      await loadSession(session.id);
      return session.id;
    }, server.address().port);
    await page.locator('#composerInput').fill(marker);
    await page.locator('#sendBtn').click();
    await until(() => heldStream, 60000);
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('RECOVERY_STREAM_BEFORE_1832'));
    const before = await page.evaluate(async () => (await z.openCodeSyncActiveRuns()).map(run => run.runId));
    assert.equal(before.length, 1);
    await crash();
    console.log('first crash dispatched');
    await ready();
    console.log('first crash recovered');
    assert.equal(application.process().pid, mainPid);
    const after = await evaluateUi(async () => (await z.openCodeSyncActiveRuns()).map(run => run.runId));
    console.log('active run inspected');
    assert.deepEqual(after, before);
    assert.equal(report.requests, 1);
    assert.equal(heldStream.destroyed, false);
    report.checks.push('a real renderer crash recovers without restarting the main process or the active model request');

    const gpu = await application.evaluate(({ app }) => app.getAppMetrics().find(process => process.type === 'GPU'));
    if (gpu?.pid) {
      process.kill(gpu.pid);
      await until(() => {
        const file = path.join(profile, 'ZData', 'logs', 'renderer-health.jsonl');
        return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('child-process-gone');
      });
      await ready();
      assert.equal(report.requests, 1);
      report.checks.push('the isolated GPU process was killed; its exit was logged and the active model request survived');
    } else report.checks.push('no dedicated GPU process is present with software rendering');

    await crash(); await ready();
    await crash();
    await until(async () => {
      return evaluateUi(() => !!document.querySelector('a[href="z-recovery://retry"]'));
    });
    await screenshot('recovery-page.png');
    assert.equal(report.requests, 1);
    report.checks.push('repeated renderer crashes stop at a visible recovery page instead of looping or leaving a black window');
    await evaluateUi(() => document.querySelector('a[href="z-recovery://retry"]').click());
    await ready();
    assert.equal(report.requests, 1);
    writeChunk(heldStream, '\nRECOVERY_STREAM_AFTER_1832', 'stop');
    heldStream.end('data: [DONE]\n\n');
    await until(async () => evaluateUi(async () => (await z.openCodeSyncActiveRuns()).every(run => !run.running)));
    await evaluateUi(id => loadSession(id), sessionId);
    await until(() => evaluateUi(() => document.querySelector('#messages').textContent.includes('RECOVERY_STREAM_AFTER_1832')));
    const saved = await evaluateUi(id => z.getSession(id), sessionId);
    assert.equal(saved.messages.filter(message => message.role === 'user' && message.content.includes(marker)).length, 1);
    assert.ok(saved.messages.some(message => message.role === 'assistant' && message.content.includes('RECOVERY_STREAM_AFTER_1832')));
    report.checks.push('manual recovery reconnects to the same run and saves its completed answer exactly once');
    const healthFile = path.join(profile, 'ZData', 'logs', 'renderer-health.jsonl');
    report.healthEvents = fs.readFileSync(healthFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(report.healthEvents.filter(entry => entry.event === 'renderer-process-gone').length, 3);
    assert.equal(report.fixtureError, undefined);
    await screenshot('restored-interface.png');
    report.ok = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    for (const response of streams) response.end();
    await application?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    // Leave this isolated test profile available for investigation if it fails.
    if (report.ok && path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('z-renderer-recovery-')) {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
})();
