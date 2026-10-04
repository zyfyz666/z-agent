'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-live-steering-interruption-'));
const outputDir = path.join(appRoot, 'output', 'live-steering-interruption');
fs.mkdirSync(outputDir, { recursive: true });
const modelId = 'live-steering-fixture';
const markers = {
  start: 'STEER_BEGIN_4197', firstGuide: 'ENTER_GUIDANCE_4197', secondGuide: 'BUTTON_GUIDANCE_4197',
  guided: 'GUIDANCE_APPLIED_4197', pause: 'PAUSE_BEGIN_4197', pauseGuide: 'PAUSE_GUIDANCE_4197',
  partial: 'PERSISTED_PARTIAL_TEXT_4197', resume: 'RESUME_BEGIN_4197', resumed: 'RESUMED_WITH_HISTORY_4197',
  file: 'REAL_TOOL_OUTPUT_4197', draft: 'UNSENT_DRAFT_RETAINED_4197'
};
const report = { ok: false, checks: [], pageErrors: [], requests: [], fixtureErrors: [] };
const pendingStreams = new Map();
let application;
let page;
let fixtureFile;
let firstSlowStarted = false;
let pauseSlowStarted = false;
let guidedRequestSeen = false;
let resumedRequestSeen = false;
let pauseStreamAborted = false;
let requestNumber = 0;

function beginStream(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.flushHeaders();
}
function chunk(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: 'live-steering-fixture', object: 'chat.completion.chunk', model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
function finish(response, delta) {
  chunk(response, delta);
  chunk(response, {}, delta.tool_calls ? 'tool_calls' : 'stop');
  response.end('data: [DONE]\n\n');
}
function completion(response, delta) {
  beginStream(response);
  finish(response, { role: 'assistant', ...delta });
}
function readCall(id) {
  return { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: fixtureFile }) } }] };
}
function hold(response, name, partial) {
  beginStream(response);
  chunk(response, { role: 'assistant', content: partial });
  pendingStreams.set(name, response);
  response.once('close', () => {
    pendingStreams.delete(name);
    if (name === 'pause' && !response.writableEnded) pauseStreamAborted = true;
  });
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', value => { raw += value; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
      const body = JSON.parse(raw || '{}');
      assert.equal(body.model, modelId, 'all model work stays on the localhost fixture');
      assert.ok(++requestNumber <= 32, 'bounded mock model follow-ups');
      const messages = body.messages || [];
      const userText = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n');
      const active = body.tools?.length && [markers.start, markers.pause, markers.resume].some(marker => userText.includes(marker));
      if (!active) return completion(response, { content: 'Fixture response' });
      const stage = userText.includes(markers.resume) ? 'resume' : userText.includes(markers.pause) ? 'pause' : 'steer';
      report.requests.push({ stage, hasFirstGuide: userText.includes(markers.firstGuide), hasSecondGuide: userText.includes(markers.secondGuide),
        hasPauseGuide: userText.includes(markers.pauseGuide) });
      assert.ok(body.tools.some(tool => tool.function?.name === 'read'));
      const toolCallIds = messages.filter(message => message.role === 'tool').map(message => message.tool_call_id);
      if (stage === 'resume') {
        resumedRequestSeen = true;
        assert.ok(userText.includes(markers.start) && userText.includes(markers.pauseGuide), 'resumed kernel context includes prior original and guidance messages');
        assert.ok(messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(markers.partial)),
          'resumed kernel context retains the interrupted assistant text');
        assert.ok(messages.some(message => message.role === 'tool' && String(message.content).includes(markers.file)),
          'resumed kernel context retains completed native tool output');
        if (!toolCallIds.includes('call-resume-read')) return completion(response, readCall('call-resume-read'));
        return completion(response, { content: markers.resumed });
      }
      if (stage === 'pause') {
        if (!toolCallIds.includes('call-pause-read')) return completion(response, readCall('call-pause-read'));
        if (!pauseSlowStarted) {
          pauseSlowStarted = true;
          return hold(response, 'pause', markers.partial);
        }
        return completion(response, { content: 'Unexpected unpaused follow-up' });
      }
      if (!toolCallIds.includes('call-steer-read')) return completion(response, readCall('call-steer-read'));
      if (!firstSlowStarted) {
        firstSlowStarted = true;
        return hold(response, 'steer', 'LIVE_BEFORE_GUIDANCE_4197');
      }
      assert.ok(userText.includes(markers.firstGuide) && userText.includes(markers.secondGuide), 'the next model step receives guidance within the same run');
      const firstDeliveries = messages.filter(message => message.role === 'user'
        && JSON.stringify(message.content).includes('YAN LIVE USER INTERJECTION')
        && JSON.stringify(message.content).includes(markers.firstGuide));
      assert.equal(firstDeliveries.reduce((count, message) => count + JSON.stringify(message.content).split(markers.firstGuide).length - 1, 0),
        1, 'a repeated requestId inserts only one native guidance message');
      guidedRequestSeen = true;
      return completion(response, { content: markers.guided });
    } catch (error) {
      report.fixtureErrors.push(error.message);
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});

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
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  assert.equal(await page.evaluate(() => typeof yan.openCodeSteerRun), 'function');
}

