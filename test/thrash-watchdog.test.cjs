'use strict';

// Yan adapter for the vendored thrash-watchdog core. The core itself is tested
// upstream against shared vectors; here we pin the vendored copy and test the
// Yan-specific glue (verification classification, observer, guidance, audit).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wd = require('../lib/thrash-watchdog');

const tool = (name, input, extra = {}) => ({ type: 'tool', tool: name, state: { status: 'completed', input, ...extra } });
const assistant = parts => ({ info: { role: 'assistant' }, parts });

test('vendored core is the pinned criteria version', () => {
  assert.strictEqual(wd.CRITERIA_SHA256, 'd2cc221b28a697d88f1e94574759ca38ff9682ecad253aa9a366f93cb11a5a42');
});

test('steps use the stated plan once and Yan verification classification', () => {
  const steps = wd.stepsFromMessages([
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
    assistant([
      { type: 'text', text: 'Read the loader, then fix it.' },
      tool('read', { filePath: 'SRC\\A.py' }, { output: 'x' }),
      tool('edit', { filePath: 'src/a.py', oldString: 'a', newString: 'b' }),
      tool('bash', { command: 'npm test' }, { output: 'ok\nexit code 0', metadata: { exit: 0 } })
    ])
  ]);
  assert.strictEqual(steps.length, 3);
  assert.deepStrictEqual(steps[0], { op: 'read', target: 'SRC/A.py', plan: 'Read the loader, then fix it.' });
  assert.strictEqual(steps[1].plan, '');
  assert.strictEqual(steps[1].mutated, true);
  assert.ok(steps[1].detail);
  assert.strictEqual(steps[2].verify, 'passed');
});

test('watcher speaks at judgement boundaries and escalates', () => {
  const watch = wd.createThrashWatch({ goal: 'find where the port is parsed', judgeEvery: 6 });
  const messages = [];
  const spoke = [];
  for (let i = 1; i <= 12; i++) {
    messages.push(assistant([tool('read', { filePath: 'src/config.py' })]));
    const d = watch.observe(messages);
    if (d) spoke.push([i, d.action, d.step]);
  }
  assert.deepStrictEqual(spoke, [[6, 'remind', 6], [12, 'escalate', 12]]);
  assert.strictEqual(watch.observe(messages), null); // no new calls: nothing to judge
});

test('guidance carries the message and the machine-readable marker', () => {
  const watch = wd.createThrashWatch({ judgeEvery: 6, traceId: 'run-1' });
  const d = watch.observe(Array.from({ length: 6 }, () => assistant([tool('read', { filePath: 'a' })])));
  const text = wd.thrashGuidance(d);
  assert.ok(text.startsWith('WD THRASH WATCHDOG (remind)'));
  assert.ok(text.includes('wd-watch: {'));
  assert.ok(text.includes('"trace":"run-1"'));
});

test('audit chain round trip', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-yan-')), 'audit.jsonl');
  const watch = wd.createThrashWatch({ judgeEvery: 6 });
  const messages = [];
  for (let i = 1; i <= 12; i++) {
    messages.push(assistant([tool('read', { filePath: 'a' })]));
    const d = watch.observe(messages);
    if (d) wd.appendAudit(file, d, { traceId: 'run-1', step: d.step });
  }
  assert.deepStrictEqual(wd.verifyChain(file), { ok: true, count: 2, specs: [wd.CRITERIA_SHA256] });
});
