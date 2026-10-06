'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ResourceLockManager } = require('../lib/z-core/tools');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { network = true, vision } = {}) {
  const sent = [];
  const timers = new Map();
  const handlers = new Map();
  const locks = new ResourceLockManager();
  const config = { permissions: { allowNetwork: network }, api: { visionRelayEnabled: !!vision } };
  const runs = new Map([
    ['run-a', { zSessionId: 'session-a', workspace: 'workspace-a', visionAbortController: new AbortController() }],
    ['run-a2', { zSessionId: 'session-a', workspace: 'workspace-a2' }],
    ['run-b', { zSessionId: 'session-b', workspace: 'workspace-a' }]
  ]);
  const reconcile = new Map();
  let nextTimer = 0;
  let now = Date.now();
  const context = vm.createContext({
    crypto, path, Buffer, AbortController, console,
    Date: class extends Date { static now() { return now; } },
    process: { env: {} },
    openCodeActiveRuns: runs, openCodeRunReconcile: reconcile,
    browserAgentToolClaims: new Map(), resourceLocks: locks,
    loadConfig: () => config,
    mainWindow: { isDestroyed: () => false, webContents: { id: 1, send: (channel, detail) => sent.push({ channel, ...detail }) } },
    mainRendererReady: true,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    ipcMain: { on: (name, handler) => handlers.set(name, handler) },
    deliveryVisualPrompt: () => '',
    buildScreenshotRelayInput: () => ({ withPrevious: false, attachments: [], userPrompt: '' }),
    normalizeAgentModelSelection: () => ({ capabilities: { imageInput: !vision } }),
    getVisionRelayModels: () => [{ providerId: 'fixture', modelId: 'vision-fixture' }],
    describeImages: vision || (() => { throw new Error('No model should be called.'); }),
    isRecoverableVisionRelayError: () => false
  });
  vm.runInContext(section('const browserAgentBridgeToken =', '\nfunction sessionActionForOpenCodeTool('), context);
  vm.runInContext(section("ipcMain.on('browser:agent-command-result'", "\nipcMain.on('session:agent-command-result'"), context);
  const pending = vm.runInContext('browserAgentBridgePending', context);
  const operations = vm.runInContext('browserAgentBridgeOperations', context);
  const commands = () => sent.filter(item => item.requestId);
  const f = {
    context, sent, commands, pending, operations, timers, locks, runs, reconcile, config,
    dispatch(action, id, runId = 'run-a', params = {}) {
      return context.dispatchBrowserAgentCommand(action, { ...params, z_run_id: runId }, { operationId: id });
    },
    reply(operationId, result = { ok: true }) {
      const command = commands().find(item => item.operationId === operationId);
      assert.ok(command, `Command ${operationId} was dispatched`);
      handlers.get('browser:agent-command-result')({ sender: { id: 1 } }, { requestId: command.requestId, result });
    },
    timeout(operationId) {
      const timer = timers.get(operations.get(operationId)?.timer);
      assert.ok(timer, 'Operation has a deadline timer');
      timer.fn();
    },
    advance(ms) { now += ms; },
    socket(operationId, action = 'click', params = {}) {
      const socket = new EventEmitter();
      socket.setEncoding = () => {};
      socket.end = value => { socket.response = JSON.parse(value); };
      socket.destroyed = false;
      context.handleBrowserAgentBridgeSocket(socket);
      socket.emit('data', `${JSON.stringify({ token: vm.runInContext('browserAgentBridgeToken', context),
        operationId, action, params: { z_run_id: 'run-a', ...params } })}\n`);
      return socket;
    }
  };
  t.after(async () => {
    context.stopBrowserAgentBridge();
    await tick();
    assert.equal(operations.size, 0, 'No browser operation is left pending');
    assert.equal(pending.size, 0, 'No renderer response is left pending');
    assert.equal(timers.size, 0, 'No operation deadline is left pending');
    assert.equal(locks.status().locked, false, 'No browser lock remains held');
  });
  return f;
}

test('tabs and find keep the browser tool ownership claim path', t => {
  const f = fixture(t);
  assert.equal(f.context.browserActionForOpenCodeTool('browser_tabs'), 'tabs');
  assert.equal(f.context.browserActionForOpenCodeTool('z_browser_browser_find'), 'find');
  f.context.trackBrowserAgentToolClaim('run-b', { type: 'session.next.tool.called',
    data: { callID: 'call-find', tool: 'browser_find', input: { text: 'Find me' } } });
  assert.equal(f.context.resolveAuthoritativeBrowserRun('find', { z_run_id: 'run-a' }).runId, 'run-b');
});

