'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LEGACY_NAMESPACE } = require('../lib/legacy-compat');
const { buildCompactionAnchor, combineTurnPrompt, collectRunResult } = require('../lib/opencode-sidecar');
const previous = LEGACY_NAMESPACE.lower;
const block = (prefix, suffix, text, attributes = '') => `<${prefix}-${suffix}${attributes}>${text}</${prefix}-${suffix}>`;

test('compaction anchors remove only known historical/current wrappers without modifying the source journal', () => {
  for (const prefix of ['z', previous]) {
    const messages = [{ info: { role: 'user' }, parts: [{ type: 'text', text: [
      block(prefix, 'session-history', 'previous responses'), 'Keep this exact objective.',
      block(prefix, 'turn-context', 'old runtime settings', ' task_id="t1"')
    ].join('\n') }] }, { parts: [{ type: 'compaction' }] }];
    const serialized = JSON.stringify(messages);
    assert.deepEqual(buildCompactionAnchor(messages), { objective: 'Keep this exact objective.' });
    assert.equal(JSON.stringify(messages), serialized);
  }
});

test('recreated session history excludes retired runtime envelopes but retains user text and unknown tags', () => {
  const userText = `My supplier ${previous}-custom is intentional. <${previous}-custom>source code</${previous}-custom>`;
  const messages = [{ role: 'user', content: userText + ['turn-context', 'reasoning-sidepath', 'continual-harness', 'long-horizon-protocol', 'experience-edges']
    .map(suffix => block(previous, suffix, `obsolete-${suffix}`, ' id="old"')).join('') }];
  const serialized = JSON.stringify(messages);
  const rendered = combineTurnPrompt({ history: messages }, 'Continue.', true);
  assert.ok(rendered.includes(userText));
  assert.doesNotMatch(rendered, /obsolete-/);
  assert.equal(JSON.stringify(messages), serialized);
  const crossNamespace = `<${previous}-turn-context>must remain</z-turn-context>`;
  assert.ok(combineTurnPrompt({ history: [{ role: 'user', content: crossNamespace }] }, '', true).includes(crossNamespace));
});

function assistantTool(name) {
  return [{ info: { id: 'assistant', role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{
    type: 'tool', tool: name, callID: 'completed-tool', state: { status: 'completed', input: {}, output: 'done' }
  }] }];
}

test('historical tool classifiers recognize the exact retired namespace without rewriting tool records', () => {
  for (const separator of ['_', '-']) {
    const messages = assistantTool(`${previous}xi${separator}edit`);
    const serialized = JSON.stringify(messages);
    assert.equal(collectRunResult(messages, new Set(), [], [], {}, 'native').status, 'done');
    assert.equal(JSON.stringify(messages), serialized);
  }
  assert.equal(collectRunResult(assistantTool(`${previous}xiother_edit`), new Set(), [], [], {}, 'native').status, 'error');
});

test('historical skill loading failures remain disclosed without renaming saved skill IDs', () => {
  const messages = assistantTool(`${previous}_skills_read_skill`);
  messages[0].parts[0].state.output = JSON.stringify({ skipped: true, id: `${previous}-user-owned`, attempts: 3, error: 'missing file' });
  const serialized = JSON.stringify(messages);
  const result = collectRunResult(messages, new Set(), [], [], {}, 'native');
  assert.ok(result.text.includes(`${previous}-user-owned`));
  assert.equal(JSON.stringify(messages), serialized);
});
