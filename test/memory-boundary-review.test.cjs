'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LongTermMemoryStore } = require('../lib/long-term-memory');
const { withMemoryDatabase } = require('../lib/memory-database');
const { normalizeTaskMemoryContext } = require('../lib/task-memory-context');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-memory-boundary-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  return { workspace, store: new LongTermMemoryStore({ dbPath: path.join(root, 'memory.sqlite') }) };
}

test('reinforcing identical content with future evidence does not inject that evidence before a branch cutoff', t => {
  const { workspace, store } = fixture(t);
  const fact = { type: 'project', scope: 'workspace', key: 'calibrator.baseline',
    content: 'The calibrator baseline uses csv.', evidence: 'Original baseline artifact.' };
  const saved = store.upsert(fact, { workspace, sessionId: 'sess_source', runId: 'r1', conversationRevision: 0 }).memory;
  withMemoryDatabase(store.dbPath, db => {
    const record = JSON.parse(db.prepare('SELECT record FROM memories WHERE id=?').get(saved.id).record);
    record.createdAt = 10; record.contentUpdatedAt = 10;
    db.prepare('UPDATE memories SET record=? WHERE id=?').run(JSON.stringify(record), saved.id);
  });
  assert.match(store.query({ workspace, sessionId: 'sess_child', conversationRevision: 0, cutoff: 20, query: 'calibrator' }).context, /Original baseline artifact/);
  const changed = store.upsert({ ...fact, evidence: 'Future experiment confirmed a different data range.' },
    { workspace, sessionId: 'sess_other', runId: 'r2', conversationRevision: 0 });
  assert.equal(changed.ok, true);
  assert.doesNotMatch(store.query({ workspace, sessionId: 'sess_child', conversationRevision: 0,
    cutoff: 20, query: 'calibrator' }).context, /Future experiment|sess_other/);
});

test('editing task progress cannot keep injecting the obsolete structured goal and constraints', t => {
  const { workspace, store } = fixture(t);
  const identity = { workspace, sessionId: 'sess_owner', branchId: 'sess_owner', conversationRevision: 2, runStartedAt: 100 };
  const saved = store.upsert({ type: 'work_state', scope: 'task', content: 'Original progress summary', taskState: {
    ...identity, goal: 'OLD_GOAL_REMOVE_ME', constraints: ['OLD_CONSTRAINT_REMOVE_ME'], verified: [], unresolved: [], nextSteps: []
  } }, identity).memory;
  assert.equal(store.update(saved.id, { content: 'User corrected the goal to verify a new data set.' }, identity).ok, true);
  const selected = store.query({ ...identity, query: 'continue' }).memories.find(item => item.id === saved.id);
  assert.ok(selected);
  const context = normalizeTaskMemoryContext(selected.taskState, identity);
  assert.doesNotMatch(JSON.stringify(context), /OLD_GOAL_REMOVE_ME|OLD_CONSTRAINT_REMOVE_ME/);
});
