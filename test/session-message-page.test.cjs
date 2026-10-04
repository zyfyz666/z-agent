'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function pageReader(messages, budget = 6_000_000) {
  const start = source.indexOf("ipcMain.handle('session:messages',");
  const end = source.indexOf("ipcMain.handle('session:create',", start);
  const estimateStart = source.indexOf('function estimateMessageSize(');
  const estimateEnd = source.indexOf('\nfunction selectTailMessages(', estimateStart);
  assert.ok(start >= 0 && end > start && estimateStart >= 0 && estimateEnd > estimateStart);
  let handler;
  const context = vm.createContext({
    MESSAGE_PAGE_CHAR_BUDGET: budget,
    messageSizeEstimateCache: new WeakMap(),
    readSessionRecord: async id => id === 'fixture' ? { messages } : null,
    ipcMain: { handle(channel, fn) {
      assert.equal(channel, 'session:messages');
      handler = fn;
    } }
  });
  // Use both the production size estimator and the actual IPC handler. Only
  // the budget and session storage are isolated for small deterministic tests.
  vm.runInContext(source.slice(estimateStart, estimateEnd), context);
  vm.runInContext(source.slice(start, end), context);
  return async options => JSON.parse(JSON.stringify(await handler(null, { id: 'fixture', ...options })));
}

test('backward pages return a contiguous size-limited suffix and its actual offset', async () => {
  const read = pageReader(['outside-left', 'aa', 'bb', 'cc', 'dd', 'outside-right'], 4);
  const page = await read({ offset: 1, limit: 4, fromEnd: true });
  assert.deepEqual(page, { ok: true, messages: ['cc', 'dd'], total: 6, offset: 3 });
  assert.equal(page.offset + page.messages.length, 5);
});

test('successive backward pages preserve all messages with no gaps or duplicates', async () => {
  const messages = ['a', 'bbbbbb', 'cc', 'ddd', 'ee', 'fffffff', 'g', 'hh'];
  const read = pageReader(messages, 4);
  let cursor = messages.length;
  let collected = [];
  while (cursor > 0) {
    const offset = Math.max(0, cursor - 4);
    const page = await read({ offset, limit: cursor - offset, fromEnd: true });
    assert.ok(page.messages.length > 0, 'a nonempty range always advances');
    assert.equal(page.offset + page.messages.length, cursor);
    collected = [...page.messages, ...collected];
    cursor = page.offset;
  }
  assert.deepEqual(collected, messages);
});

test('a final oversized message is returned alone even when it exceeds the page budget', async () => {
  const oversized = { content: 'x'.repeat(1000), agentRun: { watchdog: { checks: 12 } } };
  const read = pageReader(['first', 'middle', oversized, 'outside'], 1);
  const page = await read({ offset: 0, limit: 3, fromEnd: true });
  assert.deepEqual(page.messages, [oversized]);
  assert.equal(page.offset, 2);
  assert.equal(page.total, 4);
});

test('backward range bounds honor the requested start, total length, and count cap', async () => {
  const read = pageReader(['a', 'b', 'c', 'd'], 1000);
  assert.deepEqual(await read({ offset: 2, limit: 1, fromEnd: true }),
    { ok: true, messages: ['c'], total: 4, offset: 2 });
  assert.deepEqual(await read({ offset: 2, limit: 200, fromEnd: true }),
    { ok: true, messages: ['c', 'd'], total: 4, offset: 2 });
  assert.deepEqual(await read({ offset: 999, fromEnd: true }),
    { ok: true, messages: [], total: 4, offset: 4 });
  assert.deepEqual(await read({ offset: -10, limit: 2, fromEnd: true }),
    { ok: true, messages: ['a', 'b'], total: 4, offset: 0 });
  const many = pageReader(Array.from({ length: 250 }, (_, i) => i), 10000);
  assert.equal((await many({ limit: 999, fromEnd: true })).messages.length, 200);
});

test('default and explicit forward paging keep their existing prefix behavior', async () => {
  const read = pageReader(['outside', 'aa', 'bb', 'cc', 'dd'], 4);
  const expected = { ok: true, messages: ['aa', 'bb'], total: 5, offset: 1 };
  assert.deepEqual(await read({ offset: 1, limit: 4 }), expected);
  assert.deepEqual(await read({ offset: 1, limit: 4, fromEnd: false }), expected);
  const oversized = await pageReader(['12345', 'b'], 1)({ limit: 2 });
  assert.deepEqual(oversized.messages, ['12345']);
  const empty = await pageReader([])({ fromEnd: true });
  assert.deepEqual(empty, { ok: true, messages: [], total: 0, offset: 0 });
});

test('the preload forwards the optional backward-paging flag without changing defaults', async () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const calls = [];
  let api;
  vm.runInNewContext(preload, {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, value) { if (name === 'z') api = value; } },
        ipcRenderer: { invoke: async (channel, payload) => calls.push({ channel, payload }) },
        webUtils: {}
      };
    }
  });
  await api.getSessionMessages('fixture', 4, 7, { fromEnd: true });
  await api.getSessionMessages('fixture');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { channel: 'session:messages', payload: { id: 'fixture', offset: 4, limit: 7, fromEnd: true } },
    { channel: 'session:messages', payload: { id: 'fixture', offset: 0, limit: 40, fromEnd: false } }
  ]);
});
