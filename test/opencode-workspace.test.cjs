'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { turnContextSystem, sessionPermissionForRun } = require('../lib/opencode-sidecar');

const workspace = path.resolve('task-directory-fixture');
const actionFor = (rules, permission) => rules.find(rule => rule.permission === permission && rule.pattern === '*')?.action;

test('default task directories let a new conversation create deliverables without a folder-selection stop', () => {
  const context = turnContextSystem({
    workspace, workspaceKind: 'default', hasUserWorkspace: true,
    prompt: '创建一个 HTML 文件', workMode: 'normal'
  });
  assert.ok(context.includes(workspace));
  assert.match(context, /persistent task directory has already been assigned/);
  assert.match(context, /Work directly in this directory and create the requested files/);
  assert.doesNotMatch(context, /End the task immediately|请先选择工作区|not a deliverable workspace/);
  assert.match(context, /separate permission explicitly authorizes another location/);
  assert.match(context, /does not grant additional access or bypass approval/);
  assert.match(context, /report their actual paths/);
});

test('an explicitly selected workspace keeps its identity and file boundary', () => {
  const context = turnContextSystem({ workspace, hasUserWorkspace: true });
  assert.ok(context.includes(`A user workspace is selected: ${workspace}`));
  assert.doesNotMatch(context, /persistent task directory has already been assigned|output fallback/);
  assert.match(context, /User-owned file operations must remain inside this task directory/);
});

test('legacy blank requests use the actual run directory instead of refusing file tasks', () => {
  for (const request of [{ workspace, hasUserWorkspace: false }, { hasUserWorkspace: false }]) {
    const directory = path.resolve(request.workspace || process.cwd());
    const context = turnContextSystem(request);
    assert.ok(context.includes(`Use the current run directory as the output fallback: ${directory}`));
    assert.match(context, /Begin the requested work here/);
    assert.doesNotMatch(context, /End the task immediately|请先选择工作区|do not call file or shell tools/);
    assert.match(context, /If a tool is denied, respect the denial/);
  }
});

test('upgraded sessions retain a separate historical directory without redirecting new output', () => {
  const legacyRuntimeWorkspace = path.resolve('legacy-runtime-fixture');
  const context = turnContextSystem({
    workspace, workspaceKind: 'default', hasUserWorkspace: true, legacyRuntimeWorkspace
  });
  assert.ok(context.includes(`task directory has already been assigned to this conversation: ${workspace}`));
  assert.ok(context.includes(`pre-upgrade runtime directory: ${legacyRuntimeWorkspace}`));
  assert.match(context, /Read those historical files only when needed and permitted/);
  assert.match(context, /write new deliverables in the current task directory/);
  assert.match(context, /Do not move or delete the historical directory/);
});

test('automatic task assignment preserves the selected permission mode and explicit write denial', () => {
  for (const accessMode of ['request', 'delegate', 'full']) {
    for (const allowFileWrite of [true, false]) {
      const request = { workspace, hasUserWorkspace: true, accessMode, permissions: { allowFileWrite } };
      const selectedRules = sessionPermissionForRun(request);
      const defaultRules = sessionPermissionForRun({ ...request, workspaceKind: 'default' });
      assert.deepEqual(defaultRules, selectedRules);
      for (const permission of ['edit', 'write', 'apply_patch']) {
        assert.equal(actionFor(defaultRules, permission), !allowFileWrite ? 'deny' : accessMode === 'request' ? 'ask' : 'allow');
      }
      assert.equal(actionFor(defaultRules, 'external_directory'), accessMode === 'full' ? 'allow' : 'ask');
    }
  }
});

test('legacy directory fallback cannot turn disabled or plan-mode writes into approval requests', () => {
  for (const options of [{ permissions: { allowFileWrite: false } }, { workMode: 'plan' }]) {
    const rules = sessionPermissionForRun({ hasUserWorkspace: false, accessMode: 'full', ...options });
    for (const permission of ['edit', 'write', 'apply_patch']) assert.equal(actionFor(rules, permission), 'deny');
  }
  const guardedRules = sessionPermissionForRun({ hasUserWorkspace: false, accessMode: 'request' });
  for (const permission of ['edit', 'write', 'apply_patch', 'external_directory']) {
    assert.equal(actionFor(guardedRules, permission), 'ask');
  }
});

test('cross-directory work uses the current access policy instead of forcing a handoff', () => {
  const full = turnContextSystem({ workspace, hasUserWorkspace: true, workspaceKind: 'default', accessMode: 'full' });
  assert.match(full, /Full Access already authorizes external-directory access/);
  assert.match(full, /respecting explicit read\/write denials and plan mode/);
  assert.match(full, /Do not ask for another workspace or create a handoff/);
  for (const accessMode of ['request', 'delegate']) {
    const guarded = turnContextSystem({ workspace, hasUserWorkspace: true, accessMode });
    assert.match(guarded, /normal file tool permission flow and wait for approval/);
    assert.doesNotMatch(guarded, /Full Access already authorizes/);
  }
});
