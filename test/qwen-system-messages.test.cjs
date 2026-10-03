const test = require('node:test');
const assert = require('node:assert/strict');

test('Qwen gateway aliases receive one initial system message without losing instructions', async () => {
  const { shapeQwenRequestBody } = await import('../lib/qwen-request-shaping.mjs');
  const original = { model: 'Qwen', messages: [
    { role: 'system', content: 'Kernel instructions' },
    { role: 'system', content: 'WD Agent instructions' },
    { role: 'user', content: 'Fix the bug' }
  ] };
  const actual = shapeQwenRequestBody(original, { singleSystemMessage: true });
  assert.deepEqual(actual.messages, [
    { role: 'system', content: 'Kernel instructions\n\nWD Agent instructions' }, original.messages[2]
  ]);
  assert.equal(original.messages.length, 3);
  assert.equal(shapeQwenRequestBody(original), original, 'other gateways keep their existing contract');
});

test('Qwen shaping leaves subsequent roles and single system messages unchanged', async () => {
  const { shapeQwenRequestBody } = await import('../lib/qwen-request-shaping.mjs');
  const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Issue' },
    { role: 'assistant', content: 'Working' }, { role: 'tool', content: 'Result', tool_call_id: 'a' }];
  assert.deepEqual(shapeQwenRequestBody({ model: 'Qwen', messages }).messages, messages);
});
