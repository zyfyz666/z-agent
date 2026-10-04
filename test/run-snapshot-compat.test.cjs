'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { LEGACY_STORAGE } = require('../lib/legacy-compat');
const storageLayout = require('../lib/storage-layout');
const { mergeChangeHistory } = require('../lib/run-change-summary');
const mainPath = path.resolve(__dirname, '..', 'main.js');
const main = fs.readFileSync(mainPath, 'utf8');

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'z-snapshot-compat-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const sessionId = 'sess_snapshot_compat';
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
  function snapshot(namespace, runId, changes) {
    const file = path.join(workspace, namespace, 'snapshots', sessionId, `${runId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId, runId, changes }));
    return file;
  }
  return { workspace, sessionId, context, snapshot,
    rollback: runId => handlers.get('zagent:rollback-run')({}, { sessionId, runId, workspace }),
    history: () => context.loadSessionChangeHistory(workspace, sessionId),
    resolve: runId => context.runSnapshotPath(workspace, sessionId, runId) };
}

test('a new worktree metadata folder does not hide a preceding-format run snapshot', async t => {
  const f = fixture(t);
  const file = f.snapshot(LEGACY_STORAGE.workspaceDir, 'run-old', [{ path: 'old.txt', before: 'before', after: 'after' }]);
  const original = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(path.join(f.workspace, '.zagent', 'worktrees'), { recursive: true });
  assert.equal(f.resolve('run-old'), file);
  assert.equal((await f.history()).length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.workspace, '.zagent', 'snapshots', f.sessionId, 'run-old.json')), false);
});

test('history merges both snapshot directories, preferring the current copy of a run', async t => {
  const f = fixture(t);
  const old = f.snapshot(LEGACY_STORAGE.workspaceDir, 'run-shared', [{ path: 'shared.txt', before: 'stale', after: 'old' }]);
  const current = f.snapshot('.zagent', 'run-shared', [{ path: 'shared.txt', before: 'current-before', after: 'current-after' }]);
  f.snapshot(LEGACY_STORAGE.workspaceDir, 'run-earlier', [{ path: 'earlier.txt', before: 'earlier-before', after: 'earlier-after' }]);
  f.snapshot('.zagent', 'run-later', [{ path: 'later.txt', before: 'later-before', after: 'later-after' }]);
  const history = await f.history();
  assert.equal(history.length, 3);
  assert.equal(history.find(change => change.path === 'shared.txt').before, 'current-before');
  assert.equal(history.find(change => change.path === 'shared.txt').after, 'current-after');
  assert.equal(f.resolve('run-shared'), current);
  assert.equal(fs.existsSync(old), true);
});

test('an unreadable current snapshot does not revive a stale previous copy', async t => {
  const f = fixture(t);
  f.snapshot(LEGACY_STORAGE.workspaceDir, 'run-corrupt', [{ path: 'stale.txt', before: 'old', after: 'old-after' }]);
  const current = f.snapshot('.zagent', 'run-corrupt', []);
  fs.writeFileSync(current, '{');
  assert.equal(f.resolve('run-corrupt'), current);
  assert.equal((await f.history()).length, 0);
});

test('the real rollback handler reads an old snapshot after a new metadata directory appears', async t => {
  const f = fixture(t);
  f.snapshot(LEGACY_STORAGE.workspaceDir, 'run-revert', [{ path: 'source.txt', before: 'original source', after: 'changed source' }]);
  fs.writeFileSync(path.join(f.workspace, 'source.txt'), 'changed source');
  fs.mkdirSync(path.join(f.workspace, '.zagent', 'worktrees'), { recursive: true });
  const result = await f.rollback('run-revert');
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'source.txt'), 'utf8'), 'original source');
  assert.equal(f.resolve('run-revert'), null);
  assert.equal((await f.history()).length, 0);
});

test('undo consumes the run across both directories without deleting or reactivating an older copy', async t => {
  const f = fixture(t);
  const old = f.snapshot(LEGACY_STORAGE.workspaceDir, 'run-duplicate', [{ path: 'source.txt', before: 'stale source', after: 'stale-after' }]);
  const original = fs.readFileSync(old, 'utf8');
  f.snapshot('.zagent', 'run-duplicate', [{ path: 'source.txt', before: 'correct source', after: 'modified source' }]);
  fs.writeFileSync(path.join(f.workspace, 'source.txt'), 'modified source');
  assert.equal((await f.rollback('run-duplicate')).ok, true);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'source.txt'), 'utf8'), 'correct source');
  assert.equal(fs.readFileSync(old, 'utf8'), original, 'the historical shadow stays untouched');
  assert.equal(f.resolve('run-duplicate'), null);
  assert.equal((await f.history()).length, 0);
  fs.writeFileSync(path.join(f.workspace, 'source.txt'), 'subsequent user edit');
  assert.equal((await f.rollback('run-duplicate')).ok, false);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'source.txt'), 'utf8'), 'subsequent user edit');
});
