'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeSidecar } = require('../lib/opencode-sidecar');
const { normalizeGuidanceAttachments, validateGuidanceAttachments } = require('../lib/live-guidance');

function fixture() {
  const sidecar = new OpenCodeSidecar();
  const messages = [{ info: { id: 'previous-user', role: 'user' }, parts: [{ type: 'text', text: 'Original task' }] },
    { info: { id: 'partial-assistant', role: 'assistant', parentID: 'previous-user' }, parts: [{ type: 'tool', state: { status: 'completed' } }] }];
  const deleted = [];
  const submitted = [];
  const events = [];
  sidecar.client = { session: {
    promptAsync: async payload => {
      submitted.push(payload);
      messages.push({ info: { id: payload.messageID, role: 'user' }, parts: payload.parts });
      return { data: true };
    },
    status: async () => ({ data: {} }),
    messages: async () => ({ data: messages }),
    deleteMessage: async ({ messageID }) => { deleted.push(messageID); messages.splice(messages.findIndex(row => row.info.id === messageID), 1); return { data: true }; }
  } };
  const run = { runId: 'run', request: { zSessionId: 'sess-a' }, openCodeSessionID: 'native-session', directory: process.cwd(),
    acceptingInterjections: true, guidanceVersion: 0, interjections: [], onEvent: event => events.push(event) };
  sidecar.activeRuns.set('run', run);
  const guide = overrides => sidecar.deliverInterjection('run', { source: 'user', requestId: 'guide', kind: 'guidance', guidance: 'Use the attachment.', ...overrides });
  const detach = () => sidecar.detachPendingGuidance({ runId: 'run', zSessionId: 'sess-a', requestIds: ['guide'] });
  return { sidecar, run, messages, deleted, submitted, events, guide, detach, stop: () => sidecar.activeRuns.delete('run') };
}

test('live guidance carries text/image attachments and directory metadata beside the receipt marker', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-guidance-parts-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const text = path.join(temporary, 'notes.txt'); fs.writeFileSync(text, 'Attachment content must reach the model.');
  const image = path.join(temporary, 'photo.png'); fs.writeFileSync(image, 'image fixture');
  const f = fixture();
  const receipt = await f.guide({ attachments: [{ path: text, name: 'notes.txt', mimeType: 'text/plain' },
    { path: image, name: 'photo.png', mimeType: 'image/png' }, { path: temporary, name: 'folder', kind: 'directory' }] });
  const prompt = f.submitted[0];
  assert.equal(prompt.noReply, true);
  assert.equal(prompt.messageID, receipt.nativeMessageId);
  assert.match(prompt.messageID, /^msg_[0-9a-f]{26}$/);
  assert.match(prompt.parts[0].text, /Z_GUIDANCE_RECEIPT:/);
  assert.ok(prompt.parts.some(part => part.text?.includes('Attachment content must reach the model.')));
  assert.ok(prompt.parts.some(part => part.type === 'file' && part.mime === 'image/png' && part.url.startsWith('file:')));
  assert.ok(prompt.parts.some(part => part.text?.includes('contents are not embedded')));
});

test('stop removes only the exact queued guidance, retaining all previous partial assistant tools', async () => {
  const f = fixture(); const receipt = await f.guide();
  assert.equal((await f.detach())[0].status, 'pending');
  f.stop();
  assert.equal((await f.detach())[0].status, 'detached');
  assert.deepEqual(f.deleted, [receipt.nativeMessageId]);
  assert.deepEqual(f.messages.map(row => row.info.id), ['previous-user', 'partial-assistant']);
  assert.equal((await f.detach())[0].status, 'detached');
  assert.equal(f.deleted.length, 1);
});

test('late provider receipt after run completion excludes an already used guide from resending', async () => {
  const f = fixture(); await f.guide(); f.stop();
  f.sidecar.recordGuidanceReceipt({ token: f.run.interjections[0].receiptToken, at: 123 });
  assert.equal((await f.detach())[0].status, 'delivered');
  assert.equal(f.deleted.length, 0);
  assert.equal(f.events.at(-1).data.deliveryEvidence, 'provider-response');
});

test('an evicted native guidance record cannot be reported as never inserted', async () => {
  const f = fixture(); await f.guide(); f.stop();
  f.sidecar.guidanceDeliveryRecords.clear();
  assert.equal((await f.detach())[0].status, 'failed');
  assert.equal(f.deleted.length, 0);
});

test('provider receipt arriving during verification wins over deletion', async () => {
  const f = fixture(); await f.guide(); f.stop();
  f.sidecar.client.session.messages = async () => {
    f.sidecar.recordGuidanceReceipt({ token: f.run.interjections[0].receiptToken, at: 456 });
    return { data: f.messages };
  };
  assert.equal((await f.detach())[0].status, 'delivered'); assert.equal(f.deleted.length, 0);
});

test('an existing assistant child, busy session, wrong identity, or failed native query cannot cause duplicates', async () => {
  for (const kind of ['child', 'busy', 'identity', 'query']) {
    const f = fixture(); const receipt = await f.guide(); f.stop();
    if (kind === 'child') f.messages.push({ info: { id: 'after-guide', role: 'assistant', parentID: receipt.nativeMessageId }, parts: [] });
    if (kind === 'busy') f.sidecar.client.session.status = async () => ({ data: { 'native-session': { type: 'busy' } } });
    if (kind === 'identity') f.messages.at(-1).parts[0].text = 'unrelated user content';
    if (kind === 'query') f.sidecar.client.session.messages = async () => { throw new Error('connection lost'); };
    const result = (await f.detach())[0];
    assert.ok(['failed', 'pending'].includes(result.status), kind); assert.equal(f.deleted.length, 0, kind);
  }
});

test('a noReply insertion acknowledgement arriving after Stop remains pending until it settles', async () => {
  const f = fixture(); let acknowledge;
  const original = f.sidecar.client.session.promptAsync;
  f.sidecar.client.session.promptAsync = async payload => { await original(payload); await new Promise(resolve => { acknowledge = resolve; }); return { data: true }; };
  const guidance = f.guide(); await Promise.resolve(); f.stop();
  assert.equal((await f.detach())[0].status, 'pending');
  acknowledge(); await guidance;
  assert.equal((await f.detach())[0].status, 'detached');
});

test('attachment validation rejects missing files, symlinks outside uploads, and disabled file access', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-guidance-scope-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const uploads = path.join(temporary, 'uploads'); fs.mkdirSync(uploads);
  const file = path.join(uploads, 'a.txt'); fs.writeFileSync(file, 'visible');
  const normalize = value => normalizeGuidanceAttachments([{ path: value }]);
  assert.equal(validateGuidanceAttachments(normalize(file), { filesDir: uploads })[0].size, 7);
  assert.throws(() => validateGuidanceAttachments(normalize(file), { filesDir: uploads, permissions: { allowFileRead: false } }), /未允许读取/);
  assert.throws(() => validateGuidanceAttachments(normalize(path.join(uploads, 'missing')), { filesDir: uploads }), /不存在/);
  const outside = path.join(temporary, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const link = path.join(uploads, 'link');
  try { fs.symlinkSync(outside, link, 'junction'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => validateGuidanceAttachments(normalize(path.join(link, 'secret.txt')), { filesDir: uploads }), /重新上传/);
});
