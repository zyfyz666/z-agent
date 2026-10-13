'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const manifest = require('../vendor/opencode/runtime-patch.json');

const replacement = id => {
  const found = manifest.replacements.find(item => item.id === id);
  assert.ok(found, `Missing native patch: ${id}`);
  return found.replace;
};
const effect = value => ({ *[Symbol.iterator]() { return value; } });
function run(iterable) {
  if (!iterable?.[Symbol.iterator]) return iterable;
  const iterator = iterable[Symbol.iterator]();
  let next = iterator.next();
  while (!next.done) next = iterator.next(next.value);
  return next.value;
}
function retryContext() {
  const observed = { statuses: [], parsed: 0 };
  const context = vm.createContext({
    vs: 2000, Ds: 2, ha: 30000,
    Date: { now: () => 1_000_000, parse: Date.parse },
    na: { fromStepWithMetadata: value => value },
    me: { done: attempt => ({ stopped: true, attempt }) },
    sa: { currentTimeMillis: effect(1_000_000) },
    la: { millis: value => value },
    da: error => error.data.isRetryable ? { message: error.data.message } : undefined,
    s: { succeed: value => value, gen: fn => fn(), fn: () => fn => fn,
      retry: value => value, catch: () => {}, logError: () => effect() },
    a: { sessionID: 'isolated-fixture' }, w: { model: { providerID: 'fixture' }, assistantMessage: {} },
    $: error => { observed.parsed++; return error; },
    f: { set: (_id, status) => { observed.statuses.push(status); return effect(); } },
    wl: { policy: config => { observed.config = config; return config; } },
    Yo: String, ze: () => {}
  });
  vm.runInContext(replacement('session-retry-delay'), context);
  vm.runInContext(replacement('session-retry-policy'), context);
  vm.runInContext(replacement('session-retry-exhaustion-capture'), context);
  return { context, observed, step: context.Zd(observed.config) };
}

test('native delay honors Retry-After but every delay stays between zero and 30 seconds', () => {
  const { context } = retryContext();
  const delay = (attempt, headers) => context.ta(attempt, headers === undefined ? undefined : { data: { responseHeaders: headers } });
  assert.deepEqual([1, 2, 3, 4, 5].map(attempt => delay(attempt)), [2000, 4000, 8000, 16000, 30000]);
  for (const headers of [undefined, {}, { 'retry-after-ms': '90000' }, { 'retry-after': '90' },
    { 'retry-after': 'Thu, 01 Jan 1970 00:20:00 GMT' }]) assert.equal(delay(10, headers), 30000);
  assert.equal(delay(1, { 'retry-after-ms': '1000', 'retry-after': '20' }), 1000);
  assert.equal(delay(1, { 'retry-after': '1.25' }), 1250);
  assert.equal(delay(1, { 'retry-after': 'Thu, 01 Jan 1970 00:17:00 GMT' }), 20000);
  assert.equal(delay(1, { 'retry-after': 'invalid' }), 2000);
  assert.equal(delay(1, { 'retry-after-ms': '-100' }), 0);
  assert.equal(delay(1, { 'retry-after': '0' }), 0);
});

test('native policy allows five retries then halts with the original error and an exhaustion marker', () => {
  assert.equal(manifest.retryPolicy.maxRetries, 5);
  const { context, observed, step } = retryContext();
  const error = Object.freeze({ name: 'APIError', data: Object.freeze({
    message: 'Original upstream failure', isRetryable: true, statusCode: 500,
    responseHeaders: { 'x-request-id': 'fixture-request' }, responseBody: 'fixture error body'
  }) });
  const delays = [2000, 4000, 8000, 16000, 30000];
  for (const [index, delay] of delays.entries()) {
    const attempt = index + 1;
    assert.deepEqual(Array.from(run(step({ input: error, attempt }))), [attempt, delay]);
    assert.equal(context.a.zRetryError, undefined, 'an allowed retry must not mark the processor as exhausted');
    assert.equal(observed.statuses[index].attempt, attempt);
    assert.equal(observed.statuses[index].next, 1_000_000 + delay);
  }
  const exhaustedAttempt = manifest.retryPolicy.maxRetries + 1;
  assert.deepEqual(step({ input: error, attempt: exhaustedAttempt }), { stopped: true, attempt: exhaustedAttempt });
  assert.equal(observed.statuses.length, 5);
  assert.equal(context.a.zRetryError.name, 'APIError');
  assert.equal(context.a.zRetryError.data.message, '[Z_NATIVE_RETRY_EXHAUSTED] Original upstream failure');
  assert.equal(context.a.zRetryError.data.statusCode, 500);
  assert.equal(context.a.zRetryError.data.responseHeaders, error.data.responseHeaders);
  assert.equal(context.a.zRetryError.data.responseBody, error.data.responseBody);
  assert.equal(error.data.message, 'Original upstream failure');
  // halt normally reparses the original exception; the staged patch must use
  // the captured normalized error so the exhaustion marker survives.
  vm.runInContext(replacement('session-retry-halt-error') + 'return H});', context);
  const parsedBeforeHalt = observed.parsed;
  const finalError = run(context.ze(error));
  assert.equal(finalError, context.a.zRetryError);
  assert.equal(observed.parsed, parsedBeforeHalt);
});

test('nonretryable errors stop immediately and cannot acquire a false exhaustion marker', () => {
  for (const attempt of [1, manifest.retryPolicy.maxRetries + 1]) {
    const { context, observed, step } = retryContext();
    const error = { name: 'APIError', data: { message: 'Invalid credentials', statusCode: 401, isRetryable: false } };
    assert.deepEqual(step({ input: error, attempt }), { stopped: true, attempt });
    assert.equal(observed.statuses.length, 0);
    assert.equal(context.a.zRetryError, undefined);
    vm.runInContext(replacement('session-retry-halt-error') + 'return H});', context);
    assert.equal(run(context.ze(error)), error);
  }
});

