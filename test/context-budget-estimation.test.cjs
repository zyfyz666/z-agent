'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertForkHistoryFits, buildPromptParts, compactOpenCodeSession,
  estimateSerializedContextTokens, estimateContextMessagesTokens,
  latestOpenCodeContextTokens } = require('../lib/opencode-sidecar');

function request(context = 64_000, output = 4096) {
  return { providerId: 'fixture', modelId: 'fixture', workMode: 'normal',
    forkHistory: { kind: 'rewind', messages: [] },
    openCodeConfig: { provider: { fixture: { models: { fixture: { limit: { context, output } } } } },
      compaction: { threshold: Math.floor(context * 0.75), reserved: 4096 } } };
}

function history() {
  const user = (id, text) => ({ info: { id, role: 'user' }, parts: [{ type: 'text', text }] });
  const assistant = (id, text, input) => ({ info: { id, role: 'assistant', finish: 'stop',
    time: { completed: 2 }, tokens: { input, output: 10 } }, parts: [{ type: 'text', text }] });
  const messages = [user('old-user', 'Archived evidence. '.repeat(10_000)), assistant('old-answer', 'Old answer', 110_000),
    user('tail-user', 'Exact retained tail. '.repeat(100)), assistant('tail-answer', 'Retained answer', 114_000),
    { info: { id: 'compact', role: 'user' }, parts: [{ type: 'compaction', tail_start_id: 'tail-user' }] },
    { ...assistant('summary', 'Small successful summary', 120_000),
      info: { ...assistant('summary', '', 120_000).info, summary: true, parentID: 'compact' } },
    user('followup', 'Continue from the retained work')];
  return messages;
}

test('text estimates count decoded characters while structured tool arguments serialize once', () => {
  const plain = 'a'.repeat(60_000);
  const escaped = '"\\\n'.repeat(20_000);
  assert.equal(escaped.length, plain.length);
  assert.equal(estimateSerializedContextTokens(escaped), estimateSerializedContextTokens(plain));
  const args = { command: escaped, path: 'C:\\fixture\\input.txt' };
  assert.equal(estimateSerializedContextTokens(args), estimateSerializedContextTokens(JSON.stringify(args)));
});

test('rewind preflight does not charge HTTP escaping of prompt or system text', () => {
  const escaped = '"\\\n'.repeat(50_000);
  const payload = request();
  assert.ok(estimateSerializedContextTokens({ system: '', parts: [{ type: 'text', text: escaped }] }) > 64_000,
    'the old outer-JSON estimate would reject this request');
  assert.doesNotThrow(() => assertForkHistoryFits(payload, escaped, 'System instructions'));
  assert.doesNotThrow(() => assertForkHistoryFits(payload, 'New request', escaped));
  assert.throws(() => assertForkHistoryFits(payload, '真实正文'.repeat(20_000)),
    error => error.code === 'FORK_CONTEXT_TOO_LARGE');
});

test('preflight keeps response, thinking and tool-schema reservations', () => {
  const prompt = 'x'.repeat(150_000);
  assert.doesNotThrow(() => assertForkHistoryFits(request(), prompt));
  assert.throws(() => assertForkHistoryFits(request(64_000, 24_000), prompt),
    error => error.code === 'FORK_CONTEXT_TOO_LARGE');
  const thinking = request();
  thinking.openCodeConfig.provider.fixture.models.fixture.options = { thinking: { type: 'enabled', budgetTokens: 20_000 } };
  assert.throws(() => assertForkHistoryFits(thinking, prompt), error => error.code === 'FORK_CONTEXT_TOO_LARGE');
  assert.throws(() => assertForkHistoryFits(request(), 'x'.repeat(192_000)),
    error => error.code === 'FORK_CONTEXT_TOO_LARGE', 'the existing tool-schema reservation must still count');
});

