'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectHistoryForModel } = require('../lib/history-model-context');
const { forkRunContext, messageForkAnchor } = require('../lib/session-fork');
const { combineTurnPrompt, assertForkHistoryFits, estimateSerializedContextTokens } = require('../lib/opencode-sidecar');

test('history keeps full ordered conversation and tool evidence without UI archive copies', () => {
  const output = 'TOOL_START' + 'complete evidence '.repeat(6000) + 'TOOL_END';
  const messages = [{ role: 'user', content: 'ORIGINAL_GOAL', ts: 1,
    attachments: [{ name: 'input.txt', path: '/workspace/input.txt', mimeType: 'text/plain', previewState: 'UI_PREVIEW' }] },
  { role: 'assistant', content: 'FINAL_REPLY', agentRun: {
    status: 'done', textContent: 'FINAL_REPLY', thinkingContent: 'REASONING_ONCE',
    timeline: [
      { type: 'thinking', content: 'REASONING_ONCE', streaming: false, openCodeKey: 'UI_KEY' },
      { type: 'text', content: 'INVESTIGATION' },
      { type: 'tool_call', callId: 'one', name: 'read', args: { path: '/workspace/input.txt', full: true } },
      { type: 'tool_result', callId: 'one', name: 'read', output, ok: true },
      { type: 'progress', content: 'UI_LOADING' },
      { type: 'text', content: 'FINAL_REPLY', stage: 'summary' }
    ],
    changeSummary: { files: [{ diff: 'UI_DIFF' }] }, performance: { text: 'UI_PERFORMANCE' },
    watchdog: { events: [{ message: 'UI_OBSERVER' }] }, contextCompression: { summary: 'LATER_NATIVE_SUMMARY' }
  } }];
  const before = JSON.stringify(messages);
  const projected = projectHistoryForModel(messages);
  const wire = JSON.stringify(projected);
  assert.equal(JSON.stringify(messages), before, 'original archive remains byte-equivalent');
  assert.equal(projected[0].content, 'ORIGINAL_GOAL');
  assert.equal(projected[0].attachments[0].path, '/workspace/input.txt');
  assert.deepEqual(projected[1].agentRun.timeline.map(item => item.type), ['thinking', 'text', 'tool_call', 'tool_result']);
  assert.deepEqual(projected[1].agentRun.timeline[2].args, { path: '/workspace/input.txt', full: true });
  assert.equal(projected[1].agentRun.timeline[3].output, output, 'tool output is never cropped');
  for (const once of ['FINAL_REPLY', 'REASONING_ONCE']) assert.equal(wire.split(once).length, 2);
  assert.doesNotMatch(wire, /UI_|LATER_NATIVE_SUMMARY/);
});

test('an interrupted aggregate response remains once in original timeline order', () => {
  const message = { role: 'assistant', content: 'Before tool\n\nAfter tool', agentRun: {
    timeline: [{ type: 'text', content: 'Before tool' }, { type: 'tool', output: 'EVIDENCE' }, { type: 'text', content: 'After tool' }]
  } };
  const result = projectHistoryForModel([message])[0];
  assert.equal(result.content, '');
  assert.deepEqual(result.agentRun.timeline.map(item => item.content || item.output), ['Before tool', 'EVIDENCE', 'After tool']);
});

test('identical narration at distinct times is not globally deduplicated', () => {
  const result = projectHistoryForModel([{ role: 'assistant', content: 'Repeated', agentRun: {
    timeline: [{ type: 'text', content: 'Repeated' }, { type: 'tool', output: 'Between' }, { type: 'text', content: 'Repeated' }]
  } }])[0];
  assert.equal(result.content, 'Repeated');
  assert.deepEqual(result.agentRun.timeline.map(item => item.content || item.output), ['Repeated', 'Between']);
});

test('old records retain their only final reply and tool history', () => {
  const result = projectHistoryForModel([{ role: 'assistant', agentRun: {
    status: 'interrupted', textContent: 'ONLY_REPLY', thinkingContent: 'ONLY_REASONING',
    toolCalls: [{ name: 'bash', args: { command: 'test' }, output: 'ONLY_TOOL_OUTPUT', interrupted: true }]
  } }])[0];
  assert.equal(result.content, 'ONLY_REPLY');
  assert.equal(result.agentRun.thinkingContent, 'ONLY_REASONING');
  assert.equal(result.agentRun.toolCalls[0].output, 'ONLY_TOOL_OUTPUT');
  assert.equal(result.agentRun.toolCalls[0].interrupted, true);
});

test('mid-run guidance keeps delivery state and the exact assistant fragment boundary', () => {
  const guidance = { status: 'pending', error: 'not delivered', timelineKey: 'turn-A',
    displayBoundary: { version: 1, keys: ['text:1'], textLengths: { 'text:1': 4 } },
    deliveryEvidence: { kind: 'queued' }, requestId: 'RUNTIME_HANDLE' };
  const result = projectHistoryForModel([
    { role: 'assistant', content: 'Final', agentRun: { guidanceTimelineKey: 'turn-A',
      timeline: [{ type: 'text', content: 'Before guidance', openCodeKey: 'text:1' },
        { type: 'text', content: 'Final', openCodeKey: 'text:2' }] } },
    { role: 'user', content: 'GUIDANCE', liveGuidance: guidance }
  ]);
  assert.equal(result[0].content, '');
  assert.equal(result[0].agentRun.guidanceTimelineKey, undefined, 'ordered fragments cannot be split a second time');
  assert.deepEqual(result[0].agentRun.timeline.map(item => item.openCodeKey), ['text:1']);
  assert.equal(result[0].agentRun.timeline[0].content, 'Befo');
  assert.equal(result[2].agentRun.timeline[0].content, 're guidance');
  assert.deepEqual(result[2].agentRun.timeline.map(item => item.openCodeKey), ['text:1', 'text:2']);
  assert.deepEqual(result[1].liveGuidance.displayBoundary, guidance.displayBoundary);
  assert.equal(result[1].liveGuidance.status, 'pending');
  assert.equal(result[1].liveGuidance.error, 'not delivered');
  assert.equal(result[1].liveGuidance.requestId, undefined);
});

