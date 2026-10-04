'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { configureSoftwareRendering, createRendererHealthLog, attachProcessHealthLogging, attachRendererRecovery } = require('../lib/renderer-recovery');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await wait(5);
  assert.ok(predicate(), 'expected recovery state reached before timeout');
}
function fixture(t, options = {}) {
  const contents = new EventEmitter();
  const window = new EventEmitter();
  const events = [], readiness = [], opened = [], dialogs = [];
  let loads = 0, recoveryPages = 0, destroyed = false;
  Object.assign(contents, {
    isDestroyed: () => destroyed,
    loadURL: async url => {
      recoveryPages++;
      assert.match(decodeURIComponent(url), /判断|重试打开界面/);
      contents.emit('did-finish-load');
    }
  });
  Object.assign(window, { webContents: contents, isDestroyed: () => destroyed });
  const controller = attachRendererRecovery(window, {
    loadInterface: async () => { loads++; contents.emit('did-finish-load'); },
    log: { file: 'local-log', write: (event, detail) => events.push({ event, detail }) },
    shell: { openPath: async value => { opened.push(value); } },
    dialog: { showMessageBox: async (_window, config) => { dialogs.push(config); return { response: 2 }; } },
    onAvailabilityChange: ready => readiness.push(ready),
    retryDelayMs: 2, loadTimeoutMs: 20,
    ...options
  });
  t.after(controller.dispose);
  return { contents, window, events, readiness, opened, dialogs, controller,
    get loads() { return loads; }, get recoveryPages() { return recoveryPages; },
    destroy() { destroyed = true; window.emit('closed'); },
    crash(reason = 'crashed') { contents.emit('render-process-gone', {}, { reason, exitCode: 23 }); },
    click(action) { let prevented = false; contents.emit('will-navigate', { preventDefault() { prevented = true; } }, `z-recovery://${action}`); return prevented; }
  };
}

test('software rendering disables hardware acceleration before readiness', () => {
  const calls = [];
  configureSoftwareRendering({ disableHardwareAcceleration() { calls.push('software'); } });
  assert.deepEqual(calls, ['software']);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.indexOf('configureSoftwareRendering(app)') < main.indexOf('app.whenReady()'));
  assert.doesNotMatch(main, /appendSwitch\(['"](?:ignore-gpu-blocklist|enable-unsafe-swiftshader)/);
});

test('renderer crash reloads only the interface and records exit details', async t => {
  const f = fixture(t);
  f.crash();
  await wait(12);
  assert.equal(f.loads, 1);
  assert.deepEqual(f.readiness, [false, true]);
  assert.equal(f.events[0].detail.reason, 'crashed');
  assert.ok(f.events.some(entry => entry.event === 'renderer-recovered'));
});

test('repeated crashes stop after two reloads and display an actionable page', async t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) { f.crash('oom'); await wait(8); }
  assert.equal(f.loads, 2);
  assert.equal(f.recoveryPages, 1);
  assert.equal(f.controller.isRecoveryPage(), true);
  assert.equal(f.readiness.at(-1), false);
  assert.equal(f.click('logs'), true);
  assert.deepEqual(f.opened, ['local-log']);
  f.click('retry');
  f.click('retry');
  await wait(8);
  assert.equal(f.loads, 3, 'double clicking cannot duplicate a recovery');
  assert.equal(f.controller.isRecoveryPage(), false);
});

test('crash reports arriving together coalesce to one reload', async t => {
  const f = fixture(t);
  f.crash(); f.crash(); f.crash();
  await wait(10);
  assert.equal(f.loads, 1);
});

test('failed interface loads have bounded retries', async t => {
  let calls = 0;
  const f = fixture(t, { loadInterface: async () => { calls++; throw new Error('local loading failure'); } });
  f.crash();
  await until(() => f.recoveryPages === 1);
  assert.equal(calls, 2);
  assert.equal(f.recoveryPages, 1);
});

test('stalled interface loads time out without a reload loop', async t => {
  let calls = 0;
  const f = fixture(t, { loadTimeoutMs: 8, loadInterface: () => { calls++; return new Promise(() => {}); } });
  f.crash();
  await until(() => f.recoveryPages === 1);
  assert.equal(calls, 2);
  assert.equal(f.recoveryPages, 1);
});

test('recovery page crash shows one native error dialog', async t => {
  const f = fixture(t, { maxRetries: 0 });
  f.crash(); f.crash(); f.crash();
  await wait(6);
  assert.equal(f.loads, 0);
  assert.equal(f.dialogs.length, 1);
  assert.deepEqual(f.dialogs[0].buttons, ['重试打开界面', '打开诊断日志', '稍后再试']);
});

test('clean exits, quitting, destroyed windows and subframe load failures do not reload', async t => {
  const clean = fixture(t), quitting = fixture(t, { isQuitting: () => true }), destroyed = fixture(t);
  clean.crash('clean-exit');
  clean.contents.emit('did-fail-load', {}, -100, 'failure', 'ignored', false);
  clean.contents.emit('did-fail-load', {}, -3, 'aborted', 'ignored', true);
  quitting.crash(); destroyed.crash(); destroyed.destroy();
  await wait(10);
  assert.equal(clean.loads + quitting.loads + destroyed.loads, 0);
});

test('healthy long-running windows regain their automatic recovery budget', async t => {
  let time = 1000;
  const f = fixture(t, { maxRetries: 1, retryWindowMs: 60, now: () => time });
  f.crash(); await wait(8);
  time += 61;
  f.crash(); await wait(8);
  assert.equal(f.loads, 2);
  assert.equal(f.recoveryPages, 0);
});

test('GPU exits are logged without reloading a healthy interface', () => {
  const app = new EventEmitter(), entries = [];
  attachProcessHealthLogging(app, { write: (...entry) => entries.push(entry) });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 99 });
  assert.deepEqual(entries, [['child-process-gone', { type: 'GPU', reason: 'crashed', exitCode: 99 }]]);
});

test('diagnostics are persistent, bounded and contain no conversation or URL fields', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-renderer-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = createRendererHealthLog(directory, { maxBytes: 1 });
  log.write('renderer-process-gone', { reason: 'oom', exitCode: 9, messages: ['private'], url: 'https://private.invalid', config: { secret: 'no' } });
  log.write('renderer-recovered');
  const previous = JSON.parse(fs.readFileSync(`${log.file}.1`, 'utf8'));
  assert.equal(previous.reason, 'oom');
  assert.equal(previous.exitCode, 9);
  assert.equal(previous.messages, undefined);
  assert.equal(previous.url, undefined);
  assert.equal(previous.config, undefined);
  assert.equal(JSON.parse(fs.readFileSync(log.file, 'utf8')).event, 'renderer-recovered');
});

test('completed background answers remain available while the view cannot reconcile them', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf('function completeOpenCodeReconcileRun(');
  const end = main.indexOf('\nfunction flushOpenCodeRendererEvents', start);
  const runs = new Map([['run-offline', { completed: null }]]), timers = [];
  const context = vm.createContext({ openCodeRunReconcile: runs, mainRendererReady: false,
    OPENCODE_RECONCILE_COMPLETED_TTL_MS: 60000,
    setTimeout(callback) { timers.push(callback); return { unref() {} }; }
  });
  vm.runInContext(main.slice(start, end), context);
  context.completeOpenCodeReconcileRun('run-offline', { text: 'completed while the renderer was down' });
  timers.shift()();
  assert.ok(runs.has('run-offline'), 'expiry waits for a working interface');
  assert.equal(timers.length, 1);
  context.mainRendererReady = true;
  timers.shift()();
  assert.equal(runs.has('run-offline'), false);
});