test('preflight counts converted text attachments and keeps non-text file parts in estimates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-context-budget-'));
  try {
    const file = path.join(directory, 'evidence.txt');
    fs.writeFileSync(file, '真实附件'.repeat(20_000));
    const payload = { ...request(), attachments: [{ path: file, name: 'evidence.txt', mimeType: 'text/plain' }] };
    assert.equal(buildPromptParts({ ...payload, prompt: 'Read this' }).length, 2);
    assert.throws(() => assertForkHistoryFits(payload, 'Read this'), error => error.code === 'FORK_CONTEXT_TOO_LARGE');
    const files = [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,' + 'A'.repeat(1000) },
      { type: 'file', mime: 'application/pdf', filename: 'evidence.pdf', url: 'file:///fixture/evidence.pdf' }];
    const textOnly = estimateContextMessagesTokens([{ parts: [{ type: 'text', text: 'Read this' }] }]);
    assert.ok(estimateContextMessagesTokens([{ parts: [{ type: 'text', text: 'Read this' }, ...files] }]) > textOnly + 280);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('z-context-budget-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('successful summary occupancy includes its retained tail and newer messages, not old request usage', async () => {
  const messages = history();
  const saved = JSON.stringify(messages);
  const expected = estimateContextMessagesTokens(messages.slice(2));
  assert.equal(latestOpenCodeContextTokens(messages), expected);
  assert.ok(expected > estimateContextMessagesTokens(messages.slice(5)), 'the pre-summary tail must still count');
  let calls = 0;
  const result = await compactOpenCodeSession({ client: { session: { summarize: async () => { calls++; } } },
    session: { id: 'fixture' }, directory: '/fixture', request: request(), messages });
  assert.equal(calls, 0, 'a small active context must not compact again because the summary read 120K tokens');
  assert.equal(result.compacted, false);
  assert.equal(result.beforeTokens, expected);
  assert.equal(JSON.stringify(messages), saved);
});

test('compaction result fallback uses the same retained tail when the active-context endpoint is absent', async () => {
  const messages = history().slice(0, -1);
  const result = await compactOpenCodeSession({ client: { session: {
    summarize: async () => ({ data: true }), messages: async () => ({ data: messages }) } },
    session: { id: 'fixture' }, directory: '/fixture', request: request(128_000),
    messages: messages.slice(0, 4), force: true, manual: true });
  assert.equal(result.compacted, true, result.error);
  assert.equal(result.afterTokens, estimateContextMessagesTokens(messages.slice(2)));
  assert.ok(result.afterTokens > estimateContextMessagesTokens(messages.slice(5)));
});

test('invalid or incomplete summaries do not discard history or contribute their input usage', () => {
  for (const alter of [
    messages => { messages[5].info.error = { message: 'Summary failed' }; },
    messages => { messages[5].info.time.completed = 0; },
    messages => { delete messages[5].info.finish; },
    messages => { messages[5].parts[0].text = ''; },
    messages => { messages[5].info.parentID = 'missing-marker'; },
    messages => { messages[4].parts[0].tail_start_id = 'missing-tail'; },
    messages => { messages[4].parts[0].tail_start_id = 'summary'; }
  ]) {
    const messages = history();
    alter(messages);
    assert.equal(latestOpenCodeContextTokens(messages), 114_010);
  }
  const messages = history();
  delete messages[4].parts[0].tail_start_id;
  assert.equal(latestOpenCodeContextTokens(messages), estimateContextMessagesTokens(messages.slice(4)),
    'a valid native whole-prefix summary has no retained-tail id');
});

test('new usage after a summary wins while a later failed summary cannot revive pre-compaction usage', () => {
  const messages = history();
  messages.push({ info: { id: 'failed-summary', role: 'assistant', summary: true,
    tokens: { input: 200_000 }, error: { message: 'Summary failed' } }, parts: [] });
  assert.equal(latestOpenCodeContextTokens(messages), estimateContextMessagesTokens(messages.slice(2)));
  messages.push({ info: { role: 'assistant', tokens: { input: 1234, output: 100, cache: { read: 50 } } }, parts: [] });
  assert.equal(latestOpenCodeContextTokens(messages), 1384);
});

test('active estimates honor native pruned tool outputs but retain arguments and tool errors', () => {
  const tool = { type: 'tool', state: { status: 'completed', input: { command: '参数'.repeat(500) },
    output: 'Huge old output. '.repeat(30_000), time: { compacted: 1 } } };
  const saved = JSON.stringify(tool);
  const estimate = estimateContextMessagesTokens([{ parts: [tool] }]);
  assert.ok(estimate > 1000 && estimate < 1200, 'arguments remain while the old output stays pruned');
  assert.equal(JSON.stringify(tool), saved);
  const failed = { type: 'tool', state: { status: 'error', input: {}, error: '错误原因'.repeat(500) } };
  assert.ok(estimateContextMessagesTokens([{ parts: [failed] }]) > 2000, 'failed tool text is model-visible too');
});
