'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { LEGACY_NAMESPACE, LEGACY_FIELDS } = require('../lib/legacy-compat');
const { sessionModeMatches } = require('../lib/work-mode-isolation');
const { summarizeVerification, fileRevision } = require('../lib/verification-state');
const { parsePlanMarker, formatPlanMarker } = require('../lib/subagent/plan');
const workflow = require('../lib/subagent/workflow-state');

test('renaming metadata does not force recreation of isolated native sessions', () => {
  const session = { metadata: {
    [LEGACY_FIELDS.zModeIsolation]: 1,
    [LEGACY_FIELDS.zWorkMode]: 'normal'
  } };
  const original = JSON.stringify(session);
  assert.equal(sessionModeMatches(session, { workMode: 'normal' }), true);
  assert.equal(sessionModeMatches(session, { workMode: 'agi' }), false);
  assert.equal(sessionModeMatches({ metadata: { [LEGACY_FIELDS.zWorkMode]: 'normal' } }, { workMode: 'normal' }), false);
  assert.equal(sessionModeMatches(null, { workMode: 'normal' }), false);
  assert.equal(JSON.stringify(session), original);
});

test('current isolation metadata wins instead of resurrecting a stale mode', () => {
  const old = { [LEGACY_FIELDS.zModeIsolation]: 1, [LEGACY_FIELDS.zWorkMode]: 'normal' };
  assert.equal(sessionModeMatches({ metadata: { ...old, zModeIsolation: 0 } }, { workMode: 'normal' }), false);
  assert.equal(sessionModeMatches({ metadata: { ...old, zWorkMode: 'plan' } }, { workMode: 'normal' }), false);
  assert.equal(sessionModeMatches({ metadata: { ...old, zWorkMode: 'plan' } }, { workMode: 'plan' }), true);
});

test('old verification receipts still detect source edits after a passing test', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-legacy-verification-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'answer.js');
  fs.writeFileSync(file, 'module.exports = 42;\n');
  const receipt = { files: { 'answer.js': fileRevision(file) }, directory, status: 'passed' };
  const messages = [{ parts: [{ type: 'tool', tool: 'bash', callID: 'test-old', state: {
    input: { command: 'node --test test/answer.test.cjs' }, status: 'completed', output: 'Tests passed',
    metadata: { exit: 0, [LEGACY_FIELDS.zVerification]: receipt }
  } }] }];
  const first = summarizeVerification(messages, { workspace: directory });
  assert.equal(first.status, 'passed');
  assert.deepEqual(first.records[0].files, receipt.files);
  fs.writeFileSync(file, 'module.exports = 43;\n');
  const later = summarizeVerification(messages, { workspace: directory });
  assert.equal(later.status, 'stale');
  assert.equal(later.records[0].status, 'stale');
  assert.equal(receipt.status, 'passed', 'the stored receipt must not be rewritten');
});

test('current verification receipts take precedence over historical aliases', () => {
  const messages = [{ parts: [{ type: 'tool', tool: 'bash', callID: 'test-current', state: {
    input: { command: 'npm test' }, status: 'completed', output: 'passed',
    metadata: { exit: 0, zVerification: { status: 'stale' }, [LEGACY_FIELDS.zVerification]: { status: 'passed' } }
  } }] }];
  assert.equal(summarizeVerification(messages).status, 'stale');
});

test('historical task plan markers restore dependency and acceptance data in both parsers', () => {
  const plan = { id: 'ui', dependsOn: ['api'], acceptance: 'npm test passes' };
  const prompt = `${LEGACY_NAMESPACE.lower}-plan: ${JSON.stringify(plan)}\nContinue the existing task.`;
  const task = { type: 'tool', tool: 'task', callID: 'task-old', state: {
    status: 'running', input: { prompt, subagent_type: 'builder' }
  } };
  assert.deepEqual(parsePlanMarker(prompt), plan);
  assert.deepEqual(workflow.taskInfo(task).plan, plan);
  assert.equal(workflow.taskInfo(task).prompt, prompt);
  assert.match(formatPlanMarker(plan), /^z-plan:/);
  assert.deepEqual(parsePlanMarker(formatPlanMarker(plan)), plan);
});

test('compatibility does not accept unrelated or embedded task plan markers', () => {
  for (const prompt of [
    'other-plan: {"id":"wrong"}',
    `User quoted ${LEGACY_NAMESPACE.lower}-plan: {"id":"wrong"}`,
    `${LEGACY_NAMESPACE.lower}-plan: {not-json}`
  ]) {
    assert.equal(parsePlanMarker(prompt), null);
    assert.equal(workflow.taskInfo({ state: { input: { prompt } } }).plan, null);
  }
});

test('historical subagent events restore progress without rewriting the input event', () => {
  const run = { runId: 'parent-existing', timeline: [] };
  const event = { type: `${LEGACY_NAMESPACE.lower}.subagent.event`, data: {
    childSessionID: 'child-existing', callId: 'task-old', subagentType: 'explorer',
    event: { type: 'message.part.updated', data: { part: {
      id: 'part-existing', messageID: 'message-existing', type: 'text', text: 'Found the entry point', time: { end: 200 }
    } } }
  } };
  const original = JSON.stringify(event);
  const result = workflow.consume(run, event, 200);
  assert.equal(result.handled, true);
  assert.equal(run.subagents.length, 1);
  assert.equal(run.subagents[0].childSessionID, 'child-existing');
  assert.ok(run.subagents[0].timeline.some(item => item.content === 'Found the entry point'));
  assert.equal(JSON.stringify(event), original);
  const unknown = workflow.consume(run, { type: `${LEGACY_NAMESPACE.lower}.external.event`, data: {} }, 300);
  assert.equal(unknown.handled, false);
});

test('browser workflow restores old task plans and history with the shared helper', () => {
  const context = vm.createContext({});
  for (const name of ['legacy-compat.js', 'subagent/workflow-state.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', name), 'utf8'), context, { filename: name });
  }
  const run = { runId: 'parent-browser', timeline: [] };
  const event = { type: `${LEGACY_NAMESPACE.lower}.subagent.history`, data: {
    childSessionID: 'child-browser', callId: 'task-browser', subagentType: 'explorer',
    messages: [{ info: { id: 'message-browser', role: 'assistant' }, parts: [
      { id: 'part-browser', type: 'text', text: 'Saved result', time: { end: 400 } }
    ] }]
  } };
  assert.equal(context.ZSubagentWorkflow.consume(run, event, 500).handled, true);
  assert.ok(run.subagents[0].timeline.some(item => item.content === 'Saved result'));
  const prompt = `${LEGACY_NAMESPACE.lower}-plan: {"id":"browser-task","dependsOn":["parent-task"]}`;
  assert.equal(context.ZSubagentWorkflow.taskInfo({ state: { input: { prompt } } }).plan.id, 'browser-task');
});
