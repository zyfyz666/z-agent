'use strict';

// A complete profile survives a restart: provider catalog, browser cookies,
// desktop preferences and a durable interrupted-run journal.
// All data and credentials below are synthetic and confined to a temp profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { ZCore } = require('../lib/z-core');

const appRoot = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'z-profile-persistence-'));
const dataRoot = path.join(profile, 'ZData');
const coreRoot = path.join(dataRoot, 'z-core');
const partition = 'persist:z-browser';
const outputRoot = path.join(appRoot, 'output', 'profile-persistence');
const providerId = 'conn-profile-fixture';
const models = [
  { id: 'fixture-model-a', name: 'Fixture model A', modelType: 'text' },
  { id: 'fixture-model-b', name: 'Fixture model B', modelType: 'text' }
];
const catalog = {
  api: {
    provider: providerId, model: models[0].id, connectionsMigrated: true,
    connections: [{ id: providerId, providerId, supplierId: 'official', name: 'Fixture gateway', preset: 'openai' }],
    providerSuppliers: { [providerId]: [{ id: 'official', name: 'Fixture gateway', baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'synthetic-profile-key', apiFormat: 'openai', models }] },
    providerActiveSupplierIds: { [providerId]: 'official' }
  },
  providerModels: { [providerId]: models },
  agentModel: { providerId, supplierId: 'official', modelId: models[0].id, modelType: 'text', name: models[0].name },
  language: 'zh-CN', theme: 'dark'
};
const keys = { meta: 'z.workspace-sidebar-meta.v1', collapsed: 'z.workspace-sidebar-collapsed.v1', height: 'z.composer.height' };
const meta = { 'profile-project': { pinned: true, hidden: false } };
const collapsed = ['profile-project'];
const report = { ok: false, pageErrors: [] };
let application;
let page;

fs.mkdirSync(coreRoot, { recursive: true });
fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify(catalog));

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile,
    Z_E2E_PARENT_PID: String(process.pid), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  page = await application.firstWindow();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && typeof state === 'object' && state.currentSession && state.config);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  assert.equal(await page.evaluate(() => window.z.getBrowserPartition()), partition);
}

async function readCatalog() {
  return page.evaluate(async id => {
    const cfg = await window.z.getConfig();
    const supplier = cfg.api.providerSuppliers[id]?.find(item => item.id === 'official');
    const secret = await window.z.getProviderSecret(id, 'official');
    return {
      connections: cfg.api.connections.filter(item => item.providerId === id).map(item => item.id),
      name: supplier?.name, ids: supplier?.models?.map(item => item.id),
      providerModelIds: cfg.providerModels[id]?.map(item => item.id), selected: cfg.agentModel?.modelId,
      keyPreserved: secret.ok === true && secret.apiKey === 'synthetic-profile-key' && supplier?.apiKey === ''
    };
  }, providerId);
}

function seedInterruptedRun(session) {
  const sessionFile = path.join(dataRoot, 'sessions', `${session.id}.json`);
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  saved.messages = [{ role: 'user', content: 'Restore the interrupted run', ts: Date.now() - 60000 }];
  fs.writeFileSync(sessionFile, JSON.stringify(saved));
  const runId = `run-${session.id}-interrupted`;
  const core = new ZCore({ rootDir: coreRoot });
  core.startTurn({ threadId: session.id, turnId: runId, workspace: session.workspace, title: 'Interrupted run',
    configSnapshot: { providerId, modelId: models[0].id, modelName: models[0].name, workMode: 'normal' },
    intent: { prompt: saved.messages[0].content, workMode: 'normal' } });
  const events = [
    { type: 'z.opencode.started', data: { sessionID: 'ses_profile_fixture' } },
    { type: 'message.part.updated', data: { part: { id: 'profile-text', type: 'text', text: 'Recovered interrupted reply' } } },
    { type: 'session.next.tool.called', data: { callID: 'profile-read', tool: 'read', input: { filePath: 'source.js' } } },
    { type: 'session.next.tool.success', data: { callID: 'profile-read', result: 'Previously read source' } },
    { type: 'z.thrash.watchdog.status', data: {
      enabled: true, phase: 'observing', checks: 2, observations: 2, interventions: 0, observedSteps: 12,
      updatedAt: Date.now() - 1000, events: []
    } },
    { type: 'z.subagent.history', data: {
      childSessionID: 'child-profile', callId: 'profile-child', subagentType: 'explorer',
      messages: [{ info: { id: 'child-message', role: 'assistant' }, parts: [
        { id: 'child-text', type: 'text', text: 'Child findings', time: { end: Date.now() - 1000 } }
      ] }]
    } }
  ];
  for (const event of events) core.ingestProviderEvent(runId, event);
  core.persist();
  assert.ok(fs.readFileSync(path.join(coreRoot, 'events.jsonl'), 'utf8').includes('z.thrash.watchdog.status'));
  return { runId, sessionFile };
}

