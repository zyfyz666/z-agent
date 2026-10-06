'use strict';

// Real memory IPC, SQLite and renderer, using only a temporary profile and
// synthetic session records. Any attempt to run a model fails the test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { LongTermMemoryStore } = require('../lib/long-term-memory');
const { taskMemoryIdentity } = require('../lib/task-memory-service');
const { executeMemoryOperation } = require('../lib/memory-database');
const { messageForkAnchor } = require('../lib/session-fork');
const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-task-memory-integration-'));
const output = path.join(appRoot, 'output', 'task-memory-integration');
const report = { ok: false, checks: [], pageErrors: [] };
let application, page;
fs.mkdirSync(output, { recursive: true });
const card = id => page.locator(`.task-memory-card[data-memory-id="${id}"]:not([data-memory-usage])`);
async function open(id) {
  await page.locator(`.recent-session-list .session-item[data-id="${id}"]`).click({ button: 'right' });
  await page.locator('.sidebar-context-menu-item').filter({ hasText: '任务记忆' }).click();
  await page.waitForFunction(() => document.querySelector('#taskMemorySections')?.getAttribute('aria-busy') === 'false');
}
async function snapshot() {
  return page.evaluate(() => ({ id: state.currentSession?.id, draft: getComposerText(), loadToken: sessionLoadToken }));
}

