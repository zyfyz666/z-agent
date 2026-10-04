'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const sourceSession = {
    id: 'source', conversationRevision: 4, messagesStart: 60,
    modelSelection: { modelId: 'independent-model' }, openCodeSessionId: 'old-native',
    messages: [
      { role: 'user', content: 'old prompt', ts: 1, attachments: [{ name: 'file.txt', path: '/workspace/file.txt' }], skillCalls: [{ id: 'skill' }], subagentRoles: ['reviewer'] },
      { role: 'assistant', content: 'chosen answer', ts: 2, forkedHistory: true },
      { role: 'user', content: 'future turn', ts: 3 }
    ]
  };
  const otherSession = { id: 'other', messages: [] };
  const calls = [], confirmations = [], loads = [], toasts = [];
  let persisted = sourceSession;
  let composer = 'preserve my draft';
  let confirm = async () => true;
  let mutation = async payload => {
    const index = payload.messageIndex - sourceSession.messagesStart;
    persisted = {
      ...sourceSession, conversationRevision: 5, openCodeSessionId: '',
      messages: sourceSession.messages.slice(0, index + (payload.includeSelected === false ? 0 : 1)),
      rewindState: { backupSessionId: 'backup', action: 'rewind' }, contextReset: { kind: 'rewind' }
    };
    return { ok: true, session: persisted, backupSessionId: 'backup' };
  };
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, structuredClone, console,
    state: { currentSession: sourceSession, sessions: [], activeRuns: new Map(), queuedTurns: new Map(), composerDrafts: new Map(), attachments: [] },
    sessionLoadToken: 7, sessionSaveQueues: new Map(), sessionHistoryLoads: new WeakMap(), sessionModelSelectionVersions: new Map(),
    observerHistorySelection: new Map([['source', 'future-observation']]),
    observerPendingSessionId: '', interjectionThreads: new Map([['source', 'future-guidance']]), pendingAgentHandoffs: new Map([['source', 'future-handoff']]),
    isSessionExecutionActive: id => context.state.activeRuns.has(id),
    api: {
      forkSession: async () => {},
      rewindSession: async payload => { calls.push(structuredClone(payload)); return mutation(payload); },
      restoreSessionRewind: async payload => { calls.push(structuredClone(payload)); return mutation(payload); },
      getSession: async () => persisted
    },
    $: () => null, $$: () => [], updateSendState() {},
    requestGenericConfirmation: async options => { confirmations.push(options); return confirm(options); },
    refreshSessions: async () => {},
    loadSession: async id => { loads.push(id); context.sessionLoadToken++; context.state.currentSession = persisted; },
    toast: value => toasts.push(value),
    captureComposerDraftForSession: id => context.state.composerDrafts.set(id, { text: composer }),
    getComposerText: () => composer,
    setComposerText: text => { composer = text; },
    normalizeSkillCalls: items => items || [], installedSkillPickerItems: () => [],
    setComposerSkills: items => { context.selectedSkills = items; },
    setComposerSubagents: items => { context.selectedSubagents = items; },
    renderAttachments() {}, autoGrow() {}, input: { focus() {} }, setComposerCaretByTextOffset() {}
  });
  vm.runInContext(section('const sessionForkSavedMessages =', 'async function forkSessionFromMessage('), context);
  context.markSessionForkMessagesSaved(sourceSession.messages);
  function element(index = 1) {
    return { isConnected: true, dataset: { sessionId: sourceSession.id, msgIndex: String(index) },
      _messageRecord: sourceSession.messages[index], hasAttribute: () => true };
  }
  return { context, sourceSession, otherSession, calls, confirmations, loads, toasts, element,
    setConfirm: value => { confirm = value; }, setMutation: value => { mutation = value; },
    getComposer: () => composer };
}

