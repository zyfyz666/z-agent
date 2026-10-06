'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskMemoryApi } = require('../lib/task-memory-api');
const { LongTermMemoryStore } = require('../lib/long-term-memory');
const { taskMemoryIdentity } = require('../lib/task-memory-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-task-memory-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const workspace = path.join(root, 'workspace-a');
  const otherWorkspace = path.join(root, 'workspace-c');
  fs.mkdirSync(workspace); fs.mkdirSync(otherWorkspace);
  const sessions = new Map([
    ['sess_task_a', { id: 'sess_task_a', title: 'Source Orchard', workspace, conversationRevision: 3 }],
    ['sess_task_b', { id: 'sess_task_b', title: 'Source Birch', workspace, conversationRevision: 4 }],
    ['sess_task_c', { id: 'sess_task_c', title: 'Source Cedar', workspace: otherWorkspace, conversationRevision: 0 }]
  ]);
  const dbPath = path.join(root, 'data', 'memory.sqlite');
  const store = new LongTermMemoryStore({ dbPath });
  const reads = [], locks = [], usage = new Map();
  let lockHook;
  const api = createTaskMemoryApi({ store,
    readSession: async (id, options) => { reads.push({ id, options }); return sessions.get(id) || null; },
    withSessionWrite: async (id, operation) => { locks.push(id); if (lockHook) await lockHook(id); return operation(); },
    readUsage: identity => usage.get(identity.sessionId) || { items: [] }
  });
  const identity = id => taskMemoryIdentity(sessions.get(id));
  const add = (sessionId, content, scope = 'task') => {
    const result = store.upsert({ content, scope, type: scope === 'task' ? 'work_state' : 'project',
      key: scope === 'task' ? 'task.progress' : content.toLowerCase().replace(/\s/g, '-'), evidence: 'Synthetic verified fixture' },
    { ...identity(sessionId), runId: `run_${sessionId}`, sourceKind: 'fixture' });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.memory;
  };
  const list = (sessionId, extra = {}) => api.list({ sessionId, ...extra });
  const update = (sessionId, item, patch, extra = {}) => api.update({ sessionId, id: item.id,
    conversationRevision: identity(sessionId).conversationRevision, ...patch, ...extra });
  const remove = (sessionId, item, extra = {}) => api.remove({ sessionId, id: item.id,
    conversationRevision: identity(sessionId).conversationRevision, ...extra });
  return { root, dbPath, store, sessions, reads, locks, usage, api, identity, add, list, update, remove,
    setLockHook: hook => { lockHook = hook; } };
}

test('invalid task IDs and missing tasks never open the memory database or enter a write lock', async t => {
  const f = fixture(t);
  for (const sessionId of ['', null, 123, {}, '../sess_task_a', 'sess_a', ' sess_task_a ', 'C:\\private\\session.json']) {
    assert.equal((await f.list(sessionId)).ok, false);
    assert.equal((await f.api.update({ sessionId, id: 'x', content: 'changed' })).ok, false);
    assert.equal((await f.api.remove({ sessionId, id: 'x' })).ok, false);
  }
  assert.equal((await f.list('sess_missing')).ok, false);
  assert.deepEqual(f.locks, []);
  assert.equal(f.reads.length, 1);
  assert.equal(fs.existsSync(f.dbPath), false);
});

test('list and edits enforce task, project and conversation revision boundaries with real SQLite records', async t => {
  const f = fixture(t);
  const a = f.add('sess_task_a', 'Task A progress');
  const b = f.add('sess_task_b', 'Task B progress');
  const shared = f.add('sess_task_a', 'Orchard shared knowledge', 'workspace');
  const foreign = f.add('sess_task_c', 'Cedar private knowledge', 'workspace');
  const global = f.add('sess_task_c', 'Global reusable knowledge', 'global');
  const machine = f.add('sess_task_c', 'Device reusable knowledge', 'machine');
  const result = await f.list('sess_task_a');
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'sess_task_a');
  assert.equal(result.conversationRevision, 3);
  assert.deepEqual(result.items.map(item => item.id).sort(), [a.id, shared.id, global.id, machine.id].sort());
  assert.equal(result.items.find(item => item.id === a.id).sourceTitle, 'Source Orchard');
  assert.equal((await f.update('sess_task_a', b, { content: 'Wrong task' })).ok, false);
  assert.equal((await f.update('sess_task_a', foreign, { content: 'Wrong project' })).ok, false);
  assert.equal((await f.remove('sess_task_a', b)).ok, false);
  assert.equal((await f.remove('sess_task_a', foreign)).ok, false);
  assert.equal(f.store.get(b.id, f.identity('sess_task_b')).content, b.content);
  assert.equal(f.store.get(foreign.id, f.identity('sess_task_c')).content, foreign.content);
  assert.equal((await f.update('sess_task_a', shared, { content: 'Updated project knowledge' })).ok, true);
  assert.equal(f.store.get(shared.id, f.identity('sess_task_b')).content, 'Updated project knowledge');
  assert.ok(f.reads.some(read => read.options?.sessionLocked === true));
});

