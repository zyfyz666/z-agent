'use strict';

// Exercise the normal user-message rewind button in a real isolated Electron
// profile and bundled OpenCode. The sole model endpoint is a localhost fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-session-rewind-edit-'));
const outputDir = path.join(appRoot, 'output', 'session-rewind-edit');
const modelId = 'rewind-edit-local-fixture';
const markers = {
  prefix: 'REWIND_EDIT_RETAINED_PREFIX_5931',
  original: 'REWIND_EDIT_WITHDRAWN_PROMPT_5931',
  edited: 'REWIND_EDIT_REPLACEMENT_PROMPT_5931',
  future: 'REWIND_EDIT_REMOVED_FUTURE_5931',
  sourceDraft: 'REWIND_EDIT_EXISTING_SOURCE_DRAFT_5931',
  lateDraft: 'REWIND_EDIT_LATE_SOURCE_DRAFT_5931',
  otherDraft: 'REWIND_EDIT_OTHER_SESSION_DRAFT_5931',
  firstOriginal: 'REWIND_EDIT_FIRST_ORIGINAL_5931',
  firstEdited: 'REWIND_EDIT_FIRST_REPLACEMENT_5931',
  file: 'REWIND_EDIT_CURRENT_FILE_CONTENT_5931'
};
const report = { ok: false, checks: [], requests: [], fixtureErrors: [], pageErrors: [] };
let application;
let page;
let source;
let other;
let first;
let markerFile;
fs.mkdirSync(outputDir, { recursive: true });

