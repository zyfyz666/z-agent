'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { guidedHistory } = require('./fixtures/guidance-history.cjs');
const { forkBoundary, forkRunContext, messageForkAnchor, createSessionForkRecord } = require('../lib/session-fork');
const { rewindBoundary, createRewoundSession } = require('../lib/session-rewind');
const { projectHistoryForModel } = require('../lib/history-model-context');
const { combineTurnPrompt } = require('../lib/opencode-sidecar');
const { projectTimeline } = require('../renderer/guidance-timeline');
const clone = value => JSON.parse(JSON.stringify(value));
const boundary = (source, index, includeSelected = false) => ({ sessionId: source.id, messageIndex: index,
  messageAnchor: messageForkAnchor(source.messages[index]), includeSelected });

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy keyed archive' : 'immutable snapshot'}: first guidance preserves partial text and an unfinished tool without future output`, () => {
    const source = guidedHistory({ legacy });
    const before = JSON.stringify(source);
    const messages = rewindBoundary(source, boundary(source, 1));
    assert.equal(messages.length, 2);
    const run = messages.at(-1).agentRun;
    assert.equal(run.status, 'incomplete');
    assert.equal(run.timeline[0].content, 'BEFORE_FIRST');
    assert.equal(run.timeline[1].content, 'KNOWN_REASONING');
    assert.equal(run.timeline[2].callId, 'call-one');
    assert.equal(run.timeline[2].status, 'incomplete');
    assert.equal(run.timeline.some(item => item.type === 'tool_result'), false);
    assert.equal(run.timeline[2].args?.path, legacy ? undefined : 'known.txt');
    assert.equal(run.timeline[2].inputUnavailableAtBoundary, legacy ? true : undefined);
    assert.doesNotMatch(JSON.stringify(messages), /GUIDE_ONE|GUIDE_TWO|BETWEEN_GUIDES|KNOWN_TOOL_RESULT|FUTURE_/);
    assert.equal(JSON.stringify(source), before);
  });

  test(`${legacy ? 'legacy keyed archive' : 'immutable snapshot'}: second guidance preserves the previous guide and all activity before the selected send time`, () => {
    const source = guidedHistory({ legacy });
    const messages = rewindBoundary(source, boundary(source, 2));
    assert.deepEqual(messages.map(message => message.role), ['user', 'user', 'assistant']);
    assert.equal(messages[1].content, 'GUIDE_ONE');
    const run = messages.at(-1).agentRun;
    assert.equal(run.timeline[0].content, 'BEFORE_FIRST BETWEEN_GUIDES');
    assert.equal(run.timeline[3].output, 'KNOWN_TOOL_RESULT');
    assert.equal(run.timeline[4].status, 'incomplete');
    assert.equal(run.timeline[4].args?.command, legacy ? undefined : 'known-command');
    assert.equal(run.toolCallCount, 2);
    assert.doesNotMatch(JSON.stringify(messages), /GUIDE_TWO|FUTURE_|NATIVE_BUFFER|NATIVE_HANDLE/);
    const visible = projectTimeline(run.timeline, [messages[1].liveGuidance.displayBoundary]);
    assert.deepEqual(visible.map(parts => parts.filter(item => item.type === 'text').map(item => item.content).join('')),
      ['BEFORE_FIRST', ' BETWEEN_GUIDES']);
    assert.equal(visible[0].filter(item => item.type === 'tool_result').length, 1, 'the visible tool card keeps its observed result');
    const model = projectHistoryForModel(messages);
    assert.deepEqual(model.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(model[2].content, 'GUIDE_ONE');
    assert.equal(model[1].agentRun.timeline.some(item => item.type === 'tool_result'), false,
      'model evidence keeps a result arriving after the first guide after that guide');
    assert.equal(model[3].agentRun.timeline.some(item => item.output === 'KNOWN_TOOL_RESULT'), true);
    assert.doesNotMatch(JSON.stringify(model), /historyBoundary|NATIVE_BUFFER|FUTURE_/);
  });
}

test('snapshot freezes mutable arguments, Observer decisions and subagent evidence without runtime buffers', () => {
  const source = guidedHistory();
  const run = rewindBoundary(source, boundary(source, 2)).at(-1).agentRun;
  assert.equal(run.timeline.at(-1).args.command, 'known-command');
  assert.equal(run.watchdog.events.length, 2);
  assert.equal(run.watchdog.events[1].message, 'OBSERVER_BEFORE_SECOND');
  assert.equal(run.subagents[0].textContent, 'KNOWN_CHILD_TEXT');
  assert.equal(run.todos[0].text, 'KNOWN_TODO');
  assert.doesNotMatch(JSON.stringify(run), /FUTURE_|NATIVE_BUFFER|NATIVE_HANDLE|performance|seenEvents/);
});

