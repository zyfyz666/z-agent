'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelObserver, normalizeObserverSettings, observerInput, observerRequest, parseObserverReply, reviewWithModel } = require('../lib/observer-model');
const connection = { providerId: 'observer-api', supplierId: 'other', modelId: 'observer-model', name: 'Observer', baseUrl: 'https://example.test/gateway/v1?route=observer', apiKey: 'test-key', apiFormat: 'openai' };
const steps = n => Array.from({ length: n }, (_, i) => ({ op: 'read', target: `src/${i}.js`, plan: 'inspect', verify: i === 0 ? 'passed' : null }));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('settings default to rules only and normalize a separate exact model identity', () => {
  for (const input of [undefined, null, {}, { judgeEvery: 0 }, { judgeEvery: 101 }, { judgeEvery: 2.5 }]) {
    assert.deepEqual(normalizeObserverSettings(input), { judgeEvery: 6, model: null });
  }
  assert.deepEqual(normalizeObserverSettings({ judgeEvery: 1, model: { ...connection, apiKey: 'must-not-persist' } }), {
    judgeEvery: 1, model: { providerId: 'observer-api', supplierId: 'other', modelId: 'observer-model', name: 'Observer' }
  });
});

test('observer uses the selected credentials, model and protocol, preserving gateway path and query', () => {
  for (const [format, suffix] of [['openai', '/chat/completions'], ['responses', '/responses'], ['anthropic', '/messages']]) {
    const request = observerRequest({ ...connection, apiFormat: format, baseUrl: connection.baseUrl.replace('v1?', 'v1/chat/completions?') }, {});
    assert.equal(request.url, `https://example.test/gateway/v1${suffix}?route=observer`);
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    assert.equal(request.body.model, 'observer-model');
    assert.equal(request.body.tools, undefined);
    if (format === 'anthropic') assert.equal(request.headers['x-api-key'], 'test-key');
  }
  assert.equal(observerRequest({ ...connection, apiFormat: 'auto', baseUrl: 'https://example.test/v1/responses' }, {}).url, 'https://example.test/v1/responses');
  assert.equal(observerRequest({ ...connection, apiFormat: 'gptl', baseUrl: 'https://api.openai.com/v1' }, {}).url, 'https://api.openai.com/v1/responses');
  assert.equal(observerRequest({ ...connection, apiFormat: 'anthropic', baseUrl: 'https://example.test/proxy' }, {}).url, 'https://example.test/proxy/v1/messages');
});

test('input is bounded and omits raw messages, output, credentials and tools', () => {
  const actions = steps(100).map(s => ({ ...s, output: 'PRIVATE-TOOL-OUTPUT', plan: 'token=private-secret ' + 'x'.repeat(3000) }));
  const input = observerInput('password=private-password ' + 'g'.repeat(6000), actions, { message: 'rule reminder' });
  assert.equal(input.totalActions, 100);
  assert.equal(input.recentActions.length, 12);
  assert.equal(input.recentActions[0].target, 'src/88.js');
  assert.ok(input.goal.length <= 4000);
  assert.ok(JSON.stringify(input).length < 15000);
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE-TOOL-OUTPUT|private-secret|private-password/);
});

test('supported response formats only accept observation or reminder JSON', async () => {
  const reply = JSON.stringify({ action: 'remind', message: 'Run the focused test.' });
  for (const value of [
    { choices: [{ message: { content: reply } }] },
    { content: [{ type: 'text', text: '```json\n' + reply + '\n```' }] },
    { output: [{ content: [{ type: 'output_text', text: reply }] }] }
  ]) assert.equal(parseObserverReply(value).action, 'remind');
  assert.throws(() => parseObserverReply({ output_text: '{"action":"halt","message":"stop"}' }));
  assert.throws(() => parseObserverReply({ output_text: 'not JSON' }));
  const result = await reviewWithModel(connection, {}, { fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).model, 'observer-model');
    return { ok: true, json: async () => ({ output_text: '{"action":"observe","message":"Making progress"}' }) };
  } });
  assert.equal(result.action, 'observe');
  await assert.rejects(reviewWithModel(connection, {}, { fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
});

test('custom cadence is non-blocking, deduplicated and allows only one model review in flight', async () => {
  let resolve, calls = 0;
  const guidance = [];
  const observer = new ModelObserver({ connection, judgeEvery: 2,
    review: () => { calls++; return new Promise(done => { resolve = done; }); },
    onGuidance: value => guidance.push(value) });
  observer.observe(steps(1)); await tick(); assert.equal(calls, 0);
  assert.equal(observer.observe(steps(2)), undefined); await tick(); assert.equal(calls, 1);
  observer.observe(steps(2)); observer.observe(steps(20)); await tick(); assert.equal(calls, 1);
  resolve({ action: 'remind', message: 'Check results.' }); await observer.pending;
  assert.equal(guidance.length, 1); assert.equal(guidance[0].step, 2);
  observer.observe(steps(3)); await tick(); assert.equal(calls, 1);
  observer.observe(steps(4)); await tick(); assert.equal(calls, 2);
  resolve({ action: 'observe', message: 'Progress.' }); await observer.pending;
  assert.equal(guidance.length, 1); assert.equal(observer.state.checks, 2);
  observer.stop();
});

test('timeouts and model failures recover on later actions without exposing connection secrets', async () => {
  const states = [];
  const observer = new ModelObserver({ connection, judgeEvery: 1, timeoutMs: 10,
    review: () => new Promise(() => {}), onState: state => states.push(state) });
  observer.observe(steps(1)); await observer.pending;
  assert.equal(observer.state.phase, 'error');
  observer.review = async () => { throw new Error('test-key https://private.example'); };
  observer.observe(steps(2)); await observer.pending;
  assert.doesNotMatch(JSON.stringify(states), /test-key|private.example/);
  observer.review = async () => ({ action: 'observe', message: 'Recovered.' });
  observer.observe(steps(3)); await observer.pending;
  assert.equal(observer.state.phase, 'observing');
  assert.equal(observer.state.error, ''); observer.stop();
});

test('finishing or cancelling suppresses late advice, even from an uncooperative model', async () => {
  for (const stop of [true, false]) {
    let resolve, active = true;
    let deliveries = 0;
    const observer = new ModelObserver({ connection, judgeEvery: 1,
      review: () => new Promise(done => { resolve = done; }), isActive: () => active,
      onGuidance: () => deliveries++, onState: () => { throw new Error('closed view'); } });
    observer.observe(steps(1)); await tick();
    if (stop) observer.stop(); else active = false;
    resolve({ action: 'remind', message: 'Late result.' }); await observer.pending;
    assert.equal(deliveries, 0); observer.stop();
  }
});
