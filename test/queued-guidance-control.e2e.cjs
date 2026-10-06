'use strict';

// Isolated Electron, real bundled kernel and real uploads/tools. Every model
// request goes to this localhost fixture; no installed profile is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-queued-guidance-control-'));
const output = path.join(appRoot, 'output', 'queued-guidance-control');
const modelId = 'queued-guidance-fixture';
const mark = {
  start: 'QUEUE_START_6281', delivered: 'MANUAL_GUIDE_DELIVERED_6281', waiting: 'MANUAL_GUIDE_WAITING_6281',
  first: 'DEFAULT_QUEUE_ONE_6281', second: 'DEFAULT_QUEUE_TWO_6281',
  before: 'ORIGINAL_PARTIAL_BEFORE_GUIDE_6281', after: 'ORIGINAL_PARTIAL_AFTER_GUIDE_6281',
  file: 'ORIGINAL_TOOL_RESULT_6281', attachment: 'DELIVERED_ATTACHMENT_TEXT_6281',
  waitingAttachment: 'WAITING_ATTACHMENT_TEXT_6281', draft: 'UNSENT_DRAFT_6281'
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const report = { ok: false, checks: [], requests: [], pageErrors: [], fixtureErrors: [] };
const held = new Map();
const continuationOrder = [];
let application, page, fixtureFile;
let initialHeld = false, guidedHeld = false, requestCount = 0;
fs.mkdirSync(output, { recursive: true });

function chunk(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: 'queued-guidance-fixture', object: 'chat.completion.chunk', model: modelId,
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
function complete(response, delta) { begin(response); finish(response, { role: 'assistant', ...delta }); }
function hold(response, key, content) {
  begin(response); chunk(response, { role: 'assistant', content });
  held.set(key, response);
  response.once('close', () => held.delete(key));
}
function read(id) {
  return { tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ filePath: fixtureFile }) } }] };
}
function withoutRetrievedMemory(message) {
  const strip = text => typeof text === 'string' ? text.replace(/<z-task-memory>[\s\S]*?<\/z-task-memory>/g, '')
    .replace(/<z-long-term-memory>[\s\S]*?<\/z-long-term-memory>/g, '') : text;
  return { ...message, content: Array.isArray(message.content)
    ? message.content.map(part => typeof part.text === 'string' ? { ...part, text: strip(part.text) } : part)
    : strip(message.content) };
}
function occurrences(messages, marker) {
  return messages.filter(message => message.role === 'user')
    .reduce((count, message) => count + JSON.stringify(message.content).split(marker).length - 1, 0);
}

