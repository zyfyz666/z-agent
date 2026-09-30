'use strict';

// Turn agent transcripts into watchdog steps {op, target, plan, mutated?, verify?}.
// `plan` is the assistant's own text (or visible reasoning) right before the
// call: its stated intent, or "" when it said nothing.

const SKIP = new Set(['todowrite', 'todoread']);
const MUTATING = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'patch', 'str_replace', 'fs_write']);
const SHELL = new Set(['bash', 'shell', 'powershell', 'execute_bash']);
const SEARCH = new Set(['grep', 'glob', 'search', 'grep_search', 'file_search', 'codesearch']);
const WRITE_CMD_RE = /\b(?:set-content|out-file|add-content|new-item|remove-item|move-item|copy-item|tee|touch|mv|cp|rm)\b|\bsed\s+-i\b|(?:^|[\s;&|])(?:echo|printf|cat)\b[^\n]*>/i;
const VERIFY_CMD_RE = /\b(?:pytest|jest|vitest|mocha|tox|nox|ctest|phpunit|rspec|unittest|tsc|eslint|ruff|mypy|pyright|flake8|node\s+--test|go\s+(?:test|vet|build)|cargo\s+(?:test|check|build|clippy)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck|check)|make\s+(?:test|check|build)|mvn\s+(?:test|verify|package)|gradlew?\s+(?:test|build|check)|dotnet\s+(?:test|build))\b/i;
const EXIT_RE = /(?:^|\n)\s*(?:error:\s*)?exit(?:ed with)?\s*code[:\s]+(-?\d+)/i;

function clip(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? t.slice(-300) : t;
}

const TARGET_KEYS = ['filePath', 'file_path', 'path', 'notebook_path', 'url', 'command', 'cmd', 'query', 'pattern', 'description', 'name'];
// Arguments that never change what a call does.
const IGNORED_KEYS = new Set(['description', 'explanation', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox']);

const pickKey = (obj, keys) => keys.find(k => obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim());

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// An action's identity. `target` is the resource it works on (search tools keep
// both the pattern and the scope). `detail` hashes every other meaningful
// argument, so different edits to one file, or reads of different pages of it,
// are not mistaken for a loop. Novelty uses the target alone.
function identify(tool, input) {
  const a = input && typeof input === 'object' ? input : {};
  const used = (SEARCH.has(String(tool).toLowerCase())
    ? [pickKey(a, ['pattern', 'query', 'q', 'regex']), pickKey(a, ['path', 'include', 'glob', 'includePattern'])]
    : [pickKey(a, TARGET_KEYS)]).filter(Boolean);
  const raw = used.length ? used.map(k => String(a[k])).join(' in ') : JSON.stringify(a);
  const norm = raw.replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
  const rest = Object.entries(a)
    .filter(([k, v]) => !used.includes(k) && !IGNORED_KEYS.has(k) && v !== undefined && v !== null && v !== '');
  if (norm.length > 160) rest.push(['', norm]); // the target is truncated: keep the full value distinct
  return { target: norm.slice(0, 160), detail: rest.length ? fnv1a(JSON.stringify(rest)) : '' };
}

const targetOf = (tool, input) => identify(tool, input).target;

function makeStep(tool, input, plan) {
  const { target, detail } = identify(tool, input);
  const step = { op: String(tool), target, plan };
  if (detail) step.detail = detail;
  return step;
}

// passed | failed | null, from a tool status, an explicit exit code, or output text.
function statusOf(status, exitCode, text, assumeOk) {
  if (status === 'error') return 'failed';
  if (status !== 'completed') return null;
  if (exitCode !== undefined && exitCode !== null && exitCode !== '' && Number.isFinite(Number(exitCode))) {
    return Number(exitCode) === 0 ? 'passed' : 'failed';
  }
  const s = String(text || '');
  const m = EXIT_RE.exec(s.slice(0, 200)) || EXIT_RE.exec(s.slice(-400));
  if (m) return Number(m[1]) === 0 ? 'passed' : 'failed';
  return assumeOk ? 'passed' : null;
}

function resolveStep(step, tool, input, status, { exitCode, text, assumeOk, classified } = {}) {
  const t = String(tool).toLowerCase();
  if (status === 'completed' && MUTATING.has(t)) step.mutated = true;
  if (!SHELL.has(t)) return step;
  const cmd = String(input.command ?? input.cmd ?? '');
  if (status === 'completed' && WRITE_CMD_RE.test(cmd)) step.mutated = true;
  const verify = classified !== undefined ? classified
    : VERIFY_CMD_RE.test(cmd) ? statusOf(status, exitCode, text, assumeOk) : null;
  if (verify) step.verify = verify;
  return step;
}

// opencode session messages ({info:{role}, parts:[...]}), as returned by the
// opencode SDK. `classify(part)` may override verification: 'passed' | 'failed' | null.
function fromOpencodeMessages(messages, { classify } = {}) {
  const steps = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.info?.role !== 'assistant') continue;
    let plan = '';
    for (const part of m.parts || []) {
      if ((part?.type === 'text' || part?.type === 'reasoning') && part.text) {
        plan = clip(part.text);
        continue;
      }
      if (part?.type !== 'tool' || !part.tool || SKIP.has(String(part.tool).toLowerCase())) continue;
      const st = part.state || {};
      const input = st.input || {};
      const step = makeStep(part.tool, input, plan);
      plan = ''; // stated once: parallel siblings must not look like a repeated plan
      resolveStep(step, part.tool, input, st.status, {
        exitCode: st.metadata?.exit ?? st.metadata?.exitCode,
        text: st.output,
        classified: classify ? classify(part) : undefined
      });
      steps.push(step);
    }
  }
  return steps;
}

