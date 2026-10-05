'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { protocolBlockPattern, protocolTagNames } = require('../lib/protocol-text');
const { parseText, stripReviews, stripProtocolBlocks, StreamTracker } = require('../lib/delivery-contract');
const { parseDeliveryContract } = require('../lib/delivery-policy');

const block = (suffix, text, attributes = '') => `<z-${suffix}${attributes}>${text}</z-${suffix}>`;

test('application protocol tags use only the z- namespace and reject arbitrary tags', () => {
  assert.deepEqual(protocolTagNames('delivery-review'), ['z-delivery-review']);
  assert.throws(() => protocolTagNames('custom-user-tag'), TypeError);
  assert.throws(() => protocolBlockPattern('custom-user-tag'), TypeError);
  assert.equal(parseText('<external-delivery-contract>scope: ignored</external-delivery-contract>'), null);
  assert.equal(parseText('<other-delivery-contract>scope: ignored</z-delivery-contract>'), null);
});

test('delivery contract revisions merge in chronological order without rewriting messages', () => {
  const original = block('delivery-contract', 'scope: pricing module\nacceptance: npm test');
  const revision = block('delivery-contract', 'acceptance: node --test');
  assert.deepEqual(parseText(original + revision), { scope: 'pricing module', acceptance: 'node --test' });
  assert.deepEqual(parseText(revision + original), { scope: 'pricing module', acceptance: 'npm test' });
  const messages = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: original + revision }] }];
  const serialized = JSON.stringify(messages);
  assert.deepEqual(parseDeliveryContract(messages), { scope: 'pricing module', acceptance: 'node --test' });
  assert.equal(JSON.stringify(messages), serialized);
});

test('context tags with attributes are stripped from a derived view only', () => {
  const content = `Before${block('turn-context', 'runtime context', ' task_id="t1"')}After`;
  const pattern = protocolBlockPattern('turn-context', { allowAttributes: true });
  const match = [...content.matchAll(pattern)][0];
  assert.equal(match[1], 'z-turn-context');
  assert.equal(match[2], 'runtime context');
  assert.equal(content.replace(pattern, ''), 'BeforeAfter');
  assert.equal([...content.matchAll(protocolBlockPattern('turn-context'))].length, 0);
  const lookalike = '<z-turn-context-other>user text</z-turn-context-other>';
  assert.equal(lookalike.replace(pattern, ''), lookalike);
});

test('stream tracking reads a contract only when an assistant text block closes', () => {
  const tracker = new StreamTracker();
  const text = block('delivery-contract', 'scope: existing files');
  assert.equal(tracker.observe({ type: 'message.part.updated', data: { part: { id: 'p', type: 'text', text: text.slice(0, -5) } } }), null);
  assert.deepEqual(tracker.observe({ type: 'message.part.delta', data: { partID: 'p', field: 'text', delta: text.slice(-5) } }),
    { scope: 'existing files' });
  assert.equal(tracker.observe({ type: 'message.part.updated', data: { part: { id: 'tool', type: 'tool', state: { output: text } } } }), null);
});

test('display filters hide complete and partial protocol blocks but keep user tags', () => {
  const opening = '<z-delivery-review>';
  for (let length = 1; length <= opening.length; length += 1) {
    assert.equal(stripReviews('Visible text' + opening.slice(0, length)), 'Visible text');
  }
  for (const suffix of ['delivery-contract', 'delivery-review', 'delivery-agreement', 'reasoning-sidepath']) {
    assert.equal(stripProtocolBlocks('Before' + block(suffix, 'internal') + 'After'), 'BeforeAfter');
    assert.equal(stripProtocolBlocks(`Before<z-${suffix}>internal`), 'Before');
  }
  const custom = block('user-content', 'User-owned source');
  assert.equal(stripProtocolBlocks(custom), custom);
});

test('browser protocol and product modules load on their own', () => {
  const context = vm.createContext({});
  for (const relative of ['lib/protocol-text.js', 'lib/delivery-contract.js', 'renderer/z-product-content.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), context, { filename: relative });
  }
  const text = block('delivery-contract', 'scope: browser history');
  assert.equal(context.ZDeliveryContract.parseText(text).scope, 'browser history');
  assert.equal(context.ZDeliveryContract.stripProtocolBlocks('Visible' + text), 'Visible');
  assert.equal(context.ZProductContent.normalizeUserName(' Z\u0007 '), 'Z');
});
