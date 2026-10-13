'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyNativeDesktopCoverage } = require('../lib/native-desktop-coverage');
const { projectHistoryForModel } = require('../lib/history-model-context');
const { createDesktopContextCheckpoint, restoreDesktopContextCheckpoint,
  desktopCheckpointHistorySystem, inheritDesktopContextCheckpoints } = require('../lib/desktop-context-checkpoint');
const { captureDesktopCheckpointAtBoundary, interjectionCheckpointPrompt } = require('../lib/opencode-sidecar');

const clone = value => JSON.parse(JSON.stringify(value));
const request = { zSessionId: 'sess_coverage', branchId: 'sess_coverage', conversationRevision: 0, workMode: 'normal' };
const turn = text => `${text}\n\n<z-turn-context task_id="fixture">Runtime data</z-turn-context>`;
const user = (id, text) => ({ info: { id, role: 'user' }, parts: [{ id: `prt_${id}`, type: 'text', text: turn(text) }] });
const assistant = (id, text, extra = []) => ({ info: { id, role: 'assistant', time: { created: 2, completed: 3 } },
  parts: [...extra, { id: `prt_${id}`, type: 'text', text }] });
const desktopAssistant = (id, text, timeline = []) => ({ role: 'assistant', content: text,
  agentRun: { status: 'done', timeline: [...timeline, { type: 'text', content: text, openCodeKey: `text:prt_${id}` }] } });
const desktopUser = content => ({ role: 'user', content });
function basic() {
  const native = [user('u0', 'Original task'), assistant('a0', 'First result'),
    user('u1', 'Continue requested work'), assistant('a1', 'Final result')];
  const desktop = [desktopUser('Original task'), desktopAssistant('a0', 'First result'),
    desktopUser('Continue requested work'), desktopAssistant('a1', 'Final result')];
  return { native, desktop };
}
function compaction(tail = 'u1') {
  return [{ info: { id: 'compact', role: 'user' }, parts: [{ id: 'prt_compact', type: 'compaction', tail_start_id: tail }] },
    { info: { id: 'summary', role: 'assistant', summary: true, parentID: 'compact', time: { created: 4, completed: 5 } },
      parts: [{ id: 'prt_summary', type: 'text', text: 'New verified summary' }] }];
}
function checkpoint(prefix) {
  return createDesktopContextCheckpoint({ messages: prefix, request, nativeSessionId: 'native_old',
    restoredNativeContext: { ok: true, checkpointId: 'a'.repeat(64), context: { summary: 'Earlier summary',
      tail: [{ id: 'tail', role: 'assistant', parts: [{ id: 'prt_tail', type: 'text', text: 'Exact retained earlier tail' }] }] } } });
}

test('exact native user turns and stable assistant parts prove the whole completed archive', () => {
  const f = basic();
  assert.deepEqual(verifyNativeDesktopCoverage(f.native, f.desktop), { ok: true, seedMessageCount: 0 });
  assert.equal(verifyNativeDesktopCoverage([...f.native, ...compaction()], f.desktop).ok, true);
  for (const change of [
    value => { value.desktop[0].content = 'Different goal'; },
    value => { value.desktop[1].agentRun.timeline[0].content = 'Changed answer'; },
    value => { value.desktop[3].agentRun.status = 'incomplete'; },
    value => { value.native[3].info.time.completed = 0; },
    value => { value.native.push(user('future', 'Unrecorded request')); },
    value => { value.native.push(assistant('future', 'Unrecorded result')); },
    value => { value.native[3].parts.push({ id: 'prt_late', type: 'text', text: 'Late unrecorded text' }); },
    value => { value.native[3].parts.push({ id: 'prt_late', type: 'tool', callID: 'late', tool: 'write',
      state: { status: 'completed', input: { file: 'future.txt' }, output: 'Changed file' } }); },
    value => { value.desktop[1].agentRun.timeline[0].openCodeKey = 'text:prt_a1'; },
    value => { value.desktop[3].agentRun.todos = [{ text: 'Unverified task state' }]; }
  ]) {
    const changed = basic(); change(changed);
    assert.equal(verifyNativeDesktopCoverage(changed.native, changed.desktop).ok, false);
  }
});

