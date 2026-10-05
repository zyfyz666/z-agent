'use strict';
// End-of-turn review through the real IPC path: a local fake observer endpoint
// returns verdicts; kernel runs are stubbed so a wake never reaches a model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'z-observer-completion-e2e-'));
const output = path.join(root, 'output/observer-completion');
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, checks: [], errors: [], observerRequests: 0, kernelStarts: 0 };
const verdicts = [];
const requests = [];
let app, page, server;

const wake = extra => ({ verdict: 'continue', reason: '最终回复说测试仍有 2 项失败', unmet: ['让 npm test 全部通过'],
  evidence: [{ source: 'finalReply', fact: '回复写明 2 项测试失败' }], followUp: '修复剩下 2 项失败的测试，然后重新运行 npm test。', delayMinutes: 0, ...extra });

function startServer() {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body || '{}') });
      const verdict = verdicts.shift() || { verdict: 'achieved', reason: '已完成', unmet: [], evidence: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function main() {
  const port = await startServer();
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && window.zObserverCompletion);
  await app.evaluate(({ ipcMain }) => {
    globalThis.__kernelStarts = 0;
    ipcMain.removeHandler('opencode:start-run');
    ipcMain.handle('opencode:start-run', () => { globalThis.__kernelStarts++; throw new Error('kernel stubbed in observer-completion e2e'); });
  });
  // Observer model = the local fake endpoint.
  await page.evaluate(async port => {
    const saved = await z.connectionsSave({ name: 'Fake Observer', preset: 'openai', apiFormat: 'openai',
      manualModelId: 'fake-observer', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'isolated-test-key' });
    if (!saved.ok) throw new Error(saved.error || 'connection failed');
    const { connections } = await z.listModelConnections();
    const entry = connections.find(item => item.name.includes('Fake Observer')) || connections[0];
    const result = await z.configureObserver({ judgeEvery: 6, reasoningEffort: 'low', completion: { enabled: true, maxWakes: 3 },
      model: { providerId: entry.providerId, supplierId: entry.supplierId, modelId: entry.models[0].id } });
    if (result.error) throw new Error(result.error);
    state.config = await z.getConfig();
  }, port);
  // A conversation whose last turn ended on its own.
  const sessionId = await page.evaluate(async () => {
    const session = await z.createSession(true, '');
    session.title = 'Observer completion fixture';
    await z.renameSession(session.id, session.title);
    session.messages = [
      { role: 'user', content: '修好构建，并让 npm test 全部通过', ts: Date.now() - 60_000 },
      { role: 'assistant', content: '构建已修好，但还有 2 项测试失败。', ts: Date.now() - 1000, agentRun: {
        runId: 'fixture-run-1', status: 'done', startedAt: Date.now() - 50_000, completedAt: Date.now() - 1000,
        textContent: '构建已修好，但还有 2 项测试失败。', todos: [{ text: '修复构建', done: true }, { text: '测试全部通过', done: false }],
        timeline: [{ type: 'tool_call', name: 'bash', args: { command: 'npm test' } }] } }
    ];
    await saveCurrentSession(session);
    await loadSession(session.id);
    openRightSidebarTool('watchdog');
    return session.id;
  });
  const card = () => page.evaluate(() => {
    const node = document.querySelector('#rs-watchdog .wd-completion');
    return node && { status: node.dataset.status, title: node.querySelector('.wd-completion-title')?.textContent,
      due: node.querySelector('[data-observer-due]')?.textContent || '', eye: document.querySelector('#rs-watchdog .wd-oracle')?.dataset.eye,
      buttons: [...node.querySelectorAll('[data-observer-completion]')].map(b => b.dataset.observerCompletion) };
  });
  const after = () => page.evaluate(() => window.zObserverCompletion.afterRun(state.currentSession));
  const stored = () => page.evaluate(id => z.getSession(id), sessionId);
  const indexFile = path.join(profile, 'ZData', 'observer-wakes.json');

  // 1. Unmet goal -> countdown card -> wake message marked as an observer wake.
  verdicts.push(wake());
  await after();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  const sent = JSON.parse(requests[0].body.messages[1].content);
  assert.equal(sent.goal, '修好构建，并让 npm test 全部通过');
  assert.match(sent.finalReply, /2 项测试失败/);
  assert.equal(sent.recentActions[0].target, 'npm test');
  assert.doesNotMatch(JSON.stringify(requests[0].body), /isolated-test-key/);
  let shown = await card();
  assert.equal(shown.status, 'pending');
  assert.equal(shown.eye, 'speaking', 'deciding to wake makes the eye speak');
  assert.deepEqual(shown.buttons, ['wake', 'cancel']);
  await page.waitForTimeout(3000);
  shown = await card();
  assert.equal(shown.eye, 'watching', 'then it watches the countdown');
  assert.match(shown.due, /^1[0-3] 秒后唤醒$/, 'countdown ticks in place (15 s minus ~3 s)');
  assert.ok(JSON.parse(fs.readFileSync(indexFile, 'utf8'))[sessionId], 'pending wake is indexed for restart');
  await page.locator('#rs-watchdog').screenshot({ path: path.join(output, 'pending.png') });
  report.checks.push('review -> pending card with countdown');
  await page.locator('#rs-watchdog [data-observer-completion="wake"]').click();
  await page.waitForFunction(() => document.querySelector('#messages .msg.user.observer-wake'));
  assert.match(await page.locator('#messages .msg-observer-wake').last().innerText(), /观察者唤醒 · 第 1 次/);
  await page.waitForFunction(() => !isSessionExecutionActive(state.currentSession.id));
  let session = await stored();
  const wakeMessage = session.messages.find(message => message.observerWake);
  assert.equal(wakeMessage.observerWake.wake, 1);
  assert.match(wakeMessage.content, /修复剩下 2 项失败的测试/);
  assert.equal(session.observerCompletion.status, 'sent');
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8'))[sessionId], undefined);
  report.kernelStarts = await app.evaluate(() => globalThis.__kernelStarts);
  assert.equal(report.kernelStarts, 1, 'the wake started exactly one (stubbed) run');
  assert.equal(requests.length, 1, 'a failed woken run is not reviewed again');
  report.checks.push('wake now -> marked user message, record sent, index cleared');

  // 2. A later finished turn gets a scheduled wake; cancel clears it everywhere.
  await page.evaluate(async () => {
    const session = state.currentSession;
    session.messages.push({ role: 'user', content: '下载数据集后跑完整训练', ts: Date.now() },
      { role: 'assistant', content: '已开始下载，约 40 分钟。', ts: Date.now(), agentRun: { runId: 'fixture-run-2', status: 'done', textContent: '已开始下载，约 40 分钟。', timeline: [] } });
    await saveCurrentSession(session);
    renderMessages(session.messages);
  });
  verdicts.push(wake({ delayMinutes: 45, reason: '数据集还在下载', followUp: '确认下载完成后开始训练。' }));
  await after();
  assert.equal((await card()).eye, 'speaking');
  await page.waitForTimeout(3000);
  shown = await card();
  assert.equal(shown.status, 'scheduled');
  assert.equal(shown.eye, 'resting', 'a scheduled wake rests until its time');
  assert.match(shown.due, /^4[45] 分 \d+ 秒后唤醒$/);
  const due = JSON.parse(fs.readFileSync(indexFile, 'utf8'))[sessionId].dueAt;
  assert.ok(Math.abs(due - Date.now() - 45 * 60_000) < 10_000);
  await page.locator('#rs-watchdog').screenshot({ path: path.join(output, 'scheduled.png') });
  await page.locator('#rs-watchdog [data-observer-completion="cancel"]').click();
  await page.waitForFunction(() => document.querySelector('#rs-watchdog .wd-completion')?.dataset.status === 'cancelled');
  assert.equal((await stored()).observerCompletion.status, 'cancelled');
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8'))[sessionId], undefined);
  report.checks.push('scheduled wake -> indexed, resting eye, cancel clears it');

  // 3. Turning the review off in settings stops it.
  await page.evaluate(async () => {
    const observer = (await z.listModelConnections()).observer;
    const result = await z.configureObserver({ ...observer, completion: { enabled: false, maxWakes: 3 } });
    if (result.error) throw new Error(result.error);
    state.config = await z.getConfig();
  });
  verdicts.push(wake());
  await after();
  assert.equal(requests.length, 2, 'no request once disabled');
  report.observerRequests = requests.length;
  report.checks.push('disabled in settings -> no review');
  assert.deepEqual(report.errors, []);
}

main().then(() => {
  report.ok = true;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}).catch(error => {
  report.errors.push(error.stack || String(error));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await app?.close().catch(() => {});
  server?.close();
  fs.rmSync(profile, { recursive: true, force: true });
});