(async () => {
  try {
    await launch();
    const firstCatalog = await readCatalog();
    assert.deepEqual(firstCatalog, { connections: [providerId], name: 'Fixture gateway', ids: models.map(item => item.id),
      providerModelIds: models.map(item => item.id), selected: models[0].id, keyPreserved: true });
    const session = await page.evaluate(() => ({ id: state.currentSession.id, workspace: state.currentSession.workspace }));
    await page.evaluate(({ keys, meta, collapsed }) => {
      localStorage.setItem(keys.meta, JSON.stringify(meta));
      localStorage.setItem(keys.collapsed, JSON.stringify(collapsed));
      localStorage.setItem(keys.height, '180');
    }, { keys, meta, collapsed });
    await application.evaluate(async ({ session }, selectedPartition) => {
      const cookies = session.fromPartition(selectedPartition).cookies;
      await cookies.set({ url: 'http://profile.example.test', name: 'profile-session', value: 'preserved', expirationDate: Date.now() / 1000 + 3600 });
      await cookies.flushStore();
      session.defaultSession.flushStorageData();
    }, partition);
    await application.close();
    application = null;

    const { runId, sessionFile } = seedInterruptedRun(session);
    await launch();
    await page.waitForFunction(async ({ sessionId, runId }) => {
      const saved = await window.z.getSession(sessionId);
      return saved.messages?.some(message => message.agentRun?.runId === runId && message.agentRun.recoveredAfterRestart);
    }, { sessionId: session.id, runId });
    assert.deepEqual(await readCatalog(), firstCatalog, 'restarting must preserve both stored model catalogs and the selected model');
    const preferences = await page.evaluate(() => ({
      meta: workspaceSidebarMeta, collapsed: [...collapsedWorkspaceGroups], height: composerManualHeight
    }));
    assert.deepEqual(preferences, { meta, collapsed, height: 180 });
    const cookies = await application.evaluate(async ({ session }, selectedPartition) =>
      session.fromPartition(selectedPartition).cookies.get({ url: 'http://profile.example.test', name: 'profile-session' }), partition);
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].value, 'preserved');
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const recovered = saved.messages.filter(message => message.agentRun?.runId === runId);
    assert.equal(recovered.length, 1);
    const run = recovered[0].agentRun;
    assert.equal(run.status, 'interrupted');
    assert.equal(run.recoveredAfterRestart, true);
    assert.match(run.textContent, /Recovered interrupted reply/);
    assert.ok(run.timeline.some(item => item.type === 'tool_result' && item.callId === 'profile-read'));
    assert.equal(run.watchdog?.checks, 2, 'Observer status events survive journal recovery');
    assert.ok(run.subagents?.some(child => child.childSessionID === 'child-profile'), 'subagent history survives journal recovery');
    assert.equal(JSON.parse(fs.readFileSync(path.join(coreRoot, 'state.json'), 'utf8')).turns[runId].status, 'aborted');
    assert.deepEqual(report.pageErrors, []);
    fs.mkdirSync(outputRoot, { recursive: true });
    await page.screenshot({ path: path.join(outputRoot, 'profile-recovered.png') });
    report.ok = true;
    Object.assign(report, { modelsPreserved: models.length, cookiePreserved: true, preferencesPreserved: true,
      journalRecovered: true, observerChecks: run.watchdog.checks, recoveredMessages: recovered.length });
    console.log(JSON.stringify(report));
  } finally {
    await application?.close().catch(() => {});
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
    const resolved = path.resolve(profile);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('z-profile-persistence-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