test('ordering guidance retains a final answer that exists only outside the activity timeline', () => {
  const messages = [{ role: 'user', content: 'GUIDE', liveGuidance: { timelineKey: 'g',
    displayBoundary: { version: 1, keys: ['text:one'], textLengths: { 'text:one': 5 } } } },
  { role: 'assistant', content: 'UNIQUE_FINAL_ANSWER', agentRun: { guidanceTimelineKey: 'g',
    timeline: [{ type: 'text', openCodeKey: 'text:one', content: 'EARLY ACTIVITY' }] } }];
  const result = projectHistoryForModel(messages);
  assert.equal(result.at(-1).content, 'UNIQUE_FINAL_ANSWER');
  assert.equal(result[0].agentRun.timeline[0].content, 'EARLY');
  assert.equal(result[1].content, 'GUIDE');
  assert.equal(JSON.stringify(result).split('UNIQUE_FINAL_ANSWER').length - 1, 1);
});

test('legacy media and sole subagent output survive without subagent event buffers', () => {
  const result = projectHistoryForModel([{ role: 'assistant', media: { assetId: 'asset-1', path: '/workspace/result.png' },
    agentRun: { thinkingContent: 'ONLY_THOUGHT', timeline: [{ type: 'tool', output: 'result' }],
      subagents: [{ callId: 'child-1', title: 'Inspection', status: 'interrupted',
        timeline: [{ type: 'text', content: 'ONLY_CHILD_RESULT' }], messages: ['CACHE_ONLY'], seenEvents: ['CACHE_ONLY'] }] }
  }])[0];
  assert.equal(result.media.assetId, 'asset-1');
  assert.equal(result.agentRun.thinkingContent, 'ONLY_THOUGHT');
  assert.equal(result.agentRun.subagents[0].result, 'ONLY_CHILD_RESULT');
  assert.equal(result.agentRun.subagents[0].status, 'interrupted');
  assert.doesNotMatch(JSON.stringify(result), /CACHE_ONLY/);
});

test('a rewind uses only the authoritative prefix and no later summary or renderer history', () => {
  const messages = [{ role: 'user', content: 'RETAINED' }, { role: 'assistant', content: 'LAST_RETAINED' },
    { role: 'user', content: 'EDITED_REQUEST', ts: 3 }, { role: 'assistant', content: 'FUTURE' }];
  const session = { id: 'sess_example', contextReset: { sourceSessionId: 'sess_example', messageCount: 2 },
    messages, contextCompression: { summary: 'FUTURE_SUMMARY' } };
  const request = { prompt: 'EDITED_REQUEST', requestMessageIndex: 2, requestMessageAnchor: messageForkAnchor(messages[2]) };
  const snapshot = JSON.stringify(session);
  Object.assign(request, forkRunContext(session, request));
  const prompt = combineTurnPrompt({ ...request, history: [{ role: 'user', content: 'FORGED_RENDERER_HISTORY' }] }, request.prompt, true);
  assert.match(prompt, /RETAINED/);
  assert.match(prompt, /LAST_RETAINED/);
  assert.match(prompt, /EDITED_REQUEST/);
  assert.doesNotMatch(prompt, /FUTURE|FORGED_RENDERER_HISTORY/);
  assert.equal(JSON.stringify(session), snapshot);
});

test('oversized archive telemetry no longer rejects a fitting transcript; actual oversized content still fails', () => {
  const history = [{ role: 'user', content: 'ROOT' }, { role: 'assistant', content: 'ANSWER', agentRun: {
    textContent: 'ANSWER', timeline: [{ type: 'tool', output: 'FULL_EVIDENCE' }],
    performance: { traces: 'METADATA_ONLY'.repeat(70000) }, changeSummary: { diff: 'DIFF_ONLY'.repeat(50000) }
  } }];
  const request = { providerId: 'fixture', modelId: 'fixture', workMode: 'normal', prompt: 'Continue.',
    forkHistory: { kind: 'rewind', messages: history },
    openCodeConfig: { provider: { fixture: { models: { fixture: { limit: { context: 128000, output: 4096 } } } } },
      compaction: { threshold: 100000, reserved: 4096 } } };
  assert.ok(estimateSerializedContextTokens(history) > 128000);
  assert.doesNotThrow(() => assertForkHistoryFits(request, combineTurnPrompt(request, request.prompt, true)));
  history[0].content = '真实正文'.repeat(50000);
  assert.throws(() => assertForkHistoryFits(request, combineTurnPrompt(request, request.prompt, true)),
    error => error.code === 'FORK_CONTEXT_TOO_LARGE');
  assert.equal(history[0].content.length, 200000);
});
