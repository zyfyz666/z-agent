'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const storageLayout = require('../lib/storage-layout');
const { mergeChangeHistory } = require('../lib/run-change-summary');
const mainPath = path.resolve(__dirname, '..', 'main.js');
const main = fs.readFileSync(mainPath, 'utf8');

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'z-run-snapshot-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const sessionId = 'sess_run_snapshot';
  const handlers = new Map();
  const valid = value => /^[A-Za-z0-9_-]{1,200}$/.test(String(value || ''));
  const context = vm.createContext({
    fs, fsp: fs.promises, path, require: createRequire(mainPath), mergeChangeHistory,
    isSafeSessionId: valid, isSafePathSegment: valid,
    ensureZagent: () => { fs.mkdirSync(storageLayout.workspaceStateRoot(workspace), { recursive: true }); },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    readSessionRecord: async id => id === sessionId ? { id, workspace } : null,
    workspaceSandbox: { normalizeWorkspace: value => value ? path.resolve(value) : '' },
    sameWorkspace: (left, right) => path.resolve(left) === path.resolve(right),
    resourceLocks: { withLock: (_key, _mode, _options, operation) => operation() },
    resolveRollbackTarget: async (_workspace, target) => ({ ok: true, path: path.resolve(workspace, target) }),
    appendZagentLog: () => {}
  });
  for (const [startMarker, endMarker] of [
    ['function runSnapshotPath(', '\nfunction isSafePathSegment('],
    ['async function loadSessionChangeHistory(', '\nfunction isPathInside('],
    ['async function applySnapshotRollback(', '\nfunction appendZagentLog('],
    ["ipcMain.handle('zagent:rollback-run'", '\n// ---------------------------------------------------------------------------']
  ]) {
    const start = main.indexOf(startMarker), end = main.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(main.slice(start, end), context);
  }
  function snapshot(runId, changes) {
    const file = path.join(workspace, '.zagent', 'snapshots', sessionId, `${runId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId, runId, changes }));
    return file;
  }
  return { workspace, sessionId, context, snapshot,
    rollback: runId => handlers.get('zagent:rollback-run')({}, { sessionId, runId, workspace }),
    history: () => context.loadSessionChangeHistory(workspace, sessionId),
    resolve: runId => context.runSnapshotPath(workspace, sessionId, runId) };
}

test('run snapshots live under the workspace .zagent directory', t => {
  const f = fixture(t);
  const expected = path.join(f.workspace, '.zagent', 'snapshots', f.sessionId, 'run-new.json');
  assert.equal(f.resolve('run-new'), expected);
  assert.equal(fs.existsSync(path.dirname(expected)), true);
  assert.equal(f.resolve('../escape'), null);
});

test('history merges every run snapshot of the session', async t => {
  const f = fixture(t);
  f.snapshot('run-earlier', [{ path: 'earlier.txt', before: 'earlier-before', after: 'earlier-after' }]);
  f.snapshot('run-later', [{ path: 'later.txt', before: 'later-before', after: 'later-after' }]);
  const history = await f.history();
  assert.deepEqual(history.map(change => change.path).sort(), ['earlier.txt', 'later.txt']);
  assert.equal(history.find(change => change.path === 'later.txt').before, 'later-before');
});

test('an unreadable snapshot is skipped without breaking history', async t => {
  const f = fixture(t);
  const corrupt = f.snapshot('run-corrupt', []);
  fs.writeFileSync(corrupt, '{');
  assert.equal(f.resolve('run-corrupt'), corrupt);
  assert.equal((await f.history()).length, 0);
});

test('the rollback handler restores a run and consumes its snapshot', async t => {
  const f = fixture(t);
  f.snapshot('run-revert', [{ path: 'source.txt', before: 'original source', after: 'changed source' }]);
  fs.writeFileSync(path.join(f.workspace, 'source.txt'), 'changed source');
  const result = await f.rollback('run-revert');
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'source.txt'), 'utf8'), 'original source');
  assert.equal(f.resolve('run-revert'), null);
  assert.equal((await f.history()).length, 0);
  fs.writeFileSync(path.join(f.workspace, 'source.txt'), 'subsequent user edit');
  assert.equal((await f.rollback('run-revert')).ok, false);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'source.txt'), 'utf8'), 'subsequent user edit');
});
