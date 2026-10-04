'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const appRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-default-workspace-ui-'));
const outputDir = path.join(appRoot, 'output', 'default-workspace-ui');
fs.mkdirSync(outputDir, { recursive: true });
const configPath = path.join(userDataDir, 'YanData', 'config.json');
const report = { ok: false, checks: [], pageErrors: [] };
let application;
let page;

async function launch() {
  const env = { ...process.env, YAN_E2E_MODE: '1', YAN_E2E_USER_DATA_DIR: userDataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    page = application.windows().find(window => /\/renderer\/index\.html/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(page, 'main window must exist');
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(userDataDir));
}

function externalConfigEdit(edit) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  edit(config);
  const temporary = configPath + '.ui-test.tmp';
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2));
  fs.renameSync(temporary, configPath);
}

(async () => {
  try {
    await launch();
    const first = await page.evaluate(() => ({ id: state.currentSession.id, workspace: state.currentSession.workspace, kind: state.currentSession.workspaceKind }));
    assert.equal(first.kind, 'default');
    assert(fs.existsSync(first.workspace));
    assert(path.resolve(first.workspace).startsWith(path.resolve(userDataDir) + path.sep), 'default test folders must stay inside the isolated profile');
    assert.equal(await page.locator('#taskBarFolderName').textContent(), '任务文件夹');
    assert.equal(await page.locator('#taskBarOpenFolder').isEnabled(), true);
    assert.equal(await page.locator('#taskBarFolder').evaluate(element => element.classList.contains('task-bar-folder-empty')), false);
    report.checks.push('new task has an accessible automatic folder without asking for a workspace');

    const second = await page.evaluate(() => window.yan.createSession(true, ''));
    assert.equal(second.workspaceKind, 'default');
    assert.notEqual(second.workspace, first.workspace);
    await page.evaluate(async session => {
      session.title = 'Persistent automatic task';
      session.messages = [{ role: 'user', content: 'Keep this task for restart verification', ts: Date.now() }];
      await window.yan.saveSession(session);
    }, second);
    fs.writeFileSync(path.join(first.workspace, 'retained.txt'), 'persistent task output');
    assert.equal(fs.existsSync(path.join(second.workspace, 'retained.txt')), false);
    await page.evaluate(async () => { await refreshSessions(); renderSessionList(); });
    assert.equal(await page.locator('.workspace-group[data-workspace-group="blank"]').count(), 1);
    report.checks.push('different conversations use separate folders and share the conversation sidebar group');

    const savedConnections = await page.evaluate(async () => {
      const base = { apiKey: 'local-fixture-only', baseUrl: 'http://127.0.0.1:9/v1', streamEnabled: true };
      const main = await window.yan.connectionsSave({ ...base, name: 'Original gateway', preset: 'openai', apiFormat: 'responses', manualModelId: 'gpt-6-astra' });
      const claude = await window.yan.connectionsSave({ ...base, name: 'Secondary gateway', preset: 'anthropic', apiFormat: 'anthropic', manualModelId: 'claude-opus-4-7' });
      if (!main.ok || !claude.ok) throw new Error('Fixture connection save failed');
      openSettings('api');
      return { main: main.connection.providerId, claude: claude.connection.providerId };
    });
    await page.getByText('Original gateway', { exact: true }).first().waitFor();
    externalConfigEdit(config => {
      config.api.providerSuppliers[savedConnections.main][0].name = 'Renamed gateway';
      config.api.connections = config.api.connections.filter(connection => connection.providerId !== savedConnections.claude);
      for (const field of ['providerSuppliers', 'providerConfigs', 'providerActiveSupplierIds', 'apiKeys']) delete config.api[field][savedConnections.claude];
      delete config.providerModels[savedConnections.claude];
    });
    await page.evaluate(() => { switchTab('general'); switchTab('api'); });
    await page.locator('#connectionList .provider-name').filter({ hasText: /^Renamed gateway$/ }).waitFor();
    assert.equal(await page.locator('#connectionList').getByText(/Original gateway|Secondary gateway/).count(), 0);
    report.checks.push('switching back to API settings reloads an external rename and deletion');
    externalConfigEdit(config => { config.api.providerSuppliers[savedConnections.main][0].name = 'Renamed gateway focus'; });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('#connectionList .provider-name').filter({ hasText: /^Renamed gateway focus$/ }).waitFor();
    externalConfigEdit(config => { config.api.providerSuppliers[savedConnections.main][0].name = 'Renamed gateway'; });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('#connectionList .provider-name').filter({ hasText: /^Renamed gateway$/ }).waitFor();
    report.checks.push('returning to the app refreshes the supplier cards');
    await page.screenshot({ path: path.join(outputDir, 'settings-renamed-connection.png') });

    await page.evaluate(() => closeSettings());
    await page.evaluate(async id => { await loadSession(id); }, first.id);
    const selectedFolder = path.join(userDataDir, 'chosen-project');
    fs.mkdirSync(selectedFolder);
    await page.evaluate(async folder => { await applySessionWorkspace(folder); }, selectedFolder);
    assert.equal(await page.evaluate(() => state.currentSession.workspaceKind), 'selected');
    assert.equal(await page.evaluate(() => state.currentSession.workspace), selectedFolder);
    await page.evaluate(() => applySessionWorkspace(''));
    assert.equal(await page.evaluate(() => state.currentSession.workspaceKind), 'default');
    assert.equal(await page.locator('#taskBarFolderName').textContent(), '任务文件夹');
    report.checks.push('an optional project selection can return to the automatic task folder');
    await page.screenshot({ path: path.join(outputDir, 'automatic-task-folder.png') });

    await application.close(); application = null;
    await launch();
    const restored = await page.evaluate(id => window.yan.getSession(id), second.id);
    assert(restored, 'default task survives restart');
    assert.equal(restored.workspace, second.workspace);
    assert.equal(restored.workspaceKind, 'default');
    assert.equal(fs.readFileSync(path.join(first.workspace, 'retained.txt'), 'utf8'), 'persistent task output');
    const connections = await page.evaluate(() => window.yan.connectionsList());
    assert.deepEqual(connections.map(connection => connection.name), ['Renamed gateway']);
    report.checks.push('task folders, generated files, and supplier changes survive a full restart');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error.message;
    report.uiNames = await page?.locator('#connectionList .provider-name').allTextContents().catch(() => []);
    report.apiNames = await page?.evaluate(async () => (await window.yan.connectionsList()).map(connection => connection.name)).catch(() => []);
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      report.diskNames = (config.api.connections || []).map(connection => config.api.providerSuppliers[connection.providerId]?.[0]?.name);
    }
    await page?.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await application?.close().catch(() => {});
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    assert.equal(path.dirname(path.resolve(userDataDir)), path.resolve(os.tmpdir()));
    assert(path.basename(userDataDir).startsWith('z-default-workspace-ui-'));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
