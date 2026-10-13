'use strict';

// Pinned native kernel, isolated database, and a loopback-only model. No
// desktop profile, saved user session, external API, or workspace rollback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { OpenCodeSidecar, buildOpenCodeConfig, stopChildProcess } = require('../lib/opencode-sidecar');
const { restoreForkNativePrefix } = require('../lib/native-prefix-restore');
const { readNativePrefix } = require('../lib/native-prefix-recovery-worker.cjs');
const { nativePrefixDigest } = require('../lib/native-prefix-recovery');

process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
process.env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
const appRoot = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-native-prefix-'));
const workspace = path.join(temporary, 'workspace');
const dataDir = path.join(temporary, 'data');
fs.mkdirSync(workspace);
const evidencePath = path.join(workspace, 'evidence.txt');
const currentPath = path.join(workspace, 'current.txt');
fs.writeFileSync(evidencePath, 'PRUNED_TOOL_EVIDENCE_72831 '.repeat(1000));
fs.writeFileSync(currentPath, 'CURRENT_FILE_CONTENT_72831');
const sourceId = 'sess_native_prefix_source';
const providerId = 'native-prefix-fixture';
const modelId = 'native-prefix-local-model';
const prompts = { one: 'NATIVE_PREFIX_SOURCE_ONE_72831', two: 'NATIVE_PREFIX_SOURCE_TWO_72831',
  future: 'NATIVE_PREFIX_DISCARDED_FUTURE_72831', resume: 'NATIVE_PREFIX_RESUME_72831',
  followup: 'NATIVE_PREFIX_FOLLOWUP_72831', copyFuture: 'NATIVE_PREFIX_SECOND_DISCARDED_72831',
  repeatResume: 'NATIVE_PREFIX_REPEAT_RESUME_72831' };
const requests = [];
const failures = [];
let sequence = 0;

function unwrap(result) {
  if (result?.error) throw new Error(JSON.stringify(result.error));
  return result?.data ?? result;
}

