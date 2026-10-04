'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright');
const { messageForkAnchor } = require('../lib/session-fork');
const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'z-backup-sidebar-e2e-'));
const output = path.join(appRoot, 'output', 'session-backup-sidebar');
fs.mkdirSync(output, { recursive: true });
let application, page;
const report = { ok: false, checks: [], pageErrors: [] };

async function launch() {
  const env = { ...process.env, YAN_E2E_MODE: '1', YAN_E2E_USER_DATA_DIR: profile, YAN_E2E_PARENT_PID: String(process.pid),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    page = application.windows().find(window => /\/renderer\/index\.html/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession);
}

async function refresh() { await page.evaluate(() => refreshSessions()); }
async function allSessions() { return page.evaluate(() => yan.listSessions()); }
async function read(id) { return page.evaluate(id => yan.getSession(id), id); }
async function checkVisible(sourceId, branchId) {
  await refresh();
  const visible = await page.evaluate(() => state.sessions.map(session => session.id).sort());
  assert.deepEqual(visible, [sourceId, branchId].sort());
  const recent = await page.locator('.recent-session-list .session-item').evaluateAll(rows => rows.map(row => row.dataset.id).sort());
  assert.deepEqual(recent, visible);
  const badge = page.locator(`.recent-session-list .session-item[data-id="${branchId}"] .session-kind-badge`);
  assert.equal(await badge.innerText(), '分支');
  assert.equal(await badge.isVisible(), true);
}

(async () => {
  try {
    await launch();
    const source = await page.evaluate(async () => {
      const session = state.currentSession;
      session.title = '读取最近一次对话并继续处理一个很长很长很长的任务名称，测试分支标记不受标题截断影响';
      session.messages = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Stored original message ${index}`, ts: index + 1 }));
      await yan.saveSession(session);
      await yan.renameSession(session.id, session.title);
      return yan.getSession(session.id);
    });
    const branchResult = await page.evaluate(boundary => yan.forkSession(boundary), {
      sessionId: source.id, messageIndex: 5, messageAnchor: messageForkAnchor(source.messages[5])
    });
    assert.equal(branchResult.ok, true, branchResult.error);
    let branch = branchResult.session;
    const originalHistory = branch.messages.map(message => message.content);
    const backups = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      const rewound = await page.evaluate(boundary => yan.rewindSession(boundary), {
        sessionId: branch.id, messageIndex: 3, messageAnchor: messageForkAnchor(branch.messages[3]),
        conversationRevision: branch.conversationRevision || 0
      });
      assert.equal(rewound.ok, true, rewound.error); backups.push(rewound.backupSessionId);
      const restored = await page.evaluate(payload => yan.restoreSessionRewind(payload), {
        sessionId: branch.id, conversationRevision: rewound.session.conversationRevision
      });
      assert.equal(restored.ok, true, restored.error); backups.push(restored.backupSessionId);
      branch = restored.session;
    }
    assert.equal(backups.length, 4);
    const originalIds = (await allSessions()).map(session => session.id).sort();
    assert.equal(originalIds.length, 6);
    await page.evaluate(id => loadSession(id), branch.id);
    await checkVisible(source.id, branch.id);
    await page.locator(`.recent-session-list .session-item[data-id="${branch.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '回退备份（4）' }).click();
    assert.equal(await page.locator('#sessionRewindBackupsDialog .session-backup-row').count(), 4);
    await page.screenshot({ path: path.join(output, 'backup-history.png') });
    await page.locator(`[data-backup-id="${backups[0]}"]`).click();
    await page.waitForFunction(id => state.currentSession.id === id, backups[0]);
    assert.deepEqual((await read(backups[0])).messages.map(message => message.content), originalHistory);
    await page.evaluate(id => loadSession(id), branch.id);
    assert.deepEqual((await read(branch.id)).messages.map(message => message.content), originalHistory);
    report.checks.push('four durable rewind snapshots stay in source history; task lists show only the original and actual branch with a visible branch badge');

    // Terminate this independently verified test main process without normal
    // quit handlers, then reopen the exact same isolated profile twice.
    for (let crash = 0; crash < 2; crash++) {
      const process = application.process();
      assert.ok(process.pid > 0);
      const exited = new Promise(resolve => process.once('exit', resolve));
      process.kill('SIGKILL');
      await exited;
      await application.close().catch(() => {});
      application = null; page = null;
      await launch();
      await checkVisible(source.id, branch.id);
      assert.deepEqual((await allSessions()).map(session => session.id).sort(), originalIds);
      assert.deepEqual((await read(branch.id)).messages.map(message => message.content), originalHistory);
      for (const backup of backups) assert.ok(await read(backup));
    }
    report.checks.push('two abrupt main-process exits and complete restarts create no conversations and preserve all backup records');
    await page.evaluate(id => loadSession(id), branch.id);
    await page.screenshot({ path: path.join(output, 'after-restart.png') });

    // Continuing a snapshot is deliberate new conversation work, so it must
    // become discoverable as a branch without changing the source or snapshot.
    const continued = await read(backups[0]);
    continued.messages.push({ role: 'user', content: 'Deliberately continue this saved version', ts: Date.now() });
    await page.evaluate(session => yan.saveSession(session), continued);
    await refresh();
    assert.equal(await page.evaluate(id => state.sessions.some(session => session.id === id), continued.id), true);
    assert.equal(await page.locator(`.recent-session-list [data-id="${continued.id}"] .session-kind-badge`).innerText(), '分支');
    assert.deepEqual((await read(branch.id)).messages.map(message => message.content), originalHistory);
    report.checks.push('a deliberately continued snapshot becomes a visible independent branch; source content remains unchanged');
    await page.evaluate(id => { state.config.language = 'en'; window.YanI18n.apply('en'); openSessionRewindBackups(id); }, branch.id);
    await page.waitForFunction(() => document.querySelector('#sessionRewindBackupsTitle')?.textContent === 'Rewind backups');
    assert.doesNotMatch(await page.locator('#sessionRewindBackupsDialog').innerText(), /[\u3400-\u9fff]/u);
    report.checks.push('the backup dialog, branch badge and dynamic message counts have English translations');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
  } finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    await application?.close().catch(() => {});
    const resolved = path.resolve(profile);
    assert.ok(resolved.startsWith(temporaryRoot + path.sep) && path.basename(resolved).startsWith('z-backup-sidebar-e2e-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
