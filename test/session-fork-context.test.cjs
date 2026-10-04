'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { combineTurnPrompt, forkHistorySystem, assertForkHistoryFits } = require('../lib/opencode-sidecar');

function request(messages) {
  return {
    providerId: 'fixture', modelId: 'fixture-model', prompt: 'Continue the branch.',
    language: 'zh', workMode: 'normal', workspace: '',
    history: [{ role: 'user', content: 'UNTRUSTED_LATER_RENDERER_MESSAGE' }],
    forkHistory: { sourceSessionId: 'sess_source', messageIndex: messages.length - 1, messages },
    openCodeConfig: { provider: { fixture: { models: { 'fixture-model': { limit: { context: 131072, output: 4096 } } } } },
      compaction: { threshold: 100000, reserved: 4096 } }
  };
}

test('fresh branch restores the beginning, long content, tool history and attachments past ordinary recovery limits', () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Historical message ${index}` }));
  messages[0].content = 'ORIGINAL_GOAL';
  messages[7].content = 'x'.repeat(9000) + 'LONG_MESSAGE_END';
  messages[9].agentRun = { forkedHistory: true, watchdog: { observedSteps: 3 },
    timeline: [{ type: 'tool', tool: 'read', output: 'PRIOR_TOOL_EVIDENCE' }] };
  messages[20].attachments = [{ name: 'context.txt', path: '/workspace/context.txt' }];
  const before = JSON.stringify(messages);
  const payload = request(messages);
  const text = combineTurnPrompt(payload, payload.prompt, true);
  assert.match(text, /ORIGINAL_GOAL/);
  assert.match(text, /LONG_MESSAGE_END/);
  assert.match(text, /PRIOR_TOOL_EVIDENCE/);
  assert.match(text, /Historical message 53/);
  assert.match(text, /context\.txt/);
  assert.doesNotMatch(text, /UNTRUSTED_LATER_RENDERER_MESSAGE/);
  assert.equal(text.split('LONG_MESSAGE_END').length, 2);
  assert.equal(JSON.stringify(messages), before);
  assert.doesNotThrow(() => assertForkHistoryFits(payload, text, 'Fixture system'));
});

test('an already independent native branch does not append its original snapshot again', () => {
  const payload = request([{ role: 'user', content: 'BRANCH_SEED' }]);
  const text = combineTurnPrompt(payload, 'Next independent turn.', false);
  assert.match(text, /Next independent turn/);
  assert.doesNotMatch(text, /BRANCH_SEED|UNTRUSTED_LATER_RENDERER_MESSAGE|z-conversation-branch-history/);
});

test('history above the configured context budget fails explicitly and never clips the stored prefix', () => {
  const messages = [{ role: 'user', content: 'ROOT_GOAL' + '内容'.repeat(100000) + 'END_OF_HISTORY' }];
  const payload = request(messages);
  const text = combineTurnPrompt(payload, payload.prompt, true);
  assert.match(text, /ROOT_GOAL/);
  assert.match(text, /END_OF_HISTORY/);
  assert.throws(() => assertForkHistoryFits(payload, text, ''), error => error.code === 'FORK_CONTEXT_TOO_LARGE'
    && /完整历史仍已保存在分支中/.test(error.message));
  assert.equal(messages[0].content.endsWith('END_OF_HISTORY'), true);
});

test('the budget includes the new request and system context, not only inherited messages', () => {
  const payload = request([{ role: 'user', content: 'Small history.' }]);
  assert.throws(() => assertForkHistoryFits(payload, 'new request '.repeat(60000), 'system'),
    error => error.code === 'FORK_CONTEXT_TOO_LARGE');
  assert.throws(() => assertForkHistoryFits(payload, 'continue', 'system context '.repeat(60000)),
    error => error.code === 'FORK_CONTEXT_TOO_LARGE');
});

test('invalid persisted branch history cannot quietly fall back to a renderer snapshot', () => {
  const payload = request([]);
  payload.forkHistory = { sourceSessionId: 'sess_source' };
  assert.throws(() => combineTurnPrompt(payload, 'continue', true), error => error.code === 'FORK_HISTORY_INVALID');
  assert.throws(() => forkHistorySystem(null), error => error.code === 'FORK_HISTORY_INVALID');
});
