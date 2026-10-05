'use strict';

const { captureBoundary, captureHistoryBoundary } = require('../../renderer/guidance-timeline');
const clone = value => JSON.parse(JSON.stringify(value));

function guidedHistory({ legacy = false } = {}) {
  const run = { runId: 'fixture-run', guidanceTimelineKey: 'fixture-timeline', startedAt: 10,
    providerId: 'fixture-provider', modelId: 'fixture-model', status: 'working',
    timeline: [{ type: 'text', openCodeKey: 'text:one', content: 'BEFORE_FIRST', streaming: true },
      { type: 'thinking', openCodeKey: 'thinking:one', content: 'KNOWN_REASONING', streaming: true },
      { type: 'tool_call', openCodeKey: 'call:one', callId: 'call-one', name: 'read', args: { path: 'known.txt' } }],
    watchdog: { enabled: true, phase: 'waiting', events: [{ ts: 15, action: 'observe', message: 'EARLY_OBSERVER' }] },
    todos: [{ text: 'KNOWN_TODO', status: 'in_progress' }],
    subagents: [{ callId: 'child-one', title: 'Child evidence', status: 'working', textContent: 'KNOWN_CHILD_TEXT',
      messages: ['NATIVE_BUFFER'], seenEvents: ['NATIVE_BUFFER'], pendingDeltas: ['NATIVE_BUFFER'] }],
    openCodeSessionId: 'NATIVE_HANDLE', performance: { trace: 'NATIVE_BUFFER' } };
  function guide(content, ts) {
    return { role: 'user', content, ts, liveGuidance: {
      requestId: `request-${ts}`, runId: run.runId, timelineKey: run.guidanceTimelineKey,
      status: 'delivered', deliveryEvidence: 'provider-response', displayBoundary: captureBoundary(run.timeline),
      ...(!legacy ? { historyBoundary: captureHistoryBoundary(run) } : {})
    } };
  }
  const first = guide('GUIDE_ONE', 20);
  run.timeline[0].content += ' BETWEEN_GUIDES';
  run.timeline[1].content += ' REASONING_BEFORE_SECOND';
  run.timeline.push({ type: 'tool_result', openCodeKey: 'result:one', callId: 'call-one', name: 'read', ok: true, output: 'KNOWN_TOOL_RESULT' },
    { type: 'tool_call', openCodeKey: 'call:two', callId: 'call-two', name: 'bash', args: { command: 'known-command' } });
  run.watchdog.events.push({ ts: 30, action: 'advise', message: 'OBSERVER_BEFORE_SECOND' });
  const second = guide('GUIDE_TWO', 40);
  run.timeline[0].content += ' FUTURE_TEXT';
  run.timeline[1].content += ' FUTURE_REASONING';
  run.timeline.at(-1).args.command += ' FUTURE_ARGUMENTS';
  run.timeline.push({ type: 'tool_result', openCodeKey: 'result:two', callId: 'call-two', name: 'bash', ok: true, output: 'FUTURE_TOOL_RESULT' },
    { type: 'text', openCodeKey: 'text:final', stage: 'summary', content: 'FUTURE_FINAL' });
  run.watchdog.events.push({ ts: 60, action: 'remind', message: 'FUTURE_OBSERVER' });
  run.subagents[0].textContent += ' FUTURE_CHILD_TEXT';
  run.todos.push({ text: 'FUTURE_TODO', status: 'completed' });
  run.status = 'done';
  run.textContent = 'FUTURE_FINAL';
  run.completedAt = 80;
  return { id: 'sess_guidance_fixture', title: 'Guided fixture', workspace: '/fixture/workspace', createdAt: 1,
    conversationRevision: 0, messages: [{ role: 'user', content: 'ORIGINAL_REQUEST', ts: 1 }, first, second,
      { role: 'assistant', content: 'FUTURE_FINAL', ts: 80, agentRun: clone(run) }] };
}

module.exports = { guidedHistory };