test('independent conversations do not block while all actions within one conversation serialize', async t => {
  const f = fixture(t);
  const first = f.dispatch('snapshot', 'first');
  const same = f.dispatch('read_page', 'same', 'run-a2');
  const other = f.dispatch('click', 'other', 'run-b', { tab_id: 'tab-b' });
  await tick();
  assert.deepEqual(f.commands().map(item => item.operationId), ['first', 'other']);
  assert.equal(f.commands()[1].params.tab_id, 'tab-b');
  assert.equal(f.commands()[1].params.z_session_id, 'session-b');
  assert.ok(f.commands()[0].deadlineAt > Date.now());
  assert.equal(f.commands()[0].params.z_deadline_at, f.commands()[0].deadlineAt);
  f.reply('other');
  f.reply('first');
  await tick();
  assert.equal(f.commands()[2].operationId, 'same');
  f.reply('same');
  assert.ok((await Promise.all([first, same, other])).every(result => result.ok));
});

test('disconnect while waiting for the lock removes the queued action before it can execute', async t => {
  const f = fixture(t);
  const first = f.dispatch('click', 'first');
  await tick();
  const socket = f.socket('disconnected');
  await tick();
  assert.equal(f.operations.size, 2);
  socket.destroyed = true;
  socket.emit('close');
  await tick();
  assert.equal(f.operations.has('disconnected'), false);
  assert.equal(Object.values(f.locks.status().resources)[0].waiting, 0);
  f.reply('first');
  await first;
  await tick();
  assert.deepEqual(f.commands().map(item => item.operationId), ['first']);
});

test('queued calls use an end-to-end deadline and cannot execute after timing out', async t => {
  const f = fixture(t);
  const first = f.dispatch('click', 'first');
  const expired = f.dispatch('click', 'expired');
  await tick();
  f.timeout('expired');
  const expiredResult = await expired;
  assert.equal(expiredResult.code, 'Z_BROWSER_TIMEOUT');
  assert.equal(expiredResult.uncertain, undefined, 'A queued operation is known not to have executed');
  assert.equal(Object.values(f.locks.status().resources)[0].waiting, 0);
  f.reply('first');
  await first;
  await tick();
  assert.deepEqual(f.commands().map(item => item.operationId), ['first']);
});

test('an elapsed deadline is checked before dispatch even if the timer callback is delayed', async t => {
  const f = fixture(t);
  const first = f.dispatch('click', 'first');
  const expired = f.dispatch('click', 'expired');
  await tick();
  f.advance(40_001);
  f.reply('first');
  await first;
  assert.equal((await expired).code, 'Z_BROWSER_TIMEOUT');
  assert.deepEqual(f.commands().map(item => item.operationId), ['first']);
});

test('active timeouts cancel the correct tab, ignore late results, and release the queue', async t => {
  const f = fixture(t);
  const first = f.dispatch('click', 'first', 'run-a', { tab_id: 'tab-a', z_session_id: 'forged', z_deadline_at: 1 });
  const next = f.dispatch('snapshot', 'next');
  await tick();
  f.timeout('first');
  const firstResult = await first;
  assert.equal(firstResult.code, 'Z_BROWSER_TIMEOUT');
  assert.equal(firstResult.uncertain, true, 'Dispatched input cannot be claimed to have been rolled back');
  const cancel = f.sent.find(item => item.action === 'cancel');
  assert.equal(cancel.params.tab_id, 'tab-a');
  assert.equal(cancel.params.z_session_id, 'session-a');
  assert.equal(cancel.params.reason, 'bridge_timeout');
  await tick();
  f.reply('first', { ok: true, late: true });
  assert.equal(f.pending.size, 1);
  f.reply('next');
  assert.equal((await next).ok, true);
});

test('screenshot model analysis runs outside the conversation browser lock', async t => {
  const description = deferred();
  let visionOptions;
  const f = fixture(t, { vision: options => { visionOptions = options; return description.promise; } });
  const shot = f.dispatch('screenshot', 'shot');
  await tick();
  f.reply('shot', { ok: true, image: { data: 'test-image', mimeType: 'image/png' } });
  await tick();
  assert.ok(visionOptions);
  const click = f.dispatch('click', 'click');
  await tick();
  assert.deepEqual(f.commands().map(item => item.operationId), ['shot', 'click']);
  f.reply('click');
  assert.equal((await click).ok, true);
  description.resolve({ text: 'Captured page description' });
  assert.equal((await shot).visualEvidence.report, 'Captured page description');
});