test('status changes, content edits and deletions persist and affect subsequent recall', async t => {
  const f = fixture(t);
  const memory = f.add('sess_task_a', 'Cache protocol uses stable cache keys', 'workspace');
  assert.equal((await f.update('sess_task_a', memory, { content: 'Cache protocol uses verified cache keys' })).ok, true);
  assert.equal((await f.update('sess_task_a', memory, { status: 'disabled' })).ok, true);
  const reopened = new LongTermMemoryStore({ dbPath: f.dbPath });
  assert.equal(reopened.get(memory.id, f.identity('sess_task_a')).status, 'disabled');
  assert.equal(reopened.query({ ...f.identity('sess_task_a'), query: 'cache protocol' }).memories.some(item => item.id === memory.id), false);
  assert.equal((await f.update('sess_task_a', memory, { status: 'active' })).ok, true);
  assert.equal(reopened.get(memory.id, f.identity('sess_task_a')).status, 'active');
  assert.equal(reopened.query({ ...f.identity('sess_task_a'), query: 'cache protocol' }).memories.some(item => item.id === memory.id), true);
  assert.equal((await f.remove('sess_task_a', memory)).ok, true);
  assert.equal(reopened.get(memory.id, f.identity('sess_task_a')).status, 'deleted');
  assert.equal((await f.list('sess_task_a')).items.some(item => item.id === memory.id), false);
  assert.equal(reopened.query({ ...f.identity('sess_task_a'), query: 'cache protocol' }).memories.some(item => item.id === memory.id), false);
});

test('stale revisions are checked again inside the session lock before edit or deletion', async t => {
  const f = fixture(t);
  const memory = f.add('sess_task_a', 'Original task progress');
  const stale = await f.update('sess_task_a', memory, { content: 'Stale edit' }, { conversationRevision: 2 });
  assert.equal(stale.code, 'SESSION_REVISION_CHANGED');
  assert.equal((await f.remove('sess_task_a', memory, { conversationRevision: 2 })).code, 'SESSION_REVISION_CHANGED');
  f.setLockHook(id => { f.sessions.get(id).conversationRevision++; });
  const raced = await f.update('sess_task_a', memory, { content: 'Race edit' });
  assert.equal(raced.code, 'SESSION_REVISION_CHANGED');
  assert.equal(f.store.get(memory.id, { ...f.identity('sess_task_a'), conversationRevision: 3 }).content, 'Original task progress');
});

test('invalid edits do not change the stored record', async t => {
  const f = fixture(t);
  const memory = f.add('sess_task_a', 'Stable knowledge', 'workspace');
  for (const patch of [{ content: '' }, { content: '   ' }, { content: 'a'.repeat(801) }, { content: {} }, { status: 'deleted' }, { status: 'invalid' }, {}]) {
    assert.equal((await f.update('sess_task_a', memory, patch)).ok, false);
  }
  assert.equal(f.store.get(memory.id, f.identity('sess_task_a')).content, memory.content);
  assert.equal(f.store.get(memory.id, f.identity('sess_task_a')).status, 'active');
});

test('memory search includes the recorded source title and ID', async t => {
  const f = fixture(t);
  const a = f.add('sess_task_a', 'Queue completion invariant', 'workspace');
  f.add('sess_task_b', 'Retry completion invariant', 'workspace');
  assert.deepEqual((await f.list('sess_task_a', { query: 'Source Orchard' })).items.map(item => item.id), [a.id]);
  assert.deepEqual((await f.list('sess_task_a', { query: 'sess_task_a' })).items.map(item => item.id), [a.id]);
});

test('usage snapshots retain the actual content supplied to a past run after edits and deletion', async t => {
  const f = fixture(t);
  const memory = f.add('sess_task_a', 'Original recall snapshot', 'workspace');
  f.usage.set('sess_task_a', { runId: 'run_past', items: [JSON.parse(JSON.stringify(memory))] });
  assert.equal((await f.update('sess_task_a', memory, { content: 'Later correction' })).ok, true);
  let result = await f.list('sess_task_a');
  assert.equal(result.items[0].content, 'Later correction');
  assert.equal(result.usage.items[0].content, 'Original recall snapshot');
  assert.equal((await f.remove('sess_task_a', memory)).ok, true);
  result = await f.list('sess_task_a');
  assert.equal(result.items.length, 0);
  assert.equal(result.usage.items[0].content, 'Original recall snapshot');
});
