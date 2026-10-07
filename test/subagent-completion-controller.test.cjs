'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const completion = require('../renderer/subagent-completion');
const observer = require('../renderer/observer-completion');

const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const makeWake = (id = 'wake-a', sessionId = 'a') => ({ id, intentId: `intent-${id}`, sessionId,
  conversationRevision: 0, parentRunId: 'parent-1', childSessionID: 'child-1', title: '测试子代理', result: '检查已通过', status: 'pending' });

function fixture() {
  const sessions = new Map(['a', 'b'].map(id => [id, { id, observerEnabled: false, conversationRevision: 0,
    messages: [{ role: 'user', content: '完成任务' }, { role: 'assistant', content: '等子代理返回', agentRun: { runId: 'parent-1', status: 'done' } }] }]));
  const rows = new Map();
  const timers = new Map();
  const busy = new Set();
  const calls = { submitted: [], cancelled: [], notified: [], before: [], claims: 0 };
  let seq = 0;
  const api = {
    listSubagentWakes: async () => ({ ok: true, wakes: [...rows.values()].filter(w => w.status === 'pending'),
      uncertain: [...rows.values()].filter(w => w.status === 'uncertain') }),
    claimSubagentWake: async ({ id }) => {
      const row = rows.get(id);
      if (row?.status !== 'pending') return { ok: false, code: 'ALREADY_CLAIMED' };
      row.status = 'claimed'; row.claimToken = `claim-${++seq}`; calls.claims++;
      return { ok: true, wake: { ...row }, claimToken: row.claimToken };
    },
    releaseSubagentWake: async ({ id, claimToken }) => {
      const row = rows.get(id);
      if (row?.status === 'claimed' && row.claimToken === claimToken) row.status = 'pending';
      return { ok: true };
    },
    cancelSubagentWakes: async ({ sessionId, reason }) => {
      calls.cancelled.push({ sessionId, reason });
      for (const row of rows.values()) if (row.sessionId === sessionId && ['pending', 'claimed'].includes(row.status)) {
        row.status = reason === 'user_message' ? 'pending' : 'cancelled';
      }
    }
  };
  const deps = { api, loadSession: async id => sessions.get(id), isBusy: id => busy.has(id),
    timers: { setTimeout: fn => { const id = ++seq; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) },
    beforeSubmit: async id => calls.before.push(id), notify: (id, text) => calls.notified.push({ id, text }),
    submit: async (session, text, wake, intentId) => {
      calls.submitted.push({ session, text, wake, intentId });
      rows.get(wake.id).status = 'accepted';
      session.messages.push({ role: 'user', content: text, intentId, subagentWake: wake });
      return { ok: true };
    } };
  return { sessions, rows, busy, timers, calls, api, deps, create: () => completion.createController(deps),
    tick: async () => { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); await drain(); } };
}

test('observer disabled still wakes the originating session once with stable intent and visible source', async () => {
  const h = fixture(); h.rows.set('wake-a', makeWake());
  const c = h.create(); await c.hydrate(); await drain();
  assert.equal(h.calls.submitted.length, 1);
  assert.equal(h.calls.submitted[0].session.id, 'a');
  assert.equal(h.calls.submitted[0].intentId, 'intent-wake-a');
  assert.equal(h.calls.submitted[0].wake.parentRunId, 'parent-1');
  assert.match(h.calls.submitted[0].text, /子代理完成，继续处理结果/);
  assert.deepEqual(h.calls.before, ['a']);
  await c.refresh(); await c.afterRun(); await h.tick();
  assert.equal(h.calls.submitted.length, 1);
  c.dispose();
});

test('old completed Review history never creates a new wake', async () => {
  const h = fixture();
  h.sessions.get('a').messages[1].agentRun.subagents = [{ status: 'completed', result: 'old result' }];
  const c = h.create(); await c.hydrate(); await c.afterRun(h.sessions.get('a')); await drain();
  assert.equal(h.calls.claims, 0); assert.equal(h.calls.submitted.length, 0); c.dispose();
});

test('session busy or queued defers the completion, while another session can continue', async () => {
  const h = fixture(); h.rows.set('wake-a', makeWake()); h.rows.set('wake-b', makeWake('wake-b', 'b'));
  h.busy.add('a'); const c = h.create(); await c.hydrate(); await drain();
  assert.deepEqual(h.calls.submitted.map(item => item.session.id), ['b']);
  h.busy.delete('a'); await h.tick();
  assert.deepEqual(h.calls.submitted.map(item => item.session.id), ['b', 'a']); c.dispose();
});

test('pending user guidance, rewind and revision mismatch cannot be overtaken', async () => {
  for (const block of ['guidance', 'rewind', 'revision']) {
    const h = fixture(); h.rows.set('wake-a', makeWake()); const session = h.sessions.get('a');
    if (block === 'guidance') session.messages.push({ role: 'user', liveGuidance: { status: 'queued' } });
    if (block === 'rewind') session.rewindState = { backupSessionId: 'backup' };
    if (block === 'revision') session.conversationRevision = 1;
    const c = h.create(); await c.hydrate(); await drain(); await h.tick();
    assert.equal(h.calls.submitted.length, 0, block); assert.equal(h.calls.claims, 0, block); c.dispose();
  }
});