test('rewind uses the absolute saved boundary including inherited history and retains the old object revision', async () => {
  const f = fixture();
  const selected = f.sourceSession.messages[1];
  await f.context.rewindSessionFromMessage(f.element());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].messageIndex, 61);
  assert.equal(f.calls[0].conversationRevision, 4);
  assert.equal(f.calls[0].includeSelected, undefined);
  assert.equal(f.calls[0].messageAnchor, createHash('sha256').update(JSON.stringify([
    selected.role, selected.ts, null, selected.content, [], null
  ])).digest('hex'));
  assert.match(f.confirmations[0].description, /第 62 条消息（含这条）/);
  assert.match(f.confirmations[0].description, /备份.*文件保持不变/);
  assert.equal(f.sourceSession.messages.length, 3);
  assert.equal(f.sourceSession.conversationRevision, 4);
  assert.equal(f.context.state.currentSession.messages.length, 2);
  assert.equal(f.context.state.currentSession.openCodeSessionId, '');
  assert.equal(f.context.state.currentSession.modelSelection.modelId, 'independent-model');
  assert.equal(f.getComposer(), 'preserve my draft');
  assert.equal(f.context.observerHistorySelection.has('source'), false);
  assert.equal(f.context.interjectionThreads.has('source'), false);
  assert.deepEqual(f.loads, ['source']);
});

test('rewind resolves message object identity after older pages are prepended', async () => {
  const f = fixture();
  const element = f.element();
  const previous = { role: 'user', content: 'older saved', ts: 0 };
  f.sourceSession.messages.unshift(previous);
  f.sourceSession.messagesStart--;
  f.context.markSessionForkMessagesSaved([previous]);
  await f.context.rewindSessionFromMessage(element);
  assert.equal(f.calls[0].messageIndex, 61);
  assert.equal(element.dataset.msgIndex, '2');
});

for (const busy of ['running', 'queued', 'saving', 'loading', 'unfinished', 'unsaved']) {
  test(`rewind does not mutate a ${busy} conversation boundary`, async () => {
    const f = fixture();
    if (busy === 'running') f.context.state.activeRuns.set('source', {});
    if (busy === 'queued') f.context.state.queuedTurns.set('source', {});
    if (busy === 'saving') f.context.sessionSaveQueues.set('source', Promise.resolve());
    if (busy === 'loading') f.context.sessionHistoryLoads.set(f.sourceSession, Promise.resolve());
    if (busy === 'unfinished') f.sourceSession.messages[1].agentRun = { status: 'running' };
    if (busy === 'unsaved') f.sourceSession.messages[1] = { role: 'assistant', content: 'not saved' };
    await f.context.rewindSessionFromMessage(f.element());
    assert.equal(f.calls.length, 0);
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.sourceSession.messages.length, 3);
  });
}

test('duplicate clicks share one pending confirmation and mutation', async () => {
  const f = fixture();
  const dialog = deferred();
  f.setConfirm(() => dialog.promise);
  const first = f.context.rewindSessionFromMessage(f.element());
  await f.context.rewindSessionFromMessage(f.element());
  assert.equal(f.confirmations.length, 1);
  dialog.resolve(true);
  await first;
  assert.equal(f.calls.length, 1);
});

for (const changed of ['cancel', 'message', 'navigation', 'away-back', 'new-run', 'new-save', 'revision']) {
  test(`confirmation with ${changed} cannot rewind a stale boundary`, async () => {
    const f = fixture();
    const dialog = deferred();
    f.setConfirm(() => dialog.promise);
    const pending = f.context.rewindSessionFromMessage(f.element());
    if (changed === 'message') f.sourceSession.messages[1].content = 'changed';
    if (changed === 'navigation') { f.context.state.currentSession = f.otherSession; f.context.sessionLoadToken++; }
    if (changed === 'away-back') f.context.sessionLoadToken += 2;
    if (changed === 'new-run') f.context.state.activeRuns.set('source', {});
    if (changed === 'new-save') f.context.sessionSaveQueues.set('source', Promise.resolve());
    if (changed === 'revision') f.sourceSession.conversationRevision++;
    dialog.resolve(changed !== 'cancel');
    await pending;
    assert.equal(f.calls.length, 0);
    assert.equal(f.loads.length, 0);
  });
}