function parseLines(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split('\n');
  const out = [];
  for (const line of lines) {
    if (line && typeof line === 'object') { out.push(line); continue; }
    if (!String(line).trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line while the file is being written */ }
  }
  return out;
}

// Claude Code transcript (.jsonl text or parsed events). Subagent events are skipped.
// `current` ({id, name, input, failed}) is the call a hook is running for: the
// transcript is written asynchronously, so it may be missing or unresolved there.
function fromClaudeTranscript(input, { current } = {}) {
  const steps = [];
  const pending = new Map();
  const seen = new Set();
  let plan = '';
  let msgId = null;
  for (const e of parseLines(input)) {
    if (e.isSidechain) continue;
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === 'assistant') {
      const id = e.message?.id || e.uuid;
      if (id !== msgId) { msgId = id; plan = ''; }
      for (const b of content) {
        if (b.type === 'text' && b.text) plan = clip(b.text);
        else if (b.type === 'thinking' && b.thinking) plan = clip(b.thinking);
        else if (b.type === 'tool_use' && b.name && !SKIP.has(String(b.name).toLowerCase())) {
          const step = makeStep(b.name, b.input, plan);
          plan = ''; // stated once: parallel siblings must not look like a repeated plan
          steps.push(step);
          seen.add(b.id);
          pending.set(b.id, { step, tool: b.name, input: b.input || {} });
        }
      }
    } else if (e.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
        const p = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        const text = Array.isArray(b.content) ? b.content.map(c => c?.text || '').join('\n') : b.content;
        resolveStep(p.step, p.tool, p.input, b.is_error ? 'error' : 'completed', { text, assumeOk: true });
      }
    }
  }
  if (current && current.id) {
    const status = current.failed ? 'error' : 'completed';
    const inp = current.input || {};
    if (pending.has(current.id)) {
      const p = pending.get(current.id);
      resolveStep(p.step, p.tool, p.input, status, { text: current.text, assumeOk: true });
    } else if (!seen.has(current.id) && current.name && !SKIP.has(String(current.name).toLowerCase())) {
      steps.push(resolveStep(makeStep(current.name, inp, ''), current.name, inp, status, { text: current.text, assumeOk: true }));
    }
  }
  return steps;
}

const TAG_RE = /<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi;

// The latest real user prompt with enough content to judge drift against ("" if none).
function claudeGoal(input) {
  const { tokenize } = require('./index');
  let goal = '';
  for (const e of parseLines(input)) {
    if (e.type !== 'user' || e.isMeta || e.isSidechain) continue;
    const c = e.message?.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    const t = text.replace(TAG_RE, '').trim();
    if (t && tokenize(t).size >= 3) goal = t.slice(0, 500);
  }
  return goal;
}

module.exports = {
  fromOpencodeMessages, fromClaudeTranscript, claudeGoal, identify, targetOf,
  parseJsonl: parseLines,
  // building blocks for live adapters
  clip, makeStep, resolveStep
};
