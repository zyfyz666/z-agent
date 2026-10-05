'use strict';

// Real pinned OpenCode, isolated storage, and a loopback-only model fixture.
// The source archive is synthetic; no installed app or live profile is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  OpenCodeSidecar, buildOpenCodeConfig, combineTurnPrompt, combineSystem,
  assertForkHistoryFits, estimateSerializedContextTokens
} = require('../lib/opencode-sidecar');
const { messageForkAnchor, forkRunContext } = require('../lib/session-fork');
const { rewindBoundary, createRewoundSession } = require('../lib/session-rewind');

const appRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(appRoot, 'output');
fs.mkdirSync(outputRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(outputRoot, 'history-model-context-native-'));
const workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace);
const providerId = 'history-projection-fixture';
const modelId = 'history-projection-local-model';
const markers = {
  goal: 'HISTORY_ORIGINAL_GOAL_14837',
  answer: 'HISTORY_COMPLETE_FINAL_ANSWER_14837',
  activity: 'HISTORY_INTERMEDIATE_COMMENTARY_14837',
  guidance: 'HISTORY_RETAINED_GUIDANCE_14837',
  boundary: 'HISTORY_LAST_RETAINED_TURN_14837',
  future: 'HISTORY_DISCARDED_FUTURE_14837',
  rendererFuture: 'HISTORY_UNTRUSTED_RENDERER_FUTURE_14837',
  changeSummary: 'HISTORY_UI_CHANGE_SUMMARY_ONLY_14837',
  telemetry: 'HISTORY_UI_TELEMETRY_ONLY_14837',
  progress: 'HISTORY_UI_PROGRESS_LABEL_ONLY_14837'
};
const fullArgs = { path: '/synthetic/retained-input.txt', query: 'ARG_BEGIN_14837 ' + 'argument evidence '.repeat(800) + ' ARG_END_14837' };
const fullOutput = 'TOOL_OUTPUT_BEGIN_14837\n' + 'Complete retained tool result.\n'.repeat(900) + 'TOOL_OUTPUT_END_14837';
const cutoff = 27;
const source = {
  id: 'sess_projection_source', title: 'Synthetic rewind history', workspace, workspaceKind: 'selected',
  modelSelection: { providerId, modelId, modelType: 'text' },
  openCodeSessionId: 'future-native-session-must-never-be-reused',
  handoff: { context: markers.future },
  messages: Array.from({ length: cutoff + 3 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', ts: 1800000000000 + index,
    content: index > cutoff ? `${markers.future}_${index}` : `Retained conversation message ${index}`
  }))
};
source.messages[0].content = markers.goal;
source.messages[1] = { ...source.messages[1], content: markers.answer, agentRun: {
  status: 'done', textContent: markers.answer,
  changeSummary: [{ diff: markers.changeSummary + ' display-only-diff '.repeat(1000) }],
  watchdog: { events: [{ text: markers.telemetry + '遥测'.repeat(600000) }] },
  metrics: { latencyTrace: markers.telemetry, replayBuffer: 'UI data only' },
  timeline: [
    { type: 'progress', content: markers.progress },
    { type: 'text', content: markers.activity },
    { type: 'tool', name: 'read', callId: 'historic-read-call', args: fullArgs, output: fullOutput, status: 'completed', ok: true },
    { type: 'guidance', role: 'user', content: markers.guidance, deliveryState: 'delivered' },
    { type: 'text', content: markers.answer }
  ]
} };
source.messages[cutoff].content = markers.boundary;
const sourceBefore = JSON.stringify(source);
const boundary = { sessionId: source.id, messageIndex: cutoff, messageAnchor: messageForkAnchor(source.messages[cutoff]) };
const rewound = createRewoundSession(source, rewindBoundary(source, boundary), {
  backupSessionId: 'sess_projection_backup', modelSelection: source.modelSelection, now: 1800001000000
});
const retainedBefore = JSON.stringify(rewound.messages);
const requests = [];
const providerCalls = [];
const failures = [];
const checks = [];

function textOf(content) {
  return typeof content === 'string' ? content
    : (Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part.text || '').join('\n') : '');
}

