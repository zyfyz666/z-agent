'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LEGACY_STORAGE } = require('../lib/legacy-compat');
const layout = require('../lib/storage-layout');

test('existing profile, journal and browser partition remain at their original paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-existing-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, LEGACY_STORAGE.stableDataDir);
  const core = path.join(data, LEGACY_STORAGE.coreDir);
  fs.mkdirSync(core, { recursive: true });
  const config = '{"providers":{"private-id":{"apiKey":"fixture","models":["model-id"]}}}';
  fs.writeFileSync(path.join(data, 'config.json'), config);
  fs.mkdirSync(path.join(root, 'Partitions', LEGACY_STORAGE.browserPartition.slice(8)), { recursive: true });
  assert.equal(layout.dataRoot(root), data);
  assert.equal(layout.coreRoot(data), core);
  assert.equal(layout.browserPartition(root), LEGACY_STORAGE.browserPartition);
  assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), config);
  assert.equal(fs.existsSync(path.join(root, 'ZData')), false);
});

test('new profiles use current names and both generations of workspace state stay readable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-storage-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(layout.dataRoot(root), path.join(root, 'ZData'));
  assert.equal(layout.browserPartition(root), 'persist:z-browser');
  const previous = path.join(root, LEGACY_STORAGE.workspaceDir);
  fs.mkdirSync(previous);
  fs.writeFileSync(path.join(previous, 'memory.json'), 'old-memory');
  assert.equal(layout.workspaceStateRoot(root), previous);
  fs.mkdirSync(path.join(root, '.zagent'));
  assert.equal(layout.workspaceStatePath(root, ['memory.json']), path.join(previous, 'memory.json'));
  fs.writeFileSync(path.join(root, '.zagent', 'memory.json'), 'new-memory');
  assert.equal(layout.workspaceStatePath(root, ['memory.json']), path.join(root, '.zagent', 'memory.json'));
  assert.equal(fs.readFileSync(path.join(previous, 'memory.json'), 'utf8'), 'old-memory');
  assert.equal(layout.workspaceStatePath(root, ['memory.json'], '.custom'), path.join(root, '.custom', 'memory.json'));
});