test('cancelling or timing out screenshot analysis aborts the model request and settles promptly', async t => {
  let signal;
  const f = fixture(t, { vision: options => { signal = options.signal; return new Promise(() => {}); } });
  const shot = f.dispatch('screenshot', 'shot');
  await tick();
  f.reply('shot', { ok: true, image: { data: 'test-image', mimeType: 'image/png' } });
  await tick();
  f.timeout('shot');
  assert.equal((await shot).code, 'Z_BROWSER_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(f.sent.some(item => item.action === 'cancel'), false, 'The completed capture is not repeated or cancelled');
});

test('run cancellation and release cancel both active and waiting browser operations', async t => {
  const f = fixture(t);
  const first = f.dispatch('click', 'first');
  const queued = f.dispatch('snapshot', 'queued');
  await tick();
  f.runs.get('run-a').visionAbortController.abort();
  const firstResult = await first, queuedResult = await queued;
  assert.equal(firstResult.code, 'BROWSER_ACTION_CANCELLED');
  assert.equal(firstResult.uncertain, true);
  assert.equal(queuedResult.code, 'BROWSER_ACTION_CANCELLED');
  assert.equal(queuedResult.uncertain, undefined);
  assert.equal(f.commands().length, 1);
  const other = f.dispatch('snapshot', 'other', 'run-b');
  await tick();
  f.context.notifyBrowserAgentRelease('run-b');
  assert.equal((await other).code, 'BROWSER_ACTION_CANCELLED');
});

test('app shutdown terminates lock waiters as well as dispatched browser work', async t => {
  const f = fixture(t);
  const first = f.dispatch('click', 'first');
  const queued = f.dispatch('snapshot', 'queued');
  await tick();
  f.context.stopBrowserAgentBridge();
  assert.equal((await first).code, 'Z_APP_EXITING');
  assert.equal((await queued).code, 'Z_APP_EXITING');
  assert.equal(f.commands().length, 1);
});

test('release includes authoritative scope even after the active run has been removed', t => {
  const f = fixture(t);
  f.context.notifyBrowserAgentRelease('run-a');
  assert.equal(f.sent.at(-1).params.z_session_id, 'session-a');
  assert.equal(f.sent.at(-1).params.z_workspace, 'workspace-a');
  f.reconcile.set('run-a', { meta: { zSessionId: 'session-a', workspace: 'workspace-a' } });
  f.runs.delete('run-a');
  f.context.notifyBrowserAgentRelease('run-a');
  assert.equal(f.sent.at(-1).params.z_session_id, 'session-a');
  assert.equal(f.sent.at(-1).params.z_workspace, 'workspace-a');
  f.context.notifyBrowserAgentRelease('unknown-run');
  assert.equal(f.sent.at(-1).params.z_session_id, '');
  assert.equal(f.sent.at(-1).params.z_workspace, '');
  assert.equal(f.sent.at(-1).params.z_run_id, 'unknown-run');
});

test('open and new-tab navigation obey current network settings without blocking local files or tab listing', async t => {
  const f = fixture(t, { network: false });
  for (const [action, params] of [
    ['open', { target_type: 'url', url_or_path: 'https://example.test' }],
    ['tabs', { action: 'new', target_type: 'search', url_or_path: 'query' }],
    ['tabs', { action: 'new', target_type: 'file', url_or_path: 'https://example.test' }]
  ]) assert.equal((await f.dispatch(action, 'blocked', 'run-a', params)).code, 'BROWSER_NETWORK_DISABLED');
  assert.equal(f.commands().length, 0);
  for (const [id, params] of [['blank', { action: 'new' }], ['list', { action: 'list' }],
    ['file', { action: 'new', target_type: 'file', url_or_path: 'C:\\preview.html' }]]) {
    const call = f.dispatch('tabs', id, 'run-a', params);
    await tick();
    f.reply(id);
    assert.equal((await call).ok, true);
  }
});

test('network permission revoked while queued is enforced when the browser lock is acquired', async t => {
  const f = fixture(t);
  const first = f.dispatch('snapshot', 'first');
  const queued = f.dispatch('tabs', 'queued', 'run-a', { action: 'new', target_type: 'url', url_or_path: 'https://example.test' });
  await tick();
  f.config.permissions.allowNetwork = false;
  f.reply('first');
  await first;
  assert.equal((await queued).code, 'BROWSER_NETWORK_DISABLED');
  assert.equal(f.commands().length, 1);
});

test('a run removed while waiting cannot issue a later browser command', async t => {
  const f = fixture(t);
  const first = f.dispatch('snapshot', 'first');
  const queued = f.dispatch('click', 'queued', 'run-a2');
  await tick();
  f.runs.delete('run-a2');
  f.reply('first');
  await first;
  assert.equal((await queued).code, 'BROWSER_RUN_NOT_ACTIVE');
  assert.equal(f.commands().length, 1);
});

test('an active operation ID cannot be dispatched twice', async t => {
  const f = fixture(t);
  const first = f.dispatch('click', 'same-id');
  assert.equal((await f.dispatch('click', 'same-id')).code, 'BROWSER_OPERATION_ALREADY_ACTIVE');
  await tick();
  f.reply('same-id');
  assert.equal((await first).ok, true);
  assert.equal(f.commands().length, 1);
});