test('a late rewind result never navigates away from the user selected conversation', async () => {
  const f = fixture();
  const result = deferred(), entered = deferred();
  f.setMutation(() => { entered.resolve(); return result.promise; });
  const pending = f.context.rewindSessionFromMessage(f.element());
  await entered.promise;
  f.context.state.currentSession = f.otherSession;
  f.context.sessionLoadToken++;
  result.resolve({ ok: true, session: { ...f.sourceSession, conversationRevision: 5 }, backupSessionId: 'backup' });
  await pending;
  assert.equal(f.loads.length, 0);
  assert.equal(f.context.state.currentSession, f.otherSession);
});

test('a synchronized replacement object for the same open conversation still reloads the committed rewind', async () => {
  const f = fixture();
  const result = deferred(), entered = deferred();
  f.setMutation(() => { entered.resolve(); return result.promise; });
  const pending = f.context.rewindSessionFromMessage(f.element());
  await entered.promise;
  f.context.state.currentSession = { ...f.sourceSession };
  result.resolve({ ok: true, session: { ...f.sourceSession, conversationRevision: 5 }, backupSessionId: 'backup' });
  await pending;
  assert.deepEqual(f.loads, ['source']);
});

test('failed backend rewinds keep native and observer state intact', async () => {
  const f = fixture();
  f.setMutation(async () => ({ ok: false, error: 'revision changed' }));
  await f.context.rewindSessionFromMessage(f.element());
  assert.equal(f.context.state.currentSession, f.sourceSession);
  assert.equal(f.sourceSession.openCodeSessionId, 'old-native');
  assert.equal(f.context.observerHistorySelection.get('source'), 'future-observation');
  assert.equal(f.loads.length, 0);
});

test('normal user-message rewind opens an editable prompt with attachments, skills and subagents and preserves the old draft in backup', async () => {
  const f = fixture();
  await f.context.rewindSessionFromMessage(f.element(0));
  assert.equal(f.calls[0].messageIndex, 60);
  assert.equal(f.calls[0].includeSelected, false);
  assert.equal(f.getComposer(), 'old prompt');
  assert.equal(f.context.state.currentSession.messages.length, 0);
  assert.equal(f.context.state.composerDrafts.get('backup').text, 'preserve my draft');
  assert.equal(f.context.state.attachments[0].path, '/workspace/file.txt');
  assert.equal(f.context.selectedSkills[0].id, 'skill');
  assert.equal(f.context.selectedSubagents[0], 'reviewer');
  assert.equal(f.confirmations[0].confirmLabel, '回退并编辑');
  assert.match(f.confirmations[0].description, /输入框.*之前/);
  f.context.setComposerText('A freely edited replacement');
  assert.equal(f.getComposer(), 'A freely edited replacement');
  assert.equal(f.sourceSession.messages[0].content, 'old prompt');
});

test('the explicit edit shortcut retains the same exclusive rewind behavior', async () => {
  const f = fixture();
  await f.context.rewindSessionFromMessage(f.element(0), { edit: true });
  assert.equal(f.calls[0].includeSelected, false);
  assert.equal(f.getComposer(), 'old prompt');
});

