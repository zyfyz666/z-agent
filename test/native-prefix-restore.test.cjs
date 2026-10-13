'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreForkNativePrefix } = require('../lib/native-prefix-restore');
const { nativePrefixDigest } = require('../lib/native-prefix-recovery');

function fixture() {
  const request = { zSessionId: 'sess_target', branchId: 'sess_target', conversationRevision: 2,
    workMode: 'normal', prompt: 'Continue at the retained boundary', hasUserWorkspace: true,
    forkHistory: { messages: [{ role: 'user', content: 'retained' }] } };
  const source = [
    { info: { id: 'm1', sessionID: 'source', role: 'user' },
      parts: [{ id: 'p1', messageID: 'm1', sessionID: 'source', type: 'text', text: 'retained' }] },
    { info: { id: 'm2', sessionID: 'source', role: 'assistant', parentID: 'm1' },
      parts: [{ id: 'p2', messageID: 'm2', sessionID: 'source', type: 'tool', callID: 'call_1', tool: 'read',
        state: { status: 'completed', input: { path: 'kept.txt' }, output: 'archived output', time: { compacted: 20 } } }] }
  ];
  const copied = source.map((m, i) => ({ info: { ...m.info, id: `n${i}`, sessionID: 'new',
    ...(m.info.parentID ? { parentID: 'n0' } : {}) },
    parts: m.parts.map(p => ({ ...p, id: `q${i}`, messageID: `n${i}`, sessionID: 'new' })) }));
  const candidate = { sourceSessionId: 'source', messageID: 'm3', boundaryMessageId: 'm2',
    sourceMessageCount: source.length, sourceHash: nativePrefixDigest(source),
    desktopPrefix: { messageCount: 1, digest: 'fixture' }, desktopTail: [] };
  const calls = [];
  const client = { session: {
    fork: async value => { calls.push(['fork', value]); return { data: { id: 'new' } }; },
    messages: async value => { calls.push(['messages', value]); return { data: copied }; },
    update: async value => { calls.push(['update', value]); return { data: { ...value, id: value.sessionID } }; },
    delete: async value => { calls.push(['delete', value]); return { data: true }; }
  } };
  return { request, source, copied, candidate, calls, client, options: { client, request,
    directory: 'workspace', permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    recover: async () => candidate } };
}

test('verified fork keeps native pruning and replaces task identity/permissions', async () => {
  const f = fixture();
  const sourceBefore = JSON.stringify(f.source);
  const result = await restoreForkNativePrefix(f.options);
  assert.equal(result.session.id, 'new');
  assert.equal(result.messages[1].parts[0].state.time.compacted, 20);
  assert.equal(JSON.stringify(f.source), sourceBefore);
  assert.deepEqual(f.calls.map(c => c[0]), ['fork', 'messages', 'update']);
  assert.equal(f.calls[0][1].messageID, 'm3');
  const update = f.calls[2][1];
  assert.equal(update.metadata.zSessionID, 'sess_target');
  assert.equal(update.metadata.zConversationRevision, 2);
  assert.deepEqual(update.permission, f.options.permission);
});

for (const corruption of ['future-message', 'cleared-pruning', 'changed-output']) {
  test(`rejects ${corruption} during readback and deletes only the unbound copy`, async () => {
    const f = fixture();
    if (corruption === 'future-message') f.copied.push({ info: { id: 'future', role: 'user' }, parts: [] });
    else {
      f.copied[1].parts[0] = structuredClone(f.copied[1].parts[0]);
      if (corruption === 'cleared-pruning') delete f.copied[1].parts[0].state.time.compacted;
      else f.copied[1].parts[0].state.output = 'different';
    }
    await assert.rejects(restoreForkNativePrefix(f.options), {
      code: 'CONTEXT_NATIVE_RESTORE_FAILED', contextRestoreStage: 'readback'
    });
    assert.deepEqual(f.calls.map(c => c[0]), ['fork', 'messages', 'delete']);
    assert.equal(f.calls.at(-1)[1].sessionID, 'new');
  });
}

test('cancellation after copying never resumes or deletes the source', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.client.session.messages = async () => { controller.abort(); return { data: f.copied }; };
  assert.equal(await restoreForkNativePrefix({ ...f.options, signal: controller.signal }), null);
  assert.equal(f.calls.at(-1)[0], 'delete');
  assert.equal(f.calls.at(-1)[1].sessionID, 'new');
});

test('unconfirmed metadata update still cleans up the owned copy', async () => {
  const f = fixture();
  f.client.session.update = async () => ({ data: null });
  await assert.rejects(restoreForkNativePrefix(f.options), {
    code: 'CONTEXT_NATIVE_RESTORE_FAILED', contextRestoreStage: 'metadata'
  });
  assert.equal(f.calls.at(-1)[0], 'delete');
  assert.equal(f.calls.at(-1)[1].sessionID, 'new');
});

test('an unproven partial tail uses the existing fallback without a native fork', async () => {
  const f = fixture();
  f.candidate.desktopTail = [{ role: 'user', content: 'guidance inside an unfinished response' }];
  assert.equal(await restoreForkNativePrefix(f.options), null);
  assert.deepEqual(f.calls, []);
});

test('a failed notification does not leak an unbound fork', async () => {
  const f = fixture();
  await assert.rejects(restoreForkNativePrefix({ ...f.options,
    onEvent: () => { throw new Error('Consumer closed'); } }), {
    code: 'CONTEXT_NATIVE_RESTORE_FAILED', contextRestoreStage: 'notification'
  });
  assert.equal(f.calls.at(-1)[0], 'delete');
  assert.equal(f.calls.at(-1)[1].sessionID, 'new');
});
