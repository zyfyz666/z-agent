'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function section(start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && finish > offset, `Production section exists: ${start}`);
  return source.slice(offset, finish);
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function observe(promise) {
  const observation = { settled: false };
  promise.then(value => { observation.settled = true; observation.value = plain(value); });
  return observation;
}

// Only the browser surface and IPC are mocked. Requests, promises, queue
// ownership, draft capture, delayed callbacks, and remote events use the real
// renderer implementation. Timers can be fired after cancellation to exercise
// callbacks that were already dispatched when the user changed conversations.
function fixture() {
  const focusLog = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.className = '';
      this.value = '';
      this.scrollTop = 0;
      this.scrollHeight = 500;
      this.clientHeight = 200;
      this.style = { setProperty() {}, removeProperty() {} };
      const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = {
        contains: value => classes().has(value),
        add: (...values) => { this.className = [...new Set([...classes(), ...values])].join(' '); },
        remove: (...values) => { this.className = [...classes()].filter(v => !values.includes(v)).join(' '); },
        toggle: (value, force) => {
          const enable = force === undefined ? !classes().has(value) : force;
          this.classList[enable ? 'add' : 'remove'](value);
          return enable;
        }
      };
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key); }
    addEventListener(name, callback) {
      this.listeners.set(name, [...(this.listeners.get(name) || []), callback]);
    }
    emit(name, properties = {}) {
      const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...properties };
      for (const callback of this.listeners.get(name) || []) callback(event);
    }
    querySelectorAll(selector) {
      const matches = item => selector.startsWith('.') ? item.classList.contains(selector.slice(1))
        : selector === 'input:checked' ? item.tagName === 'input' && item.checked
          : selector.startsWith('#') ? item.id === selector.slice(1) : item.tagName === selector;
      const walk = item => item.children.flatMap(child => [child, ...walk(child)]);
      return walk(this).filter(matches);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { return { width: 600, height: 200, left: 0, top: 100, bottom: 700 }; }
    focus() { focusLog.push(this); }
  }
  const elements = new Map();
  const $ = (selector, root) => {
    if (root) return root.querySelector(selector);
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const timers = [];
  const frames = [];
  const replies = [];
  const cancellations = [];
  const handoffs = [];
  const noop = () => {};
  const setTimer = callback => { const timer = { callback }; timers.push(timer); return timer; };
  const context = vm.createContext({
    console, $, clearTimeout: timer => { if (timer) timer.cancelled = true; }, setTimeout: setTimer,
    requestAnimationFrame: callback => { frames.push(callback); },
    window: { setTimeout: setTimer, addEventListener: noop, innerWidth: 1200, innerHeight: 900 },
    document: { createElement: tag => new Element(tag) },
    state: { currentSession: { id: 'a' }, activeRuns: new Map(), config: { agent: { accessMode: 'ask' } } },
    api: {
      async openCodeReplyPermission(payload) { replies.push({ kind: 'permission', ...plain(payload) }); return { ok: true }; },
      async openCodeReplyQuestion(payload) { replies.push({ kind: 'question', ...plain(payload) }); return { ok: true }; },
      async openCodeCancelRun(id) { cancellations.push(id); },
      sessionAgentCommandResult: payload => handoffs.push(plain(payload)),
      async setConfig(config) { return config; }
    },
    renderSessionList: noop, syncBrowserFocusPromptStatus: noop, browserFocusMode: false,
    setBrowserFocusComposerMode: noop, toast: noop,
    updateSubagentWorkflow: () => false, mapOpenCodeEventToPet: () => null,
    syncInterjectionUi: noop, scheduleOpenCodeRender: noop,
    stringifyOpenCodeValue: value => JSON.stringify(value || ''),
    getCurrentAccessMode: () => context.state.config.agent?.accessMode || 'ask',
    getRunCtx: id => context.state.activeRuns.get(id)?.runCtx,
    ACCESS_MODE_UI: { ask: { toast: '' }, full: { toast: '' } },
    renderAccessModeControl: noop, setAccessModeMenuOpen: noop
  });
  for (const code of [
    section('let agentPermissionRequest = null;', 'async function handleSessionAgentCommand('),
    section('async function requireOpenCodeInteractionReply(', 'function subagentRoleLabel('),
    section('function applyOpenCodeEvent(', 'function applyOpenCodeEventBatch('),
    section('async function handleSessionAgentCommand(', 'async function activatePendingAgentHandoff('),
    section('function bindAgentPermissionPanel(', 'function persistSessionContextCompression('),
    section('async function selectAccessMode(', 'let accessModePreviewLatch =')
  ]) vm.runInContext(code, context);
  context.bindAgentPermissionPanel();
  const run = (sessionId, runId = `run-${sessionId}`) => {
    const value = { sessionId, runId, accessMode: 'ask', openCodeHandledRequests: new Set() };
    context.state.activeRuns.set(sessionId, { runCtx: value });
    return value;
  };
  return {
    context, $, timers, frames, replies, cancellations, handoffs, focusLog, run,
    visible: () => vm.runInContext('agentQuestionRequest || agentPermissionRequest', context),
    queue: id => vm.runInContext(`agentInteractionQueues.get(${JSON.stringify(id)}) || []`, context),
    switchTo(id) { context.state.currentSession = { id }; context.syncAgentInteractionPanel({ resume: true }); },
    permission: (runCtx, details = {}) => context.requestAgentPermission({ requestId: 'permission', ...details }, runCtx),
    question: (runCtx, details = {}) => context.requestAgentQuestion({ requestId: 'question', questions: [
      { question: 'First?', options: [{ label: 'First answer' }, { label: 'Second answer' }] },
      { question: 'Second?', options: [{ label: 'Final answer' }] }
    ], ...details }, runCtx),
    remote(kind, runCtx, id) { context.applyOpenCodeEvent(runCtx, { type: `${kind}.v2.replied`, data: { requestID: id } }); }
  };
}

