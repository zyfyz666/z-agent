'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const VIEWER = path.resolve(__dirname, '../lib/understand-anything/viewer/bin/viewer.mjs');
const TOKEN = 'project-map-viewer-test-token';
const CURRENT_DIR = path.join('.zagent', 'ua');

function createWorkspace(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'z-project-map-viewer-'));
  t.after(() => {
    assert.equal(path.dirname(workspace), tempRoot);
    assert.ok(path.basename(workspace).startsWith('z-project-map-viewer-'));
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}

function writeGraph(workspace, directory, name, nodes = []) {
  const graphDir = path.join(workspace, directory);
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'knowledge-graph.json'), JSON.stringify({
    project: { name }, nodes, edges: [],
  }));
}

async function withViewer(workspace, run) {
  const child = spawn(process.execPath, [VIEWER, workspace, '--port', '0', '--no-open'], {
    cwd: workspace,
    env: { ...process.env, UNDERSTAND_ACCESS_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const dashboardUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Viewer did not start: ${output}`)), 10_000);
      const finish = (error, value) => {
        clearTimeout(timeout);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        if (error) reject(error);
        else resolve(value);
      };
      const onError = error => finish(error);
      const onExit = (code, signal) => finish(new Error(`Viewer exited (${code ?? signal}): ${output}`));
      child.once('error', onError);
      child.once('exit', onExit);
      child.stderr.setEncoding('utf8');
      child.stdout.setEncoding('utf8');
      child.stderr.on('data', chunk => { output += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Dashboard URL: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
        if (match) finish(null, match[1]);
      });
    });
    const base = new URL(dashboardUrl);
    assert.equal(base.hostname, '127.0.0.1');
    assert.equal(base.searchParams.get('token'), TOKEN);
    await run(async (route, parameters = {}, token = TOKEN) => {
      const url = new URL(route, base);
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      if (token !== null) url.searchParams.set('token', token);
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timeout;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Viewer did not stop after test')), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

test('viewer serves current .zagent/ua graph and resolves source against the workspace', async t => {
  const workspace = createWorkspace(t);
  const sourcePath = path.join(workspace, 'src', 'app.js');
  const content = 'export const workspaceValue = 42;\n';
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, content);
  writeGraph(workspace, CURRENT_DIR, 'current', [{ id: 'app', type: 'file', filePath: sourcePath }]);
  const decoyPath = path.join(workspace, CURRENT_DIR, 'src', 'app.js');
  fs.mkdirSync(path.dirname(decoyPath), { recursive: true });
  fs.writeFileSync(decoyPath, 'wrong graph-directory source');

  await withViewer(workspace, async request => {
    const graph = await request('/knowledge-graph.json');
    assert.equal(graph.status, 200);
    assert.equal(graph.body.project.name, 'current');
    assert.equal(path.isAbsolute(graph.body.nodes[0].filePath), false);
    assert.equal(graph.body.nodes[0].filePath.replace(/\\/g, '/'), 'src/app.js');
    const source = await request('/file-content.json', { path: 'src/app.js' });
    assert.equal(source.status, 200);
    assert.equal(source.body.path, 'src/app.js');
    assert.equal(source.body.content, content);
    assert.equal(source.body.language, 'javascript');
    assert.equal(source.body.sizeBytes, Buffer.byteLength(content));
    assert.equal(source.body.lineCount, 2);
  });
});

test('current graph wins when both legacy graph directories also exist', async t => {
  const workspace = createWorkspace(t);
  writeGraph(workspace, '.understand-anything', 'legacy-understand');
  writeGraph(workspace, '.ua', 'legacy-ua');
  writeGraph(workspace, CURRENT_DIR, 'current');
  await withViewer(workspace, async request => {
    const graph = await request('/knowledge-graph.json');
    assert.equal(graph.status, 200);
    assert.equal(graph.body.project.name, 'current');
  });
});

for (const directory of ['.understand-anything', '.ua']) {
  test(`viewer still serves legacy ${directory} graph`, async t => {
    const workspace = createWorkspace(t);
    writeGraph(workspace, directory, directory);
    await withViewer(workspace, async request => {
      const graph = await request('/knowledge-graph.json');
      assert.equal(graph.status, 200);
      assert.equal(graph.body.project.name, directory);
    });
  });
}

test('legacy graph precedence stays unchanged when the current graph is absent', async t => {
  const workspace = createWorkspace(t);
  writeGraph(workspace, '.understand-anything', 'legacy-understand');
  writeGraph(workspace, '.ua', 'legacy-ua');
  fs.mkdirSync(path.join(workspace, CURRENT_DIR), { recursive: true });
  await withViewer(workspace, async request => {
    const graph = await request('/knowledge-graph.json');
    assert.equal(graph.status, 200);
    assert.equal(graph.body.project.name, 'legacy-understand');
  });
});

test('current graph and source endpoints still reject absent or incorrect tokens', async t => {
  const workspace = createWorkspace(t);
  writeGraph(workspace, CURRENT_DIR, 'protected');
  await withViewer(workspace, async request => {
    for (const route of ['/knowledge-graph.json', '/file-content.json']) {
      for (const token of [null, 'incorrect-token']) {
        const response = await request(route, { path: 'src/app.js' }, token);
        assert.equal(response.status, 403);
        assert.match(response.body.error, /missing or invalid token/i);
      }
    }
  });
});

test('missing-graph diagnostics name the current and both legacy directories', t => {
  const workspace = createWorkspace(t);
  const result = spawnSync(process.execPath, [VIEWER, workspace, '--no-open'], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.zagent\/ua\/knowledge-graph\.json/);
  assert.match(result.stderr, /\.understand-anything\//);
  assert.match(result.stderr, /\.ua\//);
});

test('viewer help explains graph directory precedence', t => {
  const workspace = createWorkspace(t);
  const result = spawnSync(process.execPath, [VIEWER, '--help'], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\.zagent\/ua\/[\s\S]*\.understand-anything\/[\s\S]*\.ua\//);
});
