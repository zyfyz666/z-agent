'use strict';

// Thrash detector core, JS port of python/src/thrash_watchdog/core.py.
// The Python package is the reference: spec/vectors.json (generated from it)
// must be reproduced field for field, including message text and markers.
// Result objects use the same snake_case fields as Python on purpose.

const crypto = require('node:crypto');
const CRITERIA = require('./criteria.json');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const sha256Hex = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const CRITERIA_SHA256 = sha256Hex(canonical(CRITERIA));
const WINDOW = CRITERIA.window;
const WARMUP = Math.max(CRITERIA.warmup, WINDOW);
const JUDGE_EVERY = CRITERIA.judge_every;
const RULES = CRITERIA.rules;
const TOK = CRITERIA.tokenizer;
const STOP = new Set(TOK.stopwords);
const CJK_STOP = new Set(TOK.cjk_stopwords);

const ASCII_RE = /[a-z0-9]+/g;
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g;

// [ASCII words >= ascii_min_len minus stopwords, CJK character bigrams]
function tokenizeByScript(text) {
  const low = String(text || '').toLowerCase();
  const ascii = new Set();
  for (const tok of low.match(ASCII_RE) || []) {
    if (tok.length >= TOK.ascii_min_len && !STOP.has(tok)) ascii.add(tok);
  }
  const cjk = new Set();
  for (const run of low.match(CJK_RE) || []) {
    const grams = run.length === 1 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2));
    for (const g of grams) if (!CJK_STOP.has(g)) cjk.add(g);
  }
  return [ascii, cjk];
}

function tokenize(text) {
  const [a, c] = tokenizeByScript(text);
  return new Set([...a, ...c]);
}

const normTarget = step => String(step.target || '').trim().toLowerCase().replace(/\\/g, '/');