function completion(response, model, text) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const base = { id: 'history-projection-fixture-response', object: 'chat.completion.chunk', created: 1, model };
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
    prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010
  } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(raw || '{}');
      assert.equal(body.model, modelId);
      const lastUser = [...(body.messages || [])].reverse().find(message => message.role === 'user');
      const action = [...textOf(lastUser?.content).matchAll(/HISTORY_RUN_(FIRST|SECOND|OVERSIZED|EMPTY_RETRY)_14837/g)].at(-1)?.[1];
      providerCalls.push({ action: action || 'auxiliary', model: body.model });
      if (!action) return completion(response, body.model, 'Synthetic history session title');
      requests.push({ action, body });
      assert.notEqual(action, 'OVERSIZED', 'genuinely oversized conversation text must fail before model HTTP');
      const transcript = (body.messages || []).map(message => textOf(message.content)).join('\n');
      assert.equal(transcript.split('<z-conversation-branch-history>').length - 1, 1, `${action}: exactly one history seed`);
      const match = transcript.match(/<z-conversation-branch-history>\s*([\s\S]*?)\s*<\/z-conversation-branch-history>/);
      assert.ok(match, `${action}: retained history envelope reaches the real provider`);
      const archive = JSON.parse(match[1]);
      assert.equal(archive.messages.length, cutoff + 1);
      assert.equal(archive.messages[0].content, markers.goal, `${action}: earliest goal survives past the normal recovery window`);
      assert.equal(archive.messages.at(-1).content, markers.boundary, `${action}: boundary is inclusive and complete`);
      const activity = archive.messages[1].agentRun.timeline;
      const tool = activity.find(item => item.type === 'tool');
      assert.deepEqual(tool.args, fullArgs, `${action}: no argument clipping`);
      assert.equal(tool.output, fullOutput, `${action}: no tool output clipping`);
      assert.ok(activity.some(item => item.content === markers.activity));
      assert.ok(activity.some(item => item.content === markers.guidance));
      assert.equal(transcript.split(markers.answer).length - 1, 1, `${action}: display copies do not duplicate the final answer`);
      for (const name of ['future', 'rendererFuture', 'changeSummary', 'telemetry', 'progress']) {
        assert.ok(!transcript.includes(markers[name]), `${action}: excludes ${name}`);
      }
      assert.ok(!Object.hasOwn(archive.messages[1].agentRun, 'textContent'));
      assert.ok(!Object.hasOwn(archive.messages[1].agentRun, 'changeSummary'));
      assert.ok(!Object.hasOwn(archive.messages[1].agentRun, 'watchdog'));
      if (action === 'SECOND') {
        assert.ok(!textOf(lastUser.content).includes('<z-conversation-branch-history>'), 'follow-up prompt does not seed again');
        assert.equal(transcript.split('HISTORY_RUN_FIRST_14837').length - 1, 1);
        assert.ok(transcript.includes('HISTORY_REPLY_FIRST_14837'), 'same native session retains its actual previous answer');
      }
      completion(response, body.model, `HISTORY_REPLY_${action}_14837`);
    } catch (error) {
      failures.push(error);
      completion(response, modelId, `HISTORY_FIXTURE_FAILED: ${error.message}`);
    }
  });
});

function unwrap(result) {
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.data;
}

