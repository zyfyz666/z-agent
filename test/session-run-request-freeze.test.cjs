'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}

function fixture() {
  const modelSelection = { providerId: 'provider-a', supplierId: 'official', modelId: 'model-a', modelType: 'text' };
  const prior = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }];
  const a = { id: 'sess_alpha', title: 'Existing A', modelSelection, workspace: '/fixture-a', messages: structuredClone(prior) };
  const b = { id: 'sess_beta', title: 'Existing B', modelSelection: { ...modelSelection, modelId: 'model-b' }, messages: [] };
  const saves = [];
  const starts = [];
  const guidance = [];
  let complete;
  let saveEntered, releaseSave;
  const saveBarrier = new Promise(resolve => { releaseSave = resolve; });
  const entered = new Promise(resolve => { saveEntered = resolve; });
  let composerText = 'Preserve the initial API signatures.';
  const context = vm.createContext({
    structuredClone, console, AbortController, sessionRewindRequests: new Map(),
    messageForkAnchor: async message => `anchor:${message.content}`,
    state: { currentSession: a, config: {}, activeRuns: new Map(), attachments: [], selectedSkills: [], selectedSubagents: [] },
    api: {
      async saveSession(payload) {
        saves.push(structuredClone(payload));
        if (saves.length === 1) { saveEntered(); await saveBarrier; }
        return payload;
      },
      async openCodeStartRun(payload) {
        starts.push(structuredClone(payload));
        queueMicrotask(() => complete({ result: { textContent: 'Done', status: 'done' } }));
        return { ok: true };
      },
      async openCodeSteerRun(payload) { guidance.push(structuredClone(payload)); return { ok: true, accepted: true, delivered: true, deliveryEvidence: 'provider-response' }; },
      async openCodeCancelRun() {}
    },
    ensureFullSessionLoaded: async value => value,
    findPersistedIntentSubmission: () => null,
    isSessionExecutionActive: id => context.state.activeRuns.has(id),
    canStartRun: () => true,
    normalizeSkillCalls: value => value || [],
    normalizeModelSelectionSnapshot: value => ({ ...value }),
    getAgentModelSelection: session => session.modelSelection,
    createRunCtx: (id, ui, workspace) => ({ sessionId: id, runId: `run-${id}`, ui, workspace, runAbortController: new AbortController() }),
    setRunModelPresentation: (run, selection) => { run.modelSelection = { ...selection }; },
    getCurrentAccessMode: () => 'full',
    beginChatAutoFollow() {}, startPetSupervision() {}, updateSendState() {}, showTyping() {}, renderSessionList() {},
    buildModelSwitchNotice: () => '', syncCurrentSessionAgentUi() {},
    appendMessage: () => ({}), appendModelSwitchNoticeElement() {}, setEmptyState() {},
    buildSessionSavePayload: session => structuredClone(session), refreshSessions: async () => {}, updateTaskBar() {},
    markSessionForkMessagesSaved() {}, refreshSessionForkActions() {},
    initOpenCodeRunState() {},
    attachOpenCodeRunEventListeners(_run, callback) { complete = callback; return () => {}; },
    openCodeResultToAgentRun: value => value,
    extractMediaAssetsFromAgentRun: () => [],
    rejectStartedOpenCodeRunIfAborted: async () => {},
    syncSessionOpenCodeIdAfterRun() {}, settleAgentInteractionForRun() {},
    getComposerText: () => composerText,
    createQueuedTurnId: () => 'guidance-during-save',
    getActiveAssistantElement: () => null,
    captureLiveGuidanceDisplayBoundary() {}, renderOpenCodeRunNow() {},
    clearComposerPayload: () => { composerText = ''; },
    refreshLiveGuidanceStatus() {}, toast() {}
  });
  vm.runInContext(section('const sessionSaveQueues =', 'function deriveTitle('), context);
  vm.runInContext(section('async function steerCurrentComposerTurn(', 'function queueCurrentComposerTurn('), context);
  vm.runInContext(section('async function runOpenCodeLoop(', '// Reload reconciliation:'), context);
  // Run the production submission path through its first durable save, then
  // enter the actual kernel submission function. Presentation/finalization
  // are tested elsewhere; this boundary isolates the previously racy await.
  vm.runInContext(section('async function submitMessage(', '  runCtx.workspace = runSession.workspace')
    + 'return runOpenCodeLoop(runSession, null, runCtx);\n}', context);
  return { context, a, b, prior, entered, releaseSave, starts, guidance, saves };
}

test('rewound conversations send their revision and a frozen request boundary when starting the kernel', async () => {
  const f = fixture();
  f.a.conversationRevision = 3;
  f.a.contextReset = { kind: 'rewind' };
  f.context.messageForkAnchor = async message => {
    f.a.conversationRevision = 4; // A later metadata refresh cannot relabel an old prompt.
    return `anchor:${message.content}`;
  };
  const pending = f.context.submitMessage('Continue from the rewind.', [], [], { session: f.a });
  await f.entered;
  f.releaseSave();
  await pending;
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].conversationRevision, 3);
  assert.equal(f.starts[0].requestMessageIndex, 2);
  assert.equal(f.starts[0].requestMessageAnchor, 'anchor:Continue from the rewind.');
  assert.equal(f.saves[0].conversationRevision, 3);
});

for (const switchConversation of [false, true]) {
  test(`guidance during the first save cannot replace the initiating prompt, attachments, skills, or history${switchConversation ? ' after switching conversations' : ''}`, async () => {
    const f = fixture();
    const attachments = [{ name: 'requirements.txt', path: '/fixture-a/requirements.txt', kind: 'file' }];
    const skills = [{ id: 'fixture-skill', name: 'Fixture Skill' }];
    const pending = f.context.submitMessage('Implement the original task.', attachments, skills, { session: f.a });
    await f.entered;
    assert.equal(f.starts.length, 0, 'the main prompt waits for its first durable save');
    const steering = f.context.steerCurrentComposerTurn();
    assert.equal(f.a.messages.at(-1).content, 'Preserve the initial API signatures.');
    if (switchConversation) f.context.state.currentSession = f.b;
    f.releaseSave();
    await pending;
    await steering;
    assert.equal(f.starts.length, 1);
    const request = f.starts[0];
    assert.equal(request.zSessionId, f.a.id);
    assert.equal(request.prompt, 'Implement the original task.');
    assert.deepEqual(request.attachments, attachments);
    assert.deepEqual(request.selectedSkills, skills);
    assert.deepEqual(request.history.map(item => ({ role: item.role, content: item.content })), f.prior);
    assert.equal(request.modelSelection.modelId, 'model-a');
    assert.equal(f.guidance.length, 1);
    assert.equal(f.guidance[0].zSessionId, f.a.id);
    assert.equal(f.guidance[0].text, 'Preserve the initial API signatures.');
    assert.equal(f.a.messages.filter(item => item.content === 'Implement the original task.').length, 1);
    assert.equal(f.a.messages.at(-1).liveGuidance.status, 'delivered');
    assert.deepEqual(f.b.messages, []);
  });
}
