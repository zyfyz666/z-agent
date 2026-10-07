'use strict';
// Isolated Electron profile, real completion IPC/claims/storage and renderer.
// The provider boundary is stubbed before any window starts: no model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'z-subagent-completion-e2e-'));
const output = path.join(root, 'output', 'subagent-completion');
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, checks: [], errors: [] };
let app, page;
const bootstrap = path.join(profile, 'fixture.cjs');
fs.writeFileSync(bootstrap, `
const { ipcMain } = require('electron');
// There is no native provider database in this isolated fixture. Supply the
// same fresh, unconsumed evidence that the read-only native inspector returns.
const { OpenCodeSidecar } = require(${JSON.stringify(path.join(root, 'lib/opencode-sidecar.js'))});
OpenCodeSidecar.prototype.inspectSubagentCompletion = async record => ({
  status: record.status, result: record.result, completedAt: record.completedAt, consumed: false
});
const main = require(${JSON.stringify(path.join(root, 'main.js'))});
globalThis.__subagentE2EQueue = main.__test.getSubagentCompletionQueue();
globalThis.__subagentE2EStarts = [];
globalThis.__subagentE2EAttempts = [];
ipcMain.removeHandler('opencode:start-run');
ipcMain.handle('opencode:start-run', async (event, request) => {
  globalThis.__subagentE2EAttempts.push(request);
  if (!request.subagentWake) throw new Error('Only completion wakes may start in this fixture');
  if (globalThis.__subagentE2EBusyNext) {
    globalThis.__subagentE2EBusyNext = false;
    await event.sender.executeJavaScript('state.queuedTurns.set(' + JSON.stringify(request.zSessionId)
      + ', { id: "fixture-priority", sessionRef: state.currentSession })');
    return { ok: false, code: 'SUBAGENT_WAKE_BUSY', subagentWakeAccepted: false, error: 'fixture user request has priority' };
  }
  const accepted = globalThis.__subagentE2EQueue.accept({ ...request.subagentWake,
    sessionId: request.zSessionId, conversationRevision: request.conversationRevision,
    intentId: request.intentId }, request.runId);
  if (!accepted.ok) return { ...accepted, subagentWakeAccepted: false };
  globalThis.__subagentE2EStarts.push(request);
  event.sender.send('opencode:event', { runId: request.runId, event: {
    type: 'z.finalization.progress', data: { message: '正在生成最终回复' }
  } });
  setTimeout(() => {
    globalThis.__subagentE2EQueue.settleDelivery(request.runId);
    if (!event.sender.isDestroyed()) event.sender.send('opencode:completed', {
      runId: request.runId, result: { status: 'done', text: '已核对子代理结果并完成后续工作。', toolCalls: [], todos: [] }
    });
  }, 80);
  return { ok: true, runId: request.runId };
});
`);

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_MAIN_TEST_EXPORTS: '1', Z_E2E_USER_DATA_DIR: profile,
    Z_E2E_PARENT_PID: String(process.pid), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: root, env });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && window.zSubagentCompletion);
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
}

async function seed(sessionId, suffix, { stopped = false } = {}) {
  return app.evaluate((_electron, { sessionId, suffix, stopped }) => {
    const q = globalThis.__subagentE2EQueue;
    const startedAt = Date.now();
    const parentRunId = `parent-${suffix}`;
    q.authorizeParent({ parentRunId, zSessionId: sessionId, conversationRevision: 0, startedAt });
    const event = { parentRunId, zSessionId: sessionId, conversationRevision: 0, parentSessionID: `native-parent-${suffix}`,
      childSessionID: `native-child-${suffix}`, callId: `call-${suffix}`, startedAt: startedAt + 1,
      status: 'completed', title: `检查 ${suffix}`, result: `结果 ${suffix}：检查通过。`, completedAt: startedAt + 2 };
    q.recordLifecycle(event);
    q.settleParent(parentRunId, { status: stopped ? 'interrupted' : 'done' });
    return { id: Object.values(q.state.records).find(row => row.parentRunId === parentRunId).id, event };
  }, { sessionId, suffix, stopped });
}

