(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZWdMonitor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_EVENTS = 30;
  const PHASES = new Set(['waiting', 'observing', 'disabled', 'completed', 'error']);
  const OUTCOMES = new Set(['completed', 'interrupted', 'error']);
  const DELIVERIES = new Set(['pending', 'delivered', 'failed', 'queued']);
  const RULES = Object.freeze({
    R1_loop: '重复操作',
    R2_saturation: '探索趋于饱和',
    R3_stale_strategy: '策略长期未变',
    R4_goal_drift: '偏离任务目标',
    R5_stale_verification: '验证结果需要更新',
    model_observer: '模型观察建议'
  });
  const ACTIONS = Object.freeze({ advise: '建议', remind: '提醒', escalate: '升级提醒', halt: '请求停止' });
  const text = (value, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : '';
  const count = value => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : null;
  const labels = value => Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.slice(0, 120)))].slice(0, 20) : [];

  function normalizeEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const event = {
      id: text(value.id, 300), ts: count(value.ts), step: count(value.step),
      action: text(value.action, 80), rules: labels(value.rules), advisories: labels(value.advisories),
      severity: count(value.severity), streak: count(value.streak), message: text(value.message),
      delivery: DELIVERIES.has(value.delivery) ? value.delivery : 'unknown',
      deliveryError: text(value.deliveryError, 500)
    };
    if (!event.id) event.id = JSON.stringify([
      event.ts, event.step, event.action, event.rules, event.advisories, event.streak, event.message
    ]);
    return event;
  }

  function normalizeSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const events = [];
    const ids = new Map();
    for (const raw of Array.isArray(value.events) ? value.events : []) {
      const event = normalizeEvent(raw);
      if (!event) continue;
      if (ids.has(event.id)) events[ids.get(event.id)] = event;
      else { ids.set(event.id, events.length); events.push(event); }
    }
    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : null,
      phase: PHASES.has(value.phase) ? value.phase : 'waiting',
      outcome: OUTCOMES.has(value.outcome) ? value.outcome : '',
      judgeEvery: count(value.judgeEvery), observedSteps: count(value.observedSteps),
      judgedSteps: count(value.judgedSteps), checks: count(value.checks),
      interventions: count(value.interventions), streak: count(value.streak),
      updatedAt: count(value.updatedAt), events: events.slice(-MAX_EVENTS),
      partial: value.partial === true,
      model: value.model && typeof value.model === 'object' ? {
        name: text(value.model.name, 150), modelId: text(value.model.modelId, 200),
        phase: text(value.model.phase, 30), checks: count(value.model.checks),
        message: text(value.model.message, 1200), error: text(value.model.error, 200)
      } : null
    };
  }

  // Status events are authoritative snapshots, not increments. Replaying a
  // status or reconnecting therefore never adds a second intervention.
  function reduce(snapshot, event) {
    const data = event?.data || event?.properties || {};
    if (event?.type === 'yan.thrash.watchdog.status') {
      const next = normalizeSnapshot(data);
      if (next && snapshot?.updatedAt != null && next.updatedAt != null
        && next.updatedAt < snapshot.updatedAt) return snapshot;
      return next || snapshot || null;
    }
    if (event?.type !== 'yan.thrash.watchdog') return snapshot || null;
    const entry = normalizeEvent(data);
    if (!entry) return snapshot || null;
    const previous = normalizeSnapshot(snapshot) || normalizeSnapshot({ enabled: true, phase: 'observing', partial: true });
    const events = [...previous.events];
    const index = events.findIndex(item => item.id === entry.id);
    if (index >= 0) {
      const known = events[index];
      const terminalDelivery = ['delivered', 'failed'].includes(known.delivery);
      events[index] = {
        ...entry, ts: entry.ts ?? known.ts,
        delivery: terminalDelivery || entry.delivery === 'unknown' ? known.delivery : entry.delivery,
        deliveryError: entry.deliveryError || known.deliveryError
      };
    }
    else events.push(entry);
    return {
      ...previous,
      updatedAt: entry.ts == null ? previous.updatedAt : Math.max(previous.updatedAt || 0, entry.ts),
      events: events.slice(-MAX_EVENTS)
    };
  }

  function finish(snapshot, status) {
    const next = normalizeSnapshot(snapshot);
    if (!next) return null;
    const outcome = next.outcome || (status === 'interrupted' ? 'interrupted' : status === 'error' ? 'error' : 'completed');
    return { ...next, outcome, phase: next.phase === 'error' ? 'error'
      : next.enabled === false ? 'disabled' : outcome === 'error' ? 'error' : 'completed' };
  }

  function availableRuns(session, runCtx) {
    const savedRuns = new Map();
    let prompt = '';
    const offset = count(session?.messagesStart) || 0;
    const makeRun = (run, key, message, mode = 'history', status = run.status || 'done') => {
      const ts = count(run.startedAt) || count(message?.ts) || count(message?.timestamp) || count(run.completedAt);
      const date = ts ? new Date(ts) : null;
      const time = date && Number.isFinite(date.getTime())
        ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未记录';
      return { key, mode, status, snapshot: normalizeSnapshot(run.watchdog), timestamp: ts,
        label: `${time} · ${prompt || '任务记录'}` };
    };
    (session?.messages || []).forEach((message, index) => {
      if (message?.role === 'user') prompt = text(message.content, 200).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (message?.role !== 'assistant' || !message.agentRun) return;
      const run = message.agentRun;
      const key = run.runId ? `run:${run.runId}` : `message:${offset + index}`;
      savedRuns.delete(key);
      savedRuns.set(key, makeRun(run, key, message));
    });
    const runs = [...savedRuns.values()].reverse();
    if (session?.id && runCtx?.sessionId === session.id) {
      const run = runCtx.activeAgentRun || {};
      const snapshot = normalizeSnapshot(run.watchdog);
      const status = runCtx.shouldAbort ? 'interrupted' : runCtx.finalStatus
        || ({ completed: 'done', interrupted: 'interrupted', error: 'error' }[snapshot?.outcome]) || 'working';
      const key = `run:${runCtx.runId || run.runId || 'current'}`;
      const duplicate = runs.findIndex(item => item.key === key);
      if (duplicate >= 0) runs.splice(duplicate, 1);
      runs.unshift(makeRun({ ...run, startedAt: run.startedAt || runCtx.startedAt }, key, null,
        status === 'working' ? 'live' : 'history', status));
    }
    return runs;
  }

  function selectSession(session, runCtx, selectedKey = '') {
    const runs = availableRuns(session, runCtx);
    const selected = runs.find(run => run.key === selectedKey) || runs[0];
    return { ...(selected || { mode: 'empty', status: 'idle', snapshot: null }),
      runs, selectedKey: selectedKey && selected?.key === selectedKey ? selectedKey : '',
      sessionId: session?.id || '', hasEarlier: session?.messagesTruncated === true };
  }

  function ruleName(rule) { return RULES[rule] || `其他规则（${rule}）`; }
  function deliveryLabel(delivery) {
    return {
      pending: '正在发送提醒', queued: '提醒已排队 · 等待模型接收',
      delivered: '提醒已送达模型', failed: '提醒发送失败', unknown: '送达状态未记录'
    }[delivery] || '送达状态未记录';
  }

  function viewModel(selection = {}) {
    const { mode = 'empty' } = selection;
    const snapshot = normalizeSnapshot(selection.snapshot);
    const status = ['interrupted', 'error'].includes(selection.status) ? selection.status
      : ({ completed: 'done', interrupted: 'interrupted', error: 'error' }[snapshot?.outcome]) || selection.status || 'idle';
    const events = snapshot?.events || [];
    const latest = events.at(-1) || null;
    let phase = snapshot?.phase || (mode === 'live' ? 'waiting' : 'idle');
    if (snapshot && mode === 'history' && !['disabled', 'error'].includes(phase)) {
      phase = status === 'error' ? 'error' : 'completed';
    }
    const states = {
      idle: ['随时准备观察', '开始一个任务，观察者会在这里展示真实的检查和提醒记录。'],
      waiting: [snapshot ? '等待更多动作' : '等待观察者状态', snapshot
        ? '任务刚刚开始，观察者正在积累可判断的操作记录。'
        : '任务正在运行，尚未收到本轮的观察者数据。'],
      observing: ['正在观察执行过程', snapshot?.judgeEvery
        ? `每新增 ${snapshot.judgeEvery} 个动作检查一次，留意重复操作、策略停滞和验证时效。`
        : '正在观察操作模式，发现需要关注的迹象时会提醒模型。'],
      disabled: ['本轮未启用观察者', '此轮任务没有启用观察者，不会产生运行提醒。'],
      completed: [status === 'interrupted' ? '观察已停止' : '本轮观察已结束', '以下保留的是此轮任务的监控记录。'],
      error: status === 'error'
        ? ['任务运行出现异常', '此轮任务出现异常，监控记录保留在下方。请结合任务消息查看详情。']
        : ['观察者运行异常', '观察者的检查过程出现异常，已有记录保留在下方。请结合任务消息查看详情。']
    };
    let [title, description] = states[phase];
    if (mode === 'history' && !snapshot) {
      title = '此轮没有监控记录';
      description = '这段历史没有保存观察者数据，无法还原检测或介入次数。';
    }
    let latestTitle = '尚未形成判断';
    let latestDescription = mode === 'empty' ? '监控记录会随任务自动更新。' : '收到真实检查结果后会在这里显示。';
    let latestRules = [];
    const checkedAfterEvent = snapshot?.judgedSteps != null && latest?.step != null && snapshot.judgedSteps > latest.step;
    if (snapshot?.checks > 0 && (!latest || checkedAfterEvent)) {
      latestTitle = '最近检查没有触发新提醒';
      latestDescription = snapshot.judgedSteps == null ? '该轮检查已经完成。' : `已检查到会话第 ${snapshot.judgedSteps} 个动作。`;
    } else if (latest) {
      latestTitle = `${ACTIONS[latest.action] || '运行提醒'}${latest.step == null ? '' : ` · 第 ${latest.step} 个动作`}`;
      latestDescription = latest.message || '观察者发现了需要关注的操作模式。';
      latestRules = [...new Set([...latest.rules, ...latest.advisories])].map(ruleName);
    }
    if (phase === 'disabled') {
      latestTitle = '没有进行检测';
      latestDescription = '观察者在本轮保持关闭。';
    }
    return {
      mode, phase, title, description,
      stats: [
        { label: '检测轮次', value: snapshot?.checks ?? null },
        { label: '会话动作', value: snapshot?.observedSteps ?? null },
        { label: '介入次数', value: snapshot?.interventions ?? null }
      ],
      latestTitle, latestDescription, latestRules,
      events: [...events].reverse().map(event => ({
        ...event, actionLabel: ACTIONS[event.action] || '运行提醒',
        ruleLabels: [...new Set([...event.rules, ...event.advisories])].map(ruleName),
        deliveryLabel: deliveryLabel(event.delivery)
      })),
      emptyTitle: mode === 'empty' ? '让每一步都有方向' : snapshot?.interventions === 0 ? '本轮尚无介入' : '暂无可展示的提醒',
      emptyDescription: mode === 'empty'
        ? '你专注目标，观察者留意过程。开始对话后，检查进度与触发原因会在这里逐步展开。'
        : snapshot?.interventions === 0 ? '目前没有触发观察者提醒。任务仍由模型正常执行。'
          : '此处只展示已接收到的真实记录。'
    };
  }

  function render(host, selection) {
    if (!host?.ownerDocument) return;
    const document = host.ownerDocument;
    const view = viewModel(selection);
    const node = (tag, className, content) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (content !== undefined) element.textContent = content;
      return element;
    };
    const rules = values => {
      const list = node('div', 'wd-rule-list');
      values.forEach(value => list.append(node('span', 'wd-rule', value)));
      return list;
    };
    const monitor = node('div', 'wd-monitor');
    const header = node('header', 'wd-header');
    const mode = node('span', 'wd-mode', { live: '实时', history: '历史', empty: '待命' }[view.mode] || '待命');
    mode.dataset.mode = view.mode;
    header.append(node('span', 'wd-eyebrow', '观察者 / 运行状态'), mode);
    const configure = node('button', 'wd-config-button', '设置');
    configure.type = 'button'; configure.dataset.observerConfig = 'true';
    configure.setAttribute('aria-label', '观察者模型和检查间隔');
    header.append(configure);
    const history = node('div', 'wd-history');
    const historyLabel = node('label', 'wd-section-heading', '观察记录');
    historyLabel.htmlFor = 'wdHistorySelect';
    const select = node('select', 'wd-history-select');
    select.id = 'wdHistorySelect'; select.dataset.observerHistory = 'true';
    select.setAttribute('aria-label', '选择此对话的观察记录');
    const runs = selection?.runs || [];
    const current = node('option', '', runs[0]?.mode === 'live' ? '当前运行' : '最近一轮');
    current.value = ''; select.append(current);
    runs.forEach(run => {
      const option = node('option', '', `${run.label}${run.snapshot ? '' : ' · 无记录'}`);
      option.value = run.key; select.append(option);
    });
    select.value = selection?.selectedKey || '';
    select.disabled = !runs.length;
    history.append(historyLabel, select);
    if (selection?.label) history.append(node('p', 'wd-history-caption', selection.label));
    if (selection?.hasEarlier) {
      const earlier = node('button', 'wd-history-earlier', selection.earlierLoading ? '正在加载更早记录…' : '加载更早记录');
      earlier.type = 'button'; earlier.dataset.observerEarlier = 'true'; earlier.disabled = !!selection.earlierLoading;
      history.append(earlier);
    }
    const status = node('section', 'wd-status');
    status.dataset.state = view.phase;
    const dot = node('span', 'wd-status-dot');
    dot.setAttribute('aria-hidden', 'true');
    status.append(dot, node('h2', 'wd-status-title', view.title), node('p', 'wd-status-description', view.description));
    const model = normalizeSnapshot(selection?.snapshot)?.model;
    if (model) {
      const modelState = node('div', 'wd-model-state');
      modelState.dataset.phase = model.phase;
      const label = { waiting: '等待动作', reviewing: '正在判断', observing: '已完成判断', error: '规则模式继续工作', stopped: '本轮已结束' }[model.phase] || '等待动作';
      modelState.append(node('strong', '', `${model.name || model.modelId} · ${label}`),
        node('p', '', `模型检查 ${model.checks || 0} 次`));
      if (model.message) modelState.append(node('p', '', model.message));
      if (model.error) modelState.append(node('p', '', model.error));
      status.append(modelState);
    }
    const stats = node('dl', 'wd-stats');
    view.stats.forEach(stat => {
      const item = node('div', 'wd-stat');
      item.append(node('dt', '', stat.label), node('dd', '', stat.value == null ? '—' : String(stat.value)));
      stats.append(item);
    });
    const latest = node('section', 'wd-latest');
    latest.append(node('h3', 'wd-section-heading', '最近判断'), node('p', 'wd-latest-title', view.latestTitle),
      node('p', 'wd-latest-description', view.latestDescription));
    if (view.latestRules.length) latest.append(rules(view.latestRules));
    const events = node('section', 'wd-events');
    const heading = node('h3', 'wd-section-heading', '触发时间线');
    heading.append(node('span', 'wd-event-count', `${view.events.length} 条记录`));
    events.append(heading);
    if (selection?.snapshot?.interventions > view.events.length) {
      events.append(node('p', 'wd-history-caption', `本轮共 ${selection.snapshot.interventions} 次介入，保留最近 ${view.events.length} 条提醒。`));
    }
    if (view.events.length) {
      const timeline = node('ol', 'wd-timeline');
      view.events.forEach(event => {
        const item = node('li', 'wd-event');
        item.dataset.action = Object.hasOwn(ACTIONS, event.action) ? event.action : 'unknown';
        const marker = node('span', 'wd-event-marker');
        marker.setAttribute('aria-hidden', 'true');
        const body = node('div', 'wd-event-body');
        const meta = node('div', 'wd-event-meta');
        const stamp = event.ts == null ? null : new Date(event.ts);
        const validStamp = stamp && Number.isFinite(stamp.getTime());
        const time = node('time', 'wd-event-time', validStamp
          ? stamp.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '时间未记录');
        if (validStamp) { time.dateTime = stamp.toISOString(); time.title = stamp.toLocaleString('zh-CN'); }
        meta.append(node('span', 'wd-event-action', `${event.actionLabel}${event.step == null ? '' : ` · 动作 ${event.step}`}`), time);
        body.append(meta);
        if (event.ruleLabels.length) body.append(rules(event.ruleLabels));
        if (event.message) body.append(node('p', 'wd-event-message', event.message));
        const delivery = node('p', 'wd-delivery', event.deliveryLabel);
        delivery.dataset.delivery = event.delivery;
        body.append(delivery);
        if (event.delivery === 'failed' && event.deliveryError) body.append(node('p', 'wd-event-error', event.deliveryError));
        item.append(marker, body);
        timeline.append(item);
      });
      events.append(timeline);
    } else {
      const empty = node('div', 'wd-empty');
      const orbit = node('div', 'wd-empty-orbit', '·');
      orbit.setAttribute('aria-hidden', 'true');
      empty.append(orbit, node('h4', 'wd-empty-title', view.emptyTitle), node('p', 'wd-empty-description', view.emptyDescription));
      events.append(empty);
    }
    monitor.append(header, history, status, stats, latest, events,
      node('footer', 'wd-footer', '观察者关注执行过程并发出提醒，不保证答案或解题结果正确。'));
    host.replaceChildren(monitor);
    host.dataset.wdState = view.phase;
    host.dataset.wdSessionId = selection?.sessionId || '';
    host.dataset.wdRunKey = selection?.key || '';
  }

  return { MAX_EVENTS, normalizeSnapshot, reduce, finish, availableRuns, selectSession, viewModel, ruleName, deliveryLabel, render };
});
