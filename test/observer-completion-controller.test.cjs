'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const oc = require('../renderer/observer-completion');

// Fake clock: timers fire in due order; jump() moves time without firing (a sleeping machine).
function fakeClock(start = 1_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, ms) }); return id; },
    clearTimeout: id => { timers.delete(id); },
    jump: ms => { now += ms; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
  };
}

const finishedRun = (runId, extra = {}) => ({ role: 'assistant', content: '已完成一部分',
  agentRun: { runId, status: 'done', textContent: '已完成一部分', todos: [{ text: '写测试', done: false }], timeline: [], ...extra } });
const wake = extra => ({ verdict: 'continue', reason: '测试仍失败', unmet: ['让测试通过'], evidence: [], followUp: '修复失败的测试。', delayMinutes: 0, ...extra });

function harness({ verdicts = [], busy = () => false, submit } = {}) {
  const clock = fakeClock();
  const session = { id: 's1', messages: [{ role: 'user', content: '修好构建并让测试通过' }, finishedRun('r1')] };
  const calls = { reviews: [], saved: [], submits: [], cancels: 0 };
  let pendingReply = null;
  const api = {
    reviewObserverCompletion: async payload => {
      calls.reviews.push(payload);
      const next = verdicts.shift();
      if (next === 'defer') return new Promise(resolve => { pendingReply = resolve; });
      return next || { skipped: 'rules-only' };
    },
    cancelObserverCompletion: async () => { calls.cancels += 1; },
    setObserverCompletion: async (id, record) => { calls.saved.push({ id, ...record }); },
    listObserverWakes: async () => []
  };
  const deps = {
    api, now: clock.now, timers: clock, inMemory: () => [session], loadSession: async () => session, isBusy: busy,
    reviewEnabled: () => true, render: () => {},
    submit: submit || (async (s, text, wakeInfo) => {
      calls.submits.push({ text, wakeInfo });
      s.messages.push({ role: 'user', content: text, observerWake: wakeInfo });
      s.messages.push(finishedRun(`r${s.messages.length}`));
      return { ok: true };
    })
  };
  const controller = oc.createController(deps);
  return { clock, session, calls, api, deps, controller, resolveReview: value => pendingReply?.(value) };
}

test('an unmet goal wakes the agent after the 15 s countdown, marked as an observer wake', async () => {
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3, model: 'Obs' }] });
  await h.controller.afterRun(h.session);
  const record = h.controller.recordFor('s1');
  assert.equal(record.status, 'pending');
  assert.equal(record.dueAt, h.clock.now() + oc.COUNTDOWN_MS);
  assert.equal(h.calls.reviews[0].goal, '修好构建并让测试通过');
  await h.clock.advance(14_000);
  assert.equal(h.calls.submits.length, 0);
  await h.clock.advance(1_500);
  assert.equal(h.calls.submits.length, 1);
  assert.match(h.calls.submits[0].text, /观察者唤醒，第 1 次/);
  assert.equal(h.calls.submits[0].wakeInfo.wake, 1);
  assert.equal(h.session.messages.at(-2).observerWake.runId, 'r1');
  assert.equal(h.calls.saved.at(-1).status, 'sent');
});

test('a message from the user takes over a pending wake', async () => {
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3 }] });
  await h.controller.afterRun(h.session);
  h.session.messages.push({ role: 'user', content: '先停一下' });
  await h.controller.onUserMessage('s1');
  await h.clock.advance(20_000);
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.controller.recordFor('s1').status, 'superseded');
});

test('a review reply that arrives after the user moved on is dropped', async () => {
  const h = harness({ verdicts: ['defer'] });
  const pending = h.controller.afterRun(h.session);
  await Promise.resolve();
  assert.equal(h.controller.recordFor('s1').status, 'reviewing');
  await h.controller.onUserMessage('s1');
  assert.equal(h.calls.cancels, 1);
  h.resolveReview({ verdict: wake(), maxWakes: 3 });
  await pending;
  await h.clock.advance(20_000);
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.controller.recordFor('s1'), null);
  assert.equal(h.calls.saved.length, 0, 'reviewing is never persisted');
});

test('a wake never fires into a conversation that moved on, even without onUserMessage', async () => {
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3 }] });
  await h.controller.afterRun(h.session);
  h.session.messages.push({ role: 'user', content: '图片消息', attachments: [{ name: 'a.png' }] });
  await h.clock.advance(16_000);
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.controller.recordFor('s1').status, 'superseded');
});

test('achieved, needs_user and uncertain never wake', async () => {
  for (const verdict of ['achieved', 'needs_user', 'uncertain']) {
    const h = harness({ verdicts: [{ verdict: { verdict, reason: '理由', unmet: [], evidence: [] }, maxWakes: 3 }] });
    await h.controller.afterRun(h.session);
    await h.clock.advance(60_000);
    assert.equal(h.controller.recordFor('s1').status, verdict);
    assert.equal(h.calls.submits.length, 0);
  }
});

