'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResourceLockManager } = require('../lib/z-core/tools');

test('pre-cancelled acquisition does not create a resource or run a callback', async () => {
  const locks = new ResourceLockManager();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(locks.withLock('browser:a', 'write', { signal: controller.signal }, () => { called = true; }),
    error => error.code === 'Z_LOCK_CANCELLED');
  assert.equal(called, false);
  assert.deepEqual(locks.status().resources, {});
});

test('cancelling a queued writer removes it immediately and lets compatible readers proceed', async () => {
  const locks = new ResourceLockManager();
  const first = await locks.acquire('browser:a', 'read');
  const controller = new AbortController();
  const writer = locks.acquire('browser:a', 'write', { signal: controller.signal });
  const writerRejected = assert.rejects(writer, error => error.code === 'Z_LOCK_CANCELLED');
  const reader = locks.acquire('browser:a', 'read');
  assert.equal(locks.status().resources['browser:a'].waiting, 2);
  controller.abort();
  await writerRejected;
  const second = await reader;
  assert.equal(locks.status().resources['browser:a'].waiting, 0);
  assert.equal(locks.status().resources['browser:a'].holders, 2);
  locks.release(first);
  locks.release(second);
  assert.deepEqual(locks.status().resources, {});
});

test('cancellation just after acquisition prevents execution and still releases the handle', async () => {
  const locks = new ResourceLockManager();
  const controller = new AbortController();
  let called = false;
  const run = locks.withLock('browser:a', 'write', { signal: controller.signal }, () => { called = true; });
  controller.abort();
  await assert.rejects(run, error => error.code === 'Z_LOCK_CANCELLED');
  assert.equal(called, false);
  assert.deepEqual(locks.status().resources, {});
});

test('cancelling a former waiter after grant does not revoke another holder', async () => {
  const locks = new ResourceLockManager();
  const first = await locks.acquire('browser:a', 'write');
  const controller = new AbortController();
  const waiting = locks.acquire('browser:a', 'write', { signal: controller.signal });
  locks.release(first);
  const holder = await waiting;
  controller.abort();
  assert.equal(locks.status().resources['browser:a'].holders, 1);
  locks.release(holder);
  assert.deepEqual(locks.status().resources, {});
});