async function waitForWake(sessionId, count) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (await page.evaluate(async ({ sessionId, count }) => {
      const session = await z.getSession(sessionId);
      return session.messages.filter(message => message.subagentWake).length === count
        && session.messages.at(-1)?.agentRun?.status === 'done'
        && !isSessionExecutionActive(sessionId);
    }, { sessionId, count })) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${count} completed wakes in ${sessionId}`);
}
const starts = () => app.evaluate(() => globalThis.__subagentE2EStarts);

async function main() {
  await launch();
  const sessions = await page.evaluate(async () => {
    const ids = [];
    for (const label of ['A', 'B']) {
      const session = await z.createSession(true, '');
      session.title = `子代理回报 ${label}`;
      session.observerEnabled = false;
      session.messages = [{ role: 'user', content: `保留用户任务 ${label}`, ts: Date.now() - 1000 },
        { role: 'assistant', content: '子代理还在执行。', ts: Date.now(), agentRun: { runId: `old-${label}`, status: 'done',
          textContent: '子代理还在执行。', timeline: [], subagents: [{ status: 'completed', result: '历史 Review，不得唤醒' }] } }];
      await z.saveSession(session); await z.setSessionObserverEnabled(session.id, false); ids.push(session.id);
    }
    await refreshSessions(); await loadSession(ids[1]);
    return ids;
  });
  const [a, b] = sessions;
  await page.evaluate(() => zSubagentCompletion.afterRun(state.currentSession));
  assert.equal((await starts()).length, 0, 'old Review history cannot produce a wake');
  const first = await seed(a, 'first');
  await waitForWake(a, 1);
  assert.equal(await page.evaluate(() => state.currentSession.id), b, 'a background wake must not switch the visible task');
  assert.equal(await page.locator('.msg-subagent-wake').count(), 0);
  let requests = await starts();
  assert.equal(requests.length, 1, JSON.stringify(await app.evaluate(() => ({ attempts: globalThis.__subagentE2EAttempts,
    queue: globalThis.__subagentE2EQueue.state }))) + JSON.stringify(await page.evaluate(id => z.getSession(id), a)));
  assert.equal(requests[0].zSessionId, a);
  assert.equal(requests[0].observerWake, false);
  assert.equal(requests[0].subagentWake.id, first.id);
  await page.evaluate(id => loadSession(id), a);
  assert.equal(await page.locator('.msg-subagent-wake').last().innerText(), '子代理完成，继续处理结果');
  assert.ok((await page.evaluate(() => state.currentSession.messages[0].content)).includes('保留用户任务 A'));
  await page.evaluate(() => {
    const run = state.currentSession.messages.at(-1).agentRun;
    const projection = getCachedAgentTimelineProjection(run.timeline, run.status);
    if (projection.some(item => item.openCodeKey === 'finalization' && /正在生成/.test(item.content))) throw new Error('stale finalization status');
  });
  await page.screenshot({ path: path.join(output, 'completed.png') });
  report.checks.push('observer disabled: A wakes while B remains visible; source badge and original history preserved');

  await app.evaluate((_electron, event) => globalThis.__subagentE2EQueue.recordLifecycle(event), first.event);
  await page.evaluate(() => Promise.all([zSubagentCompletion.refresh(), zSubagentCompletion.refresh()]));
  assert.equal((await starts()).length, 1);
  report.checks.push('duplicate lifecycle and repeated refresh do not start a second run');

  await page.evaluate(id => state.queuedTurns.set(id, { id: 'fixture-user-queue', sessionRef: state.currentSession }), a);
  await seed(a, 'busy');
  await page.waitForTimeout(200);
  assert.equal((await starts()).length, 1, 'the waiting user message has priority');
  await page.evaluate(id => { state.queuedTurns.delete(id); void zSubagentCompletion.afterRun(state.currentSession); }, a);
  await waitForWake(a, 2);
  report.checks.push('busy task / waiting user turn defers result without dropping it');

  await app.evaluate(() => { globalThis.__subagentE2EBusyNext = true; });
  await seed(a, 'admission-race');
  const raceDeadline = Date.now() + 10_000;
  while (await app.evaluate(() => globalThis.__subagentE2EBusyNext)) {
    if (Date.now() > raceDeadline) throw new Error('busy admission fixture did not run');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await page.waitForFunction(id => !isSessionExecutionActive(id), a);
  await page.evaluate(async () => {
    state.currentSession.messages.push({ role: 'user', content: '新增约束：保持刚才确认的格式', ts: Date.now() },
      { role: 'assistant', content: '已收到新增约束', ts: Date.now(), agentRun: { status: 'done', runId: 'user-priority-fixture', timeline: [] } });
    await saveCurrentSession(state.currentSession);
    await zSubagentCompletion.onUserMessage(state.currentSession.id);
    state.queuedTurns.delete(state.currentSession.id);
    await zSubagentCompletion.afterRun();
  });
  await waitForWake(a, 3);
  const race = await page.evaluate(async id => (await z.getSession(id)).messages, a);
  assert.equal(race.filter(message => /结果 admission-race/.test(message.content)).length, 1);
  assert.equal(race.filter(message => message.agentRun?.status === 'error').length, 0);
  assert.ok((await starts()).at(-1).history.some(message => message.content === '新增约束：保持刚才确认的格式'));
  report.checks.push('main admission busy race retries the same intent without a duplicate or false failure message');

  await page.evaluate(() => zSubagentCompletion.dispose());
  await seed(b, 'restart-pending');
  const beforeRestart = (await starts()).length;
  assert.equal(beforeRestart, 3);
  await app.close(); app = null;
  await launch();
  await waitForWake(b, 1);
  assert.equal((await starts()).length, 1, 'restart only dispatches the unaccepted pending result');
  assert.equal((await starts())[0].zSessionId, b);
  report.checks.push('app restart resumes pending completion; accepted historical deliveries stay deduplicated');

  await page.evaluate(async id => { await loadSession(id); state.queuedTurns.set(id, { id: 'fixture-stop-queue', sessionRef: state.currentSession }); }, b);
  const cancelled = await seed(b, 'cancelled');
  await page.evaluate(async id => { await zSubagentCompletion.cancel(id); state.queuedTurns.delete(id); await zSubagentCompletion.refresh(); }, b);
  await seed(b, 'stopped-parent', { stopped: true });
  await page.evaluate(() => zSubagentCompletion.refresh());
  assert.equal((await starts()).length, 1);
  assert.equal(await app.evaluate((_electron, id) => globalThis.__subagentE2EQueue.state.records[id].delivery, cancelled.id), 'cancelled');
  report.checks.push('stop/cancel never reawakens the parent, including after a later lifecycle event');
  assert.deepEqual(report.errors, []);
}

main().then(() => { report.ok = true; }).catch(error => {
  report.errors.push(error.stack || String(error)); process.exitCode = 1;
}).finally(async () => {
  await app?.close().catch(() => {});
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  // Only delete the literal temporary profile created by this test.
  if (path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('z-subagent-completion-e2e-')) {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