test('after maxWakes consecutive wakes the observer stops and hands over', async () => {
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 2 }, { verdict: wake(), maxWakes: 2 }, { verdict: wake(), maxWakes: 2 }] });
  await h.controller.afterRun(h.session);
  await h.clock.advance(16_000);
  await h.controller.afterRun(h.session);
  await h.clock.advance(16_000);
  assert.equal(h.calls.submits.length, 2);
  await h.controller.afterRun(h.session);
  assert.equal(h.calls.reviews.at(-1).observerWakes, 2);
  assert.equal(h.controller.recordFor('s1').status, 'limit');
  await h.clock.advance(60_000);
  assert.equal(h.calls.submits.length, 2);
  await h.controller.wakeNow('s1');
  assert.equal(h.calls.submits.length, 3, 'the user can still continue once by hand');
  assert.match(h.calls.submits[2].text, /第 3 次/);
});

test('a scheduled wake waits for its time', async () => {
  const h = harness({ verdicts: [{ verdict: wake({ delayMinutes: 30 }), maxWakes: 3 }] });
  await h.controller.afterRun(h.session);
  assert.equal(h.controller.recordFor('s1').status, 'scheduled');
  await h.clock.advance(29 * 60_000);
  assert.equal(h.calls.submits.length, 0);
  await h.clock.advance(61_000);
  assert.equal(h.calls.submits.length, 1);
});

test('startup: overdue and countdown wakes become expired, future scheduled wakes re-arm', async () => {
  const h = harness();
  const base = { runId: 'r1', followUp: '继续', reason: 'x', wakes: 0, maxWakes: 3 };
  h.api.listObserverWakes = async () => [
    { ...base, sessionId: 's1', status: 'scheduled', dueAt: h.clock.now() + 10 * 60_000 },
    { ...base, sessionId: 'old', status: 'scheduled', dueAt: h.clock.now() - 1 },
    { ...base, sessionId: 'cd', status: 'pending', dueAt: h.clock.now() + 5_000 }
  ];
  await h.controller.hydrate();
  assert.equal(h.controller.recordFor('old').status, 'expired');
  assert.equal(h.controller.recordFor('cd').status, 'expired');
  assert.equal(h.controller.recordFor('s1').status, 'scheduled');
  await h.clock.advance(11 * 60_000);
  assert.equal(h.calls.submits.length, 1);
});

test('a full concurrent-run limit retries; a machine that slept past the time expires the wake', async () => {
  let blocked = true;
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3 }, { verdict: wake({ delayMinutes: 5 }), maxWakes: 3 }] });
  const realSubmit = h.deps.submit;
  h.deps.submit = async (...args) => (blocked ? { ok: false, error: 'busy' } : realSubmit(...args));
  await h.controller.afterRun(h.session);
  await h.clock.advance(16_000);
  assert.equal(h.controller.recordFor('s1').retrying, true);
  assert.equal(h.controller.recordFor('s1').status, 'pending');
  blocked = false;
  await h.clock.advance(31_000);
  assert.equal(h.calls.submits.length, 1);
  await h.controller.afterRun(h.session);
  h.clock.jump(20 * 60_000);
  await h.clock.advance(1_000);
  assert.equal(h.controller.recordFor('s1').status, 'expired');
  assert.equal(h.calls.submits.length, 1);
});

test('stopped, finished-by-user and failed runs are not reviewed', async () => {
  for (const run of [{ status: 'interrupted' }, { status: 'done', userRequestedFinish: true }, { status: 'error' }]) {
    const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3 }] });
    Object.assign(h.session.messages[1].agentRun, run);
    await h.controller.afterRun(h.session);
    assert.equal(h.calls.reviews.length, 0);
  }
  const h = harness({ busy: () => true, verdicts: [{ verdict: wake(), maxWakes: 3 }] });
  await h.controller.afterRun(h.session);
  assert.equal(h.calls.reviews.length, 0, 'a queued turn or new run goes first');
});

test('goal, wake count and the card only follow the latest run', () => {
  const messages = [
    { role: 'user', content: '旧目标' }, finishedRun('a'),
    { role: 'user', content: '新目标' }, finishedRun('b'),
    { role: 'user', content: '（观察者唤醒）', observerWake: { wake: 1 } }, finishedRun('c'),
    { role: 'user', content: '运行中引导', liveGuidance: { runId: 'c' } }
  ];
  assert.deepEqual(oc.latestGoal(messages), { goal: '新目标', index: 2, wakes: 1 });
  assert.equal(oc.latestRun(messages).run.runId, 'c');
  const session = { messages };
  assert.equal(oc.displayFor(session, { runId: 'c', status: 'pending' }).status, 'pending');
  assert.equal(oc.displayFor(session, { runId: 'b', status: 'pending' }), null);
  assert.equal(oc.displayFor({ messages: [...messages, { role: 'user', content: '下一句' }] }, { runId: 'c', status: 'expired' }), null);
  assert.equal(oc.remaining(14_200), '15 秒后唤醒');
  assert.equal(oc.remaining(125_000), '2 分 5 秒后唤醒');
  assert.equal(oc.remaining(2 * 3_600_000 + 7 * 60_000), '2 小时 7 分后唤醒');
});

