'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { guidanceTokens, installGuidanceRequestObserver, createGuidanceReceiptDecoder } = require('../lib/guidance-receipts');
const { OpenCodeSidecar } = require('../lib/opencode-sidecar');
const { recordReconcileEvent, watchdogReplay } = require('../lib/wd-replay-state');
const token = 'a'.repeat(32);
const text = `Keep the API. [[Z_GUIDANCE_RECEIPT:${token}]]`;
const body = JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: text }] });

test('only model request user input carries receipt proof, not a kernel queue acknowledgement or tool output', () => {
  assert.deepEqual(guidanceTokens(body), [token]);
  assert.deepEqual(guidanceTokens(JSON.stringify({ model: 'fixture', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] })), [token]);
  assert.deepEqual(guidanceTokens(JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text }] }] })), [token]);
  assert.deepEqual(guidanceTokens(JSON.stringify({ model: { providerID: 'fixture', modelID: 'fixture' }, noReply: true, parts: [{ text }] })), []);
  assert.deepEqual(guidanceTokens(JSON.stringify({ model: 'fixture', messages: [{ role: 'tool', content: text }, { role: 'assistant', content: text }] })), []);
  assert.deepEqual(guidanceTokens('not-json'), []);
});

test('request input remains unchanged and receipt waits for actual successful provider headers', async () => {
  const reports = [];
  let release;
  const response = { ok: true, status: 200, body: { untouched: true } };
  const target = { fetch: async (input, init) => {
    assert.equal(input, 'http://local.fixture/v1/chat/completions');
    assert.equal(init.body, body);
    assert.equal(init.headers.authorization, 'Bearer fixture');
    return new Promise(resolve => { release = () => resolve(response); });
  } };
  installGuidanceRequestObserver({ target, report: value => reports.push(value) });
  const wrapped = target.fetch;
  installGuidanceRequestObserver({ target, report: () => assert.fail('observer must not be duplicated') });
  assert.equal(target.fetch, wrapped);
  const pending = target.fetch('http://local.fixture/v1/chat/completions', { method: 'POST', body, headers: { authorization: 'Bearer fixture' } });
  assert.equal(reports.length, 0);
  release();
  assert.equal(await pending, response);
  assert.deepEqual(Object.keys(reports[0]).sort(), ['at', 'token']);
  assert.equal(reports[0].token, token);
});

test('failed transport and HTTP errors never claim successful delivery', async () => {
  for (const failure of ['network', 'http']) {
    const reports = [];
    const target = { fetch: async () => {
      if (failure === 'network') throw new Error('network lost');
      return { ok: false, status: 401 };
    } };
    installGuidanceRequestObserver({ target, report: value => reports.push(value) });
    const call = target.fetch('http://local.fixture/v1/messages', { method: 'POST', body });
    if (failure === 'network') await assert.rejects(call, /network lost/); else assert.equal((await call).status, 401);
    assert.deepEqual(reports, []);
  }
});

test('Request objects are observed via a clone without consuming the original body', async () => {
  const reports = [];
  const request = new Request('http://local.fixture/v1/responses', { method: 'POST', body });
  const target = { fetch: async input => { assert.equal(await input.text(), body); return { ok: true }; } };
  installGuidanceRequestObserver({ target, report: value => reports.push(value) });
  await target.fetch(request);
  assert.equal(reports[0].token, token);
});

test('kernel stdout decoder tolerates split chunks and ignores unrelated or invalid logs', () => {
  const results = [];
  const receive = createGuidanceReceiptDecoder(value => results.push(value));
  const line = `Z_GUIDANCE_RECEIPT ${JSON.stringify({ token, at: 123 })}\n`;
  receive('ordinary startup log\n'); receive(line.slice(0, 19)); receive(line.slice(19));
  receive('Z_GUIDANCE_RECEIPT {"token":"wrong","at":123}\n');
  assert.deepEqual(results, [{ token, at: 123 }]);
});

test('a kernel acceptance is queued until its exact random token receives provider proof', async () => {
  const events = [];
  let inserted;
  const sidecar = new OpenCodeSidecar();
  sidecar.client = { session: { promptAsync: async payload => { inserted = payload; return { data: true }; } } };
  const run = { runId: 'run', directory: process.cwd(), openCodeSessionID: 'native', acceptingInterjections: true,
    interjections: [], guidanceVersion: 0, onEvent: value => events.push(value) };
  sidecar.activeRuns.set('run', run);
  const receipt = await sidecar.deliverInterjection('run', { source: 'user', requestId: 'guide', kind: 'guidance', guidance: 'Keep API' });
  assert.equal(receipt.accepted, true); assert.equal(receipt.delivered, false); assert.equal(events.length, 0);
  assert.equal(inserted.noReply, true);
  sidecar.recordGuidanceReceipt({ token, at: 123 }); assert.equal(events.length, 0);
  sidecar.recordGuidanceReceipt({ token: run.interjections[0].receiptToken, at: 456 });
  sidecar.recordGuidanceReceipt({ token: run.interjections[0].receiptToken, at: 789 });
  assert.deepEqual(events, [{ type: 'yan.guidance.status', data: { requestId: 'guide', status: 'delivered', deliveredAt: 456, deliveryEvidence: 'provider-response' } }]);
});

test('delivery proof survives replay-ring eviction and a later failed event cannot downgrade it', () => {
  const entry = { events: [] };
  const event = { type: 'yan.guidance.status', data: { requestId: 'guide', status: 'delivered', deliveredAt: 123, deliveryEvidence: 'provider-response' } };
  recordReconcileEvent(entry, event, { cap: 1 });
  recordReconcileEvent(entry, { type: 'text.delta', data: { delta: 'later' } }, { cap: 1 });
  recordReconcileEvent(entry, { type: 'yan.guidance.status', data: { requestId: 'guide', status: 'failed' } }, { cap: 1 });
  assert.deepEqual(watchdogReplay(entry).events, [event]);
});