function completion(response, text) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const chunk = { id: 'rewind-edit-fixture', object: 'chat.completion.chunk', model: modelId,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
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
      const body = JSON.parse(raw || '{}');
      assert.equal(body.model, modelId);
      const payload = JSON.stringify(body);
      const action = payload.includes(markers.firstEdited) ? 'first' : payload.includes(markers.edited) ? 'replacement' : '';
      if (!action || !body.tools?.length) return completion(response, 'REWIND_EDIT_AUXILIARY_OK');
      const counts = Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, payload.split(marker).length - 1]));
      report.requests.push({ action, counts });
      assert.ok(report.requests.length <= 3, 'bounded real fixture requests');
      assert.equal(counts[action === 'first' ? 'firstEdited' : 'edited'], 1, 'the edited prompt reaches the actual model exactly once');
      for (const key of ['original', 'future', 'sourceDraft', 'lateDraft', 'otherDraft', 'firstOriginal']) {
        assert.equal(counts[key], 0, `withdrawn/future/draft ${key} must not reach the model`);
      }
      assert.equal(counts.prefix, action === 'first' ? 0 : 1, 'only the retained history is reconstructed');
      completion(response, `REWIND_EDIT_REPLY_${action.toUpperCase()}_5931`);
    } catch (error) {
      report.fixtureErrors.push(error.message);
      completion(response, `REWIND_EDIT_FIXTURE_ERROR: ${error.message}`);
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

async function readSession(id) { return page.evaluate(id => yan.getSession(id), id); }

async function composer() {
  return page.evaluate(() => ({ text: getComposerText(), attachments: state.attachments,
    skills: state.selectedSkills.map(item => item.id), subagents: state.selectedSubagents.map(item => item.id) }));
}

async function rewindUser(marker) {
  const message = page.locator('#messages > .msg.user').filter({ hasText: marker });
  const button = message.locator('[data-act="rewind"]');
  await button.waitFor();
  assert.equal(await button.isEnabled(), true);
  await button.click();
  await page.locator('#genericConfirmModal').waitFor({ state: 'visible' });
  assert.match(await page.locator('#genericConfirmModal').innerText(), /回退并编辑/);
  assert.match(await page.locator('#genericConfirmModal').innerText(), /文件/);
  await page.locator('#genericConfirmAccept').click();
}

async function waitRewind(id) {
  await page.waitForFunction(id => !sessionRewindRequests.has(id), id);
}

async function replaceTextPreservingTokens(text) {
  // Select only editable text, leaving the restored Skill/subagent chips in
  // place, then type via the actual contenteditable input event path.
  await page.locator('#composerInput').click();
  await page.evaluate(() => {
    const input = document.querySelector('#composerInput');
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT, {
      acceptNode(node) { return node.parentElement?.closest('[contenteditable="false"]')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const range = document.createRange();
    if (nodes.length) { range.setStart(nodes[0], 0); range.setEnd(nodes.at(-1), nodes.at(-1).length); }
    else { range.selectNodeContents(input); range.collapse(false); }
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.insertText(text);
  assert.equal((await composer()).text, text);
}

async function waitCompleted(id, marker) {
  await page.waitForFunction(({ id, marker }) => !state.activeRuns.has(id)
    && state.currentSession?.id === id && state.currentSession.messages.some(message => message.role === 'assistant'
      && message.content.includes(marker)), { id, marker }, { timeout: 90_000 });
  return readSession(id);
}

async function restore() {
  const id = await page.evaluate(() => state.currentSession.id);
  await page.locator('#sessionRewindRestoreBtn').click();
  await page.locator('#genericConfirmModal').waitFor({ state: 'visible' });
  await page.locator('#genericConfirmAccept').click();
  await waitRewind(id);
  return readSession(id);
}

function unchanged() {
  assert.equal(fs.readFileSync(markerFile, 'utf8'), markers.file, 'rewind and restore do not modify project files');
}

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await launch();
    ({ source, other, first } = await page.evaluate(async ({ port, modelId, markers }) => {
      const connection = await yan.connectionsSave({ name: 'Editable rewind fixture', preset: 'openai', apiFormat: 'openai',
        manualModelId: modelId, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-only' });
      if (!connection.ok) throw new Error(connection.error);
      await yan.setConfig({ agent: { accessMode: 'full', workMode: 'normal' },
        permissions: { allowFileRead: true, allowFileWrite: true, allowNetwork: false } });
      state.config = await yan.getConfig();
      const selection = { providerId: connection.connection.providerId, supplierId: connection.connection.supplierId,
        modelId, modelType: 'text', name: modelId, capabilities: {} };
      const source = await yan.createSession(true);
      source.title = 'Editable rewind source';
      source.messages = [
        { role: 'user', content: markers.prefix, ts: 1_800_000_003_000 },
        { role: 'assistant', content: 'The retained earlier reply.', ts: 1_800_000_003_001, modelSelection: selection },
        { role: 'user', content: markers.original, ts: 1_800_000_003_002, modelSelection: selection,
          attachments: [{ name: 'current-file-marker.txt', path: source.workspace + '/current-file-marker.txt', size: markers.file.length }],
          skillCalls: [{ id: 'rewind-edit-fixture-skill', name: 'Rewind fixture skill' }], subagentRoles: ['reviewer', 'tester'] },
        { role: 'assistant', content: markers.future, ts: 1_800_000_003_003 },
        { role: 'user', content: markers.future + ' later question', ts: 1_800_000_003_004 },
        { role: 'assistant', content: markers.future + ' later answer', ts: 1_800_000_003_005 }
      ];
      await yan.saveSession(source); await yan.setSessionModel(source.id, selection);
      const other = await yan.createSession(true);
      other.messages = [{ role: 'user', content: 'An independent task', ts: 1_800_000_004_000 }];
      await yan.saveSession(other);
      const first = await yan.createSession(true);
      first.messages = [{ role: 'user', content: markers.firstOriginal, ts: 1_800_000_005_000, modelSelection: selection },
        { role: 'assistant', content: markers.future, ts: 1_800_000_005_001 }];
      await yan.saveSession(first); await yan.setSessionModel(first.id, selection);
      await refreshSessions(); renderSessionList();
      return { source: await yan.getSession(source.id), other, first };
    }, { port: server.address().port, modelId, markers }));
    assert.ok(path.resolve(source.workspace).startsWith(path.resolve(profile) + path.sep));
    markerFile = path.join(source.workspace, 'current-file-marker.txt');
    fs.writeFileSync(markerFile, markers.file);

    await switchTo(other.id);
    await page.locator('#composerInput').fill(markers.otherDraft);
    await switchTo(source.id);
    await page.locator('#composerInput').fill(markers.sourceDraft);
    const original = await readSession(source.id);
    await rewindUser(markers.original);
    await waitRewind(source.id);
    const rewound = await readSession(source.id);
    assert.deepEqual(rewound.messages.map(message => message.content), original.messages.slice(0, 2).map(message => message.content));
    assert.equal(rewound.conversationRevision, 1);
    const restoredPayload = await composer();
    assert.equal(restoredPayload.text, markers.original);
    assert.deepEqual(restoredPayload.attachments, original.messages[2].attachments);
    assert.deepEqual(restoredPayload.skills, ['rewind-edit-fixture-skill']);
    assert.deepEqual(restoredPayload.subagents, ['reviewer', 'tester']);
    const backup = await readSession(rewound.rewindState.backupSessionId);
    assert.deepEqual(backup.messages.map(message => message.content), original.messages.map(message => message.content));
    assert.equal(await page.evaluate(id => state.composerDrafts.get(id)?.text, backup.id), markers.sourceDraft);
    unchanged();
    report.checks.push('normal rewind on a user message removes it from context and restores original text, attachment, Skill and selected subagents; previous draft is kept with the full backup');

    await switchTo(backup.id);
    assert.equal((await composer()).text, markers.sourceDraft);
    await switchTo(source.id);
    assert.deepEqual(await composer(), restoredPayload);
    await replaceTextPreservingTokens(markers.edited);
    const editedPayload = await composer();
    assert.deepEqual(editedPayload.attachments, restoredPayload.attachments);
    assert.deepEqual(editedPayload.skills, restoredPayload.skills);
    assert.deepEqual(editedPayload.subagents, restoredPayload.subagents);
    await switchTo(other.id);
    assert.equal((await composer()).text, markers.otherDraft);
    await switchTo(source.id);
    assert.deepEqual(await composer(), editedPayload, 'the editable replacement survives navigating away and back');
    await page.screenshot({ path: path.join(outputDir, 'editable-rewind.png') });
    await page.locator('#sendBtn').click();
    const completed = await waitCompleted(source.id, 'REWIND_EDIT_REPLY_REPLACEMENT_5931');
    assert.equal(completed.messages.filter(message => message.role === 'user' && message.content === markers.edited).length, 1);
    assert.equal(completed.messages.some(message => message.content.includes(markers.original) || message.content.includes(markers.future)), false);
    const replacement = completed.messages.find(message => message.content === markers.edited);
    assert.deepEqual(replacement.attachments, restoredPayload.attachments);
    assert.deepEqual(replacement.skillCalls.map(item => item.id), restoredPayload.skills);
    assert.deepEqual(replacement.subagentRoles, restoredPayload.subagents);
    assert.ok(report.requests.some(request => request.action === 'replacement'));
    unchanged();
    report.checks.push('real contenteditable editing, per-conversation draft navigation and real Send deliver exactly one replacement with its attachments/Skill/subagents; localhost model sees retained history and no withdrawn/future content');

    const restored = await restore();
    assert.deepEqual(restored.messages.map(message => message.content), original.messages.map(message => message.content));
    const alternate = await readSession(restored.rewindState.backupSessionId);
    assert.deepEqual(alternate.messages.map(message => message.content), completed.messages.map(message => message.content));
    unchanged();
    report.checks.push('restore recovers the complete original conversation and preserves the edited branch in a separate backup without changing files');

    await application.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('session:rewind');
      globalThis.editRewindGate = { pending: false, release: null, original };
      ipcMain.removeHandler('session:rewind');
      ipcMain.handle('session:rewind', async (event, payload) => {
        const result = await original(event, payload);
        globalThis.editRewindGate.pending = true;
        await new Promise(resolve => { globalThis.editRewindGate.release = resolve; });
        return result;
      });
    });
    await page.locator('#composerInput').fill(markers.lateDraft);
    await rewindUser(markers.original);
    const gateDeadline = Date.now() + 20_000;
    while (!await application.evaluate(() => globalThis.editRewindGate.pending)) {
      assert.ok(Date.now() < gateDeadline, 'rewind reached the controlled IPC response delay');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await switchTo(other.id);
    await application.evaluate(() => { globalThis.editRewindGate.release(); });
    await waitRewind(source.id);
    assert.equal(await page.evaluate(() => state.currentSession.id), other.id);
    assert.equal((await composer()).text, markers.otherDraft, 'late rewind must never overwrite another conversation draft');
    const delayedRewound = await readSession(source.id);
    await switchTo(source.id);
    assert.deepEqual(await composer(), restoredPayload, 'the pending replacement is retained even if navigation happened before the rewind response');
    assert.equal(await page.evaluate(id => state.composerDrafts.get(id)?.text, delayedRewound.rewindState.backupSessionId), markers.lateDraft);
    unchanged();
    report.checks.push('switching conversations while the rewind IPC response is delayed preserves the replacement and old source draft, without stealing navigation or overwriting the other composer');

    // A rewound first prompt is temporarily empty, but it must survive the
    // normal blank-chat cleanup even while a different blank chat is active.
    assert.equal(first.workspaceKind, 'default');
    const blank = await page.evaluate(async () => {
      const blank = await yan.createSession(true);
      await refreshSessions(); renderSessionList();
      return blank;
    });
    await application.evaluate(() => { globalThis.editRewindGate.pending = false; globalThis.editRewindGate.release = null; });
    await switchTo(first.id);
    await rewindUser(markers.firstOriginal);
    const firstGateDeadline = Date.now() + 20_000;
    while (!await application.evaluate(() => globalThis.editRewindGate.pending)) {
      assert.ok(Date.now() < firstGateDeadline, 'first-message rewind reached the controlled IPC response delay');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await switchTo(blank.id);
    await application.evaluate(() => { globalThis.editRewindGate.release(); });
    await waitRewind(first.id);
    const emptyRewound = await readSession(first.id);
    assert.ok(emptyRewound, 'blank-chat cleanup must retain a default-named empty conversation with a rewind backup');
    assert.deepEqual(emptyRewound.messages, []);
    assert.equal(await page.evaluate(() => state.currentSession.id), blank.id);
    await switchTo(first.id);
    assert.equal((await composer()).text, markers.firstOriginal);
    await replaceTextPreservingTokens(markers.firstEdited);
    await page.locator('#sendBtn').click();
    const firstCompleted = await waitCompleted(first.id, 'REWIND_EDIT_REPLY_FIRST_5931');
    assert.equal(firstCompleted.messages.length, 2);
    assert.equal(firstCompleted.messages[0].content, markers.firstEdited);
    assert.ok(report.requests.some(request => request.action === 'first'));
    report.checks.push('rewinding the very first user message survives blank-chat cleanup after delayed navigation, preserves the default-named empty source and editable prompt, and resends successfully');

    assert.deepEqual(report.fixtureErrors, []);
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks, modelRequests: report.requests.length }));
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ id: state.currentSession?.id, revision: state.currentSession?.conversationRevision,
        composer: getComposerText(), attachments: state.attachments, skills: state.selectedSkills.map(item => item.id),
        subagents: state.selectedSubagents.map(item => item.id), active: [...state.activeRuns.keys()],
        pending: [...sessionRewindRequests.keys()], modal: document.querySelector('#genericConfirmModal')?.innerText })).catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (page && !page.isClosed()) await page.evaluate(async () => {
      const active = await yan.openCodeSyncActiveRuns();
      for (const run of active?.runs || []) await yan.openCodeCancelRun(run.runId).catch(() => {});
    }).catch(() => {});
    await application?.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-session-rewind-edit-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