(async () => {
  const sidecar = new OpenCodeSidecar({ appRoot, dataDir: path.join(directory, 'data') });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = buildOpenCodeConfig({ providerId, modelId,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'isolated-loopback-key',
      contextWindow: 1000000, compactionThreshold: 800000, maxOutputTokens: 4096,
      capabilities: { reasoning: false }, enableSubagents: false, mcpServers: [],
      permissions: { allowFileRead: true, allowFileWrite: false, allowNetwork: false }
    });
    config.plugin = [];
    config.mcp = {};
    config.skills = { paths: [] };
    const baseRequest = {
      workspace, hasUserWorkspace: true, providerId, modelId, openCodeConfig: config,
      title: 'Synthetic history projection native test', zSessionId: rewound.id,
      workMode: 'normal', accessMode: 'request', enableSubagents: false,
      permissions: { allowFileRead: true, allowFileWrite: false, allowNetwork: false }
    };
    const requestFor = (action, session = rewound) => {
      const prompt = `HISTORY_RUN_${action}_14837 Continue only from retained history; do not use tools.`;
      const context = forkRunContext(session, { prompt });
      return { ...baseRequest, ...context, runId: `history-projection-${action}`, prompt,
        history: [{ role: 'user', content: markers.rendererFuture }] };
    };
    const firstRequest = requestFor('FIRST');
    const projectedPrompt = combineTurnPrompt(firstRequest, firstRequest.prompt, true);
    const system = combineSystem(firstRequest);
    const oldRawPrompt = JSON.stringify({ messages: firstRequest.forkHistory.messages }) + firstRequest.prompt;
    const rawEstimate = estimateSerializedContextTokens(oldRawPrompt);
    const projectedEstimate = estimateSerializedContextTokens({ system, prompt: projectedPrompt });
    assert.ok(rawEstimate > 1000000, `old UI archive exceeds 1M: ${rawEstimate}`);
    assert.throws(() => assertForkHistoryFits(firstRequest, oldRawPrompt, system), error => error.code === 'FORK_CONTEXT_TOO_LARGE');
    assert.doesNotThrow(() => assertForkHistoryFits(firstRequest, projectedPrompt, system));
    assert.equal(config.provider[providerId].models[modelId].limit.context, 1000000);
    assert.equal(config.compaction.threshold, 800000);
    checks.push({ check: 'raw archive exceeds 1M while complete model projection fits', rawEstimate, projectedEstimate });

    const first = await sidecar.run(firstRequest);
    assert.equal(first.status, 'done', first.error);
    assert.equal(first.text, 'HISTORY_REPLY_FIRST_14837');
    assert.deepEqual(failures, []);
    rewound.openCodeSessionId = first.openCodeSessionId;
    rewound.messages.push({ role: 'user', content: firstRequest.prompt }, { role: 'assistant', content: first.text });
    const second = await sidecar.run(requestFor('SECOND'));
    assert.equal(second.status, 'done', second.error);
    assert.equal(second.text, 'HISTORY_REPLY_SECOND_14837');
    assert.equal(second.openCodeSessionId, first.openCodeSessionId, 'follow-up reuses the same independent native session');
    checks.push({ check: 'fresh rewind and same-session follow-up preserve one seed', nativeSessionReused: true });

    // The failed first preflight still emits started and can leave a saved
    // native ID. Retrying that empty ID must restore its archive as well.
    const retrySession = createRewoundSession(source, rewindBoundary(source, boundary), {
      backupSessionId: 'sess_projection_retry_backup', modelSelection: source.modelSelection, now: 1800002000000
    });
    const oversize = requestFor('OVERSIZED', retrySession);
    oversize.openCodeSessionId = '';
    oversize.forkHistory = { ...oversize.forkHistory, messages: [{ role: 'user', content: '真实正文'.repeat(300000) }] };
    let emptyNativeId = '';
    const requestCount = requests.length;
    await assert.rejects(() => sidecar.run(oversize, event => {
      if (event.type === 'z.opencode.started') emptyNativeId = event.data.sessionID;
    }), error => error.code === 'FORK_CONTEXT_TOO_LARGE');
    assert.ok(emptyNativeId, 'failed preflight created an identifiable native session');
    assert.equal(requests.length, requestCount, 'failed preflight sends no prompt to the provider');
    const empty = unwrap(await sidecar.client.session.messages({ sessionID: emptyNativeId, directory: workspace }));
    assert.equal(empty.length, 0);
    retrySession.openCodeSessionId = emptyNativeId;
    const retried = await sidecar.run(requestFor('EMPTY_RETRY', retrySession));
    assert.equal(retried.status, 'done', retried.error);
    assert.equal(retried.text, 'HISTORY_REPLY_EMPTY_RETRY_14837');
    assert.equal(retried.openCodeSessionId, emptyNativeId, 'retry seeds the existing empty session rather than silently replacing it');
    checks.push({ check: 'preflight failure and retry of existing empty native session', noModelCallOnFailure: true });

    assert.deepEqual(failures, []);
    assert.deepEqual(requests.map(item => item.action), ['FIRST', 'SECOND', 'EMPTY_RETRY']);
    assert.deepEqual(providerCalls.map(item => item.action), ['FIRST', 'SECOND', 'EMPTY_RETRY'], 'no hidden compaction or auxiliary model request');
    assert.equal(JSON.stringify(source), sourceBefore, 'source archive including future history remains byte-for-byte unchanged');
    assert.equal(JSON.stringify(rewound.messages.slice(0, cutoff + 1)), retainedBefore, 'original retained UI archive is not rewritten');
    checks.push({ check: 'archives unchanged; no paid or compression model requests', mainRequests: requests.length });
    const report = { ok: true, checkedAt: new Date().toISOString(), opencodeVersion: '1.18.11', loopbackOnly: true, checks };
    fs.writeFileSync(path.join(outputRoot, 'history-model-context-native-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    const child = sidecar.server?.child;
    const stopped = child && child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    sidecar.close();
    await stopped;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(outputRoot));
    assert.ok(path.basename(directory).startsWith('history-model-context-native-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
