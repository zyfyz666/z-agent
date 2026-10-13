'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { contextPromptParts, contextMessageReady, waitForContextMessage } = require('../lib/context-message-receipt');

const info = { id: 'msg_receipt', sessionID: 'session', role: 'user' };
const missing = () => ({ error: { name: 'NotFoundError', data: { message: 'Message not found' } }, response: { status: 404 } });
function fixture(read, parts) {
  return { client: { session: { message: read, promptAsync() { throw Error('Must never resend a prompt'); } } },
    sessionID: 'session', messageID: info.id, partIds: parts.map(p => p.id), pollMs: 1, timeoutMs: 200 };
}

test('dispatch acknowledgement can precede both message and attachment persistence', async () => {
  const parts = contextPromptParts([{ type: 'text', text: 'request' }, { type: 'file', mime: 'application/pdf', url: 'file:///fixture.pdf' }]);
  let reads = 0;
  const options = fixture(async (query) => {
    assert.equal(query.messageID, info.id);
    reads++;
    if (reads <= 2) return missing();
    return { data: { info, parts: parts.slice(0, reads - 3) } };
  }, parts);
  const result = await waitForContextMessage(options);
  assert.equal(reads, 5);
  assert.deepEqual(result.parts, parts);
  assert.equal(contextMessageReady({ info, parts: [parts[0]] }, options), false);
});

test('a thrown 404 is a temporary visibility failure; unrelated errors are not hidden', async () => {
  const parts = contextPromptParts([{ type: 'text', text: 'request' }]);
  let reads = 0;
  const options = fixture(async () => {
    if (++reads === 1) throw Object.assign(new Error('Message not found'), { name: 'NotFoundError' });
    return { data: { info, parts } };
  }, parts);
  await waitForContextMessage(options);
  assert.equal(reads, 2);
  let deniedReads = 0;
  await assert.rejects(waitForContextMessage(fixture(async () => {
    deniedReads++; return { error: { message: 'Access denied' }, response: { status: 403 } };
  }, parts)), /Access denied/);
  assert.equal(deniedReads, 1);
});

test('unavailable or hanging reads are bounded and remain eligible for settled-history recovery', async () => {
  const parts = contextPromptParts([{ type: 'text', text: 'request' }]);
  for (const read of [async () => missing(), () => new Promise(() => {})]) {
    const start = Date.now();
    await assert.rejects(waitForContextMessage({ ...fixture(read, parts), timeoutMs: 35 }), { code: 'CONTEXT_MESSAGE_PENDING' });
    assert(Date.now() - start < 500);
  }
});

test('user cancellation ends a pending receipt read without changing the submitted prompt', async () => {
  const controller = new AbortController();
  const parts = contextPromptParts([{ type: 'text', text: 'request' }]);
  const timer = setTimeout(() => controller.abort(new Error('User cancelled')), 10);
  try { await assert.rejects(waitForContextMessage({ ...fixture(() => new Promise(() => {}), parts), signal: controller.signal }), /User cancelled/); }
  finally { clearTimeout(timer); }
});

test('a receipt from another session or an assistant cannot satisfy the boundary', () => {
  const parts = contextPromptParts([{ type: 'text', text: 'request' }]);
  const options = fixture(async () => {}, parts);
  assert.equal(contextMessageReady({ info: { ...info, sessionID: 'other' }, parts }, options), false);
  assert.equal(contextMessageReady({ info: { ...info, role: 'assistant' }, parts }, options), false);
});

test('live guidance waits for every persisted attachment part without claiming model consumption', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { ContextStore } = require('../lib/context-store');
  const { OpenCodeSidecar } = require('../lib/opencode-sidecar');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-context-receipt-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('z-context-receipt-'));
    fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'notes.txt'); fs.writeFileSync(file, 'ATTACHMENT_MUST_BE_SAVED');
  const sidecar = new OpenCodeSidecar({ dataDir: root }), events = [], store = new ContextStore(root);
  let submissions = 0, reads = 0, payload;
  sidecar.client = { session: {
    messages: async () => ({ data: [] }),
    promptAsync: async value => { submissions++; payload = value; return { data: true }; },
    message: async () => {
      reads++;
      if (reads < 3) return missing();
      return { data: { info: { id: payload.messageID, sessionID: 'native', role: 'user' },
        parts: payload.parts.slice(0, reads === 3 ? 1 : undefined) } };
    }
  } };
  const run = { runId: 'run', request: { zSessionId: 'sess_receipt' }, openCodeSessionID: 'native', directory: root,
    acceptingInterjections: true, guidanceVersion: 0, interjections: [], baselineReady: true, contextStore: store,
    onEvent: event => events.push(event) };
  sidecar.activeRuns.set('run', run);
  const result = await sidecar.deliverInterjection('run', { source: 'user', requestId: 'guide', kind: 'guidance', guidance: 'Continue',
    attachments: [{ path: file, name: 'notes.txt', mimeType: 'text/plain' }] });
  assert.equal(submissions, 1); assert.equal(reads, 4);
  assert.equal(result.accepted, true); assert.equal(result.delivered, false);
  assert(!events.some(event => event.type === 'z.context.state.failed'));
  const receipt = events.find(event => event.type === 'z.context.state.snapshot' && event.data.phase === 'after-user');
  assert(receipt);
  const saved = store.read(receipt.data.ref).messages;
  assert.equal(saved.at(-1).parts.length, 2);
  assert.match(JSON.stringify(saved), /ATTACHMENT_MUST_BE_SAVED/);
});