test('new labels translate to English', () => {
  const context = vm.createContext({ window: {}, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/i18n.js'), 'utf8'), context);
  const translate = value => context.window.ZI18n.translate(value, 'en');
  assert.equal(translate('15 秒后唤醒'), 'Wakes in 15 s');
  assert.equal(translate('2 分 5 秒后唤醒'), 'Wakes in 2 min 5 s');
  assert.equal(translate('2 小时 7 分后唤醒'), 'Wakes in 2 h 7 min');
  assert.equal(translate('观察者唤醒 · 第 2 次'), 'Observer wake · #2');
  for (const value of ['收尾核验', '即将唤醒主 Agent', '定时唤醒已过期', '你已接手，未唤醒', '立即唤醒', '继续一次',
    '观察者已连续唤醒 3 次，仍判断未完成，交给你决定。', '收尾核验并自动唤醒']) {
    assert.doesNotMatch(translate(value), /[㐀-鿿]/u, value);
  }
});

test('a disabled task never starts a completion review', async () => {
  const h = harness({ verdicts: [{ verdict: wake() }] });
  h.session.observerEnabled = false;
  await h.controller.afterRun(h.session);
  assert.equal(h.calls.reviews.length, 0);
  assert.equal(h.controller.recordFor('s1'), null);
});

test('disabling immediately cancels the countdown and enabling does not revive it', async () => {
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3 }] });
  await h.controller.afterRun(h.session);
  h.session.observerEnabled = false;
  await h.controller.setEnabled('s1', false);
  assert.equal(h.controller.recordFor('s1').status, 'cancelled');
  h.session.observerEnabled = true;
  await h.controller.setEnabled('s1', true);
  await h.clock.advance(60_000);
  assert.equal(h.calls.submits.length, 0);
});

test('a late review cannot revive a disabled and then re-enabled task', async () => {
  const h = harness({ verdicts: ['defer'] });
  const pending = h.controller.afterRun(h.session);
  await Promise.resolve();
  await h.controller.setEnabled('s1', false);
  await h.controller.setEnabled('s1', true);
  h.resolveReview({ verdict: wake(), maxWakes: 3 });
  await pending;
  await h.clock.advance(60_000);
  assert.equal(h.calls.cancels, 1);
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.controller.recordFor('s1'), null);
});

test('disabled scheduled wakes are cancelled during hydration', async () => {
  const h = harness();
  h.session.observerEnabled = false;
  h.api.listObserverWakes = async () => [{ sessionId: 's1', runId: 'r1', status: 'scheduled', dueAt: h.clock.now() + 60_000, followUp: 'continue', wakes: 0 }];
  await h.controller.hydrate();
  assert.equal(h.controller.recordFor('s1').status, 'cancelled');
  await h.clock.advance(120_000);
  assert.equal(h.calls.submits.length, 0);
});

test('disabling while dispatch loads the session prevents the wake', async () => {
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3 }] });
  await h.controller.afterRun(h.session);
  let finishLoad;
  h.deps.loadSession = () => new Promise(resolve => { finishLoad = resolve; });
  const dispatch = h.controller.dispatch('s1');
  await Promise.resolve();
  await h.controller.setEnabled('s1', false);
  finishLoad(h.session);
  await dispatch;
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.controller.recordFor('s1').status, 'cancelled');
});

test('disabling while a reserved wake is saved blocks submit and never records sent', async () => {
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3 }] });
  await h.controller.afterRun(h.session);
  let finishSave;
  const saved = [];
  h.api.setObserverCompletion = async (id, record) => {
    saved.push(record);
    if (record.dispatching && record.status === 'pending') await new Promise(resolve => { finishSave = resolve; });
  };
  const dispatch = h.controller.dispatch('s1');
  for (let i = 0; i < 10 && !finishSave; i++) await Promise.resolve();
  await h.controller.setEnabled('s1', false);
  finishSave(); await dispatch;
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.controller.recordFor('s1').status, 'cancelled');
  assert.equal(saved.some(record => record.status === 'sent'), false);
});

test('a reserved dispatch rejects a second manual wake while submit is pending', async () => {
  const h = harness({ verdicts: [{ verdict: wake(), maxWakes: 3 }] });
  await h.controller.afterRun(h.session);
  let finishSubmit;
  h.deps.submit = async (session, text, wakeInfo) => {
    h.calls.submits.push(wakeInfo);
    await new Promise(resolve => { finishSubmit = resolve; });
    session.messages.push({ role: 'user', content: text, observerWake: wakeInfo });
    return { ok: true };
  };
  const first = h.controller.wakeNow('s1');
  for (let i = 0; i < 20 && !finishSubmit; i++) await Promise.resolve();
  assert.equal(h.controller.recordFor('s1').dispatching, true);
  await h.controller.wakeNow('s1');
  assert.equal(h.calls.submits.length, 1);
  finishSubmit(); await first;
  assert.equal(h.controller.recordFor('s1').status, 'sent');
});