// Identity of an action: op + normalized target (+ detail, e.g. an edit's content
// hash). `detail` separates different edits to one file; novelty uses the target alone.
function signature(step) {
  const sig = String(step.op || '').trim().toLowerCase() + ' ' + normTarget(step);
  const detail = String(step.detail || '').trim().toLowerCase();
  return detail ? sig + ' #' + detail : sig;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function planSimilarity(plans) {
  const sets = plans.map(tokenize).filter(s => s.size);
  if (sets.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < sets.length; i++) total += jaccard(sets[i - 1], sets[i]);
  return total / (sets.length - 1);
}

function novelRatio(steps, start, end) {
  const seen = new Set();
  let novel = 0;
  for (let i = 0; i < end; i++) {
    const tgt = normTarget(steps[i]);
    if (i >= start && tgt && !seen.has(tgt)) novel += 1;
    seen.add(tgt);
  }
  return end > start ? novel / (end - start) : 0;
}

function verificationState(steps) {
  let lastMut = -1;
  let lastPass = -1;
  steps.forEach((s, i) => {
    if (s.mutated === true) lastMut = i;
    if (String(s.verify || '').toLowerCase() === 'passed') lastPass = i;
  });
  return [lastMut, lastPass];
}

const r3 = x => Math.floor(x * 1000 + 0.5) / 1000;

function analyze(steps, goal = '') {
  const n = steps.length;
  if (n < WARMUP) {
    return { is_thrashing: false, rules: [], advisories: [], severity: 0, features: {}, messages: {}, reason: `warmup: ${n}/${WARMUP} steps` };
  }
  const start = n - WINDOW;
  const win = steps.slice(start, n);
  const dupCount = WINDOW - new Set(win.map(signature)).size;
  const dup = dupCount / WINDOW;
  const novel = novelRatio(steps, start, n);
  const plans = win.map(s => String(s.plan || ''));
  const planSim = planSimilarity(plans);
  const planAscii = new Set();
  const planCjk = new Set();
  for (const p of plans) {
    const [a, c] = tokenizeByScript(p);
    for (const t of a) planAscii.add(t);
    for (const t of c) planCjk.add(t);
  }
  const [goalAscii, goalCjk] = tokenizeByScript(goal);
  const r4 = RULES.R4_goal_drift;
  // Overlap per script: an English plan cannot overlap a Chinese goal lexically,
  // so a script only counts when both sides have enough tokens in it.
  const m = r4.min_tokens_per_script;
  const overlaps = [[planAscii, goalAscii], [planCjk, goalCjk]]
    .filter(([p, g]) => p.size >= m && g.size >= m).map(([p, g]) => jaccard(p, g));
  const goalOverlap = overlaps.length ? Math.max(...overlaps) : 1; // no shared script: never judge drift

  const rules = [];
  const advisories = [];
  const messages = {};
  const fire = (rule, text) => {
    (RULES[rule].advisory ? advisories : rules).push(rule);
    messages[rule] = text;
  };

  if (dup >= RULES.R1_loop.min_dup_in_window) {
    fire('R1_loop', `${dupCount} of your last ${WINDOW} actions repeat an earlier action on the ` +
      'same target. Repeating it is unlikely to give a different result.');
  }
  const k = RULES.R2_saturation.zero_novel_windows;
  if (n >= k * WINDOW && Array.from({ length: k }, (_, j) => novelRatio(steps, n - (j + 1) * WINDOW, n - j * WINDOW)).every(x => x === 0)) {
    fire('R2_saturation', `Your last ${k * WINDOW} actions touched nothing you had not already ` +
      'seen. New information has been near zero for a while.');
  }
  const r3r = RULES.R3_stale_strategy;
  if (planSim >= r3r.min_plan_sim && novel <= r3r.max_novel_ratio) {
    fire('R3_stale_strategy', 'Your stated approach has barely changed while new information is ' +
      'low. You may be varying the surface without changing strategy.');
  }
  if (goalOverlap === 0 && dup >= r4.min_dup_in_window) {
    fire('R4_goal_drift', 'Your recent actions are repetitive and share nothing with the stated ' +
      'goal. Restate the goal and check whether you are still serving it.');
  }
  const [lastMut, lastPass] = verificationState(steps);
  const age = n - 1 - lastMut;
  const stale = lastPass >= 0 && lastPass < lastMut && age >= RULES.R5_stale_verification.min_age;
  if (stale) {
    fire('R5_stale_verification', 'You changed files after the last passing check and have not ' +
      `re-run it in the ${age} steps since. Re-run it before relying on it.`);
  }
  return {
    is_thrashing: rules.length > 0,
    rules,
    advisories,
    severity: rules.length,
    features: {
      dup_in_window: r3(dup),
      novel_ratio: r3(novel),
      plan_sim: r3(planSim),
      goal_overlap: r3(goalOverlap),
      stale_pass: stale ? lastPass : -1
    },
    messages,
    reason: 'ok'
  };
}

// Map a verdict to an action: none | advise | remind | escalate | halt.
// Advisories never touch the streak and are dropped when their key (the stale
// pass index) is already in `advised`.
function decision(steps, goal = '', { streak = 0, allowHalt = false, advised = [], traceId = '' } = {}) {
  const v = analyze(steps, goal);
  const key = v.features.stale_pass ?? -1;
  let advisories = new Set(advised).has(key) ? [] : [...v.advisories];
  const esc = CRITERIA.escalation;
  let action;
  if (v.is_thrashing) {
    streak = Math.max(0, Math.trunc(Number(streak) || 0)) + 1;
    if (allowHalt && streak >= esc.halt_at) action = 'halt';
    else if (streak >= esc.escalate_at) action = 'escalate';
    else action = 'remind';
  } else {
    streak = 0;
    action = advisories.length ? 'advise' : 'none';
  }
  let parts;
  if (action === 'halt') {
    advisories = [];
    parts = [`HALT: thrashing has persisted for ${streak} consecutive checks. ` +
      'Stop the current approach and wait for human direction.'];
  } else {
    parts = v.rules.map(r => v.messages[r]);
    if (action === 'escalate') {
      parts.push(`This has persisted for ${streak} consecutive checks. Change strategy, ` +
        'or state in one line why this path can still work.');
    }
    parts.push(...advisories.map(r => v.messages[r]));
  }
  const payload = { action, rules: v.rules, advisories, severity: v.severity, streak, step: steps.length };
  if (traceId) payload.trace = traceId;
  return {
    action,
    rules: v.rules,
    advisories,
    severity: v.severity,
    streak,
    advisory_key: advisories.length ? key : -1,
    marker: action === 'none' ? '' : 'wd-watch: ' + JSON.stringify(payload),
    message: parts.join(' '),
    features: v.features
  };
}

// Stateful observer: judges every `judgeEvery` steps, tracks the streak, and
// delivers each advisory once. `state` is plain JSON so hook-style adapters
// (one process per tool call) can persist it between calls.
class Watchdog {
  constructor({ goal = '', judgeEvery = JUDGE_EVERY, allowHalt = false, traceId = '', state = null } = {}) {
    this.goal = goal;
    this.judgeEvery = Math.max(1, Math.trunc(Number(judgeEvery) || 1));
    this.allowHalt = allowHalt;
    this.traceId = traceId;
    this.state = { judged: 0, streak: 0, fires: 0, advised: [], ...(state || {}) };
    this.state.advised = [...this.state.advised];
  }

  observe(steps) {
    const st = this.state;
    const n = steps.length;
    if (n < st.judged) Object.assign(st, { judged: 0, streak: 0, advised: [] });
    if (n < WARMUP || n - st.judged < this.judgeEvery) return null;
    st.judged = n;
    const d = decision(steps, this.goal, { streak: st.streak, allowHalt: this.allowHalt, advised: st.advised, traceId: this.traceId });
    st.streak = d.streak;
    if (d.advisory_key >= 0) st.advised.push(d.advisory_key);
    if (d.action === 'none') return null;
    st.fires += 1;
    return d;
  }
}

module.exports = {
  CRITERIA, CRITERIA_SHA256, WINDOW, WARMUP, JUDGE_EVERY,
  canonical, sha256Hex, tokenize, tokenizeByScript, signature, analyze, decision, Watchdog
};
