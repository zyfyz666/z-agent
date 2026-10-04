'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production run rejection handler without starting Electron or
// the model kernel. In particular, an error can arrive before the renderer has
// received a status event, so the completed result must carry the snapshot.
function failedRunHandler() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const marker = source.indexOf('console.error(`[opencode] Run ${runId} failed:`, error);');
  assert.ok(marker > 0, 'main-process run rejection handler exists');
  const start = source.lastIndexOf('.catch(error => {', marker) + '.catch('.length;
  const end = source.indexOf('}).finally(() => {', marker) + 1;
  assert.ok(start > 0 && end > start, 'the production rejection handler is isolated');
  const calls = { flushed: [], core: [], reconciled: [], sent: [] };
  const handler = vm.runInNewContext(`(${source.slice(start, end)})`, {
    console: { error() {} },
    runId: 'run-failed-history',
    OPENCODE_VERSION: 'test',
    coreTurnStarted: true,
    flushOpenCodeRendererEvents: runId => calls.flushed.push(runId),
    yanCore: { completeTurn: (runId, result) => calls.core.push({ runId, result }) },
    completeOpenCodeReconcileRun: (runId, result) => calls.reconciled.push({ runId, result }),
    mainWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => calls.sent.push({ channel, payload }) }
    },
    openCodeErrorDetail: error => error.message
  });
  return { handler, calls };
}

test('a rejected run retains its Observer snapshot in completion and history replay', async () => {
  const { handler, calls } = failedRunHandler();
  const watchdog = {
    enabled: true, phase: 'error', outcome: 'error', judgeEvery: 6,
    observedSteps: 12, judgedSteps: 12, checks: 2, interventions: 1,
    streak: 1, updatedAt: 2000,
    events: [{ id: 'wd-1', ts: 1000, step: 6, action: 'remind',
      rules: ['R1_loop'], advisories: [], severity: 1,
      message: 'Try a different approach.', delivery: 'delivered' }],
    model: { name: 'Observer model', modelId: 'observer', phase: 'stopped',
      checks: 2, message: 'Keep the verified fix.', error: '' }
  };
  const error = Object.assign(new Error('OpenCode kernel exited'), { watchdog });
  await Promise.reject(error).catch(handler);

  assert.deepEqual(calls.flushed, ['run-failed-history']);
  assert.equal(calls.core.length, 1);
  assert.equal(calls.reconciled.length, 1);
  assert.equal(calls.sent.length, 1);
  const result = calls.reconciled[0].result;
  assert.equal(result.status, 'error');
  assert.equal(result.error, error.message);
  assert.deepEqual(JSON.parse(JSON.stringify(result.watchdog)), watchdog);
  assert.equal(calls.core[0].result, result);
  assert.equal(calls.sent[0].channel, 'opencode:completed');
  assert.equal(calls.sent[0].payload.runId, 'run-failed-history');
  assert.equal(calls.sent[0].payload.result, result);
});

test('a failure before Observer startup does not invent historical telemetry', async () => {
  const { handler, calls } = failedRunHandler();
  await Promise.reject(new Error('Model startup failed')).catch(handler);
  const result = calls.sent[0].payload.result;
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'Model startup failed');
  assert.equal(Object.hasOwn(result, 'watchdog'), false);
});