async function composerSend(text, enter = false) {
  await page.locator('#composerInput').fill(text);
  if (enter) await page.locator('#composerInput').press('Enter');
  else await page.locator('#sendBtn').click();
}
async function waitRunning(sessionId) {
  await page.waitForFunction(id => Boolean(state.activeRuns.get(id)?.runCtx?.openCodeSessionId), sessionId, { timeout: 60_000 });
  return page.evaluate(id => {
    const run = state.activeRuns.get(id).runCtx;
    return { runId: run.runId, kernelSessionId: run.openCodeSessionId };
  }, sessionId);
}
async function waitSettled(sessionId) {
  await page.waitForFunction(id => !state.activeRuns.has(id), sessionId, { timeout: 75_000 });
  return page.evaluate(id => yan.getSession(id), sessionId);
}
async function waitGuidance(text, status = 'queued') {
  await page.waitForFunction(({ marker, status }) => state.currentSession.messages?.some(message => message.content === marker
    && message.liveGuidance?.status === status), { marker: text, status }, { timeout: 30_000 });
  return page.evaluate(marker => state.currentSession.messages.find(message => message.content === marker), text);
}
function assertPaused(session, expectedKernelId) {
  assert.ok(session.messages.some(message => message.role === 'user' && message.content.includes(markers.start)));
  assert.ok(session.messages.some(message => message.role === 'user' && message.content.includes(markers.pause)));
  for (const marker of [markers.firstGuide, markers.secondGuide, markers.pauseGuide]) {
    const messages = session.messages.filter(message => message.content === marker);
    assert.equal(messages.length, 1, 'guidance message persists exactly once');
    assert.equal(messages[0].liveGuidance?.status, marker === markers.pauseGuide ? 'failed' : 'delivered');
    if (marker !== markers.pauseGuide) assert.equal(messages[0].liveGuidance?.deliveryEvidence, 'provider-response');
  }
  const interrupted = session.messages.findLast(message => message.role === 'assistant' && message.agentRun?.status === 'interrupted');
  assert.ok(interrupted, 'manual pause persists an interrupted assistant message');
  assert.match(interrupted.content, new RegExp(markers.partial));
  assert.equal(interrupted.agentRun.openCodeSessionId, expectedKernelId);
  assert.equal(session.openCodeSessionId, expectedKernelId, 'manual pause keeps the resumable kernel session');
  assert.ok(interrupted.agentRun.timeline.some(item => item.type === 'tool_call' && JSON.stringify(item).includes('read')),
    'the read tool invocation survives pause');
  assert.ok(interrupted.agentRun.timeline.some(item => item.type === 'tool_result' && String(item.output).includes(markers.file)),
    'the completed native tool result survives pause');
  return interrupted;
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    const sessions = await page.evaluate(async port => {
      const connection = await yan.connectionsSave({ name: 'Live steering fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: 'live-steering-fixture', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!connection.ok) throw new Error(connection.error);
      await yan.setConfig({ agent: { accessMode: 'full', workMode: 'normal' }, permissions: { allowFileRead: true, allowFileWrite: true, allowNetwork: false } });
      state.config = await yan.getConfig();
      const result = [];
      for (const title of ['Steering conversation A', 'Isolated conversation B']) {
        const session = await yan.createSession(true);
        session.title = title;
        session.messages = [{ role: 'user', content: `Keep ${title}`, ts: Date.now() }];
        await yan.saveSession(session);
        result.push(session);
      }
      await refreshSessions(); renderSessionList();
      await loadSession(result[0].id);
      return result;
    }, server.address().port);
    const [sessionA, sessionB] = sessions;
    assert.ok(path.resolve(sessionA.workspace).startsWith(path.resolve(profile) + path.sep));
    fixtureFile = path.join(sessionA.workspace, 'steering fixture.txt');
    fs.writeFileSync(fixtureFile, `${markers.file}\n`);

    await composerSend(`${markers.start}: Read ${fixtureFile}, then wait for my guidance before finishing.`);
    const initialRun = await waitRunning(sessionA.id);
    await page.waitForFunction(() => document.body.textContent.includes('LIVE_BEFORE_GUIDANCE_4197'), null, { timeout: 60_000 });
    assert.ok(pendingStreams.has('steer'), 'the initial native model call remains active');
    await composerSend(markers.firstGuide, true);
    const firstGuide = await waitGuidance(markers.firstGuide);
    assert.equal(await page.evaluate(id => state.queuedTurns.has(id), sessionA.id), false, 'Enter immediately steers instead of queueing');
    assert.equal(await page.evaluate(id => state.activeRuns.get(id)?.runCtx?.runId, sessionA.id), initialRun.runId);
    assert.ok(pendingStreams.has('steer'), 'guidance is acknowledged before the current model call finishes');
    const duplicate = await page.evaluate(payload => yan.openCodeSteerRun(payload), {
      runId: initialRun.runId, yanSessionId: sessionA.id, requestId: firstGuide.liveGuidance.requestId, text: markers.firstGuide
    });
    assert.equal(duplicate.ok, true, duplicate.error);
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.delivered, false);
    assert.equal(await page.locator('.msg-live-guidance').last().textContent(), '等待引导');
    const wrongSession = await page.evaluate(payload => yan.openCodeSteerRun(payload), {
      runId: initialRun.runId, yanSessionId: sessionB.id, requestId: 'wrong-session-4197', text: 'MUST_NOT_REACH_OTHER_SESSION_4197'
    });
    assert.equal(wrongSession.ok, false, 'another conversation cannot steer this run');
    await composerSend(markers.secondGuide);
    await waitGuidance(markers.secondGuide);
    assert.equal(await page.evaluate(id => state.queuedTurns.has(id), sessionA.id), false, 'Send immediately steers instead of queueing');
    const release = pendingStreams.get('steer');
    assert.ok(release && !release.destroyed);
    finish(release, readCall('call-after-guidance-read'));
    await waitGuidance(markers.firstGuide, 'delivered');
    await waitGuidance(markers.secondGuide, 'delivered');
    assert.equal(await page.locator('.msg-live-guidance').last().textContent(), '已经引导');
    const guided = await waitSettled(sessionA.id);
    assert.ok(guidedRequestSeen, 'a subsequent real kernel model step received both guidance messages');
    assert.equal(guided.openCodeSessionId, initialRun.kernelSessionId);
    assert.ok(guided.messages.some(message => message.role === 'assistant' && message.content.includes(markers.guided)));
    const savedB = await page.evaluate(id => yan.getSession(id), sessionB.id);
    assert.equal(savedB.messages.length, 1, 'conversation B remains untouched');
    report.checks.push('Enter and Send insert guidance into the active kernel run; duplicate IDs and wrong sessions are guarded');
    console.log('live steering and isolation passed');

    await composerSend(`${markers.pause}: Read ${fixtureFile}, then provide a slow partial response.`);
    const pauseRun = await waitRunning(sessionA.id);
    assert.equal(pauseRun.kernelSessionId, initialRun.kernelSessionId);
    await page.waitForFunction(marker => document.body.textContent.includes(marker), markers.partial, { timeout: 60_000 });
    assert.ok(pendingStreams.has('pause'));
    await composerSend(markers.pauseGuide, true);
    await waitGuidance(markers.pauseGuide);
    assert.equal(await page.locator('#composerInput').innerText(), '');
    await page.locator('#composerInput').fill(markers.draft);
    await page.locator('#stopRunBtn').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#stopRunBtn').isVisible(), true, 'a nonempty draft keeps a separate Stop control available');
    assert.equal(await page.locator('#stopRunBtn').isEnabled(), true);
    assert.equal(await page.locator('#queueTurnBtn').isVisible(), true, 'the explicit queue entry remains available');
    await page.screenshot({ path: path.join(outputDir, 'controls.png') });
    await page.locator('#stopRunBtn').click();
    const paused = await waitSettled(sessionA.id);
    assertPaused(paused, initialRun.kernelSessionId);
    assert.equal(await page.locator('#composerInput').innerText(), markers.draft, 'Stop preserves the unsent composer draft');
    assert.ok(!paused.messages.some(message => message.content.includes(markers.draft)), 'Stop does not submit the draft');
    assert.ok(pauseStreamAborted || !pendingStreams.has('pause'), 'manual pause stops the active model stream');
    await page.evaluate(id => loadSession(id), sessionB.id);
    await page.evaluate(id => loadSession(id), sessionA.id);
    assert.equal(await page.locator('#composerInput').innerText(), markers.draft, 'the retained draft stays with its conversation after switching');
    await page.waitForFunction(marker => document.body.textContent.includes(marker), markers.partial);
    await page.reload();
    await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSession && state.config);
    await page.evaluate(id => loadSession(id), sessionA.id);
    assertPaused(await page.evaluate(id => yan.getSession(id), sessionA.id), initialRun.kernelSessionId);
    await page.waitForFunction(marker => document.body.textContent.includes(marker), markers.partial);
    report.checks.push('separate Stop preserves a nonempty unsent draft; original/guidance messages, partial text and native tool trace survive switching and reload');
    console.log('manual pause and reload persistence passed');

    await application.close(); application = null; page = null;
    await launch();
    await page.evaluate(id => loadSession(id), sessionA.id);
    assertPaused(await page.evaluate(id => yan.getSession(id), sessionA.id), initialRun.kernelSessionId);
    await page.waitForFunction(marker => document.body.textContent.includes(marker), markers.partial);
    await composerSend(`${markers.resume}: Continue this same task using its previous context and read ${fixtureFile} once more.`);
    const resumedRun = await waitRunning(sessionA.id);
    assert.equal(resumedRun.kernelSessionId, initialRun.kernelSessionId);
    const resumed = await waitSettled(sessionA.id);
    assert.ok(resumedRequestSeen);
    assert.equal(resumed.openCodeSessionId, initialRun.kernelSessionId);
    const finalMessage = resumed.messages.findLast(message => message.role === 'assistant');
    assert.equal(finalMessage.agentRun.status, 'done');
    assert.equal(finalMessage.agentRun.openCodeSessionId, initialRun.kernelSessionId);
    assert.match(finalMessage.content, new RegExp(markers.resumed));
    assertPaused(resumed, initialRun.kernelSessionId);
    report.checks.push('full restart restores paused history and continuation reuses the original kernel session and context');
    assert.deepEqual(report.fixtureErrors, []);
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ session: state.currentSession, active: [...state.activeRuns].map(([id, run]) => ({ id, runId: run.runCtx.runId,
        kernel: run.runCtx.openCodeSessionId, phase: run.runCtx.openCodePhase, shouldAbort: run.runCtx.shouldAbort })),
      composer: document.querySelector('#composerInput')?.textContent, button: document.querySelector('#sendBtn')?.outerHTML,
      stopButton: document.querySelector('#stopRunBtn')?.outerHTML,
      stopStyle: document.querySelector('#stopRunBtn') ? { display: getComputedStyle(document.querySelector('#stopRunBtn')).display,
        visibility: getComputedStyle(document.querySelector('#stopRunBtn')).visibility,
        rectangle: document.querySelector('#stopRunBtn').getBoundingClientRect().toJSON() } : null })).catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (page && !page.isClosed()) await page.evaluate(async () => {
      for (const run of await yan.openCodeSyncActiveRuns()) if (run.running) await yan.openCodeCancelRun(run.runId).catch(() => {});
    }).catch(() => {});
    for (const response of pendingStreams.values()) response.destroy();
    await application?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-live-steering-interruption-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