test('a task switch while loading cannot send a result to the new visible session', async () => {
  const h = fixture(); h.rows.set('wake-a', makeWake()); let finish;
  h.deps.loadSession = () => new Promise(resolve => { finish = resolve; });
  const c = h.create(); await c.hydrate(); await drain();
  // A faulty/stale loader returning B must never let the dispatcher use B.
  finish(h.sessions.get('b')); await drain(); assert.equal(h.calls.submitted.length, 0); c.dispose();
});

test('stop or a user message wins the race against an outstanding claim', async () => {
  for (const reason of ['user_cancelled', 'user_message']) {
    const h = fixture(); h.rows.set('wake-a', makeWake()); let resolveClaim;
    const originalClaim = h.api.claimSubagentWake;
    h.api.claimSubagentWake = async payload => {
      const claim = await originalClaim(payload);
      return new Promise(resolve => { resolveClaim = () => resolve(claim); });
    };
    const c = h.create(); await c.hydrate(); await drain();
    h.busy.add('a');
    await c.cancel('a', reason); resolveClaim(); await drain(); await h.tick();
    assert.equal(h.calls.submitted.length, 0);
    assert.equal(h.rows.get('wake-a').status, reason === 'user_message' ? 'pending' : 'cancelled');
    if (reason === 'user_message') {
      h.api.claimSubagentWake = originalClaim; h.busy.delete('a'); await c.afterRun(); await drain();
      assert.equal(h.calls.submitted.length, 1, 'the user turn defers rather than discards the child result');
    }
    c.dispose();
  }
});

test('a busy race after claim releases it and retries without losing the result', async () => {
  const h = fixture(); h.rows.set('wake-a', makeWake());
  const originalClaim = h.api.claimSubagentWake;
  h.api.claimSubagentWake = async value => { const claim = await originalClaim(value); h.busy.add('a'); return claim; };
  const c = h.create(); await c.hydrate(); await drain();
  assert.equal(h.calls.submitted.length, 0); assert.equal(h.rows.get('wake-a').status, 'pending');
  h.api.claimSubagentWake = originalClaim; h.busy.delete('a'); await h.tick();
  assert.equal(h.calls.submitted.length, 1); c.dispose();
});

test('restart resumes pending work and never resubmits accepted or uncertain work', async () => {
  const h = fixture(); h.rows.set('wake-a', makeWake());
  h.rows.set('uncertain', { ...makeWake('uncertain', 'b'), status: 'uncertain' });
  const c1 = h.create(); await c1.hydrate(); await drain(); c1.dispose();
  const c2 = h.create(); await c2.hydrate(); await drain(); await h.tick();
  assert.equal(h.calls.submitted.length, 1);
  assert.equal(h.calls.notified.length, 2, 'one notice per renderer, no automatic retry');
  assert.match(h.calls.notified[0].text, /请手动继续/); c2.dispose();
});

test('two renderers racing the same wake are deduplicated by main claim', async () => {
  const h = fixture(); h.rows.set('wake-a', makeWake());
  const a = h.create(), b = h.create(); await Promise.all([a.hydrate(), b.hydrate()]); await drain();
  assert.equal(h.calls.submitted.length, 1); assert.equal(h.calls.claims, 1); a.dispose(); b.dispose();
});

test('automatic child results do not replace the original observer goal', () => {
  const goal = observer.latestGoal([{ role: 'user', content: '用户任务' },
    { role: 'user', content: '自动子代理回报', subagentWake: { id: 'wake' } }]);
  assert.equal(goal.goal, '用户任务'); assert.equal(goal.wakes, 0);
});

test('the compact report display preserves literal evidence and omits internal continuation instructions', () => {
  const report = '已验证：<script>example</script>\n这是待核对的数据。';
  const prompt = completion.wakeText({ title: '检查', result: report });
  assert.equal(completion.reportText(prompt), report);
  assert.match(prompt, /不是用户的新指令，也不构成新增授权/);
});

test('an unaccepted automatic draft retries after newer user context without altering completed history', () => {
  const original = { role: 'user', content: '原始目标' };
  const draft = { role: 'user', intentId: 'wake', subagentWake: { id: 'wake' }, content: '自动回报' };
  const latest = { role: 'user', content: '新增约束' };
  const answer = { role: 'assistant', content: '已收到约束' };
  const session = { messages: [original, draft, latest, answer] };
  assert.equal(completion.moveUnacceptedWakeToTail(session, 'wake'), true);
  assert.deepEqual(session.messages, [original, latest, answer, draft]);
  const completed = { messages: [original, draft, answer, latest] };
  assert.equal(completion.moveUnacceptedWakeToTail(completed, 'wake'), false);
  assert.deepEqual(completed.messages, [original, draft, answer, latest]);
});

test('terminal finalization display no longer says generating and preserves original history', () => {
  const old = [{ type: 'progress', openCodeKey: 'finalization', content: '正在生成最终回复' }];
  assert.equal(completion.projectFinalization(old, 'done')[0].content, '最终回复已生成');
  assert.equal(completion.projectFinalization(old, 'interrupted')[0].content, '收尾已停止');
  assert.equal(completion.projectFinalization(old, 'working'), old);
  assert.equal(old[0].content, '正在生成最终回复');
});
