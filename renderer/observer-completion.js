(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZObserverCompletion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // After a turn ends on its own the observer checks the user's goal. If work is
  // left it wakes the main agent: after a 15 s countdown, or at a time it picks
  // (1 min to 24 h). The record lives on the session as `observerCompletion`.
  const COUNTDOWN_MS = 15_000;
  const RETRY_MS = 30_000;
  const STALE_MS = 5 * 60_000; // a scheduled wake missed by more than this is shown as expired
  const OPEN = new Set(['reviewing', 'pending', 'scheduled']);
  const text = (value, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';

  // The goal is the latest message the user wrote; observer wakes and live
  // guidance inside a run are not new goals.
  function latestGoal(messages = []) {
    let wakes = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'user' || message.liveGuidance) continue;
      if (message.observerWake) { wakes += 1; continue; }
      if (message.subagentWake) continue;
      return { goal: text(message.content), index, wakes };
    }
    return { goal: '', index: -1, wakes };
  }

  function latestRun(messages = []) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === 'user' && !message.liveGuidance) return null;
      if (message?.role === 'assistant' && message.agentRun) return { message, run: message.agentRun };
    }
    return null;
  }

  // Natural end: the run finished without the user stopping or finishing it.
  function shouldReview(run) {
    return !!run && run.status === 'done' && run.userRequestedFinish !== true && !run.mediaType;
  }

  const MUTATING = /^(edit|write|patch|apply_patch|multiedit|create|move|delete|rename|str_replace)/i;
  function stepsFromTimeline(timeline = []) {
    return timeline.filter(item => item?.type === 'tool_call').slice(-300).map(item => {
      const args = item.args && typeof item.args === 'object' ? item.args : {};
      const target = args.filePath || args.path || args.file || args.command || args.url || args.pattern || args.query || '';
      return { op: text(item.name, 80), target: text(String(target), 200), mutated: MUTATING.test(String(item.name || '')) };
    });
  }

  function verificationSummary(delivery) {
    const records = Array.isArray(delivery?.verification?.records) ? delivery.verification.records : [];
    if (!records.length) return null;
    const passed = records.filter(record => record?.status === 'passed').length;
    const failed = records.filter(record => record?.status === 'failed').length;
    return { passed, failed, latest: delivery.verification.hasCurrentPass ? 'passed' : failed ? 'failed' : null };
  }

  function reviewPayload(session) {
    const messages = session?.messages || [];
    const goal = latestGoal(messages);
    const last = latestRun(messages);
    const run = last?.run || {};
    return {
      sessionId: String(session?.id || ''), runId: String(run.runId || ''), goal: goal.goal,
      finalReply: text(run.textContent || last?.message?.content, 20_000),
      todos: Array.isArray(run.todos) ? run.todos : [],
      steps: stepsFromTimeline(run.timeline),
      changedFiles: (run.changeSummary?.files || []).map(file => text(file?.path || file?.file || String(file || ''), 260)).filter(Boolean),
      verification: verificationSummary(run.delivery), observerWakes: goal.wakes
    };
  }

  // Verdict -> the record stored on the session.
  function decide(verdict, { wakes = 0, maxWakes = 3, now = Date.now(), runId = '' } = {}) {
    const base = { runId, verdict: verdict.verdict, reason: text(verdict.reason, 600), unmet: verdict.unmet || [],
      evidence: verdict.evidence || [], decidedAt: now, wakes };
    if (verdict.verdict !== 'continue') return { ...base, status: verdict.verdict };
    const followUp = text(verdict.followUp, 2000);
    if (wakes >= maxWakes) return { ...base, status: 'limit', followUp, maxWakes };
    const delayMs = Math.max(0, Math.min(1440, Number(verdict.delayMinutes) || 0)) * 60_000;
    return { ...base, followUp, maxWakes, status: delayMs ? 'scheduled' : 'pending', dueAt: now + (delayMs || COUNTDOWN_MS) };
  }

  function wakeText(record) {
    return `（观察者唤醒，第 ${record.wakes + 1} 次）本轮任务结束后，观察者核验认为目标还没有达成：${record.reason}\n\n${record.followUp}`;
  }
  // The record shown for a session only describes its latest run.
  function displayFor(session, record = session?.observerCompletion) {
    const last = latestRun(session?.messages || []);
    return record && last && String(last.run.runId || '') === String(record.runId || '') ? record : null;
  }

  function remaining(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    if (s < 60) return `${s} 秒后唤醒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒后唤醒`;
    return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分后唤醒`;
  }

  // deps: api (IPC bridge), loadSession(id) -> live or freshly loaded session,
  // inMemory(id) -> session objects the renderer holds, submit(session, text, wake),
  // isBusy(id), render(id), reviewEnabled(), now, timers ({ setTimeout, clearTimeout }).
  function createController(deps) {
    const now = deps.now || Date.now;
    const clock = deps.timers || globalThis;
    const live = new Map(); // sessionId -> { record }
    const timers = new Map();
    const enabledOverrides = new Map();
    const generations = new Map();
    const quiet = async fn => { try { return await fn(); } catch { return null; } };
    const enabled = (id, session) => enabledOverrides.get(id) !== false && session?.observerEnabled !== false
      && deps.sessionEnabled?.(id, session) !== false;

    function setEnabled(id, value) {
      id = String(id || '');
      if (!id) return Promise.resolve();
      const next = value !== false;
      if (enabledOverrides.get(id) === next) return Promise.resolve();
      enabledOverrides.set(id, next);
      generations.set(id, (generations.get(id) || 0) + 1);
      if (next) return Promise.resolve();
      clock.clearTimeout(timers.get(id)); timers.delete(id);
      return cancel(id);
    }

    // Main writes only `observerCompletion` (and the wake index); the renderer's
    // copies are updated so a later full save carries the same record.
    async function finalize(id, record) {
      const entry = live.get(id);
      if (!entry) return;
      clock.clearTimeout(timers.get(id)); timers.delete(id);
      entry.record = record;
      for (const session of deps.inMemory?.(id) || []) session.observerCompletion = record;
      await quiet(() => deps.api.setObserverCompletion?.(id, record));
      deps.render?.(id);
    }

    // Long waits are stepped (<= 60 s) so a machine that slept through a wake sees it as expired.
    function arm(id) {
      clock.clearTimeout(timers.get(id)); timers.delete(id);
      if (!enabled(id)) return;
      const record = live.get(id)?.record;
      if (!['pending', 'scheduled'].includes(record?.status)) return;
      timers.set(id, clock.setTimeout(() => {
        timers.delete(id);
        const current = live.get(id)?.record;
        if (current !== record) return;
        const late = now() - record.dueAt;
        if (late > STALE_MS && !record.retrying) return void finalize(id, { ...record, status: 'expired', expiredAt: now() });
        if (late < -500) return arm(id);
        void dispatch(id);
      }, Math.max(0, Math.min(record.dueAt - now(), 60_000))));
    }

    async function dispatch(id) {
      const entry = live.get(id);
      if (!entry) return;
      const { record } = entry;
      if (record.dispatching) return;
      const generation = generations.get(id) || 0;
      const session = await quiet(() => deps.loadSession(id));
      if (live.get(id) !== entry || entry.record !== record || (generations.get(id) || 0) !== generation) return;
      if (!enabled(id, session)) return cancel(id);
      if (!session) return finalize(id, { ...record, status: 'failed', endedAt: now(), error: '找不到这个对话' });
      const last = latestRun(session.messages || []);
      if (deps.isBusy(id) || String(last?.run?.runId || '') !== record.runId) {
        return finalize(id, { ...record, status: 'superseded', endedAt: now() });
      }
      // Reserve the wake while it is still cancellable. `submit` resolves when
      // the run ends, so never overwrite a newer run's review on completion.
      const wakeId = `wake-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await finalize(id, { ...record, dispatching: true, wakeId, retrying: undefined });
      if (!enabled(id, session) || (generations.get(id) || 0) !== generation) return;
      const result = await quiet(() => deps.submit(session, wakeText(record), { id: wakeId, wake: record.wakes + 1, runId: record.runId }));
      if (!enabled(id, session) || (generations.get(id) || 0) !== generation) return;
      if ((session.messages || []).some(message => message?.observerWake?.id === wakeId)) {
        if (live.get(id) === entry && entry.record.wakeId === wakeId && entry.record.dispatching) {
          await finalize(id, { ...record, status: 'sent', sentAt: now(), wakeId, retrying: undefined });
        }
        return;
      }
      if (result?.error === 'busy' && !deps.isBusy(id)) {
        // The concurrent-run limit is full; the conversation itself is free. Retry,
        // keeping the original pending/scheduled status.
        await finalize(id, { ...record, retrying: true, dueAt: now() + RETRY_MS });
        return arm(id);
      }
      await finalize(id, { ...record, status: 'failed', endedAt: now(), error: String(result?.error || '唤醒消息没有发出') });
    }
    async function afterRun(session) {
      const id = String(session?.id || '');
      if (!id) return;
      const last = latestRun(session.messages || []);
      const open = live.get(id)?.record;
      if (!enabled(id, session)) { await cancel(id); return; }
      if (!shouldReview(last?.run) || deps.isBusy(id) || deps.reviewEnabled?.(id, session) === false) {
        if (OPEN.has(open?.status)) await finalize(id, { ...open, status: 'superseded', endedAt: now() });
        return;
      }
      const payload = reviewPayload(session);
      if (!payload.goal) return;
      // Reviewing is shown live but never persisted, so a restart cannot strand it.
      const reviewing = { runId: payload.runId, status: 'reviewing', startedAt: now(), wakes: payload.observerWakes };
      clock.clearTimeout(timers.get(id)); timers.delete(id);
      live.set(id, { record: reviewing });
      deps.render?.(id);
      const reply = await quiet(() => deps.api.reviewObserverCompletion(payload)) || { error: '观察者模型暂时不可用，本轮未核验' };
      if (live.get(id)?.record !== reviewing) return;
      const freshSession = await quiet(() => deps.loadSession(id));
      if (live.get(id)?.record !== reviewing || !enabled(id, freshSession)) return cancel(id);
      const fresh = latestRun(freshSession?.messages || []);
      if (deps.isBusy(id) || String(fresh?.run?.runId || '') !== payload.runId || reply.cancelled || reply.skipped) {
        live.delete(id);
        return void deps.render?.(id);
      }
      if (!reply.verdict) return finalize(id, { ...reviewing, status: 'error', error: String(reply.error || '核验失败'), endedAt: now() });
      await finalize(id, { ...decide(reply.verdict, { wakes: payload.observerWakes, maxWakes: reply.maxWakes, now: now(), runId: payload.runId }), model: reply.model || '' });
      arm(id);
    }

    async function cancel(id) {
      const record = live.get(id)?.record;
      if (record?.status === 'reviewing') {
        live.delete(id);
        await quiet(() => deps.api.cancelObserverCompletion?.(id));
        return void deps.render?.(id);
      }
      if (OPEN.has(record?.status)) await finalize(id, { ...record, status: 'cancelled', endedAt: now() });
    }

    // Manual wake: a pending/scheduled one now, or one that expired or hit the limit.
    async function wakeNow(id, fallback) {
      if (!enabled(id)) return;
      if (!live.has(id) && fallback?.followUp) live.set(id, { record: fallback });
      const record = live.get(id)?.record;
      if (!record?.followUp || !['pending', 'scheduled', 'expired', 'limit'].includes(record.status)) return;
      await dispatch(id);
    }

    // A message the user writes takes over from the observer.
    async function onUserMessage(id) {
      const record = live.get(id)?.record;
      if (!record) return;
      if (record.status === 'reviewing') return cancel(id);
      if (['pending', 'scheduled', 'expired', 'limit'].includes(record.status)) {
        await finalize(id, { ...record, status: 'superseded', endedAt: now() });
      }
    }

    // Startup: Z was closed for every stored wake. Overdue ones are shown as expired
    // ("click to wake"); scheduled ones still in the future are re-armed.
    async function hydrate() {
      const stored = await quiet(() => deps.api.listObserverWakes?.()) || [];
      for (const storedRecord of Array.isArray(stored) ? stored : []) {
        // No dispatch can remain in flight across a renderer restart.
        const record = { ...storedRecord, dispatching: undefined };
        const id = String(record?.sessionId || '');
        if (!id || !['pending', 'scheduled'].includes(record.status)) continue;
        const generation = generations.get(id) || 0;
        const session = await quiet(() => deps.loadSession(id));
        if ((generations.get(id) || 0) !== generation || live.has(id)) continue;
        live.set(id, { record });
        if (!enabled(id, session)) { await cancel(id); continue; }
        if (record.dueAt <= now() || record.status === 'pending') await finalize(id, { ...record, status: 'expired', expiredAt: now() });
        else arm(id);
      }
    }

    function recordFor(id) { return live.get(String(id || ''))?.record || null; }

    // Countdown text updates in place once a second; the panel is not re-rendered.
    function tick(document) {
      for (const element of document?.querySelectorAll?.('[data-observer-due]') || []) {
        element.textContent = remaining(Number(element.dataset.observerDue) - now());
      }
    }

    return { afterRun, cancel, wakeNow, onUserMessage, hydrate, recordFor, tick, arm, dispatch, setEnabled, isEnabled: enabled };
  }

  return { COUNTDOWN_MS, latestGoal, latestRun, shouldReview, stepsFromTimeline, reviewPayload, decide, wakeText, displayFor, remaining, createController };
});
