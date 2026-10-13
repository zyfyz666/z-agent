'use strict';
// Actual pinned native kernel + isolated DB + loopback provider. Inspect the
// serialized model input, not just the desktop token counter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { OpenCodeSidecar, buildOpenCodeConfig, stopChildProcess } = require('../lib/opencode-sidecar');
const { ContextStore } = require('../lib/context-store');
const { restoreContextSnapshot, resolveContextBoundary } = require('../lib/context-runtime');
const { contextContentDigest, clipNativeBoundary } = require('../lib/context-state');
process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
process.env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
const appRoot = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-context-v2-'));
const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
fs.mkdirSync(workspace);
const markerFile = path.join(workspace, 'evidence.txt');
fs.writeFileSync(markerFile, 'PRUNED_EVIDENCE_3817 '.repeat(1000));
const receiptFile = path.join(workspace, 'receipt.txt');
fs.writeFileSync(receiptFile, 'RECEIPT_ATTACHMENT_3817');
const requests = [], failures = [], receipts = [];
const providerId = 'context-v2-fixture', modelId = 'context-v2-local';
const text = content => typeof content === 'string' ? content : (content || []).map(p => p.text || '').join('\n');
let sidecar, n = 0;
async function deadline(promise, label, ms = 60000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout`)), ms); })]); }
  finally { clearTimeout(timer); }
}
const unwrap = v => { if (v?.error) throw new Error(JSON.stringify(v.error)); return v?.data ?? v; };
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      const body = JSON.parse(raw), last = text(body.messages.findLast(m => m.role === 'user')?.content);
      const action = /V2_(ONE|TWO|FUTURE|RESUME|COMPACT|GUIDANCE)\b/.exec(last)?.[1] || 'AUX';
      const wire = body.messages.map(m => text(m.content)).join('\n');
      requests.push({ action, body, wire }); assert(requests.length < 30, 'bounded requests');
      if (['RESUME', 'COMPACT', 'GUIDANCE'].includes(action)) {
        assert.doesNotMatch(wire, /PRUNED_EVIDENCE_3817|V2_FUTURE|REPLY_FUTURE|z-conversation-branch-history|z-session-history|z-desktop-context-checkpoint/);
        for (const marker of ['V2_TWO', 'REPLY_TWO']) assert.equal(wire.split(marker).length - 1, 1, marker);
        if (action === 'COMPACT') {
          assert.equal(wire.split('COMPACTION_SUMMARY_3817').length - 1, 1);
          assert.doesNotMatch(wire, /V2_ONE|REPLY_ONE/);
        } else if (action === 'RESUME') {
          assert.equal(wire.split('V2_ONE').length - 1, 1);
          assert.match(wire, /Old tool result content cleared/);
        } else {
          assert.match(wire, /VISIBLE_PART_3817/);
          assert.doesNotMatch(wire, /FUTURE_PART_3817|FUTURE_RESULT_3817/);
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: `v2_${++n}`, object: 'chat.completion.chunk', model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } } : {}) })}\n\n`);
      if (action === 'ONE' && !body.messages.some(m => m.role === 'tool')) {
        emit({ tool_calls: [{ index: 0, id: 'read_evidence', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: markerFile }) } }] });
        emit({}, 'tool_calls');
      } else { emit({ role: 'assistant', content: `REPLY_${action}` }); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) { console.error(JSON.parse(raw).messages.map(m => ({ role: m.role, content: text(m.content).slice(0, 1500) }))); failures.push(error.message); if (!res.headersSent) res.writeHead(400); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
});
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = buildOpenCodeConfig({ providerId, modelId, apiKey: 'local-only', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      contextWindow: 1_000_000, compactionThreshold: 900_000, maxOutputTokens: 4096, capabilities: { reasoning: false },
      enableSubagents: false, accessMode: 'full', mcpServers: [] });
    config.plugin = []; config.mcp = {}; config.skills = { paths: [] };
    sidecar = new OpenCodeSidecar({ appRoot, dataDir, log: { info() {}, warn() {}, error() {} } });
    await sidecar.start(config);
    const getUserMessage = sidecar.client.session.message.bind(sidecar.client.session);
    const receiptReads = new Map();
    const receiptPartCounts = new Map();
    sidecar.client.session.message = async (query, options) => {
      const count = (receiptReads.get(query.messageID) || 0) + 1;
      receiptReads.set(query.messageID, count);
      // First prompt: 404, then a partially visible message. Second prompt:
      // GET never sees it, so settled session history must repair the receipt.
      if (receiptReads.size === 2 || count <= 2) return { error: { name: 'NotFoundError', data: { message: 'Message not found' } }, response: { status: 404 } };
      const result = await getUserMessage(query, options);
      if (result.data) receiptPartCounts.set(query.messageID, result.data.parts.length);
      return count === 3 && result.data ? { ...result, data: { ...result.data, parts: [] } } : result;
    };
    const request = { providerId, modelId, workspace, openCodeConfig: config, hasUserWorkspace: true,
      zSessionId: 'sess_context_source', branchId: 'sess_context_source', workMode: 'normal', accessMode: 'full',
      enableSubagents: false, observerEnabled: false, utility: true, contextV2: true, title: 'Context fixture' };
    const run = async (prompt, options = {}) => {
      const result = await deadline(sidecar.run({ ...request, runId: `fixture-${++n}`, prompt, contextBeforeKey: prompt, ...options }, e => receipts.push(e)), prompt);
      assert.equal(result.status, 'done', result.error); assert.deepEqual(failures, []); return result;
    };
    const one = await run('V2_ONE', { attachments: [{ path: receiptFile, name: 'receipt.txt', mimeType: 'text/plain' }] });
    const sid = one.openCodeSessionId;
    const get = async id => unwrap(await sidecar.client.session.messages({ sessionID: id, directory: workspace }));
    const first = await get(sid);
    assert(receipts.some(e => e.type === 'z.context.state.snapshot' && e.data.phase === 'after-user'));
    const firstReceipt = receipts.find(e => e.type === 'z.context.state.snapshot' && e.data.phase === 'after-user');
    assert.match(JSON.stringify(new ContextStore(dataDir).read(firstReceipt.data.ref).messages), /RECEIPT_ATTACHMENT_3817/);
    await run('V2_TWO', { openCodeSessionId: sid });
    const retained = await get(sid);
    await run('V2_FUTURE', { openCodeSessionId: sid });
    const original = await get(sid), store = new ContextStore(dataDir);
    const copy = structuredClone(retained);
    const tool = copy.flatMap(m => m.parts).find(p => p.type === 'tool');
    assert(tool); tool.state.time.compacted = 1;
    const ref = store.capture(copy, { directory: workspace, zSessionId: request.zSessionId });
    // Same rewind 5 times: no automatic compaction, no seed, stable wire size.
    const sizes = [];
    for (let i = 0; i < 5; i++) {
      const result = await run('V2_RESUME', { contextSource: ref });
      assert.notEqual(result.openCodeSessionId, sid);
      const input = requests.at(-1).wire; sizes.push(input.length);
      assert.equal(input.split('V2_RESUME').length - 1, 1);
    }
    assert.equal(new Set(sizes).size, 1, 'identical rewinds must have identical payload size');
    // Native summary/tail fixture built from real schema-valid user/assistant
    // messages. A summary's old billing must not trigger another compaction.
    const compact = structuredClone(retained);
    const marker = structuredClone(retained.find(m => m.info.role === 'user'));
    marker.info.time.created = retained.at(-1).info.time.completed + 1;
    marker.info.id = 'msg_ffffffff0001'; marker.parts = [{ id: 'prt_ffffffff0001', sessionID: sid, messageID: marker.info.id,
      type: 'compaction', auto: true, tail_start_id: retained[first.length].info.id }];
    const summary = structuredClone(retained.at(-1));
    summary.info.id = 'msg_ffffffff0002'; summary.info.parentID = marker.info.id; summary.info.summary = true;
    summary.info.time = { created: marker.info.time.created + 1, completed: marker.info.time.created + 2 };
    summary.info.tokens.input = 950000;
    summary.parts = [{ id: 'prt_ffffffff0002', messageID: summary.info.id, sessionID: sid, type: 'text', text: 'COMPACTION_SUMMARY_3817' }];
    compact.push(marker, summary);
    const compactRef = store.capture(compact, { directory: workspace });
    for (let i = 0; i < 2; i++) await run('V2_COMPACT', { contextSource: compactRef });
    // Exact guidance cut: completed source has more text and a later tool
    // result, but the branch may only retain what existed at the click.
    const guided = structuredClone(copy);
    const last = guided.at(-1), at = Date.now();
    last.info.time.created = at - 50; last.info.time.completed = at + 50;
    last.parts.push({ id: 'prt_visible', type: 'text', text: 'VISIBLE_PART_3817 FUTURE_PART_3817' });
    last.parts.push({ id: 'prt_tool', type: 'tool', tool: 'read', callID: 'late_read', state: {
      status: 'completed', input: { filePath: markerFile }, output: 'FUTURE_RESULT_3817', title: 'read', metadata: {}, time: { start: at - 20, end: at + 50 } } });
    const boundary = clipNativeBoundary(guided, { startedAt: at - 100, historyBoundaryAt: at, timeline: [
      ...last.parts.filter(p => p.type === 'text').map(p => ({ type: 'text', openCodeKey: `text:${p.id}`, content: p.id === 'prt_visible' ? 'VISIBLE_PART_3817' : p.text })),
      { type: 'tool_call', callId: 'late_read', args: { filePath: markerFile } }
    ] }, new Set(guided.slice(0, -1).map(m => m.info.id)));
    const guidedRef = store.capture(boundary, { directory: workspace });
    await run('V2_GUIDANCE', { contextSource: guidedRef });
    // Native part provenance migration works with real rows without replaying
    // a UI archive (even if the archive carries arbitrarily huge tool logs).
    const finalText = retained.at(-1).parts.find(p => p.type === 'text');
    const archive = [{ role: 'assistant', content: finalText.text, agentRun: { timeline: [
      { type: 'tool_result', output: 'UI_ARCHIVE_ONLY'.repeat(10000) },
      { type: 'text', content: finalText.text, openCodeKey: `text:${finalText.id}` } ] } }];
    const migrated = await resolveContextBoundary({ appRoot, dataDir, directory: workspace,
      source: { id: request.zSessionId, messages: archive }, prefix: archive });
    assert.doesNotMatch(JSON.stringify(store.read(migrated)), /UI_ARCHIVE_ONLY|V2_FUTURE/);
    assert.deepEqual(await get(sid), original, 'source native session unchanged');
    assert.equal(fs.readFileSync(markerFile, 'utf8'), 'PRUNED_EVIDENCE_3817 '.repeat(1000));
    assert.equal(receipts.some(e => e.type === 'z.context.checkpoint' || e.type === 'z.context.desktop-checkpoint'), false);
    assert.equal(receipts.some(e => e.type === 'z.context.state.failed'), false, 'dispatch/persistence races must not produce false failures');
    assert.equal(receipts.filter(e => e.type === 'z.context.state.snapshot' && e.data.phase === 'after-user').length, 11,
      'each accepted user receives one complete boundary, including the settled-history repair');
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ ok: true, repeatedRewinds: 5, identicalWireSizes: sizes,
      completedCompactionRewinds: 2, guidanceExactBoundary: true, oldToolsNotReplayed: true,
      legacyNativeMigration: true, sourceUnchanged: true, filesUnchanged: true, modelRequests: requests.length,
      delayedMessageAndParts: true, settledReceiptRecovery: true, promptNotReplayed: true }));
  } finally {
    const child = sidecar?.server?.child || sidecar?.startingChild;
    const stopped = child?.exitCode === null ? once(child, 'exit') : Promise.resolve();
    sidecar?.close();
    if (child?.exitCode === null) await deadline(stopChildProcess(child), 'stop native', 15000);
    await deadline(stopped, 'native exit', 15000);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('z-context-v2-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