const server = http.createServer((request, response) => {
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
      assert.ok(++requestCount <= 40, 'bounded localhost model work');
      // Markers in recalled task state are historical references, not new
      // user submissions. Count only original inputs for queue idempotence.
      const messages = (body.messages || []).map(withoutRetrievedMemory);
      const userText = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n');
      if (!body.tools?.length || !userText.includes(mark.start)) return complete(response, { content: 'Fixture auxiliary response' });
      const tags = [mark.start, mark.delivered, mark.first, mark.second, mark.waiting];
      const stage = tags.reduce((latest, tag) => userText.lastIndexOf(tag) > userText.lastIndexOf(latest) ? tag : latest, mark.start);
      const images = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(part => part.type === 'image_url').map(part => part.image_url?.url || part.image_url);
      report.requests.push({ stage, images: images.length, delivered: occurrences(messages, mark.delivered),
        waiting: occurrences(messages, mark.waiting), first: occurrences(messages, mark.first), second: occurrences(messages, mark.second) });
      if ([mark.first, mark.second, mark.waiting].includes(stage)) {
        continuationOrder.push(stage);
        assert.equal(continuationOrder.filter(item => item === stage).length, 1, 'each queued turn starts exactly once');
        assert.equal(occurrences(messages, stage), 1, 'continuation prompt occurs once in native context');
        assert.equal(occurrences(messages, mark.delivered), 1, 'already delivered guidance is never submitted again');
        assert.ok(messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(mark.before)));
        assert.ok(messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(mark.after)));
        assert.ok(messages.some(message => message.role === 'tool' && String(message.content).includes(mark.file)),
          'Stop preserves the original completed native tool output');
        if (stage !== mark.waiting) assert.equal(occurrences(messages, mark.waiting), 0,
          'the unsent native guide is detached until its queued turn');
        else assert.ok(userText.includes(mark.waitingAttachment), 'the waiting guidance keeps its attachment when continued');
        return complete(response, { content: `FINISHED_${stage}` });
      }
      const toolIds = messages.filter(message => message.role === 'tool').map(message => message.tool_call_id);
      if (!toolIds.includes('call-queue-original-read')) return complete(response, read('call-queue-original-read'));
      if (!initialHeld) { initialHeld = true; return hold(response, 'initial', mark.before); }
      assert.equal(stage, mark.delivered);
      assert.equal(guidedHeld, false, 'only one in-run continuation before Stop');
      assert.equal(occurrences(messages, mark.delivered), 1);
      assert.ok(userText.includes(mark.attachment), 'manual guidance includes the actual uploaded text contents');
      assert.equal(images.length, 1, 'manual guidance includes one native image part');
      assert.match(images[0], /^data:image\/png;base64,/);
      assert.deepEqual(Buffer.from(images[0].split(',')[1], 'base64'), png);
      assert.equal(occurrences(messages, mark.first), 0);
      assert.equal(occurrences(messages, mark.second), 0);
      guidedHeld = true;
      return hold(response, 'guided', mark.after);
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
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), profile);
}
async function send(text, control = 'send') {
  await page.locator('#composerInput').fill(text);
  if (control === 'enter') await page.locator('#composerInput').press('Enter');
  else await page.locator(control === 'steer' ? '#steerTurnBtn' : '#sendBtn').click();
}
async function guide(marker, status) {
  await page.waitForFunction(({ marker, status }) => state.currentSession.messages.some(message =>
    message.content === marker && message.liveGuidance?.status === status), { marker, status }, { timeout: 40_000 });
}
async function upload(paths) {
  await page.locator('#fileInput').setInputFiles(paths);
  await page.waitForFunction(count => state.attachments.length === count, paths.length);
  assert.ok((await page.evaluate(() => state.attachments.map(item => item.path)))
    .every(file => path.resolve(file).startsWith(profile + path.sep)));
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    const sessions = await page.evaluate(async ({ port, modelId }) => {
      const result = await z.connectionsSave({ name: 'Queued guidance fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!result.ok) throw new Error(result.error);
      const cfg = await z.getConfig();
      for (const suppliers of Object.values(cfg.api.providerSuppliers || {})) {
        for (const supplier of suppliers) {
          for (const model of supplier.models || []) if (model.id === modelId) {
            model.capabilities = { ...model.capabilities, vision: true, imageInput: true };
          }
        }
      }
      await z.setConfig({ api: { providerSuppliers: cfg.api.providerSuppliers, visionRelayEnabled: false },
        agent: { accessMode: 'full', workMode: 'normal' }, permissions: { allowFileRead: true, allowFileWrite: true, allowNetwork: false } });
      state.config = await z.getConfig();
      const sessions = [];
      for (const title of ['Queued guidance source', 'Untouched conversation']) {
        const session = await z.createSession(true);
        session.title = title;
        session.messages = [{ role: 'user', content: `Keep ${title}`, ts: Date.now() }];
        await z.saveSession(session); sessions.push(session);
      }
      await refreshSessions(); await loadSession(sessions[0].id);
      return sessions;
    }, { port: server.address().port, modelId });
    const [a, b] = sessions;
    const beforeB = await page.evaluate(id => z.getSession(id), b.id);
    assert.ok(path.resolve(a.workspace).startsWith(profile + path.sep));
    fixtureFile = path.join(a.workspace, 'queue-tool.txt'); fs.writeFileSync(fixtureFile, mark.file);
    const textFile = path.join(profile, 'manual-guidance.txt'); fs.writeFileSync(textFile, mark.attachment);
    const imageFile = path.join(profile, 'manual-guidance.png'); fs.writeFileSync(imageFile, png);
    const waitingFile = path.join(profile, 'waiting-guidance.txt'); fs.writeFileSync(waitingFile, mark.waitingAttachment);

    await send(`${mark.start}: Read ${fixtureFile}, then wait for guidance.`);
    await page.waitForFunction(marker => document.querySelector('#messages')?.textContent.includes(marker), mark.before, { timeout: 60_000 });
    const originalRun = await page.evaluate(id => ({ runId: state.activeRuns.get(id).runCtx.runId,
      native: state.activeRuns.get(id).runCtx.openCodeSessionId }), a.id);
    await send(mark.first, 'enter');
    await upload([textFile, imageFile]);
    await send(mark.delivered);
    await send(mark.second);
    const cardToPromote = page.locator('#queuedTurnHost [data-queued-turn-id]').filter({ hasText: mark.delivered });
    assert.equal(await page.locator('#queuedTurnHost [data-queued-action="steer"]').count(), 3, 'every queued message exposes its own guidance action');
    assert.equal(await cardToPromote.locator('[data-queued-action="steer"]').isEnabled(), true);
    await page.locator('#composerInput').fill('PRESERVE_DRAFT_DURING_QUEUE_PROMOTION');
    await cardToPromote.locator('[data-queued-action="steer"]').click();
    await guide(mark.delivered, 'queued');
    await cardToPromote.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#composerInput').innerText(), 'PRESERVE_DRAFT_DURING_QUEUE_PROMOTION');
    await page.locator('#composerInput').fill('');
    const queue = await page.evaluate(id => {
      const head = state.queuedTurns.get(id); return head ? [head, ...(head.followingTurns || [])].map(turn => turn.text) : [];
    }, a.id);
    assert.deepEqual(queue, [mark.first, mark.second]);
    assert.equal(await page.evaluate(({ first, second }) => state.currentSession.messages
      .some(message => message.content === first || message.content === second), mark), false);
    assert.equal(await page.evaluate(id => state.activeRuns.get(id).runCtx.runId, a.id), originalRun.runId);
    assert.equal(report.requests.some(request => request.first || request.second), false);
    report.checks.push('Enter/Send queue by default; every queued card exposes conversion, and converting the middle card preserves the composer draft and remaining queue order');

    finish(held.get('initial'), read('call-queue-after-guide'));
    await guide(mark.delivered, 'delivered');
    await page.waitForFunction(marker => document.querySelector('#messages')?.textContent.includes(marker), mark.after, { timeout: 60_000 });
    assert.ok(guidedHeld && held.has('guided'));
    report.checks.push('manual guidance carries uploaded text and the original PNG bytes into the next native request');
    await upload([waitingFile]);
    await send(mark.waiting);
    await page.locator('#queuedTurnHost [data-queued-turn-id]').filter({ hasText: mark.waiting }).locator('[data-queued-action="steer"]').click();
    await guide(mark.waiting, 'queued');
    await page.locator('#composerInput').fill(mark.draft);
    await page.screenshot({ path: path.join(output, 'before-stop.png') });
    await page.locator('#stopRunBtn').click();
    await page.waitForFunction(({ id, marker }) => !state.activeRuns.has(id) && !state.queuedTurns.has(id)
      && state.currentSession.messages.some(message => message.role === 'assistant' && message.content.includes(`FINISHED_${marker}`)),
    { id: a.id, marker: mark.waiting }, { timeout: 100_000 });
    const saved = await page.evaluate(id => z.getSession(id), a.id);
    assert.deepEqual(continuationOrder, [mark.first, mark.second, mark.waiting]);
    const interrupted = saved.messages.find(message => message.agentRun?.runId === originalRun.runId);
    assert.equal(interrupted?.agentRun?.status, 'interrupted');
    assert.ok(interrupted.content.includes(mark.before) && interrupted.content.includes(mark.after));
    assert.ok(interrupted.agentRun.timeline.some(item => item.type === 'tool_result' && String(item.output).includes(mark.file)));
    for (const marker of [mark.first, mark.second, mark.waiting]) {
      assert.equal(saved.messages.filter(message => message.role === 'user' && !message.liveGuidance && message.content === marker).length, 1);
    }
    const delivered = saved.messages.filter(message => message.content === mark.delivered);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].liveGuidance.status, 'delivered');
    const waiting = saved.messages.filter(message => message.content === mark.waiting && message.liveGuidance);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].liveGuidance.continuationStatus, 'dispatched');
    assert.equal(await page.locator('#composerInput').innerText(), mark.draft);
    assert.equal(saved.messages.some(message => message.content.includes(mark.draft)), false);
    assert.deepEqual(await page.evaluate(id => z.getSession(id), b.id), beforeB);
    report.checks.push('Stop retains partial text and tool output, dispatches both queued turns and undelivered guidance once in order, and preserves the draft and other conversation');
    await page.screenshot({ path: path.join(output, 'after-stop.png') });
    assert.deepEqual(report.fixtureErrors, []);
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks, requests: report.requests }));
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ session: state.currentSession,
        active: [...state.activeRuns].map(([id, entry]) => ({ id, runId: entry.runCtx.runId, phase: entry.runCtx.openCodePhase })),
        queued: [...state.queuedTurns], composer: document.querySelector('#composerInput')?.textContent })).catch(() => null);
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (page && !page.isClosed()) await page.evaluate(async () => {
      const active = await z.openCodeSyncActiveRuns();
      for (const run of Array.isArray(active) ? active : active?.runs || []) if (run.running) await z.openCodeCancelRun(run.runId).catch(() => {});
    }).catch(() => {});
    for (const response of held.values()) response.destroy();
    await application?.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-queued-guidance-control-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
