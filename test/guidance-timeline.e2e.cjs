'use strict';

// Real isolated Electron and bundled OpenCode; streaming model traffic stays
// on this localhost fixture. The user profile and its live runs are untouched.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-guidance-timeline-'));
const outputDir = path.join(appRoot, 'output', 'guidance-timeline');
fs.mkdirSync(outputDir, { recursive: true });
const modelId = 'guidance-timeline-fixture';
const markers = {
  start: 'TIMELINE_START_6438', before: 'TEXT_BEFORE_GUIDANCE_6438', first: 'SENT_GUIDE_ONE_6438',
  middle: 'TEXT_AFTER_FIRST_GUIDANCE_6438', second: 'SENT_GUIDE_TWO_6438', after: 'TEXT_AFTER_SECOND_GUIDANCE_6438',
  background: 'TEXT_WHILE_OTHER_CONVERSATION_OPEN_6438', done: 'GUIDED_FINISH_6438',
  pause: 'TIMELINE_PAUSE_6438', pauseBefore: 'TEXT_BEFORE_PAUSE_GUIDANCE_6438',
  pauseGuide: 'SENT_GUIDE_PAUSE_6438', pauseAfter: 'TEXT_AFTER_PAUSE_GUIDANCE_6438',
  branch: 'TIMELINE_BRANCH_6438', branchBefore: 'TEXT_BEFORE_BRANCH_GUIDANCE_6438',
  branchGuide: 'SENT_GUIDE_BRANCH_6438', branchAfter: 'TEXT_AFTER_BRANCH_GUIDANCE_6438',
  file: 'TIMELINE_REAL_TOOL_OUTPUT_6438'
};
const report = { ok: false, checks: [], snapshots: [], requests: [], pageErrors: [], fixtureErrors: [] };
const streams = new Map();
let application;
let page;
let fixtureFile;
let started = false;
let pauseStarted = false;
let branchStarted = false;
let modelCalls = 0;
let completedReplies = 0;
let sessionA;
let sessionB;

