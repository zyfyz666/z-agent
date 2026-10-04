'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');

function permissionContext(decision = 'once') {
  const replies = [];
  const prompts = [];
  const cancellations = [];
  const context = {
    api: { openCodeReplyPermission: async value => { replies.push(value); return { ok: true }; },
      openCodeCancelRun: async value => cancellations.push(value) },
    getCurrentAccessMode: () => 'request',
    requestAgentPermission: async request => { prompts.push(request); return { decision }; },
    requireOpenCodeInteractionReply: async result => assert.equal(result.ok, true),
  };
  vm.createContext(context);
  vm.runInContext(renderer.slice(renderer.indexOf('const SHELL_PERMISSION_ACTIONS'),
    renderer.indexOf('async function handleOpenCodeQuestion')), context);
  return { context, replies, prompts, cancellations };
}

test('an edit in a default or older blank task follows normal permission and never cancels for a folder choice', async () => {
  for (const workspace of ['', 'C:/Tasks/session-1']) {
    const { context, replies, prompts, cancellations } = permissionContext();
    const run = { runId: 'run', sessionId: 'session-1', workspace, accessMode: 'full', openCodeHandledRequests: new Set() };
    await context.handleOpenCodePermission(run, { data: { id: 'p-edit', action: 'edit', resources: ['answer.txt'] } });
    assert.equal(replies[0].reply, 'always');
    assert.equal(prompts.length, 0);
    assert.equal(cancellations.length, 0);
    assert.equal(run.workspaceRequired, undefined);
  }
});

test('automatic task folders still respect request mode and a user denial', async () => {
  const { context, replies, prompts, cancellations } = permissionContext('deny');
  const run = { runId: 'run', sessionId: 's', workspace: 'C:/Tasks/s', accessMode: 'request', openCodeHandledRequests: new Set() };
  await context.handleOpenCodePermission(run, { data: { id: 'p-edit', action: 'edit', resources: ['answer.txt'] } });
  assert.equal(prompts.length, 1);
  assert.equal(replies[0].reply, 'reject');
  assert.equal(cancellations.length, 0);
});

test('automatic folders share the conversation sidebar group while selected projects remain separate', () => {
  const context = { normalizeWorkspaceUiPath: value => String(value).replaceAll('\\', '/').replace(/\/$/, '') };
  vm.createContext(context);
  vm.runInContext(renderer.slice(renderer.indexOf('function workspaceGroupKey('), renderer.indexOf('async function toggleSessionPinnedFromSidebar(')), context);
  assert.equal(context.workspaceGroupKey({ workspaceKind: 'default', workspace: 'C:/Tasks/a' }), 'blank');
  assert.equal(context.workspaceGroupKey({ workspaceKind: 'default', workspace: 'C:/Tasks/b' }), 'blank');
  assert.equal(context.workspaceGroupKey({ workspaceKind: 'selected', workspace: 'C:/Project' }), 'c:/project');
  assert.equal(context.workspaceGroupLabel(''), '对话');
});