test('a pending user rewind preserves the edit until returning to its revision without changing another conversation draft', async () => {
  const f = fixture();
  const result = deferred(), entered = deferred();
  f.setMutation(() => { entered.resolve(); return result.promise; });
  const pending = f.context.rewindSessionFromMessage(f.element(0));
  await entered.promise;
  f.context.captureComposerDraftForSession('source');
  f.context.state.currentSession = f.otherSession;
  f.context.sessionLoadToken++;
  f.context.setComposerText('Other conversation draft');
  const rewound = { ...f.sourceSession, conversationRevision: 5, messages: [] };
  result.resolve({ ok: true, session: rewound, backupSessionId: 'backup' });
  await pending;
  assert.equal(f.getComposer(), 'Other conversation draft');
  assert.equal(f.context.restorePendingSessionRewindEdit(f.otherSession), false);
  assert.equal(f.context.restorePendingSessionRewindEdit(f.sourceSession), false);
  f.context.state.currentSession = rewound;
  f.context.setComposerText(f.context.state.composerDrafts.get('source').text);
  assert.equal(f.context.restorePendingSessionRewindEdit(rewound), true);
  assert.equal(f.getComposer(), 'old prompt');
  assert.equal(f.context.state.composerDrafts.get('backup').text, 'preserve my draft');
  f.context.setComposerText('Edited after returning');
  assert.equal(f.context.restorePendingSessionRewindEdit(rewound), false);
  assert.equal(f.getComposer(), 'Edited after returning');
});

test('a newer conversation revision cannot resurrect an old pending edit', async () => {
  const f = fixture();
  f.context.state.currentSession = f.otherSession;
  const result = { ok: true, session: { ...f.sourceSession, conversationRevision: 5 }, backupSessionId: 'backup' };
  await f.context.applySessionRewindResult(result, f.sourceSession, 6, { editMessage: f.sourceSession.messages[0] });
  const newer = { ...f.sourceSession, conversationRevision: 6 };
  f.context.state.currentSession = newer;
  assert.equal(f.context.restorePendingSessionRewindEdit(newer), false);
  assert.equal(f.getComposer(), 'preserve my draft');
});

test('first-message rewind with a default title survives blank-chat cleanup while viewing another empty chat', async () => {
  const rewound = { id: 'rewound', title: '新对话', messages: [], workspaceKind: 'default',
    rewindState: { backupSessionId: 'backup' } };
  const blank = { id: 'blank', title: '新对话', messageCount: 0, workspaceKind: 'default' };
  const deleted = [];
  const context = vm.createContext({ state: { currentSession: blank, sessions: [], composerDrafts: new Map(), queuedTurns: new Map() },
    api: { listSessions: async () => [rewound, blank], deleteSession: async id => { deleted.push(id); return { ok: true }; } },
    renderSessionList() {}, clearYanCoreQueuedIntentsForThread() {} });
  vm.runInContext(section('function isDefaultSessionTitle(', 'function syncCurrentSessionWorkspace('), context);
  vm.runInContext(section('function setSessionSummaries(', '// Core IPC is optional'), context);
  await context.refreshSessions();
  assert.deepEqual(deleted, []);
  assert.equal(context.isBlankNewChat(rewound), false);
  assert.equal(context.isBlankUnassignedNewChat(blank), true);
  assert.equal(context.state.sessions.length, 2);
});

test('restore selects the backend checkpoint using the current revision and preserves drafts', async () => {
  const f = fixture();
  f.sourceSession.rewindState = { backupSessionId: 'backup', action: 'rewind' };
  f.setMutation(async () => ({ ok: true, session: { ...f.sourceSession, conversationRevision: 5 }, backupSessionId: 'next-backup' }));
  await f.context.restoreSessionRewind();
  assert.deepEqual(f.calls, [{ sessionId: 'source', conversationRevision: 4 }]);
  assert.match(f.confirmations[0].description, /当前对话也会先备份/);
  assert.equal(f.getComposer(), 'preserve my draft');
});