test('switching conversations preserves question progress, draft, scroll, and collapse without answering', async () => {
  const f = fixture();
  const a = f.run('a'); const b = f.run('b');
  const question = observe(f.question(a));
  f.context.advanceAgentQuestion();
  f.$('#agentQuestionCustomInput').value = 'Keep my unfinished answer';
  f.$('#agentQuestionCustomInput').emit('input');
  f.$('#agentQuestionCustomToggle').setAttribute('aria-expanded', 'true');
  f.$('#agentQuestionFields').scrollTop = 123;
  f.$('#agentPermissionPanel').classList.add('collapsed');
  const permission = observe(f.permission(b));
  assert.equal(f.visible().sessionId, 'a');
  f.switchTo('b');
  assert.equal(f.visible().kind, 'permission');
  f.switchTo('a');
  const restored = f.visible();
  assert.equal(restored.currentIndex, 1);
  assert.equal(f.$('#agentQuestionCustomInput').value, 'Keep my unfinished answer');
  assert.equal(restored.drafts[1].scrollTop, 123);
  assert.equal(restored.collapsed, true);
  assert.equal(f.$('#agentQuestionCustomToggle').getAttribute('aria-expanded'), 'true');
  await tick();
  assert.equal(question.settled, false);
  assert.equal(permission.settled, false);
  f.context.advanceAgentQuestion();
  await tick();
  assert.deepEqual(question.value.answers, [['First answer'], ['Keep my unfinished answer']]);
  assert.equal(permission.settled, false);
});

test('same-session FIFO and duplicate IDs do not cancel or replace pending requests', async () => {
  const f = fixture(); const a = f.run('a');
  const first = f.question(a);
  assert.equal(f.question(a), first, 'A replay must share the original promise');
  const second = observe(f.permission(a));
  const third = observe(f.question(a, { requestId: 'second-question' }));
  assert.equal(f.queue('a').length, 3);
  f.context.settleAgentQuestion({ answers: [['A'], ['B']] });
  await tick();
  assert.equal(f.visible().kind, 'permission');
  assert.equal(second.settled, false);
  assert.equal(third.settled, false);
  f.context.settleAgentPermission('once');
  await tick();
  assert.equal(second.value.decision, 'once');
  assert.equal(f.visible().requestId, 'second-question');
});

test('vision relay choice belongs to its original permission when another conversation is shown', async () => {
  const f = fixture(); const a = f.run('a'); const b = f.run('b');
  const permission = observe(f.permission(a, { visionRelay: { show: true, checked: true } }));
  f.$('#agentPermissionVisionRelayCheck').checked = false;
  f.$('#agentPermissionVisionRelayCheck').emit('change');
  f.question(b);
  f.switchTo('b');
  f.switchTo('a');
  assert.equal(f.$('#agentPermissionVisionRelayCheck').checked, false);
  f.context.settleAgentPermission('once');
  await tick();
  assert.equal(permission.value.useVisionRelay, false);
});

