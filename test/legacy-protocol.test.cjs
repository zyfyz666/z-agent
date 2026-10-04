'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LEGACY_NAMESPACE } = require('../lib/legacy-compat');
const { protocolBlockPattern, protocolTagNames } = require('../lib/protocol-text');
const { parseText, stripReviews, stripProtocolBlocks, StreamTracker } = require('../lib/delivery-contract');
const {
  resolveDeliveryPolicy, applyDeliveryContract, deliveryContractId,
  deliveryReviewFromMessages, deliveryReviewDiagnostics, parseDeliveryContract
} = require('../lib/delivery-policy');

const previous = LEGACY_NAMESPACE.lower;
const block = (prefix, suffix, text) => `<${prefix}-${suffix}>${text}</${prefix}-${suffix}>`;

test('historical delivery contracts and current revisions merge in chronological order', () => {
  const original = block(previous, 'delivery-contract', 'scope: pricing module\nacceptance: npm test');
  const current = block('z', 'delivery-contract', 'acceptance: node --test');
  assert.deepEqual(parseText(original + current), { scope: 'pricing module', acceptance: 'node --test' });
  assert.deepEqual(parseText(current + original), { scope: 'pricing module', acceptance: 'npm test' });
  const messages = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: original + current }] }];
  const serialized = JSON.stringify(messages);
  assert.deepEqual(parseDeliveryContract(messages), { scope: 'pricing module', acceptance: 'node --test' });
  assert.equal(JSON.stringify(messages), serialized);
});

test('protocol pairs cannot cross namespaces and arbitrary tags are not treated as protocols', () => {
  const mixed = `<${previous}-delivery-contract>scope: ignored</z-delivery-contract>`;
  assert.equal(parseText(mixed), null);
  assert.equal(parseText('<external-delivery-contract>scope: ignored</external-delivery-contract>'), null);
  assert.deepEqual(protocolTagNames('delivery-review'), ['z-delivery-review', `${previous}-delivery-review`]);
  assert.throws(() => protocolBlockPattern('custom-user-tag'), TypeError);
});

test('historical context tags with attributes can be stripped from a derived history view', () => {
  const history = { content: `Before<${previous}-turn-context task_id="t1">runtime context</${previous}-turn-context>After` };
  const original = history.content;
  const pattern = protocolBlockPattern('turn-context', { allowAttributes: true });
  const match = [...history.content.matchAll(pattern)][0];
  assert.equal(match[1], `${previous}-turn-context`);
  assert.equal(match[2], 'runtime context');
  assert.equal(history.content.replace(pattern, ''), 'BeforeAfter');
  assert.equal(history.content, original);
  assert.equal([...original.matchAll(protocolBlockPattern('turn-context'))].length, 0);
  assert.equal(`<${previous}-turn-context-other>user text</${previous}-turn-context-other>`.replace(pattern, ''),
    `<${previous}-turn-context-other>user text</${previous}-turn-context-other>`);
});

test('stream tracking recovers old contracts only when an assistant text block closes', () => {
  const tracker = new StreamTracker();
  const text = block(previous, 'delivery-contract', 'scope: existing files');
  const first = text.slice(0, -5);
  assert.equal(tracker.observe({ type: 'message.part.updated', data: { part: { id: 'old-p', type: 'text', text: first } } }), null);
  assert.deepEqual(tracker.observe({ type: 'message.part.delta', data: { partID: 'old-p', field: 'text', delta: text.slice(-5) } }),
    { scope: 'existing files' });
  assert.equal(tracker.observe({ type: 'message.part.updated', data: { part: { id: 'tool', type: 'tool', state: { output: text } } } }), null);
});

test('display filters hide complete and partial historical protocol blocks', () => {
  for (const prefix of ['z', previous]) {
    const opening = `<${prefix}-delivery-review>`;
    for (let length = 1; length <= opening.length; length += 1) {
      assert.equal(stripReviews('Visible text' + opening.slice(0, length)), 'Visible text');
    }
    for (const suffix of ['delivery-contract', 'delivery-review', 'delivery-agreement', 'reasoning-sidepath']) {
      assert.equal(stripProtocolBlocks('Before' + block(prefix, suffix, 'internal') + 'After'), 'BeforeAfter');
      assert.equal(stripProtocolBlocks(`Before<${prefix}-${suffix}>internal`), 'Before');
    }
  }
  const custom = block(previous, 'user-content', 'User-owned source');
  assert.equal(stripProtocolBlocks(custom), custom);
});

function reviewFixture(prefix, { contractId: selectedContractId, role = 'assistant', anchored = true } = {}) {
  const policy = applyDeliveryContract(resolveDeliveryPolicy({ prompt: '修复价格计算代码，可交付', hasUserWorkspace: true }), {
    scope: '只改价格模块', acceptance: 'node test/pricing.test.js 通过'
  });
  const review = { contractId: selectedContractId ?? deliveryContractId(policy.contract), criteria: {
    scope: { status: 'pass', evidence: anchored ? 'bash：仅改动价格模块范围' : '都正确' },
    acceptance: { status: 'pass', evidence: anchored ? 'node test/pricing.test.js：全部通过' : '全部通过' }
  } };
  const messages = [{ info: { role }, parts: [
    { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'node test/pricing.test.js' }, metadata: { exit: 0 }, output: 'ok' } },
    { type: 'text', text: block(prefix, 'delivery-review', JSON.stringify(review)) }
  ] }];
  return { policy, messages };
}

test('historical review records retain the same evidence and contract checks', () => {
  const valid = reviewFixture(previous);
  const serialized = JSON.stringify(valid.messages);
  assert.equal(deliveryReviewFromMessages(valid.messages, valid.policy)?.verdict, 'pass');
  assert.equal(deliveryReviewDiagnostics(valid.messages, valid.policy).accepted, 1);
  assert.equal(JSON.stringify(valid.messages), serialized);
  const fabricated = reviewFixture(previous, { anchored: false });
  assert.equal(deliveryReviewFromMessages(fabricated.messages, fabricated.policy)?.verdict, 'unobserved');
  const stale = reviewFixture(previous, { contractId: 'different-contract' });
  assert.equal(deliveryReviewFromMessages(stale.messages, stale.policy), null);
  assert.equal(deliveryReviewDiagnostics(stale.messages, stale.policy).contractIdMismatch, 1);
  const user = reviewFixture(previous, { role: 'user' });
  assert.equal(deliveryReviewFromMessages(user.messages, user.policy), null);
});

test('historical malformed review JSON is diagnosed instead of accepted', () => {
  const fixture = reviewFixture(previous);
  fixture.messages[0].parts[1].text = block(previous, 'delivery-review', '{invalid');
  const result = deliveryReviewDiagnostics(fixture.messages, fixture.policy);
  assert.equal(result.blockSeen, true);
  assert.ok(result.parseError);
  assert.equal(result.accepted, 0);
});

test('browser protocol and product modules use the same limited compatibility layer', () => {
  const context = vm.createContext({});
  for (const relative of ['lib/legacy-compat.js', 'lib/protocol-text.js', 'lib/delivery-contract.js', 'renderer/z-product-content.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), context, { filename: relative });
  }
  const text = block(previous, 'delivery-contract', 'scope: browser history');
  assert.equal(context.ZDeliveryContract.parseText(text).scope, 'browser history');
  assert.equal(context.ZDeliveryContract.stripProtocolBlocks('Visible' + text), 'Visible');
  assert.equal(context.ZProductContent.normalizeUserName(`${LEGACY_NAMESPACE.title}xi`), '');
  assert.equal(context.ZProductContent.normalizeUserName('Z'), 'Z');
});
