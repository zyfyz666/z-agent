'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const start = source.indexOf('async function recordLearningReview(');
const end = source.indexOf("\nipcMain.handle('skills:market'", start);
assert.ok(start >= 0 && end > start);

function fixture({ ready = true } = {}) {
  const writes = [], candidate = { id: 'z-candidate', name: 'Fixture', prompt: 'Fixture procedure', description: 'Fixture',
    verification: { postconditions: ['Outputs exist'] }, successfulRuns: ['run1', 'run2'], evidence: 'Checked' };
  let held = false, allowed = true, validationCalls = 0, resolveValidation;
  const write = name => { assert.equal(held, true, `${name} must have a current session guard`); writes.push(name); };
  const context = vm.createContext({
    process: { env: {} }, console: { warn() {} },
    skillEvolution: {
      record: () => { write('record'); return { ok: true, candidate, ready }; },
      list: () => [candidate],
      attachValidation: (_id, evidence) => { write('attachValidation'); candidate.validation = evidence; return { ok: true, validation: evidence }; },
      canPromote: () => ({ ok: !!candidate.validation, reason: 'Missing validation' }),
      markPromoted: () => write('markPromoted')
    },
    continualHarness: {
      load: () => ({ entries: { skill: {} } }),
      apply: async () => { write('harness.apply'); return { ok: true, refinement: { id: 'ref1', appliedEdits: [{ applied: true }] } }; },
      rollback: async () => { write('harness.rollback'); return { ok: true }; },
      recordOutcome: async () => { write('harness.outcome'); return { ok: true }; }
    },
    validateSkillCandidate: async () => {
      validationCalls++;
      assert.equal(held, false, 'the model judge must not hold the session write queue');
      return new Promise(resolve => { resolveValidation = resolve; });
    },
    checkConsistency: () => ({ ok: true }),
    loadConfig: () => ({ customSkills: [] }),
    skillRegistry: { isGeneratedSkill: () => true },
    upsertCustomSkill: value => { write('upsertCustomSkill'); return value; }
  });
  vm.runInContext(`${source.slice(start, end)}; globalThis.review = recordLearningReview;`, context);
  const applyInSession = async callback => {
    if (!allowed) return { ok: true, skipped: true, reason: 'Conversation rewound' };
    assert.equal(held, false, 'guards must not nest');
    held = true;
    try { return await callback(); } finally { held = false; }
  };
  return { writes, candidate, review: () => context.review({ skillCandidate: {}, applyInSession,
    verified: true, runId: 'run2', sessionId: 'sess_fixture' }),
    allow: value => { allowed = value; }, get validationCalls() { return validationCalls; },
    finishValidation: evidence => resolveValidation(evidence) };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('skill judge runs outside the session guard and all durable promotion writes are guarded', async () => {
  const f = fixture(), pending = f.review();
  await tick();
  assert.equal(f.validationCalls, 1);
  assert.deepEqual(f.writes, ['record']);
  f.finishValidation({ ok: true, passed: 1, failed: 0 });
  const result = await pending;
  assert.ok(result.promotedSkill);
  assert.deepEqual(f.writes, ['record', 'attachValidation', 'harness.apply', 'upsertCustomSkill', 'markPromoted', 'harness.outcome']);
});

test('a rewind while the judge is waiting suppresses later durable writes', async () => {
  const f = fixture(), pending = f.review();
  await tick();
  f.allow(false);
  f.finishValidation({ ok: true, passed: 1, failed: 0 });
  assert.equal((await pending).skipped, true);
  assert.deepEqual(f.writes, ['record']);
});

test('an already-invalid source skips candidate recording and never invokes the judge', async () => {
  const f = fixture(); f.allow(false);
  assert.equal((await f.review()).skipped, true);
  assert.equal(f.validationCalls, 0);
  assert.deepEqual(f.writes, []);
});

test('observing candidates are stored under the guard without calling a model', async () => {
  const f = fixture({ ready: false });
  const result = await f.review();
  assert.equal(result.promotedSkill, null);
  assert.equal(f.validationCalls, 0);
  assert.deepEqual(f.writes, ['record', 'harness.apply', 'harness.outcome']);
});
