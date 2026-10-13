'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeSidecar, collectFailedRunResult } = require('../lib/opencode-sidecar');

const failureMessage = '[Z_NATIVE_RETRY_EXHAUSTED] Service unavailable HTTP 503';
function history() {
  const created = Date.now();
  return [
    { info: { id: 'previous', role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'text', text: 'Earlier turn' }] },
    { info: { id: 'progress', role: 'assistant', time: { created, completed: created + 1 },
        finish: 'tool-calls', tokens: { input: 3, output: 2 } }, parts: [
      { type: 'text', text: 'The existing change is saved.' },
      { type: 'tool', callID: 'write-1', tool: 'write', state: {
        status: 'completed', input: { filePath: 'fixture.txt' }, output: 'saved once' } }
    ] },
    { info: { id: 'failed', role: 'assistant', time: { created: created + 2, completed: created + 3 },
        error: { name: 'APIError', data: { message: failureMessage } } }, parts: [
      { type: 'text', text: 'Partial summary before the error.' }
    ] }
  ];
}
const run = () => ({ openCodeSessionID: 'fixture-session', directory: '/fixture',
  baselineIDs: new Set(['previous']), baselineReady: true });

test('terminal failure retains current text, completed tool results and original error', async () => {
  const result = await collectFailedRunResult({ session: {
    messages: async () => ({ data: history() })
  } }, run(), {}, new Error(failureMessage));
  assert.equal(result.status, 'error');
  assert.equal(result.openCodeSessionId, 'fixture-session');
  assert.equal(result.error, failureMessage);
  assert.match(result.text, /change is saved/);
  assert.match(result.text, /Partial summary/);
  assert.doesNotMatch(result.text, /Earlier turn/);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].status, 'completed');
  assert.equal(result.toolCalls[0].output, 'saved once');
  assert.equal(result.usage.input, 3);
});

test('failed result collection has a deadline and does not replay old work during setup', async () => {
  const client = { session: { messages: () => new Promise(() => {}) } };
  const result = await collectFailedRunResult(client, { ...run(), lastObservedMessages: history() }, {},
    new Error('connection lost'), { timeoutMs: 15 });
  assert.equal(result.status, 'error');
  assert.match(result.text, /change is saved/);
  const early = await collectFailedRunResult(client, { ...run(), baselineReady: false,
    lastObservedMessages: history() }, {}, new Error('setup failed'), { timeoutMs: 15 });
  assert.equal(early.text, '');
  assert.deepEqual(early.toolCalls, []);
});

test('actual sidecar failure attaches persisted work and never replays exhausted inference', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-failure-result-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('z-failure-result-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let messages = [history()[0]];
  let prompts = 0;
  const events = [];
  const sidecar = new OpenCodeSidecar({ appRoot: path.resolve(__dirname, '..'), dataDir: root,
    log: { warn() {}, info() {} } });
  sidecar.start = async () => ({ ok: true });
  sidecar.client = { session: {
    create: async () => ({ data: { id: 'fixture-session', directory: root } }),
    messages: async () => ({ data: messages }),
    status: async () => ({ data: {} }),
    promptAsync: async () => { prompts++; messages = history(); return { data: true }; },
    abort: async () => ({ data: true }), todo: async () => ({ data: [] }), diff: async () => ({ data: [] })
  }, event: { subscribe: async (_query, { signal }) => ({ stream: (async function* () {
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  })() }) } };
  await assert.rejects(sidecar.run({ runId: 'failed-fixture', workspace: root, hasUserWorkspace: true,
    prompt: 'Inspect fixture', providerId: 'fixture', modelId: 'fixture', workMode: 'normal',
    utility: true, observerEnabled: false }, event => events.push(event)), error => {
    assert.match(error.message, /Z_NATIVE_RETRY_EXHAUSTED/);
    assert.equal(error.runResult.status, 'error');
    assert.equal(Object.keys(error).includes('runResult'), false, 'generic error logs must not dump conversation content');
    assert.match(error.runResult.text, /change is saved/);
    assert.match(error.runResult.text, /Partial summary/);
    assert.equal(error.runResult.toolCalls[0].status, 'completed');
    assert.equal(error.runResult.toolCalls[0].output, 'saved once');
    return true;
  });
  assert.equal(prompts, 1);
  assert.equal(events.filter(event => event.type === 'z.model.retrying').length, 0);
  assert.equal(sidecar.activeRuns.size, 0);
});