test('requests arriving during session loading stay hidden and reappear when loading is resolved', async () => {
  const f = fixture(); const a = f.run('a');
  f.context.suspendAgentInteractionPanel();
  const pending = observe(f.permission(a));
  assert.equal(f.visible(), null);
  assert.equal(f.$('#agentPermissionPanel').classList.contains('hidden'), true);
  f.context.syncAgentInteractionPanel({ resume: true });
  assert.equal(f.visible().runCtx, a);
  await tick();
  assert.equal(pending.settled, false);
});

test('run termination cancels its hidden FIFO, preserves another run, and rejects late requests', async () => {
  const f = fixture(); const a = f.run('a'); const b = f.run('b');
  const permission = observe(f.permission(a));
  const question = observe(f.question(a));
  const newer = f.run('a', 'newer-run');
  const newerQuestion = observe(f.question(newer));
  const background = observe(f.permission(b));
  f.switchTo('b');
  f.context.settleAgentInteractionForRun(a, { permissionDecision: 'deny' });
  await tick();
  assert.equal(permission.value.decision, 'deny');
  assert.equal(question.value.cancelled, true);
  assert.equal(newerQuestion.settled, false);
  assert.equal(background.settled, false);
  assert.equal(f.visible().runCtx, b);
  assert.equal(f.queue('a')[0].runCtx, newer);
  assert.deepEqual(plain(await f.question(a, { requestId: 'late' })), { answers: [], reject: false, cancelled: true });
  f.context.settleAgentInteractionsForSession('a');
  await tick();
  assert.equal(newerQuestion.value.cancelled, true);
  assert.equal(f.visible().runCtx, b);
});

test('remote replies settle hidden permission/question promises without replying twice or touching the visible session', async () => {
  const f = fixture(); const a = f.run('a'); const b = f.run('b');
  const permission = f.context.handleOpenCodePermission(a, { data: { id: 'same-id', action: 'read' } });
  const question = f.context.handleOpenCodeQuestion(a, { data: { id: 'same-id', questions: [{ question: 'A?' }] } });
  const visible = observe(f.question(b, { requestId: 'same-id' }));
  f.switchTo('b');
  f.remote('permission', a, 'same-id');
  f.remote('question', a, 'same-id');
  await Promise.all([permission, question]);
  assert.equal(f.queue('a').length, 0);
  assert.equal(f.visible().runCtx, b);
  assert.equal(visible.settled, false);
  assert.deepEqual(f.replies, []);
});

test('already-dispatched option timer and focus callbacks cannot affect another conversation', async () => {
  const f = fixture(); const a = f.run('a'); const b = f.run('b');
  const first = observe(f.question(a));
  const oldFrames = f.frames.splice(0);
  const option = f.$('#agentQuestionFields').querySelector('input');
  option.checked = true;
  option.emit('change');
  const timer = f.timers.at(-1);
  assert.ok(timer);
  const second = observe(f.question(b));
  f.switchTo('b');
  timer.callback();
  for (const frame of oldFrames) frame();
  assert.equal(f.visible().currentIndex, 0);
  assert.equal(f.focusLog.length, 0);
  f.switchTo('a');
  timer.callback();
  assert.equal(f.visible().currentIndex, 0, 'An old timer must remain invalid even after switching back');
  await tick();
  assert.equal(first.settled, false);
  assert.equal(second.settled, false);
});

test('no-run requests capture a synchronous owner; malformed run identities cannot borrow the active session', async () => {
  const f = fixture();
  const direct = observe(f.permission(undefined));
  f.switchTo('b');
  assert.equal(f.queue('a').length, 1);
  assert.equal(f.visible(), null);
  const malformed = observe(f.permission({ runId: 'missing-owner' }, { requestId: 'malformed' }));
  const declared = observe(f.permission({ runId: 'missing-owner-declared' }, { sessionId: 'a', requestId: 'declared-only' }));
  const mismatch = observe(f.permission({ runId: 'a', sessionId: 'a' }, { sessionId: 'b', requestId: 'mismatch' }));
  await tick();
  assert.equal(malformed.settled, true);
  assert.equal(malformed.value.decision, null);
  assert.equal(declared.settled, true, 'A run must have its own identity so terminal cleanup can find its queue');
  assert.equal(declared.value.decision, null);
  assert.equal(mismatch.settled, true);
  assert.equal(mismatch.value.decision, null);
  assert.equal(f.queue('b').length, 0);
  assert.equal(direct.settled, false);
});