test('a persisted send-time snapshot survives when a crash prevented the final assistant archive from being appended', () => {
  const source = guidedHistory();
  source.messages.pop();
  const retained = rewindBoundary(clone(source), boundary(source, 2));
  assert.equal(retained.at(-1).agentRun.timeline[0].content, 'BEFORE_FIRST BETWEEN_GUIDES');
  assert.doesNotMatch(JSON.stringify(retained), /GUIDE_TWO|FUTURE_/);
});

test('detached backup history uses its stable timeline key without runtime run or request IDs', () => {
  const source = guidedHistory({ legacy: true });
  for (const message of source.messages) {
    if (message.agentRun) delete message.agentRun.runId;
    if (message.liveGuidance) { delete message.liveGuidance.runId; delete message.liveGuidance.requestId; }
  }
  const messages = rewindBoundary(clone(source), boundary(source, 1));
  assert.equal(messages.at(-1).agentRun.timeline[0].content, 'BEFORE_FIRST');
});

test('missing legacy execution boundaries fail before deleting historical work', () => {
  const source = guidedHistory({ legacy: true });
  delete source.messages[1].liveGuidance.displayBoundary;
  const before = JSON.stringify(source);
  assert.throws(() => rewindBoundary(source, boundary(source, 1)), { code: 'SESSION_GUIDANCE_BOUNDARY_UNAVAILABLE' });
  assert.equal(JSON.stringify(source), before);
});

test('back-to-back guidance with no new output preserves the preceding guide without importing later work', () => {
  const source = guidedHistory();
  source.messages[2].liveGuidance.displayBoundary = clone(source.messages[1].liveGuidance.displayBoundary);
  source.messages[2].liveGuidance.historyBoundary = clone(source.messages[1].liveGuidance.historyBoundary);
  const messages = rewindBoundary(source, boundary(source, 2));
  const model = projectHistoryForModel(messages);
  assert.equal(model.filter(message => message.content === 'GUIDE_ONE').length, 1);
  assert.equal(JSON.stringify(model).split('BEFORE_FIRST').length - 1, 1);
  assert.doesNotMatch(JSON.stringify(model), /BETWEEN_GUIDES|GUIDE_TWO|KNOWN_TOOL_RESULT|FUTURE_/);
});

test('reload, second rewind and edited resubmission retain the exact authoritative boundary in model context', () => {
  const source = guidedHistory();
  const selected = rewindBoundary(source, boundary(source, 2));
  const rewound = createRewoundSession(source, selected, { backupSessionId: 'sess_fixture_backup', now: 100 });
  const reloaded = clone(rewound);
  const edited = { role: 'user', ts: 120, content: 'EDITED_GUIDANCE' };
  reloaded.messages.push(edited);
  const request = { prompt: edited.content, requestMessageIndex: reloaded.messages.length - 1,
    requestMessageAnchor: messageForkAnchor(edited) };
  Object.assign(request, forkRunContext(reloaded, request));
  const prompt = combineTurnPrompt({ ...request, history: [{ role: 'assistant', content: 'FORGED_FUTURE' }] }, request.prompt, true);
  for (const marker of ['BEFORE_FIRST', 'BETWEEN_GUIDES', 'GUIDE_ONE', 'KNOWN_TOOL_RESULT', 'EDITED_GUIDANCE']) assert.match(prompt, new RegExp(marker));
  assert.doesNotMatch(prompt, /GUIDE_TWO|FUTURE_|FORGED_FUTURE|historyBoundary|NATIVE_BUFFER/);
  assert.ok(prompt.indexOf('BEFORE_FIRST') < prompt.indexOf('GUIDE_ONE'));
  assert.ok(prompt.indexOf('GUIDE_ONE') < prompt.indexOf('BETWEEN_GUIDES'));
  const earlier = rewindBoundary(reloaded, boundary(reloaded, 1));
  assert.equal(earlier.at(-1).agentRun.timeline[0].content, 'BEFORE_FIRST');
  assert.doesNotMatch(JSON.stringify(earlier), /BETWEEN_GUIDES|EDITED_GUIDANCE|GUIDE_ONE/);
});

test('inclusive branch creation at a live guide uses the same send-time boundary', () => {
  const source = guidedHistory({ legacy: true });
  const fork = createSessionForkRecord(source, boundary(source, 1, true), { id: 'sess_guidance_branch', workspace: '/fixture/workspace' });
  assert.deepEqual(fork.messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.equal(fork.messages.at(-1).content, 'GUIDE_ONE');
  assert.equal(fork.messages[1].agentRun.timeline[0].content, 'BEFORE_FIRST');
  assert.doesNotMatch(JSON.stringify(fork), /BETWEEN_GUIDES|FUTURE_/);
  assert.equal(forkBoundary(source, boundary(source, 1, true)).at(-1).content, 'GUIDE_ONE');
});