test('an exact branch seed covers its projected desktop prefix while bounded or changed seeds do not', () => {
  const f = basic();
  const seed = { branchPointMessageIndex: 1, messages: projectHistoryForModel(f.desktop.slice(0, 2)) };
  const seeded = [user('u1', `<z-conversation-branch-history>${JSON.stringify(seed)}</z-conversation-branch-history>\n\nContinue requested work`), f.native[3]];
  assert.deepEqual(verifyNativeDesktopCoverage(seeded, f.desktop), { ok: true, seedMessageCount: 2 });
  const changed = clone(seeded); changed[0].parts[0].text = changed[0].parts[0].text.replace('First result', 'Different result');
  assert.equal(verifyNativeDesktopCoverage(changed, f.desktop).reason, 'seed-prefix-mismatch');
  assert.equal(verifyNativeDesktopCoverage([user('u1', '<z-session-history>user: Original task</z-session-history>\nContinue requested work'), f.native[3]], f.desktop).ok, false);
});

test('already projected branch and checkpoint seeds are never projected a second time', () => {
  const f = basic();
  f.desktop[1].agentRun.timeline = [{ type: 'text', content: 'First result' },
    { type: 'tool_call', name: 'read', callId: 'c1', args: { path: 'before.txt' } },
    { type: 'text', content: 'First result' }];
  const seed = { branchPointMessageIndex: 1, messages: projectHistoryForModel(f.desktop.slice(0, 2)) };
  const seeded = [user('u1', `<z-conversation-branch-history>${JSON.stringify(seed)}</z-conversation-branch-history>\n\nContinue requested work`), f.native[3]];
  assert.equal(verifyNativeDesktopCoverage(seeded, f.desktop).ok, true);
  const saved = checkpoint(f.desktop.slice(0, 1));
  const restored = restoreDesktopContextCheckpoint(saved, { messages: f.desktop.slice(0, 2), request });
  const checkpointSeed = [user('u1', `${desktopCheckpointHistorySystem(restored)}\n\nContinue requested work`), f.native[3]];
  assert.equal(verifyNativeDesktopCoverage(checkpointSeed, f.desktop, { request, checkpoints: [saved] }).ok, true);
});

test('tool arguments, successful outputs and error outputs require exact native evidence', () => {
  const f = basic();
  const tool = { id: 'prt_tool', type: 'tool', tool: 'read', callID: 'call_one',
    state: { status: 'completed', input: { path: 'evidence.txt', offset: 4 }, output: 'Verified file contents' } };
  f.native[1].parts.unshift(tool);
  f.desktop[1].agentRun.timeline.unshift(
    { type: 'tool_call', name: 'read', callId: 'call_one', args: { offset: 4, path: 'evidence.txt' } },
    { type: 'tool_result', name: 'read', callId: 'call_one', output: 'Verified file contents', ok: true });
  assert.equal(verifyNativeDesktopCoverage(f.native, f.desktop).ok, true);
  for (const field of ['input', 'output']) {
    const changed = clone(f);
    if (field === 'input') changed.desktop[1].agentRun.timeline[0].args.path = 'different.txt';
    else changed.desktop[1].agentRun.timeline[1].output = 'Unverified result';
    assert.equal(verifyNativeDesktopCoverage(changed.native, changed.desktop).reason, `desktop-tool-${field}-mismatch`);
  }
  tool.state = { ...tool.state, status: 'error', error: 'File unavailable' }; delete tool.state.output;
  f.desktop[1].agentRun.timeline[1] = { type: 'tool_result', name: 'read', callId: 'call_one', output: 'File unavailable', ok: false };
  assert.equal(verifyNativeDesktopCoverage(f.native, f.desktop).ok, true);
});