async function deadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function contentText(content) {
  return typeof content === 'string' ? content : (content || []).map(part => part.text || '').join('\n');
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(raw);
      assert.equal(body.model, modelId);
      const lastUser = (body.messages || []).findLast(message => message.role === 'user');
      const lastText = contentText(lastUser?.content);
      const action = Object.keys(prompts).find(key => lastText.includes(prompts[key]));
      if (body.tools?.length) assert.ok(action, 'unexpected model execution');
      requests.push({ action: action || 'auxiliary', body });
      assert.ok(requests.length <= 12, 'fixture must not loop or request hidden compaction');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const base = { id: `fixture_${++sequence}`, object: 'chat.completion.chunk', created: 1, model: modelId };
      const emit = (delta, finish = null) => response.write(`data: ${JSON.stringify({ ...base,
        choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? {
          usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } } : {}) })}\n\n`);
      if (action === 'one' && !body.messages.some(message => message.role === 'tool')) {
        assert.ok(body.tools.some(tool => tool.function?.name === 'read'));
        emit({ tool_calls: [{ index: 0, id: 'fixture_read_once', type: 'function', function: { name: 'read',
          arguments: JSON.stringify({ filePath: evidencePath }) } },
        { index: 1, id: 'fixture_read_error', type: 'function', function: { name: 'read',
          arguments: JSON.stringify({ filePath: path.join(workspace, 'missing-file.txt') }) } }] });
        emit({}, 'tool_calls');
      } else {
        if (['resume', 'followup', 'repeatResume'].includes(action)) {
          const wire = body.messages.map(message => contentText(message.content)).join('\n');
          for (const retained of ['one', 'two']) assert.equal(wire.split(prompts[retained]).length - 1, 1);
          assert.doesNotMatch(wire, /NATIVE_PREFIX_DISCARDED_FUTURE_72831|PREFIX_REPLY_FUTURE/);
          assert.doesNotMatch(wire, /<z-conversation-branch-history>|<z-desktop-context-checkpoint>|<z-session-history>/);
          assert.doesNotMatch(wire, /PRUNED_TOOL_EVIDENCE_72831/);
          assert.match(wire, /\[Old tool result content cleared\]/);
          if (action === 'followup') {
            assert.equal(wire.split(prompts.resume).length - 1, 1);
            assert.equal(wire.split('PREFIX_REPLY_RESUME').length - 1, 1);
          }
          if (action === 'repeatResume') {
            assert.doesNotMatch(wire, /NATIVE_PREFIX_SECOND_DISCARDED_72831|PREFIX_REPLY_COPYFUTURE/);
            for (const retained of ['resume', 'followup']) assert.equal(wire.split(prompts[retained]).length - 1, 1);
            for (const reply of ['PREFIX_REPLY_RESUME', 'PREFIX_REPLY_FOLLOWUP']) assert.equal(wire.split(reply).length - 1, 1);
          }
        }
        emit({ role: 'assistant', content: `PREFIX_REPLY_${String(action || 'title').toUpperCase()}` });
        emit({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      failures.push(error.message);
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});

function desktopTurn(prompt, native) {
  const timeline = [];
  for (const message of native) {
    if (message.info.role !== 'assistant') continue;
    for (const part of message.parts || []) {
      if (['text', 'reasoning'].includes(part.type) && String(part.text || '').trim()) {
        timeline.push({ type: part.type === 'text' ? 'text' : 'thinking', content: part.text,
          openCodeKey: `${part.type}:${part.id}` });
      }
      if (part.type === 'tool') {
        timeline.push({ type: 'tool_call', name: part.tool, callId: part.callID, args: part.state.input });
        timeline.push({ type: 'tool_result', name: part.tool, callId: part.callID,
          output: part.state.status === 'error' ? part.state.error : part.state.output,
          ok: part.state.status === 'completed' });
      }
    }
  }
  const finalText = timeline.findLast(item => item.type === 'text')?.content;
  assert.ok(finalText);
  return [{ role: 'user', content: prompt }, { role: 'assistant', content: finalText,
    agentRun: { status: 'done', timeline } }];
}

(async () => {
  let sidecar;
  let primaryError;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = buildOpenCodeConfig({ providerId, modelId, apiKey: 'local-fixture',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 1_000_000,
      compactionThreshold: 900_000, maxOutputTokens: 4096, capabilities: { reasoning: false },
      enableSubagents: false, accessMode: 'full', mcpServers: [] });
    config.plugin = [];
    config.mcp = {};
    config.skills = { paths: [] };
    sidecar = new OpenCodeSidecar({ appRoot, dataDir, log: { info() {}, warn() {}, error() {} } });
    const sourceRequest = { providerId, modelId, openCodeConfig: config, workspace, hasUserWorkspace: true,
      zSessionId: sourceId, branchId: sourceId, conversationRevision: 0, workMode: 'normal',
      accessMode: 'full', enableSubagents: false, observerEnabled: false,
      title: 'Isolated native prefix regression', utility: true };
    const one = await deadline(sidecar.run({ ...sourceRequest, runId: 'prefix-source-one', prompt: prompts.one }), 60_000, 'source one');
    assert.equal(one.status, 'done', one.error);
    const originalNativeId = one.openCodeSessionId;
    const firstHistory = unwrap(await sidecar.client.session.messages({ sessionID: originalNativeId, directory: workspace }));
    const two = await deadline(sidecar.run({ ...sourceRequest, runId: 'prefix-source-two', prompt: prompts.two,
      openCodeSessionId: originalNativeId }), 60_000, 'source two');
    assert.equal(two.status, 'done', two.error);
    const retained = unwrap(await sidecar.client.session.messages({ sessionID: originalNativeId, directory: workspace }));
    const desktop = [...desktopTurn(prompts.one, firstHistory), ...desktopTurn(prompts.two, retained.slice(firstHistory.length))];
    const future = await deadline(sidecar.run({ ...sourceRequest, runId: 'prefix-source-future', prompt: prompts.future,
      openCodeSessionId: originalNativeId }), 60_000, 'source future');
    assert.equal(future.status, 'done', future.error);
    assert.deepEqual(failures, []);

    const tool = retained.flatMap(message => message.parts || []).find(part => part.type === 'tool');
    assert.ok(tool && tool.state.status === 'completed');
    assert.match(tool.state.output, /PRUNED_TOOL_EVIDENCE_72831/);
    const errorTool = retained.flatMap(message => message.parts || []).find(part => part.type === 'tool' && part.state.status === 'error');
    assert.ok(errorTool, 'the fixture must contain a real failed tool alongside the pruned completed tool');
    // Mark only the isolated fixture tool as pruned. This reproduces native
    // pruning while retaining the full output in the desktop audit archive.
    const dbPath = path.join(dataDir, 'opencode-runtime', 'data', 'opencode', 'opencode.db');
    assert.ok(path.resolve(dbPath).startsWith(path.resolve(temporary) + path.sep));
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout=1000');
      const row = db.prepare('SELECT data FROM part WHERE id=? AND session_id=?').get(tool.id, originalNativeId);
      const data = JSON.parse(row.data);
      data.state.time = { ...data.state.time, compacted: 1 };
      assert.equal(db.prepare('UPDATE part SET data=? WHERE id=? AND session_id=?')
        .run(JSON.stringify(data), tool.id, originalNativeId).changes, 1);
      const errorRow = db.prepare('SELECT data FROM part WHERE id=? AND session_id=?').get(errorTool.id, originalNativeId);
      const errorData = JSON.parse(errorRow.data);
      // Legacy runtimes could persist title on a failed tool. The current
      // native ToolStateError schema removes that obsolete presentation field.
      errorData.state.title = 'Legacy failed read title';
      assert.equal(db.prepare('UPDATE part SET data=? WHERE id=? AND session_id=?')
        .run(JSON.stringify(errorData), errorTool.id, originalNativeId).changes, 1);
    } finally { db.close(); }

    const originalMessages = unwrap(await sidecar.client.session.messages({ sessionID: originalNativeId, directory: workspace }));
    assert.equal(originalMessages.flatMap(message => message.parts || []).find(part => part.id === errorTool.id).state.title, undefined);
    const originalSession = unwrap(await sidecar.client.session.get({ sessionID: originalNativeId, directory: workspace }));
    const originalFiles = [fs.readFileSync(evidencePath), fs.readFileSync(currentPath)];
    assert.equal(originalMessages.some(message => message.info.summary === true || message.parts.some(part => part.type === 'compaction')), false);
    const request = { ...sourceRequest, utility: false, zSessionId: 'sess_native_prefix_rewound',
      branchId: 'sess_native_prefix_rewound', conversationRevision: 1, runId: 'prefix-resume', prompt: prompts.resume,
      forkHistory: { kind: 'rewind', sourceSessionId: sourceId, messageIndex: desktop.length - 1, messages: desktop } };
    const archiveBefore = JSON.stringify(desktop);
    const recovered = readNativePrefix({ dbPath, directory: workspace, messages: desktop, request });
    assert.ok(recovered.prefix, JSON.stringify(recovered));
    const candidate = recovered.prefix;
    assert.equal(candidate.sourceMessageCount, retained.length);
    assert.equal(candidate.desktopTail.length, 0);
    const events = [];
    const resumed = await deadline(sidecar.run(request, event => events.push(event)), 60_000, 'restored run');
    assert.equal(resumed.status, 'done', resumed.error);
    assert.notEqual(resumed.openCodeSessionId, originalNativeId);
    const restoredEvents = events.filter(event => event.type === 'z.context.native-prefix.restored');
    assert.equal(restoredEvents.length, 1, 'the production restore path must actually run');
    const copy = unwrap(await sidecar.client.session.messages({ sessionID: resumed.openCodeSessionId, directory: workspace }));
    assert.equal(nativePrefixDigest(copy.slice(0, retained.length)), candidate.sourceHash);
    const copiedTool = copy.flatMap(message => message.parts || []).find(part => part.type === 'tool');
    assert.equal(copiedTool.state.time.compacted, 1);
    assert.equal(copiedTool.state.output, tool.state.output, 'the audit output remains intact behind the native pruning marker');
    const followupEvents = [];
    const followup = await deadline(sidecar.run({ ...request, runId: 'prefix-followup', prompt: prompts.followup,
      openCodeSessionId: resumed.openCodeSessionId }, event => followupEvents.push(event)), 60_000, 'restored followup');
    assert.equal(followup.status, 'done', followup.error);
    assert.equal(followup.openCodeSessionId, resumed.openCodeSessionId);
    assert.equal(followupEvents.filter(event => event.type === 'z.context.native-prefix.restored').length, 0);

    // The UI keeps its old part IDs after a native fork. Rewind again after
    // two new turns, without rewriting those original desktop identities.
    const afterFollowup = unwrap(await sidecar.client.session.messages({ sessionID: resumed.openCodeSessionId, directory: workspace }));
    const repeatedDesktop = [...desktop, ...desktopTurn(prompts.resume, copy.slice(retained.length)),
      ...desktopTurn(prompts.followup, afterFollowup.slice(copy.length))];
    const repeatedArchiveBefore = JSON.stringify(repeatedDesktop);
    assert.notEqual(repeatedDesktop[1].agentRun.timeline.find(item => item.type === 'text').openCodeKey,
      desktopTurn(prompts.one, copy.slice(0, firstHistory.length))[1].agentRun.timeline.find(item => item.type === 'text').openCodeKey,
      'the fixture must retain original UI part IDs rather than silently updating them to the first fork');
    const nextFuture = await deadline(sidecar.run({ ...request, runId: 'prefix-copy-future', prompt: prompts.copyFuture,
      openCodeSessionId: resumed.openCodeSessionId }), 60_000, 'new future turn');
    assert.equal(nextFuture.status, 'done', nextFuture.error);
    const copySourceMessages = unwrap(await sidecar.client.session.messages({ sessionID: resumed.openCodeSessionId, directory: workspace }));
    const copySourceSession = unwrap(await sidecar.client.session.get({ sessionID: resumed.openCodeSessionId, directory: workspace }));
    const repeatedRequest = { ...request, runId: 'prefix-repeat-resume', openCodeSessionId: '',
      conversationRevision: 2, prompt: prompts.repeatResume,
      forkHistory: { kind: 'rewind', sourceSessionId: request.zSessionId,
        messageIndex: repeatedDesktop.length - 1, messages: repeatedDesktop } };
    const repeatedEvents = [];
    const repeated = await deadline(sidecar.run(repeatedRequest, event => repeatedEvents.push(event)), 60_000, 'second rewind');
    assert.equal(repeated.status, 'done', repeated.error);
    assert.notEqual(repeated.openCodeSessionId, resumed.openCodeSessionId);
    assert.equal(repeatedEvents.filter(event => event.type === 'z.context.native-prefix.restored').length, 1,
      'repeated rewinds must recover the proven native prefix despite old UI part IDs');
    const repeatedHistory = unwrap(await sidecar.client.session.messages({ sessionID: repeated.openCodeSessionId, directory: workspace }));
    assert.equal(nativePrefixDigest(repeatedHistory.slice(0, afterFollowup.length)), nativePrefixDigest(afterFollowup));
    assert.equal(JSON.stringify(repeatedDesktop), repeatedArchiveBefore);
    assert.deepEqual(unwrap(await sidecar.client.session.messages({ sessionID: resumed.openCodeSessionId, directory: workspace })), copySourceMessages);
    assert.deepEqual(unwrap(await sidecar.client.session.get({ sessionID: resumed.openCodeSessionId, directory: workspace })), copySourceSession);

    const wholeDesktop = [...desktop, ...desktopTurn(prompts.future, originalMessages.slice(retained.length))];
    const endRequest = { ...request, forkHistory: { ...request.forkHistory, messages: wholeDesktop,
      messageIndex: wholeDesktop.length - 1 } };
    const atEnd = readNativePrefix({ dbPath, directory: workspace, messages: wholeDesktop, request: endRequest });
    assert.ok(atEnd.prefix, JSON.stringify(atEnd));
    assert.equal(atEnd.prefix.messageID, atEnd.prefix.boundaryMessageId + '0');
    const endCopy = await deadline(restoreForkNativePrefix({ client: sidecar.client, appRoot, dataDir,
      request: endRequest, directory: workspace, recover: async () => atEnd.prefix }), 10_000, 'terminal boundary fork');
    assert.ok(endCopy, 'the actual kernel must accept the exclusive end-of-history sentinel');
    assert.equal(endCopy.messages.length, originalMessages.length);
    assert.equal(nativePrefixDigest(endCopy.messages), atEnd.prefix.sourceHash);
    await sidecar.client.session.delete({ sessionID: endCopy.session.id, directory: workspace });

    const cleanupChecks = [];
    for (const mode of ['digest-mismatch', 'cancel-after-fork']) {
      const controller = new AbortController();
      const deleted = [];
      let owned = '';
      const client = { session: {
        fork: async (...args) => {
          const result = await sidecar.client.session.fork(...args);
          owned = unwrap(result).id;
          if (mode === 'cancel-after-fork') controller.abort();
          return result;
        },
        messages: async (...args) => {
          const result = await sidecar.client.session.messages(...args);
          if (mode !== 'digest-mismatch') return result;
          const changed = structuredClone(unwrap(result));
          changed[0].parts[0].text += 'INVALID_COPY';
          return { data: changed };
        },
        update: (...args) => sidecar.client.session.update(...args),
        delete: async (...args) => { deleted.push(args[0].sessionID); return sidecar.client.session.delete(...args); }
      } };
      const restore = deadline(restoreForkNativePrefix({ client, appRoot, dataDir, request, directory: workspace,
        signal: controller.signal, recover: async () => candidate }), 10_000, mode);
      if (mode === 'digest-mismatch') {
        await assert.rejects(restore, error => error.code === 'CONTEXT_NATIVE_RESTORE_FAILED'
          && error.contextRestoreStage === 'readback');
      } else assert.equal(await restore, null);
      assert.ok(owned && owned !== originalNativeId);
      assert.deepEqual(deleted, [owned]);
      assert.ok((await sidecar.client.session.get({ sessionID: owned, directory: workspace })).error,
        'failed or cancelled owned copy must be removed from the real kernel');
      cleanupChecks.push(mode);
    }

    assert.deepEqual(failures, []);
    assert.equal(JSON.stringify(desktop), archiveBefore);
    assert.deepEqual(unwrap(await sidecar.client.session.messages({ sessionID: originalNativeId, directory: workspace })), originalMessages);
    assert.deepEqual(unwrap(await sidecar.client.session.get({ sessionID: originalNativeId, directory: workspace })), originalSession);
    assert.deepEqual(fs.readFileSync(evidencePath), originalFiles[0]);
    assert.deepEqual(fs.readFileSync(currentPath), originalFiles[1]);
    assert.deepEqual(requests.map(item => item.action), ['one', 'one', 'two', 'future', 'resume', 'followup', 'copyFuture', 'repeatResume'],
      'native forks and their cleanup must not issue model or hidden compaction requests');
    console.log(JSON.stringify({ ok: true, sourceHadSummary: false, retainedNativeMessages: retained.length,
      restoredDesktopMessages: desktop.length, prunedOutputCharacters: tool.state.output.length,
      nativePrefixDigestVerified: true, sourceUnchanged: true, filesUnchanged: true,
      independentNativeSession: true, followupReseeded: false, exclusiveTerminalBoundary: true,
      repeatedRewindPreservedOldDesktopPartIds: true, repeatedRewindExcludedFuture: true,
      legacyErrorTitleNormalized: true,
      modelRequests: requests.length, cleanupChecks }));
  } catch (error) { primaryError = error; }
  finally {
    const errors = [];
    try {
      const child = sidecar?.server?.child || sidecar?.startingChild;
      const stopped = child && child.exitCode === null ? once(child, 'exit') : Promise.resolve();
      sidecar?.close();
      if (child && child.exitCode === null) assert.equal(await deadline(stopChildProcess(child), 12_000, 'native cleanup'), true);
      await deadline(stopped, 12_000, 'native exit');
    } catch (error) { errors.push(error); }
    try {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    } catch (error) { errors.push(error); }
    try {
      assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('z-native-prefix-'));
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (error) { errors.push(error); }
    if (errors.length) {
      if (!primaryError) primaryError = errors[0];
      else console.error(`Cleanup failed: ${errors.map(error => error.message).join('; ')}`);
    }
  }
  if (primaryError) throw primaryError;
})().catch(error => { console.error(error); process.exitCode = 1; });
