(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZWdMonitor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_EVENTS = 30;
  const HEALTH_STATES = new Set(['working', 'waiting_user', 'overdue', 'unknown', 'silent', 'completed']);
  const PHASES = new Set(['waiting', 'observing', 'disabled', 'completed', 'error']);
  const OUTCOMES = new Set(['completed', 'interrupted', 'error']);
  const DELIVERIES = new Set(['pending', 'delivered', 'failed', 'queued', 'not-needed']);
  const RULES = Object.freeze({
    R1_loop: '重复操作',
    R2_saturation: '探索趋于饱和',
    R3_stale_strategy: '策略长期未变',
    R4_goal_drift: '偏离任务目标',
    R5_stale_verification: '验证结果需要更新',
    model_observer: '模型观察判断'
  });
  const ACTIONS = Object.freeze({ observe: '判断为不介入', advise: '建议', remind: '提醒', escalate: '升级提醒', halt: '请求停止' });
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

  function normalizeHealth(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const tool = value.tool && typeof value.tool === 'object' && !Array.isArray(value.tool) ? value.tool : null;
    return {
      state: HEALTH_STATES.has(value.state) ? value.state : 'unknown',
      checkedAt: count(value.checkedAt ?? value.ts), lastProgressAt: count(value.lastProgressAt),
      message: text(value.message), waitingPermissions: count(value.waitingPermissions), waitingQuestions: count(value.waitingQuestions),
      tool: tool ? { callId: text(tool.callId, 300), name: text(tool.name, 200), status: text(tool.status, 40),
        startedAt: count(tool.startedAt), timeoutMs: count(tool.timeoutMs), deadlineAt: count(tool.deadlineAt),
        lastProgressAt: count(tool.lastProgressAt) } : null
    };
  }

  function normalizeHealthEvents(value) {
    const records = new Map();
    for (const raw of Array.isArray(value) ? value : []) {
      const health = normalizeHealth(raw);
      if (!health) continue;
      const id = text(raw.id, 300) || JSON.stringify([health.checkedAt, health.state, health.tool?.callId, health.message]);
      records.set(id, { ...health, id, ts: count(raw.ts) });
    }
    return [...records.values()].slice(-MAX_EVENTS);
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
      interventions: count(value.interventions), observations: count(value.observations), streak: count(value.streak),
      updatedAt: count(value.updatedAt), events: events.slice(-MAX_EVENTS),
      health: normalizeHealth(value.health), healthEvents: normalizeHealthEvents(value.healthEvents),
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
    if (event?.type === 'z.thrash.watchdog.status') {
      const next = normalizeSnapshot(data);
      if (next && snapshot?.updatedAt != null && next.updatedAt != null
        && next.updatedAt < snapshot.updatedAt) return snapshot;
      return next || snapshot || null;
    }
    if (event?.type !== 'z.thrash.watchdog') return snapshot || null;
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
      delivered: '提醒已送达模型', failed: '提醒发送失败', 'not-needed': '未向主 Agent 发送提示', unknown: '送达状态未记录'
    }[delivery] || '送达状态未记录';
  }

  function healthTitle(health) {
    if (!health) return '等待运行巡检';
    if (health.state === 'working') return health.tool ? '等待工具返回' : '执行中';
    if (health.state === 'waiting_user') return health.waitingPermissions > 0 ? '等待用户授权' : '等待用户回复';
    return { overdue: '工具等待超出声明时限', unknown: '运行状态待确认',
      silent: '等待模型进展', completed: '本轮已结束' }[health.state];
  }

  function healthDuration(value) {
    if (value == null || !Number.isFinite(value) || value < 0) return '未记录';
    const units = [[3_600_000, '小时'], [60_000, '分钟'], [1000, '秒'], [1, '毫秒']];
    const [unit, label] = units.find(([unit]) => value >= unit) || units.at(-1);
    return `${Number((value / unit).toFixed(1))} ${label}`;
  }

  function healthTimestamp(value) {
    const date = value > 0 ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString('sv-SE') : '未记录';
  }

  function healthView(snapshot, mode) {
    const health = snapshot?.health;
    const facts = [];
    if (health) {
      if (health.tool) {
        facts.push({ label: '等待工具', value: health.tool.name || '工具名称未记录' });
        if (health.tool.startedAt > 0 && health.checkedAt >= health.tool.startedAt) {
          facts.push({ label: '至最近巡检已等待', value: healthDuration(health.checkedAt - health.tool.startedAt) });
        }
        facts.push({ label: '声明时限', value: health.tool.timeoutMs > 0 ? healthDuration(health.tool.timeoutMs) : '未声明' });
      }
      facts.push({ label: '最近实际进展', value: healthTimestamp(health.lastProgressAt) },
        { label: '最近巡检', value: healthTimestamp(health.checkedAt) });
    }
    return {
      state: health?.state || 'unrecorded',
      title: health ? healthTitle(health) : mode === 'history' ? '此轮没有运行巡检记录'
        : mode === 'empty' ? '等待任务开始' : '等待运行巡检',
      message: health?.message || '', facts,
      historical: mode === 'history' && !!health,
      caution: !!health?.tool && ['overdue', 'unknown'].includes(health.state),
      events: [...(snapshot?.healthEvents || [])].reverse().map(event => ({ ...event, title: healthTitle(event) }))
    };
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
    const checkedAfterEvent = !snapshot?.model && snapshot?.judgedSteps != null
      && latest?.step != null && snapshot.judgedSteps > latest.step;
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
      mode, phase, title, description, health: healthView(snapshot, mode),
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
        : snapshot?.interventions === 0 ? '目前没有触发观察者提醒。'
          : '此处只展示已接收到的真实记录。'
    };
  }

  // Observer eye: a persistent SVG above the status card. Its expression follows
  // the run (data-eye): resting with no task, closed once a run has stopped,
  // verifying while the end-of-turn review runs, watching a live run between
  // checks, pondering while the model judges, then briefly assured (judged, no
  // need to step in) or speaking (a reminder or a wake), and alarmed on errors.
  // It is kept across renders so blinks and gaze never reset.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FLARE_ACTIONS = new Set(['remind', 'escalate', 'halt']);
  const ASSURE_ACTIONS = new Set(['observe']);
  const WAKE_VERDICTS = new Set(['pending', 'scheduled']);
  const CALM_VERDICTS = new Set(['achieved', 'needs_user', 'uncertain']);
  const TRACKING = new Set(['watching', 'resting']);
  const shells = new WeakMap();
  const tracked = new WeakSet();
  const ALMOND = 'M48 70C80 35 160 35 192 70C160 101 80 101 48 70Z';
  let eyeSerial = 0;

  function eyeState(view, selection = {}) {
    if (view.mode === 'empty') return 'resting';
    const completion = selection.completion?.status;
    if (completion === 'reviewing') return 'verifying';
    if (completion === 'pending') return 'watching';
    if (completion === 'scheduled') return 'resting';
    if (view.mode !== 'live' || view.phase === 'disabled') return 'closed';
    if (view.phase === 'error') return 'alarmed';
    return normalizeSnapshot(selection.snapshot)?.model?.phase === 'reviewing' ? 'pondering' : 'watching';
  }

  function buildEye(document) {
    if (typeof document.createElementNS !== 'function') return null;
    const id = `wdEye${++eyeSerial}`;
    const svg = (tag, attrs, parent) => {
      const element = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
      parent?.append(element);
      return element;
    };
    const root = svg('svg', { class: 'wd-eye', viewBox: '0 0 240 140', 'aria-hidden': 'true', focusable: 'false' });
    const defs = svg('defs', {}, root);
    // Gradient stops are coloured by class, so state and theme changes recolour them in CSS.
    const gradient = (tag, name, attrs, stops) => {
      const grad = svg(tag, { id: `${id}${name}`, ...attrs }, defs);
      stops.forEach(([offset, tone, opacity]) => svg('stop', { offset, class: `wd-stop-${tone}`, 'stop-opacity': opacity }, grad));
    };
    gradient('radialGradient', 'Glow', {}, [['0', 'halo', '.5'], ['.45', 'halo', '.16'], ['1', 'halo', '0']]);
    gradient('radialGradient', 'Fade', { gradientUnits: 'userSpaceOnUse', cx: 120, cy: 70, r: 70 }, [['.5', 'halo', '.9'], ['1', 'halo', '0']]);
    gradient('radialGradient', 'Iris', {}, [['.3', 'light', '1'], ['.48', 'eye', '1'], ['.84', 'eye', '1'], ['1', 'deep', '1']]);
    gradient('radialGradient', 'White', { cy: '.42', r: '.62' }, [['.55', 'white', '1'], ['1', 'white-edge', '1']]);
    gradient('linearGradient', 'Shade', { x1: 0, y1: 0, x2: 0, y2: 1 }, [['.18', 'ink', '.38'], ['.5', 'ink', '0']]);
    svg('path', { d: ALMOND }, svg('clipPath', { id: `${id}Clip` }, defs));
    const at = (r, angle) => [120 + r * Math.cos(angle), 70 + r * Math.sin(angle)];
    const pt = ([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`;
    svg('circle', { class: 'wd-eye-glow', cx: 120, cy: 70, r: 70, fill: `url(#${id}Glow)` }, root);
    // Glory: 16 tapered beams alternate with 16 flame-like waves, as on a monstrance.
    const rays = svg('g', { class: 'wd-eye-rays' }, root);
    let beams = '', flames = '';
    for (let i = 0; i < 32; i += 1) {
      const angle = i * Math.PI / 16 - Math.PI / 2;
      if (i % 2) {
        flames += `M${pt(at(41, angle))}Q${pt(at(45, angle + 0.045))} ${pt(at(49, angle))}T${pt(at(57, angle))}T${pt(at(64, angle))}`;
      } else {
        const reach = i % 4 ? 61 : 69;
        beams += `M${pt(at(39, angle - 0.042))}L${pt(at(reach, angle))}L${pt(at(39, angle + 0.042))}Z`;
      }
    }
    svg('path', { class: 'wd-eye-beams', d: beams, fill: `url(#${id}Fade)` }, rays);
    svg('path', { class: 'wd-eye-flames', d: flames, stroke: `url(#${id}Fade)` }, rays);
    svg('circle', { class: 'wd-eye-ring', cx: 120, cy: 70, r: 66 }, root);
    svg('circle', { class: 'wd-eye-sweep', cx: 120, cy: 70, r: 66 }, root);
    let ticks = '';
    for (let i = 0; i < 72; i += 1) ticks += `M${pt(at(i % 6 ? 64 : 62, i * Math.PI / 36))}L${pt(at(66, i * Math.PI / 36))}`;
    svg('path', { d: ticks }, svg('g', { class: 'wd-eye-dial' }, root));
    svg('circle', { class: 'wd-eye-orbit', cx: 120, cy: 70, r: 47 }, root);
    const star = (x, y, s) => {
      const p = (dx, dy) => pt([x + dx, y + dy]);
      return `M${p(0, -s)}Q${p(0, 0)} ${p(s, 0)}Q${p(0, 0)} ${p(0, s)}Q${p(0, 0)} ${p(-s, 0)}Q${p(0, 0)} ${p(0, -s)}Z`;
    };
    [[178, 22, 4.2], [56, 26, 3], [196, 112, 3.2], [40, 104, 2.4]].forEach(([x, y, s], index) =>
      svg('path', { class: 'wd-eye-spark', d: star(x, y, s), style: `--wd-spark-delay:${index * -1.3}s` }, root));
    svg('path', { class: 'wd-eye-crease', d: 'M80 42C104 31 136 31 160 42' }, root);
    // One ring sweeps outward when a check ends: soft for "no need to step in", sharp for a reminder.
    svg('circle', { class: 'wd-eye-wave', cx: 120, cy: 70, r: 50 }, root);
    // The lid squeezes this group vertically: half-open at rest, a line when closed.
    const ball = svg('g', { class: 'wd-eye-ball' }, root);
    svg('path', { class: 'wd-eye-white', d: ALMOND, fill: `url(#${id}White)` }, ball);
    const inner = svg('g', { 'clip-path': `url(#${id}Clip)` }, ball);
    const gaze = svg('g', { class: 'wd-eye-gaze' }, inner);
    svg('circle', { class: 'wd-eye-iris', cx: 120, cy: 70, r: 26, fill: `url(#${id}Iris)` }, gaze);
    // Iris texture: jittered light and dark strands, a ragged collarette and a dark limbal ring.
    const jitter = seed => { const x = Math.sin(seed * 91.7) * 4375.85; return x - Math.floor(x); };
    let light = '', dark = '', collarette = '';
    for (let i = 0; i < 64; i += 1) {
      const angle = (i + jitter(i) * 0.6) * Math.PI / 32;
      const strand = `M${pt(at(10.5 + jitter(i + 7) * 2, angle))}L${pt(at(19 + jitter(i + 3) * 5.5, angle + (jitter(i + 5) - 0.5) * 0.08))}`;
      if (i % 2) dark += strand; else light += strand;
    }
    for (let i = 0; i < 28; i += 1) collarette += `${i ? 'L' : 'M'}${pt(at(13.2 + (jitter(i + 11) - 0.5) * 2.4, i * Math.PI / 14))}`;
    svg('path', { class: 'wd-eye-strands-light', d: light }, gaze);
    svg('path', { class: 'wd-eye-strands-dark', d: dark }, gaze);
    svg('path', { class: 'wd-eye-collarette', d: `${collarette}Z` }, gaze);
    svg('circle', { class: 'wd-eye-limbus', cx: 120, cy: 70, r: 25.2 }, gaze);
    svg('circle', { class: 'wd-eye-pupil', cx: 120, cy: 70, r: 9 }, gaze);
    // The upper-lid shadow falls on sclera and iris alike; corneal glints sit above it.
    svg('rect', { class: 'wd-eye-shade', x: 40, y: 34, width: 160, height: 72, fill: `url(#${id}Shade)` }, inner);
    const glints = svg('g', { class: 'wd-eye-gaze' }, inner);
    svg('ellipse', { class: 'wd-eye-glint', cx: 129, cy: 60.5, rx: 4.6, ry: 3.1, transform: 'rotate(-28 129 60.5)' }, glints);
    svg('circle', { class: 'wd-eye-glint wd-eye-glint-soft', cx: 110.5, cy: 80, r: 1.7 }, glints);
    svg('path', { class: 'wd-eye-lid', d: 'M48 70C80 35 160 35 192 70' }, ball);
    svg('path', { class: 'wd-eye-lid wd-eye-lid-low', d: 'M48 70C80 101 160 101 192 70' }, ball);
    svg('path', { class: 'wd-eye-wing', d: 'M48 70Q41 67.6 35.5 63.2M192 70Q199 67.6 204.5 63.2' }, ball);
    // A closed eye is drawn as a downcast curve instead of a squeezed ball.
    svg('path', { class: 'wd-eye-sleep', d: 'M48 70C80 90 160 90 192 70M48 70Q41 67.6 35.5 63.2M192 70Q199 67.6 204.5 63.2' }, root);
    return root;
  }

  function scheduleBlink(entry) {
    const view = entry.oracle.ownerDocument?.defaultView;
    if (!view?.setTimeout || entry.blinkTimer) return;
    const tick = () => {
      entry.blinkTimer = null;
      if (!entry.oracle.isConnected) return;
      const calm = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!calm && !view.document?.hidden && ['watching', 'pondering', 'verifying'].includes(entry.oracle.dataset.eye)) {
        entry.oracle.dataset.blink = 'true';
        view.setTimeout(() => { delete entry.oracle.dataset.blink; }, 150);
        if (Math.random() < 0.18) {
          view.setTimeout(() => { entry.oracle.dataset.blink = 'true'; }, 330);
          view.setTimeout(() => { delete entry.oracle.dataset.blink; }, 470);
        }
      }
      entry.blinkTimer = view.setTimeout(tick, 2800 + Math.random() * 3800);
    };
    entry.blinkTimer = view.setTimeout(tick, 1600 + Math.random() * 2400);
  }
  // The eye follows the pointer while it is over the panel, only in calm states.
  function trackPointer(host) {
    if (tracked.has(host) || typeof host.addEventListener !== 'function') return;
    tracked.add(host);
    let frame = 0, last = null;
    const update = () => {
      frame = 0;
      const entry = shells.get(host);
      const stage = entry?.oracle;
      if (!stage?.isConnected || !last || !TRACKING.has(stage.dataset.eye)) return;
      const box = stage.getBoundingClientRect();
      const clamp = value => Math.max(-1, Math.min(1, value));
      const dx = clamp((last.clientX - (box.left + box.width / 2)) / (box.width * 0.75));
      const dy = clamp((last.clientY - (box.top + box.height / 2)) / (box.height * 1.6));
      stage.style.setProperty('--wd-gaze-x', `${(dx * 12).toFixed(1)}px`);
      stage.style.setProperty('--wd-gaze-y', `${(dy * 6).toFixed(1)}px`);
    };
    host.addEventListener('pointermove', event => {
      last = event;
      if (!frame) frame = (host.ownerDocument.defaultView?.requestAnimationFrame || (fn => setTimeout(fn, 16)))(update);
    });
    host.addEventListener('pointerleave', () => {
      last = null;
      const stage = shells.get(host)?.oracle;
      stage?.style.removeProperty('--wd-gaze-x');
      stage?.style.removeProperty('--wd-gaze-y');
    });
  }

  // header | eye | body. Only header and body children are rebuilt per render.
  function ensureShell(host, document) {
    const known = shells.get(host);
    if (known && known.monitor.parentNode === host && host.children?.length === 1) return known;
    if (known?.flareTimer) clearTimeout(known.flareTimer);
    const make = (tag, className) => { const element = document.createElement(tag); element.className = className; return element; };
    const entry = { monitor: make('div', 'wd-monitor'), header: make('header', 'wd-header'),
      oracle: make('div', 'wd-oracle'), body: make('div', 'wd-body'), runKey: null, lastEventId: null };
    entry.oracle.setAttribute('aria-hidden', 'true');
    const eye = buildEye(document);
    if (eye) entry.oracle.append(eye);
    entry.monitor.append(entry.header, entry.oracle, entry.body);
    host.replaceChildren(entry.monitor);
    shells.set(host, entry);
    trackPointer(host);
    return entry;
  }
  function applyEye(entry, expression) {
    const oracle = entry.oracle;
    if (oracle.dataset.eye === expression) return;
    oracle.dataset.eye = expression;
    if (!TRACKING.has(expression)) {
      oracle.style?.removeProperty?.('--wd-gaze-x');
      oracle.style?.removeProperty?.('--wd-gaze-y');
    }
  }

  // A judgement that arrives while the run is live shows briefly on the eye:
  // "speaking" for a reminder (glow flares, pupil narrows, gaze turns to the
  // conversation), "assured" for a check that decided not to step in (a slow
  // blink and a soft halo). Opening a panel or switching runs only records the
  // latest event and never flares.
  function updateEye(entry, view, selection) {
    const base = eyeState(view, selection);
    const latest = normalizeSnapshot(selection?.snapshot)?.events?.at(-1) || null;
    const runKey = `${selection?.sessionId || ''}|${selection?.key || ''}`;
    const fresh = entry.runKey === runKey && !!latest && latest.id !== entry.lastEventId;
    const win = entry.oracle.ownerDocument?.defaultView;
    if (entry.runKey !== runKey && entry.flareTimer) { win?.clearTimeout(entry.flareTimer); entry.flareTimer = null; entry.flare = null; }
    // The end-of-turn review speaks when it decides to wake the agent and is assured when it does not.
    const completion = selection?.completion?.status || null;
    const reviewed = entry.lastCompletion === 'reviewing' && completion !== 'reviewing';
    Object.assign(entry, { runKey, lastEventId: latest?.id ?? null, base, lastCompletion: completion });
    const live = fresh && view.mode === 'live';
    const flare = (live && FLARE_ACTIONS.has(latest.action)) || (reviewed && WAKE_VERDICTS.has(completion)) ? 'speaking'
      : (live && ASSURE_ACTIONS.has(latest.action)) || (reviewed && CALM_VERDICTS.has(completion)) ? 'assured' : null;
    // A reminder is never cut short by a calmer verdict that lands right after it.
    if (flare && win?.setTimeout && !(flare === 'assured' && entry.flare === 'speaking')) {
      if (entry.flareTimer) win.clearTimeout(entry.flareTimer);
      entry.flare = flare;
      entry.flareTimer = win.setTimeout(() => { entry.flareTimer = null; entry.flare = null; applyEye(entry, entry.base); }, 2600);
    }
    applyEye(entry, entry.flareTimer ? entry.flare : base);
    scheduleBlink(entry);
  }

  const COMPLETION = Object.freeze({
    reviewing: ['正在核验目标', '本轮已自然结束，观察者正在核验目标是否达成。'],
    achieved: ['目标已达成', ''], needs_user: ['等待你的回复', ''], uncertain: ['无法确认是否完成', ''],
    error: ['本轮未核验', ''], pending: ['即将唤醒主 Agent', ''], scheduled: ['已安排稍后唤醒', ''],
    expired: ['定时唤醒已过期', 'Z 关闭期间到了唤醒时间，没有自动执行。'], limit: ['已达到连续唤醒上限', ''],
    sent: ['已唤醒主 Agent', ''], cancelled: ['已取消唤醒', ''], superseded: ['你已接手，未唤醒', ''], failed: ['唤醒没有发出', '']
  });

  // End-of-turn review card: verdict, reason, what is left and the wake controls.
  function completionCard(node, record) {
    const known = record?.status && COMPLETION[record.status];
    if (!known) return null;
    const card = node('section', 'wd-completion');
    card.dataset.status = record.status;
    card.append(node('h3', 'wd-section-heading', '收尾核验'), node('p', 'wd-completion-title', known[0]));
    const detail = ['error', 'failed'].includes(record.status) ? record.error : record.reason;
    if (detail || known[1]) card.append(node('p', 'wd-completion-reason', text(detail, 600) || known[1]));
    const waiting = ['pending', 'scheduled', 'expired', 'limit'].includes(record.status);
    if (waiting && Array.isArray(record.unmet) && record.unmet.length) {
      const list = node('ul', 'wd-completion-unmet');
      record.unmet.slice(0, 5).forEach(item => list.append(node('li', '', text(item, 300))));
      card.append(list);
    }
    if (['pending', 'scheduled'].includes(record.status) && record.dueAt > 0) {
      const due = node('p', 'wd-completion-due', globalThis.ZObserverCompletion?.remaining(record.dueAt - Date.now()) || '即将唤醒');
      due.dataset.observerDue = String(record.dueAt);
      card.append(due);
    }
    if (record.status === 'limit') {
      card.append(node('p', 'wd-completion-reason', `观察者已连续唤醒 ${count(record.maxWakes) || 3} 次，仍判断未完成，交给你决定。`));
    }
    if (waiting && record.followUp) {
      const details = node('details', 'wd-completion-followup');
      details.append(node('summary', '', '续做指令'), node('p', '', text(record.followUp, 2000)));
      card.append(details);
    }
    const buttons = [];
    const button = (label, act) => {
      const element = node('button', 'wd-completion-button', label);
      element.type = 'button'; element.dataset.observerCompletion = act;
      buttons.push(element);
    };
    if (['pending', 'scheduled'].includes(record.status)) { button('立即唤醒', 'wake'); button('取消', 'cancel'); }
    else if (record.status === 'reviewing') button('取消核验', 'cancel');
    else if (record.status === 'expired') button('唤醒', 'wake');
    else if (record.status === 'limit') button('继续一次', 'wake');
    if (buttons.length) { const actions = node('div', 'wd-completion-actions'); actions.append(...buttons); card.append(actions); }
    return card;
  }

  function render(host, selection) {
    if (!host?.ownerDocument) return;
    const document = host.ownerDocument;
    const view = viewModel(selection);
    const keepHealthHistoryOpen = host.dataset.wdSessionId === selection?.sessionId
      && host.dataset.wdRunKey === selection?.key && host.querySelector?.('.wd-health-history')?.open === true;
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
    const shell = ensureShell(host, document);
    const header = shell.header;
    header.replaceChildren();
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
    const health = node('section', 'wd-health');
    health.dataset.state = view.health.state;
    health.append(node('h3', 'wd-section-heading', '运行巡检'), node('p', 'wd-health-title', view.health.title));
    if (view.health.historical) health.append(node('p', 'wd-health-caption', '该轮保留的最后巡检'));
    if (view.health.message) health.append(node('p', 'wd-health-message', view.health.message));
    const facts = node('dl', 'wd-health-facts');
    view.health.facts.forEach(fact => {
      const row = node('div', 'wd-health-fact');
      row.append(node('dt', '', fact.label), node('dd', '', fact.value)); facts.append(row);
    });
    health.append(facts);
    if (view.health.caution) health.append(node('p', 'wd-health-caution',
      '请先保留已有产物并核对后台任务；如需中断，可使用对话中的“停止”，确认后再继续。'));
    health.append(node('p', 'wd-health-caption', '仅记录执行状态；不计入模型判断或介入次数，也不会自动发送引导或停止任务。'));
    if (view.health.events.length) {
      const history = node('details', 'wd-health-history');
      history.open = keepHealthHistoryOpen;
      history.append(node('summary', '', `巡检记录（${view.health.events.length}）`));
      const timeline = node('ol', 'wd-health-timeline');
      view.health.events.forEach(event => {
        const item = node('li', 'wd-health-event');
        item.dataset.state = event.state;
        item.append(node('strong', '', event.title), node('time', 'wd-health-time', healthTimestamp(event.ts)));
        if (event.tool?.name) item.append(node('span', 'wd-health-tool', event.tool.name));
        if (event.message) item.append(node('p', 'wd-health-message', event.message));
        timeline.append(item);
      });
      history.append(timeline); health.append(history);
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
    const heading = node('h3', 'wd-section-heading', '观察时间线');
    heading.append(node('span', 'wd-event-count', `${view.events.length} 条记录`));
    events.append(heading);
    const totalRecords = (count(selection?.snapshot?.interventions) || 0) + (count(selection?.snapshot?.observations) || 0);
    if (totalRecords > view.events.length) {
      events.append(node('p', 'wd-history-caption', `本轮共 ${totalRecords} 条观察记录，保留最近 ${view.events.length} 条。`));
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
    // The status card sits under the eye and reads as what the observer is doing.
    const completion = completionCard(node, selection?.completion);
    shell.body.replaceChildren(status, ...(completion ? [completion] : []), history, health, stats, latest, events,
      node('footer', 'wd-footer', '观察者关注执行过程并发出提醒，不保证答案或解题结果正确。'));
    updateEye(shell, view, selection);
    host.dataset.wdState = view.phase;
    host.dataset.wdSessionId = selection?.sessionId || '';
    host.dataset.wdRunKey = selection?.key || '';
  }

  return { MAX_EVENTS, normalizeSnapshot, normalizeHealth, reduce, finish, availableRuns, selectSession, viewModel, eyeState, ruleName, deliveryLabel, render };
});