test('live guidance requires exact insertion text and its actual position between assistant fragments', () => {
  const guideText = 'Use the corrected requirement';
  const live = `Z LIVE USER INTERJECTION\n\nGuidance version: 1\n\n[[Z_GUIDANCE_RECEIPT:abc]]\n\n${guideText}\n\nUser intent: adjust the remaining work without interrupting the active operation.`;
  const before = { type: 'text', openCodeKey: 'text:prt_before', content: 'Before guide' };
  const run = desktopAssistant('after', 'After guide', [before]); run.agentRun.guidanceTimelineKey = 'owner';
  const guide = { role: 'user', content: guideText, liveGuidance: { timelineKey: 'owner', deliveryEvidence: 'provider-response',
    displayBoundary: { version: 1, keys: ['text:prt_before'], textLengths: { 'text:prt_before': 12 } } } };
  const native = [user('u0', 'Original task'), assistant('before', 'Before guide'), user('guide', live),
    user('checkpoint', interjectionCheckpointPrompt([{ version: 1, guidance: guideText }], 'after-work')), assistant('after', 'After guide')];
  const desktop = [desktopUser('Original task'), guide, run];
  assert.equal(verifyNativeDesktopCoverage(native, desktop).ok, true);
  for (const change of [
    value => { value[1].liveGuidance.displayBoundary.keys.push('text:prt_after'); },
    value => { value[1].liveGuidance.displayBoundary.keys = []; },
    value => { value[1].liveGuidance.displayBoundary.textLengths['text:prt_before'] = 3; },
    value => { value[1].content = 'Different guide'; }
  ]) {
    const changed = clone(desktop); change(changed);
    assert.equal(verifyNativeDesktopCoverage(native, changed).ok, false);
  }
});

test('native runtime notices are recognized narrowly and unknown user turns are never skipped', () => {
  const f = basic();
  const notice = 'Z RUNTIME REQUIREMENT\n\nGuidance version: 1\n\nConfirm the current work\n\nRuntime requirement: satisfy this in the remaining work without interrupting the active operation.';
  f.native.splice(3, 0, user('notice', notice));
  assert.equal(verifyNativeDesktopCoverage(f.native, f.desktop).ok, true);
  f.native[3] = user('notice', 'Z RUNTIME REQUIREMENT\nAn unrecognized wrapper');
  assert.equal(verifyNativeDesktopCoverage(f.native, f.desktop).reason, 'native-user-mismatch');
});

test('checkpoint-seeded sessions can establish a later verified checkpoint without replaying their old archive', () => {
  const f = basic();
  const saved = checkpoint(f.desktop.slice(0, 2));
  const restored = restoreDesktopContextCheckpoint(saved, { messages: f.desktop, request });
  const continued = [user('u2', `${desktopCheckpointHistorySystem(restored)}\n\nA new task step`), assistant('a2', 'Next completed result'),
    user('u3', 'Finish this step'), assistant('a3', 'Final completed result'), ...compaction('u3')];
  const allDesktop = [...f.desktop, desktopUser('A new task step'), desktopAssistant('a2', 'Next completed result'),
    desktopUser('Finish this step'), desktopAssistant('a3', 'Final completed result')];
  const options = { request, checkpoints: [saved] };
  assert.deepEqual(verifyNativeDesktopCoverage(continued, allDesktop, options), { ok: true, seedMessageCount: 4 });
  const next = captureDesktopCheckpointAtBoundary({ messages: continued,
    request: { ...request, checkpointDesktopHistory: allDesktop, desktopContextCheckpoints: [saved] },
    nativeSessionId: 'native_new', directory: '/fixture' });
  assert.ok(next);
  assert.equal(next.desktopPrefix.messageCount, 8);
  const changed = clone(continued); changed[0].parts[0].text = changed[0].parts[0].text.replace('Earlier summary', 'Forged summary');
  assert.equal(verifyNativeDesktopCoverage(changed, allDesktop, options).ok, false);
  assert.equal(verifyNativeDesktopCoverage(continued, allDesktop, { request, checkpoints: [] }).ok, false);
  const reboundRequest = { ...request, conversationRevision: 1 };
  const inherited = inheritDesktopContextCheckpoints([saved], { sourceMessages: allDesktop, targetMessages: allDesktop,
    sourceRequest: request, targetRequest: reboundRequest });
  assert.equal(verifyNativeDesktopCoverage(continued, allDesktop, { request: reboundRequest, checkpoints: inherited }).ok, true);
});

test('unknown attachment or subagent evidence cannot be silently covered by a text-only match', () => {
  const f = basic();
  f.desktop[2].attachments = [{ name: 'document.txt', path: '/private/document.txt' }];
  assert.equal(verifyNativeDesktopCoverage(f.native, f.desktop).reason, 'unverified-attachment');
  delete f.desktop[2].attachments;
  f.desktop[3].agentRun.subagents = [{ result: 'An unverified report' }];
  assert.equal(verifyNativeDesktopCoverage(f.native, f.desktop).reason, 'unverified-desktop-evidence');
});