test('handoff permission without a live run belongs to sourceSessionId, never the displayed conversation', async () => {
  const f = fixture();
  f.switchTo('b');
  const operation = f.context.handleSessionAgentCommand({ requestId: 'handoff-a', sourceSessionId: 'a', targetWorkspace: 'fixture-workspace' });
  assert.equal(f.visible(), null);
  assert.equal(f.queue('a')[0].kind, 'permission');
  assert.deepEqual(f.handoffs, []);
  f.switchTo('a');
  f.context.settleAgentPermission('once');
  await operation;
  assert.equal(f.handoffs[0].approved, true);
  const invalid = observe(f.context.handleSessionAgentCommand({ requestId: 'missing-source', targetWorkspace: 'fixture-workspace' }));
  await tick();
  assert.equal(invalid.settled, true, 'An invalid handoff must finish instead of asking the displayed conversation');
  assert.equal(f.handoffs.at(-1).approved, false);
  assert.equal(f.queue('a').length, 0);
});

for (const endState of ['remote-replied', 'stopped', 'completed']) {
  for (const requiresApproval of [true, false]) {
    test(`classifier reply after ${endState} cannot reopen or approve an obsolete permission (${requiresApproval ? 'high' : 'low'} risk)`, async () => {
      const f = fixture(); const a = f.run('a'); const b = f.run('b');
      a.accessMode = 'delegate';
      const classification = deferred();
      f.context.api.classifyOpenCodeShellCommand = () => classification.promise;
      const operation = observe(f.context.handleOpenCodePermission(a, { data: { id: 'slow-classifier', action: 'bash', resources: ['fixture-command'] } }));
      const visible = observe(f.permission(b));
      f.switchTo('b');
      if (endState === 'remote-replied') f.remote('permission', a, 'slow-classifier');
      else {
        if (endState === 'stopped') a.shouldAbort = true;
        f.context.settleAgentInteractionForRun(a);
      }
      classification.resolve({ level: requiresApproval ? 'high' : 'low', requiresApproval });
      await tick();
      assert.equal(operation.settled, true, 'An obsolete permission must finish instead of creating a new popup');
      assert.equal(f.queue('a').length, 0);
      assert.deepEqual(f.replies, []);
      assert.deepEqual(f.cancellations, []);
      assert.equal(f.visible().runCtx, b);
      assert.equal(visible.settled, false);
    });
  }
}

test('changing access mode during a slow config save settles only the permission visible when clicked', async () => {
  const f = fixture(); const a = f.run('a'); const b = f.run('b');
  const first = observe(f.permission(a)); const second = observe(f.permission(b));
  const save = deferred();
  f.context.api.setConfig = () => save.promise;
  const operation = f.context.selectAccessMode('full');
  f.switchTo('b');
  save.resolve({ agent: { accessMode: 'full' } });
  await operation;
  await tick();
  assert.equal(first.settled, true);
  assert.equal(first.value.decision, 'always');
  assert.equal(second.settled, false);
  assert.equal(f.visible().runCtx, b);
});

test('a late permission reply failure cancels only its run and preserves another conversation question', async () => {
  const f = fixture(); const a = f.run('a'); const b = f.run('b');
  const reply = deferred();
  f.context.api.openCodeReplyPermission = () => reply.promise;
  const operation = f.context.handleOpenCodePermission(a, { data: { id: 'request-a', action: 'read' } });
  f.context.settleAgentPermission('once');
  await tick();
  const pending = observe(f.question(b));
  f.switchTo('b');
  reply.resolve({ ok: false, error: 'fixture reply error' });
  await operation;
  assert.deepEqual(f.cancellations, ['run-a']);
  assert.equal(f.visible().runCtx, b);
  assert.equal(pending.settled, false);
});

test('an access-mode save cannot approve a newer request after the original request was remotely settled', async () => {
  const f = fixture(); const a = f.run('a');
  const original = observe(f.permission(a));
  const save = deferred();
  f.context.api.setConfig = () => save.promise;
  const operation = f.context.selectAccessMode('full');
  f.remote('permission', a, 'permission');
  const replacement = observe(f.permission(a, { requestId: 'replacement' }));
  save.resolve({ agent: { accessMode: 'full' } });
  await operation;
  await tick();
  assert.equal(original.value.decision, null);
  assert.equal(replacement.settled, false);
  assert.equal(f.visible().requestId, 'replacement');
});
