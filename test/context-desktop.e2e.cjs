'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron: electron } = require('playwright');
const { messageForkAnchor } = require('../lib/session-fork');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'z-context-desktop-'));
const modelId = 'context-desktop-local';
const wires = [], failures = [];
let app, page, sourceId, file;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
    try {
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: modelId }] })); }
      assert.equal(req.url, '/v1/chat/completions');
      const body = JSON.parse(raw), wire = JSON.stringify(body.messages);
      const last = JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content);
      const action = /UI_V2_(FIRST|FUTURE|EDITED|AGAIN)\b/.exec(last)?.[1] || 'AUX';
      if (body.tools?.length) {
        wires.push({ action, wire });
        if (action === 'EDITED' || action === 'AGAIN') {
          assert.doesNotMatch(wire, /UI_V2_FUTURE|ANSWER_FUTURE|z-conversation-branch-history|z-session-history/);
          assert.equal(wire.split('UI_V2_FIRST').length - 1, 1);
          assert.equal(wire.split('ANSWER_FIRST').length - 1, 1);
          if (action === 'AGAIN') assert.doesNotMatch(wire, /UI_V2_EDITED|ANSWER_EDITED/);
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = { id: `desktop_${Date.now()}`, object: 'chat.completion.chunk', model: modelId,
        choices: [{ index: 0, delta: { role: 'assistant', content: `ANSWER_${action}` }, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
      chunk.usage = { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`); res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error.message); if (!res.headersSent) res.writeHead(400); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
});
async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  for (let i = 0; i < 200; i++) {
    page = app.windows().find(p => /\/renderer\/index\.html/.test(p.url()));
    if (page) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert(page);
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && state.config);
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
}
const read = () => page.evaluate(id => z.getSession(id), sourceId);
async function send(action) {
  await page.evaluate(id => loadSession(id), sourceId);
  await page.locator('#composerInput').fill(`UI_V2_${action}`);
  await page.locator('#sendBtn').click();
  try { await page.waitForFunction(({ id, action }) => !state.activeRuns.has(id)
    && state.currentSession?.messages?.some(m => m.role === 'assistant' && m.content?.includes(`ANSWER_${action}`)),
  { id: sourceId, action }, { timeout: 60000 }); }
  catch (error) { console.error(JSON.stringify({ action, requests: wires.map(w => w.action), failures,
    session: await read(), ui: await page.evaluate(() => ({ active: [...state.activeRuns.keys()], text: document.querySelector('#messages')?.innerText, composer: getComposerText() })) })); throw error; }
  await page.waitForFunction(async id => !!(await z.getSession(id))?.contextState?.head, sourceId);
  assert.deepEqual(failures, []);
  return read();
}
(async () => {
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    await launch();
    const session = await page.evaluate(async ({ port, modelId }) => {
      const connection = await z.connectionsSave({ name: 'Context desktop fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'loopback-only' });
      if (!connection.ok) throw new Error(connection.error);
      await z.setConfig({ agent: { accessMode: 'full', workMode: 'normal' }, permissions: { allowFileRead: true, allowFileWrite: true, allowNetwork: false } });
      state.config = await z.getConfig();
      const session = await z.createSession(true);
      state.currentSession = session;
      session.title = 'Native context desktop fixture'; await z.saveSession(session);
      await z.setSessionModel(session.id, { providerId: connection.connection.providerId, supplierId: connection.connection.supplierId,
        modelId, modelType: 'text', name: modelId, capabilities: {} });
      await z.setSessionObserverEnabled(session.id, false);
      await refreshSessions(); return z.getSession(session.id);
    }, { port: server.address().port, modelId });
    sourceId = session.id;
    assert(path.resolve(session.workspace).startsWith(path.resolve(profile) + path.sep));
    file = path.join(session.workspace, 'unchanged.txt'); fs.writeFileSync(file, 'DO_NOT_ROLL_BACK');
    const first = await send('FIRST');
    assert(first.contextState.head); assert(first.contextState.points);
    const original = await send('FUTURE');
    // Actual message menu -> confirmation -> composer restoration.
    await page.locator('#messages > .msg.user').filter({ hasText: 'UI_V2_FUTURE' }).locator('[data-act="rewind"]').click();
    await page.locator('#genericConfirmAccept').click();
    await page.waitForFunction(id => !sessionRewindRequests.has(id) && state.currentSession?.conversationRevision === 1, sourceId);
    assert.equal(await page.evaluate(() => getComposerText()), 'UI_V2_FUTURE');
    const rewound = await read();
    assert.equal(rewound.messages.length, first.messages.length);
    assert.equal(rewound.contextState.needsRestore, true);
    const head = rewound.contextState.head;
    const edited = await send('EDITED');
    assert.notEqual(edited.openCodeSessionId, original.openCodeSessionId);
    assert.equal(edited.contextState.needsRestore, false);
    // Full application restart must keep the same authoritative boundary.
    await app.close(); app = null; await launch();
    const current = await read();
    const selectedIndex = current.messages.findIndex(m => m.content === 'UI_V2_EDITED');
    const result = await page.evaluate(payload => z.rewindSession(payload), { sessionId: sourceId,
      conversationRevision: current.conversationRevision, messageIndex: selectedIndex,
      messageAnchor: messageForkAnchor(current.messages[selectedIndex]), includeSelected: false });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.session.contextState.head, head, 'same boundary after restart remains the same snapshot');
    await send('AGAIN');
    const updated = await read();
    const undo = await page.evaluate(payload => z.restoreSessionRewind(payload), { sessionId: sourceId, conversationRevision: updated.conversationRevision });
    assert.equal(undo.ok, true, undo.error);
    assert.deepEqual(undo.session.messages.map(m => m.content), edited.messages.map(m => m.content));
    // Renderer cannot overwrite the native pointer using a stale session save.
    await page.evaluate(async id => {
      const value = await z.getSession(id); value.contextState = { version: 2, head: 'f'.repeat(64) };
      value.openCodeSessionId = 'forged-native'; await z.saveSession(value);
    }, sourceId);
    assert.notEqual((await read()).contextState.head, 'f'.repeat(64));
    assert.notEqual((await read()).openCodeSessionId, 'forged-native');
    assert.equal(fs.readFileSync(file, 'utf8'), 'DO_NOT_ROLL_BACK');
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ ok: true, actualComposerRewind: true, editAndResend: true, restartRestoresSameBoundary: true,
      backupRestore: true, staleRendererCannotReplaceHead: true, filesUnchanged: true, requests: wires.map(w => w.action) }));
  } finally {
    await app?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir())); assert(path.basename(profile).startsWith('z-context-desktop-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
