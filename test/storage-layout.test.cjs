'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const layout = require('../lib/storage-layout');

test('existing profile, journal and browser partition stay at their current paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-existing-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'ZData');
  const core = path.join(data, 'z-core');
  fs.mkdirSync(core, { recursive: true });
  const config = '{"providers":{"private-id":{"apiKey":"fixture","models":["model-id"]}}}';
  fs.writeFileSync(path.join(data, 'config.json'), config);
  fs.mkdirSync(path.join(root, 'Partitions', 'z-browser'), { recursive: true });
  assert.equal(layout.dataRoot(root), data);
  assert.equal(layout.coreRoot(data), core);
  assert.equal(layout.browserPartition(root), 'persist:z-browser');
  assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), config);
});

test('new profiles and workspace state use current names without touching the disk', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-storage-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(layout.dataRoot(root), path.join(root, 'ZData'));
  assert.equal(layout.coreRoot(path.join(root, 'ZData')), path.join(root, 'ZData', 'z-core'));
  assert.equal(layout.browserPartition(root), 'persist:z-browser');
  assert.equal(layout.workspaceStateRoot(root), path.join(root, '.zagent'));
  assert.equal(layout.workspaceStatePath(root, ['memory.json']), path.join(root, '.zagent', 'memory.json'));
  assert.deepEqual(fs.readdirSync(root), []);
  fs.mkdirSync(path.join(root, '.zagent'));
  fs.writeFileSync(path.join(root, '.zagent', 'memory.json'), 'new-memory');
  assert.equal(layout.workspaceStatePath(root, ['memory.json']), path.join(root, '.zagent', 'memory.json'));
  assert.equal(layout.workspaceStateRoot(root, '.custom'), path.join(root, '.custom'));
  assert.equal(layout.workspaceStatePath(root, ['memory.json'], '.custom'), path.join(root, '.custom', 'memory.json'));
});