test('overlapping processors retain separate retry exhaustion state', () => {
  const { context } = retryContext();
  // Both processors use the same VM/global helper, matching one native kernel;
  // only their create() state and policy closures are independent.
  vm.runInContext('function makeProcessor(a,w){let ze,config;const wl={policy:value=>(config=value)};'
    + replacement('session-retry-exhaustion-capture') + ';'
    + replacement('session-retry-halt-error') + 'return H});'
    + 'return {state:a,step:Zd(config),halt:ze};}', context);
  const failed = context.makeProcessor({ sessionID: 'A' }, context.w);
  const healthy = context.makeProcessor({ sessionID: 'B' }, context.w);
  const makeError = message => ({ name: 'APIError', data: { message, isRetryable: true, statusCode: 500 } });
  const failure = makeError('Task A failure'), transient = makeError('Task B transient error');
  run(failed.step({ input: failure, attempt: 1 }));
  run(healthy.step({ input: transient, attempt: 1 }));
  for (let attempt = 2; attempt <= manifest.retryPolicy.maxRetries; attempt++) {
    run(failed.step({ input: failure, attempt }));
  }
  failed.step({ input: failure, attempt: manifest.retryPolicy.maxRetries + 1 });
  assert.equal(healthy.state.zRetryError, undefined);
  assert.equal(run(healthy.halt(transient)), transient);
  assert.match(run(failed.halt(failure)).data.message, /Task A failure$/);
  assert.equal(transient.data.message, 'Task B transient error');
});

function taskContext(result, { extending = false } = {}) {
  const observed = { calls: 0 };
  const yielded = value => {
    const item = effect(value);
    item.pipe = () => item;
    return item;
  };
  const context = vm.createContext({
    s: { fn: () => fn => (...args) => {
      const iterator = fn(...args); iterator.pipe = () => iterator; return iterator;
    }, fail: error => ({ *[Symbol.iterator]() { throw error; } }),
    all: () => yielded(), onInterrupt: () => {}, forkIn: () => {}, ignore: () => {} },
    K: { resolvePromptParts: () => yielded([{ type: 'text', text: 'fixture task' }]),
      prompt: request => { observed.calls++; observed.request = request; return yielded(result); },
      cancel: () => yielded() },
    Lo: { ascending: () => 'fixture-message' },
    O: { id: 'fixture-child' }, R: { modelID: 'fixture-model', providerID: 'fixture-provider' },
    c: { name: 'builder' }, q: 'fixture-variant', m: { prompt: 'fixture task', description: 'Fixture title' },
    p: { sessionID: 'fixture-parent', agent: 'build', metadata: () => yielded() },
    N: { sessionId: 'fixture-child' }, sr: 'fixture-task', t: {},
    e: { extend: () => yielded(extending), start: request => {
      observed.job = request; return yielded({ id: 'fixture-job' });
    } },
    Rr: value => value, Bs: 'updated instructions', Fs: 'started instructions'
  });
  return { context, observed };
}

test('native TaskTool fails with the real child error and all partial text, including cancellation identity', () => {
  const first = replacement('task-propagate-child-error').split(',D=s.fn(')[0];
  for (const error of [
    { name: 'APIError', data: { message: '[Z_NATIVE_RETRY_EXHAUSTED] Original service failure', statusCode: 500 } },
    { name: 'MessageAbortedError', data: { message: 'Cancelled by user' } }
  ]) {
    const { context, observed } = taskContext({ info: { error }, parts: [
      { type: 'text', text: 'First partial paragraph' }, { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: 'Second partial paragraph' }
    ] });
    vm.runInContext(first + ';globalThis.runTask=A;', context);
    assert.throws(() => run(context.runTask()), thrown => {
      assert.ok(thrown.message.startsWith('[Z_SUBAGENT_FAILED] '));
      assert.ok(thrown.message.includes(JSON.stringify(error)));
      assert.ok(thrown.message.endsWith('Partial output:\nFirst partial paragraph\nSecond partial paragraph'));
      assert.doesNotMatch(thrown.message, /private reasoning/);
      return true;
    });
    assert.equal(observed.calls, 1);
  }
});

test('successful native TaskTool output and background start/update receipts keep their original identities', () => {
  const source = replacement('task-propagate-child-error');
  const { context } = taskContext({ info: {}, parts: [
    { type: 'text', text: 'Earlier progress must not become the returned task result' },
    { type: 'reasoning', text: 'Internal reasoning' },
    { type: 'text', text: 'Verified result' }
  ] });
  vm.runInContext(source.split(',D=s.fn(')[0] + ';globalThis.runTask=A;', context);
  assert.equal(run(context.runTask()), 'Verified result');
  for (const extending of [false, true]) {
    const { context: background, observed } = taskContext({ info: {}, parts: [] }, { extending });
    vm.runInContext('function* fixture(){' + source + 'return oo();}', background);
    const receipt = run(background.fixture());
    assert.equal(receipt.metadata.jobId, extending ? 'fixture-child' : 'fixture-job');
    assert.equal(receipt.output.state, 'running');
    assert.equal(receipt.output.summary, `Background task ${extending ? 'updated' : 'started'}`);
    assert.equal(receipt.output.text, extending ? 'updated instructions' : 'started instructions');
    assert.equal(!!observed.job, !extending);
  }
});