(async () => {
  try {
    const workspaceA = path.join(profile, 'workspace-a'), workspaceC = path.join(profile, 'workspace-c');
    fs.mkdirSync(workspaceA); fs.mkdirSync(workspaceC);
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
    assert.ok(page); page.setDefaultTimeout(15_000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession && state.config);
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), profile);
    await application.evaluate(({ ipcMain }) => {
      globalThis.memoryIntegrationModelCalls = [];
      for (const channel of ['opencode:start-run', 'opencode:compress-session']) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => { globalThis.memoryIntegrationModelCalls.push(channel); throw new Error('Unexpected model invocation in memory test'); });
      }
    });
    const [a, b, c] = await page.evaluate(async ({ workspaceA, workspaceC }) => {
      const sessions = [];
      for (const [title, workspace] of [['Memory IPC A', workspaceA], ['Memory IPC B', workspaceA], ['Memory IPC C', workspaceC]]) {
        const session = await z.createSession(true, workspace);
        session.messages = [
          { role: 'user', content: title + ' first synthetic prompt', ts: Date.now() - 4000 },
          { role: 'assistant', content: 'First synthetic result', ts: Date.now() - 3000 },
          { role: 'user', content: 'Second synthetic prompt', ts: Date.now() - 2000 },
          { role: 'assistant', content: 'Second synthetic result', ts: Date.now() - 1000 }
        ];
        await z.saveSession(session); await z.renameSession(session.id, title);
        sessions.push(await z.getSession(session.id));
      }
      await refreshSessions(); await loadSession(sessions[0].id);
      setComposerText('MEMORY_IPC_PRESERVE_A_DRAFT'); captureComposerDraftForSession();
      return sessions;
    }, { workspaceA, workspaceC });
    const first = await page.evaluate(sessionId => z.listTaskMemories({ sessionId, includeInactive: true }), a.id);
    assert.equal(first.ok, true, JSON.stringify(first));
    const dbPath = first.storage.path;
    assert.equal(path.resolve(dbPath), path.join(profile, 'ZData', 'memory.sqlite'));
    const store = new LongTermMemoryStore({ dbPath });
    const add = (session, content, scope = 'task') => {
      const result = store.upsert({ type: scope === 'task' ? 'work_state' : 'project', scope, content, evidence: 'Synthetic IPC evidence' },
        { ...taskMemoryIdentity(session), runId: 'run_memory_fixture', sourceKind: 'fixture' });
      assert.equal(result.ok, true, JSON.stringify(result)); return result.memory;
    };
    const memoryA = add(a, 'A isolated progress');
    const memoryB = add(b, 'B isolated progress');
    const shared = add(b, 'Cache policy persists verified keys', 'workspace');
    const foreign = add(c, 'Private Cedar policy', 'workspace');
    executeMemoryOperation(dbPath, 'review.usage-save', { ...taskMemoryIdentity(b), runId: 'run_used_fixture', items: [shared] });
    const before = await snapshot();
    const beforeAFile = fs.readFileSync(path.join(profile, 'ZData', 'sessions', a.id + '.json'), 'utf8');
    await open(b.id);
    assert.equal(await card(memoryB.id).count(), 1);
    assert.equal(await card(memoryA.id).count(), 0);
    assert.equal(await card(foreign.id).count(), 0);
    assert.equal(await card(shared.id).count(), 1);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await page.evaluate(request => z.updateTaskMemory(request), { sessionId: a.id, id: memoryB.id, content: 'Illegal A edit', conversationRevision: 0 })).ok, false);
    assert.equal((await page.evaluate(request => z.deleteTaskMemory(request), { sessionId: b.id, id: foreign.id, conversationRevision: 0 })).ok, false);
    report.checks.push('Real IPC lists B progress and project knowledge without A progress or another project; cross-task and cross-project writes are rejected');

    await card(shared.id).locator('[data-memory-action="edit"]').click();
    await card(shared.id).locator('textarea').fill('Cache policy stores reviewed keys');
    await card(shared.id).locator('[data-memory-action="save"]').click();
    await page.waitForFunction(id => document.querySelector(`.task-memory-card[data-memory-id="${id}"]:not([data-memory-usage]) .task-memory-content`)?.textContent === 'Cache policy stores reviewed keys', shared.id);
    assert.equal(new LongTermMemoryStore({ dbPath }).get(shared.id, taskMemoryIdentity(b)).content, 'Cache policy stores reviewed keys');
    assert.equal(await page.locator(`.task-memory-card[data-memory-id="${shared.id}"][data-memory-usage] .task-memory-content`).innerText(), 'Cache policy persists verified keys');
    await card(shared.id).locator('[data-memory-action="toggle"]').click();
    await page.waitForFunction(id => document.querySelector(`.task-memory-card[data-memory-id="${id}"]:not([data-memory-usage]) .task-memory-state`)?.textContent === '已停用', shared.id);
    assert.equal(store.get(shared.id, taskMemoryIdentity(b)).status, 'disabled');
    assert.equal(store.query({ ...taskMemoryIdentity(b), query: 'cache policy' }).memories.some(item => item.id === shared.id), false);
    await card(shared.id).locator('[data-memory-action="toggle"]').click();
    await page.waitForFunction(id => document.querySelector(`.task-memory-card[data-memory-id="${id}"]:not([data-memory-usage]) .task-memory-state`)?.textContent === '使用中', shared.id);
    assert.equal(store.get(shared.id, taskMemoryIdentity(b)).status, 'active');
    await card(shared.id).locator('[data-memory-action="delete"]').click();
    assert.equal(store.get(shared.id, taskMemoryIdentity(b)).status, 'active');
    await card(shared.id).locator('[data-memory-action="confirm-delete"]').click();
    await card(shared.id).waitFor({ state: 'detached' });
    assert.equal(store.get(shared.id, taskMemoryIdentity(b)).status, 'deleted');
    assert.equal(store.query({ ...taskMemoryIdentity(b), query: 'cache policy' }).memories.some(item => item.id === shared.id), false);
    assert.equal(await page.locator(`.task-memory-card[data-memory-id="${shared.id}"][data-memory-usage] .task-memory-content`).innerText(), 'Cache policy persists verified keys');
    assert.deepEqual(await snapshot(), before);
    assert.equal(fs.readFileSync(path.join(profile, 'ZData', 'sessions', a.id + '.json'), 'utf8'), beforeAFile);
    report.checks.push('UI edits, disables, re-enables and deletes the real SQLite record; new readers see the mutations, retrieval excludes deleted/disabled knowledge, and previous usage remains an immutable snapshot');

    await card(memoryB.id).locator('[data-memory-action="edit"]').click();
    await card(memoryB.id).locator('textarea').fill('Stale UI edit must not save');
    const currentB = await page.evaluate(id => z.getSession(id), b.id);
    const rewind = await page.evaluate(request => z.rewindSession(request), { sessionId: b.id,
      messageIndex: 1, messageAnchor: messageForkAnchor(currentB.messages[1]), conversationRevision: currentB.conversationRevision || 0 });
    assert.equal(rewind.ok, true, JSON.stringify(rewind));
    await card(memoryB.id).locator('[data-memory-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('#taskMemoryStatus')?.classList.contains('error'));
    assert.match(await page.locator('#taskMemoryStatus').innerText(), /回退|变化|重新/);
    assert.equal(store.get(memoryB.id, taskMemoryIdentity(b)).content, 'B isolated progress');
    const staleDelete = await page.evaluate(request => z.deleteTaskMemory(request), { sessionId: b.id, id: memoryB.id, conversationRevision: 0 });
    assert.equal(staleDelete.code, 'SESSION_REVISION_CHANGED');
    assert.equal((await page.evaluate(sessionId => z.listTaskMemories({ sessionId }), b.id)).items.some(item => item.id === memoryB.id), false);
    report.checks.push('A real session rewind invalidates the open editor revision and stale deletion; old progress is excluded from the new revision');
    await page.screenshot({ path: path.join(output, 'stale-revision-rejected.png') });
    assert.deepEqual(await application.evaluate(() => globalThis.memoryIntegrationModelCalls), []);
    assert.deepEqual(report.pageErrors, []);
    report.ok = true; console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await application?.close().catch(() => {});
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-task-memory-integration-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
