'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeSidecar, collectInterruptedRunResult } = require('../lib/opencode-sidecar');

function assistant(id, parts) {
  return { info: { id, role: 'assistant', time: { created: Date.now() }, tokens: { input: 3, output: 2 } }, parts };
}
function history() {
  return [
    assistant('old', [{ type: 'text', text: 'Previous turn' }]),
    assistant('step-1', [
      { type: 'text', text: 'I inspected the configuration.' },
      { type: 'tool', tool: 'read', callID: 'read-1', state: { status: 'completed', input: { filePath: 'fixture.txt' }, output: 'fixture contents' } }
    ]),
    assistant('step-2', [
      { type: 'text', text: 'The next change is' },
      { type: 'tool', tool: 'bash', callID: 'bash-1', state: { status: 'running', input: { command: 'test-command' }, output: 'started' } }
    ])
  ];
}
function runState() {
  return { openCodeSessionID: 'kernel-session', directory: '/fixture', baselineIDs: new Set(['old']), todoUpdated: true };
}

test('interruption preserves partial text, completed and unfinished tools, and todos from this turn', async () => {
  const client = { session: {
    messages: async (_query, options) => { assert.equal(options.signal.aborted, false); return { data: history() }; },
    todo: async () => ({ data: [{ id: 'todo-1', content: 'Finish the change', status: 'in_progress', priority: 'medium' }] })
  } };
  const result = await collectInterruptedRunResult(client, runState(), { workMode: 'normal' });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.openCodeSessionId, 'kernel-session');
  assert.match(result.text, /inspected the configuration/);
  assert.match(result.text, /The next change is/);
  assert.doesNotMatch(result.text, /Previous turn/);
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(result.toolCalls.map(t=>t.status), ['completed', 'interrupted']);
  assert.equal(result.toolCalls[0].output, 'fixture contents');
  assert.equal(result.toolCalls[1].output, 'started');
  assert.equal(result.todos.length, 1);
  assert.equal(result.error, '');
});

test('an unreachable kernel uses the last observed work and never waits indefinitely to stop', async () => {
  const run = { ...runState(), lastObservedMessages: history(), lastObservedTodos: [] };
  const result = await collectInterruptedRunResult({ session: {
    messages: () => new Promise(()=>{}), todo: async () => { throw new Error('kernel unavailable'); }
  } }, run, {}, { timeoutMs: 20 });
  assert.match(result.text, /The next change is/);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.status, 'interrupted');
});

test('cancellation before the kernel starts remains a resumable interrupted result', async () => {
  const result = await collectInterruptedRunResult(null, { baselineIDs: new Set() });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, []);
});

test('cancel while resuming history does not archive old replies as new work', async () => {
  const result = await collectInterruptedRunResult({ session: {
    messages: async () => ({ data: history() }), todo: async () => ({ data: [] })
  } }, { ...runState(), baselineIDs: new Set(), baselineReady: false, lastObservedMessages: history() });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.openCodeSessionId, 'kernel-session');
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, []);
});

test('the actual sidecar cancellation path returns saved work instead of an empty result', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-cancel-result-'));
  t.after(() => {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let messages = [];
  let started;
  const promptStarted = new Promise(resolve=>{ started=resolve; });
  const sidecar = new OpenCodeSidecar({ appRoot: path.resolve(__dirname,'..'), dataDir: root, log: { warn() {}, info() {} } });
  sidecar.start = async () => ({ ok: true });
  sidecar.client = { session: {
    create: async () => ({ data: { id: 'kernel-session', directory: root } }),
    messages: async () => ({ data: messages }),
    status: async () => ({ data: { 'kernel-session': { type: 'busy' } } }),
    promptAsync: async () => { messages = history().slice(1); started(); return { data: true }; },
    abort: async () => ({ data: true }), todo: async () => ({ data: [] }), diff: async () => ({ data: [] })
  }, event: { subscribe: async (_query, {signal}) => ({ stream: (async function* () {
    if (!signal.aborted) await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  })() }) } };
  const pending = sidecar.run({ runId:'cancel-fixture', workspace:root, hasUserWorkspace:true,
    prompt:'Inspect a fixture', providerId:'fixture', modelId:'fixture', workMode:'normal' },()=>{});
  await promptStarted;
  assert((await sidecar.cancel('cancel-fixture')).ok);
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.text, /inspected the configuration/);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.openCodeSessionId, 'kernel-session');
});
