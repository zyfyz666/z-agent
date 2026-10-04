'use strict';

// Real isolated Electron, CodeGraph CLI indexing, graph conversion and viewer
// HTTP. No model connection, generated graph fixture, or mocked IPC is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryRoot, 'z-project-map-'));
const profile = path.join(root, 'profile');
const emptyWorkspace = path.join(root, 'Empty task folder');
const sourceWorkspace = path.join(root, 'Map source fixture');
const outputDir = path.join(appRoot, 'output', 'project-map');
const emptyMessage = '当前任务文件夹中没有可显示的代码。请选择包含源码的项目文件夹后再打开项目地图。';
const sourceFiles = {
  'src/math.js': "export function add(left, right) {\n  return left + right;\n}\nexport const marker = 'PROJECT_MAP_SOURCE_7319';\n",
  'src/main.js': "import { add } from './math.js';\nexport function total() {\n  return add(2, 3);\n}\n"
};
const report = { ok: false, checks: [], pageErrors: [], viewerHttp: [] };
let application;
let page;
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(emptyWorkspace, { recursive: true });
fs.mkdirSync(path.join(sourceWorkspace, 'src'), { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
for (const [relative, content] of Object.entries(sourceFiles)) fs.writeFileSync(path.join(sourceWorkspace, relative), content);

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile,
    Z_E2E_PARENT_PID: String(process.pid), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DOWNLOAD: '1', DO_NOT_TRACK: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    page = application.windows().find(window => /\/renderer\/index\.html/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'the isolated main window exists');
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  // Use bundled fallback fonts; the graph itself must load from its real server.
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
    && state.currentSession && state.config && window.ZUnderstandAnything);
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  await application.evaluate(({ app }) => {
    const localRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/main.js`);
    const codeGraph = localRequire('./lib/codegraph-runtime');
    const viewer = localRequire('./lib/understand-anything-runtime');
    globalThis.projectMapRuntimeLog = [];
    for (const operation of ['ensureIndex', 'syncIndex']) {
      const original = codeGraph[operation];
      codeGraph[operation] = async function (...args) {
        const result = await original.apply(this, args);
        globalThis.projectMapRuntimeLog.push({ operation, workspace: args[1], ok: result.ok,
          error: result.error, stdout: result.stdout, stderr: result.stderr });
        return result;
      };
    }
    const originalOpen = viewer.openUnderstandAnything;
    viewer.openUnderstandAnything = async function (...args) {
      const result = await originalOpen.apply(this, args);
      globalThis.projectMapRuntimeLog.push({ operation: 'open', workspace: args[1], ok: result.ok,
        empty: !!result.empty, nodeCount: result.graph?.nodeCount, error: result.error });
      return result;
    };
  });
  await page.evaluate(() => {
    window.projectMapToasts = [];
    window.projectMapLifecycle = [];
    for (const operation of ['open', 'close', 'refresh', 'handleWorkspaceChanged']) {
      const original = window.ZUnderstandAnything[operation];
      window.ZUnderstandAnything[operation] = function (...args) {
        window.projectMapLifecycle.push({ operation, args, view: currentWindowView,
          workspace: state.currentSession?.workspace, stack: new Error().stack });
        return original.apply(this, args);
      };
    }
    const node = document.querySelector('#toast');
    const capture = () => {
      if (!node.classList.contains('hidden') && node.textContent.trim()) window.projectMapToasts.push(node.textContent.trim());
    };
    new MutationObserver(capture).observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
  });
}

async function createWorkspaceSession(workspace, title) {
  return page.evaluate(async ({ workspace, title }) => {
    const session = await z.createSession(true, workspace);
    await z.renameSession(session.id, title);
    await refreshSessions();
    await loadSession(session.id);
    return { id: session.id, workspace: state.currentSession.workspace };
  }, { workspace, title });
}

async function openMap() {
  await page.locator('[data-window-view="project-map"]').click();
  await page.waitForFunction(() => currentWindowView === 'project-map' && window.ZUnderstandAnything.isOpen());
  await page.waitForFunction(() => {
    const status = document.querySelector('#understandAnythingStatus');
    const src = document.querySelector('#understandAnythingFrame').src;
    return status.classList.contains('is-error') || /没有可显示的代码/.test(status.textContent)
      || (/^http:\/\/127\.0\.0\.1:\d+\//.test(src) && status.hidden);
  }, null, { timeout: 120_000 });
  assert.equal(await page.locator('#understandAnythingStatus').evaluate(node => node.classList.contains('is-error')), false,
    await page.locator('#understandAnythingStatus').textContent());
}

async function assertEmptyMap() {
  await page.waitForFunction(message => document.querySelector('#understandAnythingStatus').textContent === message, emptyMessage,
    { timeout: 120_000 });
  assert.equal(await page.locator('#understandAnythingStatus').isVisible(), true);
  assert.equal(await page.locator('#understandAnythingStatus').evaluate(node => node.classList.contains('is-error')), false);
  assert.equal(await page.locator('#understandAnythingFrame').getAttribute('src'), 'about:blank');
  assert.equal(await page.evaluate(() => currentWindowView), 'project-map');
  assert.deepEqual(await page.evaluate(() => window.projectMapToasts), [], 'empty maps never produce an error toast');
}

async function viewerRecords() {
  return application.evaluate(({ app }) => {
    const localRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/main.js`);
    return localRequire('./lib/understand-anything-runtime').listUnderstandAnything().map(record => ({
      workspace: record.workspace, pid: record.pid, nodeCount: record.graph?.nodeCount
    }));
  });
}