function chunk(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: 'timeline-fixture', object: 'chat.completion.chunk', model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
function begin(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.flushHeaders();
}
function finish(response, delta) {
  chunk(response, delta);
  chunk(response, {}, delta.tool_calls ? 'tool_calls' : 'stop');
  response.end('data: [DONE]\n\n');
}
function completion(response, content) {
  begin(response);
  finish(response, { role: 'assistant', content });
}
function hold(response, key, content) {
  begin(response);
  chunk(response, { role: 'assistant', content });
  streams.set(key, response);
  response.once('close', () => streams.delete(key));
}
function append(key, content) {
  const response = streams.get(key);
  assert.ok(response && !response.destroyed, `${key} is still the same live model stream`);
  chunk(response, { content: `\n\n${content}` });
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
      assert.equal(body.model, modelId);
      assert.ok(++modelCalls <= 24, 'bounded localhost-only model work');
      const messages = body.messages || [];
      const userText = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n');
      if (!body.tools?.length || ![markers.start, markers.branch].some(marker => userText.includes(marker))) {
        return completion(response, 'Fixture auxiliary response');
      }
      const stage = userText.includes(markers.branch) ? 'branch' : userText.includes(markers.pause) ? 'pause' : 'complete';
      report.requests.push({ stage, first: userText.includes(markers.first), second: userText.includes(markers.second),
        pauseGuide: userText.includes(markers.pauseGuide) });
      if (stage === 'branch') {
        assert.equal(branchStarted, false, 'the branch stops without a model follow-up');
        branchStarted = true;
        return hold(response, 'branch', markers.branchBefore);
      }
      if (stage === 'pause') {
        assert.equal(pauseStarted, false, 'interruption stops the held response without a follow-up');
        pauseStarted = true;
        return hold(response, 'pause', markers.pauseBefore);
      }
      if (!started) {
        started = true;
        return hold(response, 'complete', markers.before);
      }
      assert.ok(userText.includes(markers.first) && userText.includes(markers.second), 'actual kernel receives both live guides');
      assert.ok(messages.some(message => message.role === 'tool' && String(message.content).includes(markers.file)),
        'actual kernel executes the fixture read tool');
      return completion(response, `${markers.done}_${++completedReplies}`);
    } catch (error) {
      report.fixtureErrors.push(error.message);
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
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
}
async function switchTo(id) {
  await page.evaluate(id => loadSession(id), id);
  await page.waitForFunction(id => state.currentSession?.id === id && !observerPendingSessionId, id);
}
async function send(text, enter = false) {
  await page.locator('#composerInput').fill(text);
  if (enter) await page.locator('#composerInput').press('Enter');
  else await page.locator('#sendBtn').click();
}
async function waitText(marker) {
  await page.waitForFunction(marker => document.querySelector('#messages')?.textContent.includes(marker), marker, { timeout: 60_000 });
}
async function guidance(marker, enter = false) {
  await send(marker, enter);
  await page.waitForFunction(marker => state.currentSession.messages.some(message => message.content === marker
    && message.liveGuidance?.status === 'delivered'), marker, { timeout: 30_000 });
  return page.evaluate(marker => state.currentSession.messages.find(message => message.content === marker), marker);
}
async function settled(id) {
  await page.waitForFunction(id => !state.activeRuns.has(id), id, { timeout: 75_000 });
  return page.evaluate(id => yan.getSession(id), id);
}
async function assertOrder(label, order) {
  // Completed history initially hides its work transcript. Exercise the real
  // expansion control before asserting all retained streaming text.
  await page.locator('#messages .agent-work-toggle[aria-expanded="false"]').evaluateAll(nodes => nodes.forEach(node => node.click()));
  await waitText(order.at(-1));
  const result = await page.evaluate(order => {
    const container = document.querySelector('#messages');
    const text = container.textContent;
    return {
      positions: order.map(marker => ({ marker, index: text.indexOf(marker), count: text.split(marker).length - 1 })),
      guides: [...container.querySelectorAll('.msg.user[data-guidance-request-id]')].map(element => ({
        text: element.querySelector('.msg-body')?.textContent, nested: !!element.parentElement.closest('.msg.assistant')
      })),
      segments: container.querySelectorAll('.agent-guidance-segment').length
    };
  }, order);
  report.snapshots.push({ label, ...result });
  for (const item of result.positions) assert.equal(item.count, 1, `${label}: ${item.marker} is rendered exactly once`);
  for (let index = 1; index < result.positions.length; index++) {
    assert.ok(result.positions[index - 1].index < result.positions[index].index,
      `${label}: ${result.positions[index - 1].marker} must appear before ${result.positions[index].marker}`);
  }
  assert.ok(result.segments >= 2, `${label}: the assistant is displayed as segments around the live guidance`);
}
function assertRelationship(session, guideMarkers, status) {
  const assistant = session.messages.findLast(message => message.role === 'assistant' && message.agentRun?.status === status);
  assert.ok(assistant, `the ${status} assistant remains a single persisted message`);
  assert.ok(assistant.agentRun.guidanceTimelineKey, 'the persisted assistant has its stable guidance timeline key');
  for (const marker of guideMarkers) {
    const matches = session.messages.filter(message => message.content === marker);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].liveGuidance.timelineKey, assistant.agentRun.guidanceTimelineKey);
    assert.ok(matches[0].liveGuidance.displayBoundary, 'the guide persists its precise display boundary');
  }
  return assistant;
}
function boundary(session, messageIndex) {
  const message = session.messages[messageIndex];
  const messageAnchor = crypto.createHash('sha256').update(JSON.stringify([message.role ?? null, message.ts ?? null,
    message.id ?? null, message.content ?? '', message.attachments ?? [], message.agentRun?.runId ?? null])).digest('hex');
  return { sessionId: session.id, messageIndex, messageAnchor, conversationRevision: session.conversationRevision || 0 };
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    [sessionA, sessionB] = await page.evaluate(async ({ port, modelId }) => {
      const connection = await yan.connectionsSave({ name: 'Guidance timeline fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!connection.ok) throw new Error(connection.error);
      await yan.setConfig({ agent: { accessMode: 'full', workMode: 'normal' },
        permissions: { allowFileRead: true, allowFileWrite: true, allowNetwork: false } });
      state.config = await yan.getConfig();
      const result = [];
      for (const title of ['Guidance timeline source', 'Guidance timeline independent conversation']) {
        const session = await yan.createSession(true);
        session.title = title;
        session.messages = [{ role: 'user', content: `Keep ${title}`, ts: Date.now() }];
        await yan.saveSession(session);
        result.push(session);
      }
      await refreshSessions(); renderSessionList();
      await loadSession(result[0].id);
      return result;
    }, { port: server.address().port, modelId });
    assert.ok(path.resolve(sessionA.workspace).startsWith(path.resolve(profile) + path.sep));
    fixtureFile = path.join(sessionA.workspace, 'guidance timeline fixture.txt');
    fs.writeFileSync(fixtureFile, markers.file);

    await send(`${markers.start}: Show your progress, then read ${fixtureFile} before finishing.`);
    await waitText(markers.before);
    const runId = await page.evaluate(id => state.activeRuns.get(id).runCtx.runId, sessionA.id);
    const firstGuidance = await guidance(markers.first, true);
    append('complete', markers.middle);
    await waitText(markers.middle);
    await page.reload();
    await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && state.config);
    await switchTo(sessionA.id);
    await page.waitForFunction(id => !!state.activeRuns.get(id)?.runCtx?.openCodeSessionId, sessionA.id, { timeout: 60_000 });
    await waitText(markers.middle);
    const secondGuidance = await guidance(markers.second);
    assert.equal(secondGuidance.liveGuidance.timelineKey, firstGuidance.liveGuidance.timelineKey,
      'renderer recovery reuses the original live guidance timeline key');
    append('complete', markers.after);
    const completeOrder = [markers.before, markers.first, markers.middle, markers.second, markers.after];
    await assertOrder('two guides within one streaming text part', completeOrder);
    assert.equal(await page.evaluate(id => state.activeRuns.get(id)?.runCtx.runId, sessionA.id), runId,
      'guidance stays in the original live run');
    await page.screenshot({ path: path.join(outputDir, 'live-guidance.png') });

    await switchTo(sessionB.id);
    append('complete', markers.background);
    await page.waitForFunction(({ id, marker }) => state.activeRuns.get(id)?.runCtx.partialContent?.includes(marker),
      { id: sessionA.id, marker: markers.background });
    assert.equal(await page.evaluate(() => document.querySelector('#messages').textContent.includes('TEXT_WHILE_OTHER_CONVERSATION_OPEN_6438')), false,
      'background activity does not appear in another conversation');
    await switchTo(sessionA.id);
    completeOrder.push(markers.background);
    await assertOrder('switch away while streaming and return', completeOrder);
    const response = streams.get('complete');
    assert.ok(response && !response.destroyed);
    finish(response, { tool_calls: [{ index: 0, id: 'call-timeline-read', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ filePath: fixtureFile }) } }] });
    const completed = await settled(sessionA.id);
    assertRelationship(completed, [markers.first, markers.second], 'done');
    assert.ok(completedReplies > 0);
    completeOrder.push(...Array.from({ length: completedReplies }, (_, index) => `${markers.done}_${index + 1}`));
    await assertOrder('completed run', completeOrder);
    assert.equal((await page.evaluate(id => yan.getSession(id), sessionB.id)).messages.length, 1);
    await page.reload();
    await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && state.config);
    await switchTo(sessionA.id);
    await assertOrder('completed history after renderer reload', completeOrder);
    report.checks.push('two live guides split the same streaming text part at send time and reuse the same timeline key after active renderer recovery; no text or guide duplication across continued deltas, background navigation, completion and history reload');

    await send(`${markers.pause}: Continue slowly so I can give guidance before stopping.`);
    await waitText(markers.pauseBefore);
    await guidance(markers.pauseGuide, true);
    append('pause', markers.pauseAfter);
    const pauseOrder = [...completeOrder, markers.pauseBefore, markers.pauseGuide, markers.pauseAfter];
    await assertOrder('guidance in a second live run', pauseOrder);
    await page.locator('#composerInput').fill('UNSENT_TIMELINE_DRAFT_6438');
    await page.locator('#stopRunBtn').click();
    const paused = await settled(sessionA.id);
    assert.equal(await page.locator('#composerInput').innerText(), 'UNSENT_TIMELINE_DRAFT_6438');
    const interrupted = assertRelationship(paused, [markers.pauseGuide], 'interrupted');
    assert.match(interrupted.content, new RegExp(markers.pauseBefore));
    assert.match(interrupted.content, new RegExp(markers.pauseAfter));
    await assertOrder('interrupted run keeps chronology', pauseOrder);
    await switchTo(sessionB.id);
    await switchTo(sessionA.id);
    await assertOrder('interrupted history after switching', pauseOrder);
    await application.close(); application = null; page = null;
    await launch();
    await switchTo(sessionA.id);
    assertRelationship(await page.evaluate(id => yan.getSession(id), sessionA.id), [markers.pauseGuide], 'interrupted');
    await assertOrder('completed and interrupted history after full restart', pauseOrder);
    await page.screenshot({ path: path.join(outputDir, 'restored-guidance.png') });
    report.checks.push('a later run keeps its own guidance relationship; interruption, conversation switching and full Electron restart preserve the same chronological display');

    const original = await page.evaluate(id => yan.getSession(id), sessionA.id);
    const fork = await page.evaluate(payload => yan.forkSession(payload), boundary(original, original.messages.length - 1));
    assert.equal(fork.ok, true, fork.error);
    await switchTo(fork.session.id);
    assertRelationship(await page.evaluate(id => yan.getSession(id), fork.session.id), [markers.pauseGuide], 'interrupted');
    await assertOrder('branch with detached runtime identities', pauseOrder);
    assert.ok(fork.session.messages.filter(message => message.agentRun).every(message => !message.agentRun.runId),
      'inherited branch history has no live run handles');
    await send(`${markers.branch}: Continue this independent branch slowly.`);
    await waitText(markers.branchBefore);
    await guidance(markers.branchGuide, true);
    append('branch', markers.branchAfter);
    const branchOrder = [...pauseOrder, markers.branchBefore, markers.branchGuide, markers.branchAfter];
    await assertOrder('new branch guidance leaves inherited history in place', branchOrder);
    await page.locator('#composerInput').fill('UNSENT_BRANCH_DRAFT_6438');
    await page.locator('#stopRunBtn').click();
    const branchPaused = await settled(fork.session.id);
    const branchRun = assertRelationship(branchPaused, [markers.branchGuide], 'interrupted');
    assert.notEqual(branchRun.agentRun.guidanceTimelineKey,
      original.messages.findLast(message => message.agentRun)?.agentRun.guidanceTimelineKey);
    await assertOrder('branch interruption retains separate guidance timelines', branchOrder);
    assert.equal((await page.evaluate(id => yan.getSession(id), sessionA.id)).messages.length, original.messages.length);
    const completedIndex = original.messages.findIndex(message => message.agentRun?.status === 'done');
    assert.ok(completedIndex >= 0);
    const rewind = await page.evaluate(payload => yan.rewindSession(payload), boundary(original, completedIndex));
    assert.equal(rewind.ok, true, rewind.error);
    await switchTo(sessionA.id);
    await assertOrder('rewind keeps earlier guidance positions', completeOrder);
    assert.equal(await page.evaluate(marker => document.querySelector('#messages').textContent.includes(marker), markers.pauseGuide), false);
    const restored = await page.evaluate(payload => yan.restoreSessionRewind(payload), {
      sessionId: sessionA.id, conversationRevision: rewind.conversationRevision
    });
    assert.equal(restored.ok, true, restored.error);
    await switchTo(sessionA.id);
    await assertOrder('restore keeps both guidance timelines', pauseOrder);
    report.checks.push('branch history remains separate from a new guided run after native runtime identities are detached; rewind and restore keep stable guidance placement');
    assert.equal(fs.readFileSync(fixtureFile, 'utf8'), markers.file);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.fixtureErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks, snapshots: report.snapshots.length, modelCalls }));
  } catch (error) {
    report.error = error.stack || error.message;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ session: state.currentSession,
        active: [...state.activeRuns].map(([id, run]) => ({ id, runId: run.runCtx.runId,
          partial: run.runCtx.partialContent, timeline: run.runCtx.timeline })),
        messages: document.querySelector('#messages')?.outerHTML })).catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (page && !page.isClosed()) await page.evaluate(async () => {
      const active = await yan.openCodeSyncActiveRuns();
      for (const run of Array.isArray(active) ? active : active?.runs || []) {
        if (run.running) await yan.openCodeCancelRun(run.runId).catch(() => {});
      }
    }).catch(() => {});
    for (const response of streams.values()) response.destroy();
    await application?.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-guidance-timeline-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