test('rewind action exposes an accessible label and updates both rewind and edit busy state', () => {
  const f = fixture();
  const buttons = new Map();
  const createButton = () => ({ dataset: {}, attributes: {}, addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const edit = createButton();
  buttons.set('[data-act="edit"]', edit);
  const actions = { querySelector: selector => buttons.get(selector), appendChild: button => buttons.set(`[data-act="${button.dataset.act}"]`, button) };
  f.context.document = { createElement: createButton };
  const element = { ...f.element(), querySelector: () => actions };
  f.context.syncMessageRewindAction(element);
  const button = buttons.get('[data-act="rewind"]');
  assert.equal(button.attributes['aria-label'], '回退到这里');
  assert.equal(button.disabled, false);
  f.context.state.activeRuns.set('source', {});
  f.context.syncMessageRewindAction(element);
  assert.equal(button.disabled, true);
  assert.equal(edit.disabled, true);
  assert.match(button.title, /任务执行中/);
});

test('queued requests freeze the current conversation revision in durable intent and discard stale acknowledgements', async () => {
  const payloads = [], response = deferred();
  const session = { id: 'source', conversationRevision: 3 };
  const context = vm.createContext({
    state: { currentSession: session, activeRuns: new Map(), queuedTurns: new Map(), attachments: [], selectedSkills: [], selectedSubagents: [] },
    getRunCtx: () => ({ runId: 'running' }), syncComposerSkillsFromDom() {}, syncComposerSubagentsFromDom() {},
    getComposerText: () => 'follow-up prompt', normalizeComposerSkill: value => value,
    normalizeModelSelectionSnapshot: value => value, getAgentModelSelection: () => ({ modelType: 'text' }),
    validateQueuedModelPayload: () => true, createQueuedTurnId: () => 'queued-id',
    invokeYanCore: (_method, payload) => { payloads.push(payload); return response.promise; },
    clearComposerPayload() {}, syncQueuedTurnUi() {}, updateSendState() {}, console: { warn() {} }
  });
  vm.runInContext(section('function queueCurrentComposerTurn(', 'function editCurrentQueuedTurn('), context);
  assert.equal(context.queueCurrentComposerTurn(), true);
  session.conversationRevision = 4;
  assert.equal(payloads[0].conversationRevision, 3);
  assert.equal(payloads[0].intent.conversationRevision, 3);
  assert.equal(context.state.queuedTurns.get('source').conversationRevision, 3);
  response.resolve({ ok: false, code: 'SESSION_REVISION_CHANGED' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(context.state.queuedTurns.has('source'), false);
});

test('queue hydration retains matching revised intents and excludes discarded history revisions', async () => {
  const context = vm.createContext({
    state: { sessions: [{ id: 'fresh', conversationRevision: 2 }, { id: 'stale', conversationRevision: 2 }], queuedTurns: new Map() },
    api: { yanCoreGetState: async () => ({ intents: {
      fresh: { id: 'fresh-intent', threadId: 'fresh', status: 'queued', intent: { prompt: 'new prompt', conversationRevision: 2 } },
      stale: { id: 'stale-intent', threadId: 'stale', status: 'queued', intent: { prompt: 'old prompt', conversationRevision: 1 } }
    } }) },
    getAgentModelSelection: () => ({ modelId: 'selected' }), console
  });
  vm.runInContext(section('async function hydrateQueuedTurns(', 'async function listRecoveredYanCoreTurns('), context);
  await context.hydrateQueuedTurns();
  assert.equal(context.state.queuedTurns.get('fresh').conversationRevision, 2);
  assert.equal(context.state.queuedTurns.has('stale'), false);
});

test('stale consume or requeue errors stop only the matching local queue and never remove a newer message', () => {
  const notices = [];
  const old = { id: 'old', conversationRevision: 1 };
  const current = { id: 'new', conversationRevision: 2 };
  const context = vm.createContext({ state: { currentSession: { id: 'source' }, queuedTurns: new Map([['source', old]]) }, toast: text => notices.push(text) });
  vm.runInContext(section('function discardStaleQueuedTurn(', 'function scheduleQueuedTurnDispatch('), context);
  assert.equal(context.discardStaleQueuedTurn('source', old, { code: 'SESSION_REVISION_CHANGED' }), true);
  assert.equal(context.state.queuedTurns.size, 0);
  context.state.queuedTurns.set('source', current);
  assert.equal(context.discardStaleQueuedTurn('source', old, { code: 'SESSION_REVISION_CHANGED' }), true);
  assert.equal(context.state.queuedTurns.get('source'), current);
  assert.equal(notices.length, 1);
});
