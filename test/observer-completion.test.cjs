'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { completionInput, completionSettings, normalizeObserverSettings, parseCompletionReply, reviewCompletion,
  validateCompletionDecision } = require('../lib/observer-model');

const connection = { providerId: 'p', supplierId: 's', modelId: 'observer-model', name: 'Observer',
  baseUrl: 'https://example.test/v1', apiKey: 'test-key', apiFormat: 'openai' };
const wake = extra => ({ verdict: 'continue', reason: '测试仍在失败', unmet: ['让 npm test 通过'],
  evidence: [{ source: 'verification', fact: '最近一次测试失败' }], followUp: '修复失败的测试后再运行一次。', delayMinutes: 0, ...extra });

test('a wake needs a named gap, evidence and an instruction; otherwise it is uncertain', () => {
  assert.equal(validateCompletionDecision(wake()).verdict, 'continue');
  for (const missing of [{ unmet: [] }, { evidence: [] }, { followUp: '  ' }, { evidence: [{ source: 'made-up', fact: 'x' }] }]) {
    const result = validateCompletionDecision(wake(missing));
    assert.equal(result.verdict, 'uncertain');
    assert.equal(result.followUp, undefined);
    assert.match(result.reason, /^证据不足，不唤醒/);
  }
  assert.throws(() => validateCompletionDecision({ verdict: 'retry', reason: 'x' }), /格式无效/);
  assert.throws(() => validateCompletionDecision({ verdict: 'achieved', reason: '  ' }), /没有返回判断/);
});

test('delay is whole minutes between 0 and 24 hours, and only kept for a wake', () => {
  assert.equal(validateCompletionDecision(wake({ delayMinutes: 30.4 })).delayMinutes, 30);
  assert.equal(validateCompletionDecision(wake({ delayMinutes: 99999 })).delayMinutes, 1440);
  assert.equal(validateCompletionDecision(wake({ delayMinutes: -5 })).delayMinutes, 0);
  assert.equal(validateCompletionDecision(wake({ delayMinutes: 'soon' })).delayMinutes, 0);
  assert.equal(validateCompletionDecision({ verdict: 'achieved', reason: '完成', delayMinutes: 10 }).delayMinutes, undefined);
});

test('replies wrapped in prose or code fences still parse; secrets are redacted', () => {
  const wrapped = `判断如下：\n${JSON.stringify(wake({ reason: '还差一步 api_key=sk-abcdefghijklmnopqrstu' }))}\n以上。`;
  const result = parseCompletionReply({ choices: [{ message: { content: wrapped } }] });
  assert.equal(result.verdict, 'continue');
  assert.doesNotMatch(result.reason, /sk-abcdefghijklmnopqrstu/);
  assert.equal(parseCompletionReply({ output_text: '```json\n{"verdict":"achieved","reason":"已完成"}\n```' }).verdict, 'achieved');
  assert.throws(() => parseCompletionReply({ output_text: 'no json here' }), /格式无效/);
});

test('input keeps the start and end of a long reply and bounds every list', () => {
  const finalReply = `开头${'中'.repeat(9000)}结论：还剩两项`;
  const input = completionInput({ goal: '修好构建', finalReply, steps: Array.from({ length: 30 }, (_, i) => ({ op: 'bash', target: `t${i}` })),
    todos: [{ text: '写测试', done: true }, { content: '跑测试', status: 'pending' }], changedFiles: ['a.js'], observerWakes: 2,
    verification: { passed: 1, failed: 2, latest: 'failed' } });
  assert.ok(input.finalReply.startsWith('开头') && input.finalReply.endsWith('结论：还剩两项'));
  assert.ok(input.finalReply.length < 6100);
  assert.equal(input.recentActions.length, 20);
  assert.equal(input.recentActions[0].index, 11);
  assert.deepEqual(input.todos, [{ text: '写测试', done: true }, { text: '跑测试', done: false }]);
  assert.deepEqual(input.verification, { passed: 1, failed: 2, latest: 'failed' });
  assert.equal(input.observerWakes, 2);
});

test('the review sends its own system prompt to the configured observer model', async () => {
  let sent;
  const fetchImpl = async (url, options) => { sent = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(wake()) } }] }) }; };
  const result = await reviewCompletion(connection, completionInput({ goal: 'g', finalReply: 'r' }), { fetchImpl });
  assert.equal(result.verdict, 'continue');
  assert.equal(sent.url, 'https://example.test/v1/chat/completions');
  assert.match(sent.body.messages[0].content, /自然结束后，核验用户目标是否已经达成/);
  assert.equal(JSON.parse(sent.body.messages[1].content).goal, 'g');
  await assert.rejects(reviewCompletion(connection, {}, { fetchImpl: async () => ({ ok: false, status: 502 }) }), /HTTP 502/);
});

test('completion settings default on with three wakes and only persist when given', () => {
  assert.deepEqual(completionSettings(undefined), { enabled: true, maxWakes: 3 });
  assert.deepEqual(completionSettings({ enabled: false, maxWakes: 7 }), { enabled: false, maxWakes: 7 });
  assert.deepEqual(completionSettings({ maxWakes: 0 }), { enabled: true, maxWakes: 3 });
  assert.equal(Object.hasOwn(normalizeObserverSettings({}), 'completion'), false);
  assert.deepEqual(normalizeObserverSettings({ completion: { maxWakes: 2 } }).completion, { enabled: true, maxWakes: 2 });
});
