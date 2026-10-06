'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { executeMemoryOperation } = require('../lib/memory-database');
const { MemoryReviewQueue } = require('../lib/memory-review-jobs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-memory-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'memory.sqlite');
  const op = (name, args = {}) => executeMemoryOperation(dbPath, `review.${name}`, args);
  return { root, dbPath, op };
}
const job = (id = 'run-1', sessionId = 'sess_aaaa', revision = 0) => ({ id, sessionId, conversationRevision: revision, payload: { prompt: 'Review verified outcomes', result: { text: 'Result' } } });

test('queue enqueue is idempotent and rows remain isolated by task and revision', t => {
  const { op } = fixture(t);
  op('enqueue', { job: job(), now: 1000 }); op('enqueue', { job: job(), now: 2000 });
  op('enqueue', { job: job('run-2', 'sess_bbbb'), now: 2000 });
  op('enqueue', { job: job('run-3', 'sess_aaaa', 1), now: 2000 });
  assert.equal(op('list', { sessionId: 'sess_aaaa', conversationRevision: 0 }).length, 1);
  assert.equal(op('list', { sessionId: 'sess_aaaa', conversationRevision: 1 })[0].id, 'run-3');
  assert.equal(op('list', { sessionId: 'sess_bbbb', conversationRevision: 0 })[0].id, 'run-2');
  assert.equal(op('list', { sessionId: 'sess_aaaa', conversationRevision: 0 })[0].payload, undefined);
});

test('lease expiration allows recovery and fences the previous owner', t => {
  const { op } = fixture(t);
  op('enqueue', { job: job(), now: 1000 });
  assert.equal(op('claim', { owner: 'first', now: 1000, leaseMs: 100 }).attempts, 1);
  assert.equal(op('claim', { owner: 'second', now: 1099 }), null);
  assert.equal(op('claim', { owner: 'second', now: 1100 }).attempts, 2);
  assert.equal(op('owns', { id: 'run-1', owner: 'first', now: 1100 }), false);
  assert.equal(op('renew', { id: 'run-1', owner: 'first', now: 1100 }).changed, 0);
  assert.equal(op('finish', { id: 'run-1', owner: 'first', now: 1100 }).changed, 0);
  assert.equal(op('fail', { id: 'run-1', owner: 'first', now: 1100 }).changed, 0);
  assert.equal(op('finish', { id: 'run-1', owner: 'second', now: 1150 }).changed, 1);
  const finished = op('list', { sessionId: 'sess_aaaa', includePayload: true })[0];
  assert.equal(finished.status, 'done'); assert.deepEqual(finished.payload, {});
});

test('failure retries wait for backoff and eventually become terminal', t => {
  const { op } = fixture(t);
  op('enqueue', { job: job(), now: 1000 });
  op('claim', { owner: 'worker', now: 1000 });
  op('fail', { id: 'run-1', owner: 'worker', now: 1000, maxAttempts: 2, error: 'Transient provider error' });
  assert.equal(op('claim', { owner: 'worker', now: 15999 }), null);
  assert.equal(op('claim', { owner: 'worker', now: 16000 }).attempts, 2);
  op('fail', { id: 'run-1', owner: 'worker', now: 16000, maxAttempts: 2, error: 'Repeated provider error' });
  assert.equal(op('list', { sessionId: 'sess_aaaa' })[0].status, 'failed');
  assert.equal(op('claim', { owner: 'worker', now: 9999999 }), null);
});

test('shutdown release preserves pending payload for restart without releasing another owner', t => {
  const { op } = fixture(t);
  op('enqueue', { job: job('run-a'), now: 1000 }); op('enqueue', { job: job('run-b'), now: 1001 });
  op('claim', { owner: 'first', now: 1002 }); op('claim', { owner: 'second', now: 1002 });
  assert.equal(op('release', { owner: 'first', now: 1003 }).changed, 1);
  const recovered = op('claim', { owner: 'restarted', now: 1004 });
  assert.equal(recovered.id, 'run-a'); assert.equal(recovered.payload.prompt, 'Review verified outcomes');
  assert.equal(op('owns', { owner: 'second', id: 'run-b', now: 1004 }), true);
});

test('retrieval usage ignores late writes and stays revision-specific', t => {
  const { op } = fixture(t);
  op('usage-save', { sessionId: 'sess_aaaa', conversationRevision: 0, runId: 'new', now: 200, items: [{ id: 'new-memory' }] });
  op('usage-save', { sessionId: 'sess_aaaa', conversationRevision: 0, runId: 'old', now: 100, items: [{ id: 'old-memory' }] });
  op('usage-save', { sessionId: 'sess_aaaa', conversationRevision: 1, runId: 'rewound', now: 300, items: [] });
  assert.equal(op('usage-get', { sessionId: 'sess_aaaa', conversationRevision: 0 }).runId, 'new');
  assert.equal(op('usage-get', { sessionId: 'sess_aaaa', conversationRevision: 1 }).runId, 'rewound');
});

test('two independent processes cannot claim the same job', async t => {
  const { root, dbPath, op } = fixture(t);
  op('enqueue', { job: job() });
  const helper = path.join(root, 'claim.cjs');
  fs.writeFileSync(helper, `const {executeMemoryOperation}=require(${JSON.stringify(path.resolve(__dirname, '../lib/memory-database'))});
    console.log(JSON.stringify(executeMemoryOperation(process.argv[2],'review.claim',{owner:process.argv[3]})));`);
  const results = await Promise.all(['first','second'].map(owner => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, dbPath, owner], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', error = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject); child.once('exit', code => code ? reject(new Error(error)) : resolve(JSON.parse(output)));
  })));
  assert.equal(results.filter(Boolean).length, 1);
});

test('queue driver drains a durable job and clears its evidence payload after completion', async t => {
  const { dbPath, op } = fixture(t);
  op('enqueue', { job: job() });
  const seen = [];
  const queue = new MemoryReviewQueue({ dbPath, execute: executeMemoryOperation, processJob: async (next, context) => {
    seen.push(next.id); assert.equal(context.isCurrent(), true); return { ok: true };
  } });
  t.after(() => queue.stop());
  await queue.drain();
  assert.deepEqual(seen, ['run-1']);
  assert.equal(op('list', { sessionId: 'sess_aaaa' })[0].status, 'done');
});

test('stopping a queue invalidates and aborts the in-flight callback before another owner resumes it', async t => {
  const { dbPath, op } = fixture(t);
  op('enqueue', { job: job() });
  let release, context;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = new MemoryReviewQueue({ dbPath, execute: executeMemoryOperation, processJob: async (_job, current) => {
    context = current; await gate;
    assert.equal(current.isCurrent(), false); assert.equal(current.signal.aborted, true);
    return { skipped: true };
  } });
  const draining = queue.drain();
  assert.equal(context.isCurrent(), true);
  queue.stop();
  const replacement = op('claim', { owner: 'replacement' });
  assert.equal(replacement.id, 'run-1');
  release(); await draining;
  assert.equal(op('owns', { owner: 'replacement', id: 'run-1' }), true);
  assert.equal(op('list', { sessionId: 'sess_aaaa' })[0].status, 'running');
});
