'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSessionWriteQueue } = require('../lib/session-model');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const helperStart = main.indexOf('function isSafeSessionId(');
const helperEnd = main.indexOf('function sanitizeSessionReviewSummaries(', helperStart);
const ipcStart = main.indexOf("ipcMain.handle('session:storage-location'");
const ipcEnd = main.indexOf('async function getSessionBrowserStateRecord(', ipcStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart && ipcStart >= 0 && ipcEnd > ipcStart);

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-session-storage-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sessionsDir = path.join(temporary, 'custom-active-profile', 'ZData', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const handlers = new Map();
  const revealed = [];
  const stats = [];
  const queue = createSessionWriteQueue();
  const noMutation = () => assert.fail('storage metadata must not read conversation contents, create sessions, or change configuration');
  const context = vm.createContext({
    path, sessionsDir, withSessionWrite: queue,
    fsp: { stat: async file => { stats.push(file); return fs.promises.stat(file); }, readFile: noMutation, writeFile: noMutation, mkdir: noMutation },
    ensureDirs: noMutation, readSessionRecord: noMutation, createFreshSessionRecord: noMutation, loadConfig: noMutation, saveConfig: noMutation,
    shell: { showItemInFolder: file => revealed.push(file) },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
  });
  vm.runInContext(main.slice(helperStart, helperEnd), context);
  vm.runInContext(main.slice(ipcStart, ipcEnd), context);
  const file = id => path.join(sessionsDir, `${id}.json`);
  const write = (id, contents = 'Not parsed: fixture history bytes') => { fs.writeFileSync(file(id), contents); return file(id); };
  return { context, stats, revealed, queue, file, write, sessionsDir,
    get: id => handlers.get('session:storage-location')(null, id),
    reveal: id => handlers.get('session:storage-reveal')(null, id) };
}

test('location comes from the active profile session path without reading or changing history', async t => {
  const f = fixture(t);
  const id = 'sess_storage_fixture';
  const file = f.write(id);
  const before = fs.statSync(file);
  const location = await f.get(id);
  assert.deepEqual(JSON.parse(JSON.stringify(location)), {
    ok: true, id, path: file, directory: f.sessionsDir, fileName: `${id}.json`
  });
  assert.equal(path.isAbsolute(location.path), true);
  assert.deepEqual(f.stats, [file]);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Not parsed: fixture history bytes');
  assert.deepEqual(f.revealed, []);
});

test('invalid IDs, arbitrary paths, and path traversal fail before touching the filesystem', async t => {
  const f = fixture(t);
  for (const id of ['', null, {}, 123, 'sess_a', ' sess_valid ', '../sess_valid', 'sess_../../private', f.file('sess_valid'), 'C:\\private\\file.json']) {
    assert.equal((await f.get(id)).code, 'INVALID_SESSION_ID');
    assert.equal((await f.reveal(id)).code, 'INVALID_SESSION_ID');
  }
  assert.deepEqual(f.stats, []);
  assert.deepEqual(f.revealed, []);
});

test('missing or deleted sessions and directories report failure without creating history', async t => {
  const f = fixture(t);
  const missing = 'sess_missing';
  assert.equal((await f.get(missing)).code, 'SESSION_NOT_FOUND');
  assert.equal((await f.reveal(missing)).code, 'SESSION_NOT_FOUND');
  assert.equal(fs.existsSync(f.file(missing)), false);
  const id = 'sess_deleted';
  const file = f.write(id);
  assert.equal((await f.get(id)).ok, true);
  fs.unlinkSync(file);
  assert.equal((await f.reveal(id)).code, 'SESSION_NOT_FOUND');
  fs.mkdirSync(file);
  assert.equal((await f.get(id)).code, 'SESSION_NOT_FOUND');
  assert.deepEqual(f.revealed, []);
});

test('Locate targets the validated session JSON and rechecks after an in-app deletion', async t => {
  const f = fixture(t);
  const id = 'sess_locate';
  const file = f.write(id);
  const result = await f.reveal(id);
  assert.equal(result.revealed, true);
  assert.equal(result.path, file);
  assert.deepEqual(f.revealed, [file]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const deletion = f.queue(id, async () => { await gate; fs.unlinkSync(file); });
  const locate = f.reveal(id);
  await Promise.resolve();
  assert.equal(f.revealed.length, 1, 'Locate waits for the existing session write lock');
  release(); await deletion;
  assert.equal((await locate).code, 'SESSION_NOT_FOUND');
  assert.equal(f.revealed.length, 1);
});

test('filesystem and shell failures return explicit errors', async t => {
  const f = fixture(t);
  const id = 'sess_failure';
  f.write(id);
  f.context.shell.showItemInFolder = () => { throw new Error('shell unavailable'); };
  assert.equal((await f.reveal(id)).code, 'SESSION_STORAGE_REVEAL_FAILED');
  f.context.fsp.stat = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.equal((await f.get(id)).code, 'SESSION_STORAGE_UNAVAILABLE');
  assert.equal((await f.reveal(id)).code, 'SESSION_STORAGE_UNAVAILABLE');
});

test('preload storage APIs send only a session ID through dedicated channels', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'z') api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on() {}, removeListener() {} }, webUtils: {} })
  });
  await api.getSessionStorageLocation('sess_selected');
  await api.revealSessionStorage('sess_selected');
  assert.deepEqual(calls, [
    ['session:storage-location', 'sess_selected'],
    ['session:storage-reveal', 'sess_selected']
  ]);
});