async function returnToComposer(expectedDraft) {
  await page.locator('[data-window-view="main"]').click();
  await page.waitForFunction(() => currentWindowView === 'main' && !window.ZUnderstandAnything.isOpen());
  assert.equal(await page.locator('#understandAnythingLayer').isVisible(), false);
  const composer = page.locator('#composerInput');
  assert.equal(await composer.isVisible(), true);
  assert.equal(await composer.getAttribute('contenteditable'), 'true');
  if (expectedDraft !== undefined) assert.equal(await page.evaluate(() => getComposerText()), expectedDraft);
  await composer.fill('PROJECT_MAP_COMPOSER_USABLE_7319');
  assert.equal(await page.evaluate(() => getComposerText()), 'PROJECT_MAP_COMPOSER_USABLE_7319');
}

async function readViewerJson(frameUrl, endpoint, parameters = {}) {
  const base = new URL(frameUrl);
  assert.equal(base.hostname, '127.0.0.1');
  const url = new URL(endpoint, base);
  url.searchParams.set('token', base.searchParams.get('token'));
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  report.viewerHttp.push({ endpoint, status: response.status });
  assert.equal(response.status, 200, `${endpoint} loads from the spawned viewer`);
  return response.json();
}

(async () => {
  try {
    await launch();
    const emptySession = await createWorkspaceSession(emptyWorkspace, 'Empty project map fixture');
    assert.equal(path.resolve(emptySession.workspace), path.resolve(emptyWorkspace));
    await openMap();
    await assertEmptyMap();
    assert.ok(fs.existsSync(path.join(emptyWorkspace, '.codegraph', 'codegraph.db')), 'real CLI created the empty index');
    assert.equal(JSON.parse(fs.readFileSync(path.join(emptyWorkspace, '.zagent', 'ua', 'knowledge-graph.json'), 'utf8')).nodes.length, 0);
    assert.deepEqual(await viewerRecords(), [], 'empty projects do not launch a viewer process');
    await page.screenshot({ path: path.join(outputDir, 'empty-project.png') });
    const emptyRefresh = await page.evaluate(() => window.ZUnderstandAnything.refresh());
    assert.equal(emptyRefresh.ok, true);
    assert.equal(emptyRefresh.empty, true);
    await assertEmptyMap();
    await returnToComposer();
    report.checks.push('empty task folder is indexed/converted for real; open and refresh show a neutral empty state, blank iframe and no toast/viewer');

    const sourceSession = await createWorkspaceSession(sourceWorkspace, 'Source project map fixture');
    assert.equal(path.resolve(sourceSession.workspace), path.resolve(sourceWorkspace));
    const sourceDraft = 'PROJECT_MAP_SOURCE_DRAFT_7319';
    await page.locator('#composerInput').fill(sourceDraft);
    await openMap();
    const frameUrl = await page.locator('#understandAnythingFrame').getAttribute('src');
    assert.match(frameUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    const graph = await readViewerJson(frameUrl, '/knowledge-graph.json');
    assert.ok(graph.nodes.length > 0);
    assert.ok(graph.nodes.some(node => node.filePath === 'src/math.js'));
    assert.ok(graph.nodes.some(node => node.filePath === 'src/main.js'));
    assert.ok(graph.nodes.some(node => node.name === 'add'), 'CodeGraph parsed actual source symbols');
    const converted = JSON.parse(fs.readFileSync(path.join(sourceWorkspace, '.zagent', 'ua', 'knowledge-graph.json'), 'utf8'));
    assert.equal(graph.nodes.length, converted.nodes.length);
    assert.equal(fs.existsSync(path.join(sourceWorkspace, '.ua')), false);
    assert.equal(fs.existsSync(path.join(sourceWorkspace, '.understand-anything')), false);
    for (const [relative, content] of Object.entries(sourceFiles)) {
      const source = await readViewerJson(frameUrl, '/file-content.json', { path: relative });
      assert.equal(source.path, relative);
      assert.equal(source.language, 'javascript');
      assert.equal(source.content, content, 'viewer source preview reads the real indexed file');
    }
    const frame = await page.locator('#understandAnythingFrame').contentFrame();
    await frame.locator('.react-flow__node').first().waitFor({ timeout: 45_000 });
    assert.ok(await frame.locator('.react-flow__node').count() > 0, 'the embedded graph renders visible nodes');
    await page.evaluate(workspace => window.ZUnderstandAnything.handleWorkspaceChanged({ workspace }), emptyWorkspace);
    assert.equal(await page.locator('#understandAnythingFrame').getAttribute('src'), frameUrl,
      'a delayed event from the previous workspace must not replace the current project graph');
    assert.equal(await page.locator('#understandAnythingStatus').isVisible(), false);
    const records = await viewerRecords();
    assert.equal(records.length, 1);
    assert.equal(path.resolve(records[0].workspace), path.resolve(sourceWorkspace));
    assert.ok(records[0].pid > 0);
    assert.equal(records[0].nodeCount, graph.nodes.length);
    report.graph = { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, renderedNodes: await frame.locator('.react-flow__node').count() };
    await page.screenshot({ path: path.join(outputDir, 'source-project.png') });
    await returnToComposer(sourceDraft);
    report.checks.push('real CLI symbols are converted into .zagent/ua, served through authenticated viewer HTTP and rendered; source content matches, and stale workspace events cannot replace the current graph');

    await openMap();
    for (const relative of Object.keys(sourceFiles)) {
      const target = path.resolve(sourceWorkspace, relative);
      assert.ok(target.startsWith(path.resolve(sourceWorkspace) + path.sep));
      fs.rmSync(target);
    }
    const cleared = await page.evaluate(() => window.ZUnderstandAnything.refresh());
    assert.equal(cleared.ok, true, cleared.error);
    assert.equal(cleared.empty, true, 'real incremental sync removes deleted source nodes');
    await assertEmptyMap();
    assert.deepEqual(await viewerRecords(), [], 'refresh stops the previous viewer when the project becomes empty');
    await returnToComposer('PROJECT_MAP_COMPOSER_USABLE_7319');
    report.checks.push('refreshing a previously populated project after deleting its fixture sources clears the stale iframe and stops the viewer; returning to main preserves a usable composer');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks, graph: report.graph, viewerHttp: report.viewerHttp }));
  } catch (error) {
    report.error = error.stack;
    const generated = path.join(sourceWorkspace, '.zagent', 'ua', 'knowledge-graph.json');
    report.sourceFixture = { files: Object.keys(sourceFiles).map(relative => ({ relative, exists: fs.existsSync(path.join(sourceWorkspace, relative)) })),
      graph: fs.existsSync(generated) ? JSON.parse(fs.readFileSync(generated, 'utf8')) : null };
    if (page && !page.isClosed()) {
      report.ui = await page.evaluate(() => ({ view: currentWindowView,
        workspace: state.currentSession?.workspace,
        status: document.querySelector('#understandAnythingStatus')?.textContent,
        error: document.querySelector('#understandAnythingStatus')?.classList.contains('is-error'),
        toasts: window.projectMapToasts })).catch(() => null);
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (application) report.runtime = await application.evaluate(() => globalThis.projectMapRuntimeLog).catch(() => []);
    if (page && !page.isClosed()) report.lifecycle = await page.evaluate(() => window.projectMapLifecycle).catch(() => []);
    report.indexErrors = Object.fromEntries([['empty', emptyWorkspace], ['source', sourceWorkspace]].map(([name, workspace]) => {
      const file = path.join(workspace, '.codegraph', 'errors.log');
      return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''];
    }));
    await application?.close().catch(() => {});
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    if (!report.ok) fs.writeFileSync(path.join(outputDir, 'failure-report.json'), JSON.stringify(report, null, 2));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-project-map-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
