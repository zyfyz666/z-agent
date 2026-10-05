'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageOpenCodeRuntime, applyRuntimeReplacements } = require('../lib/opencode-runtime');
const patch = require('../vendor/opencode/runtime-patch.json');

function removeFixture(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('z-runtime-patch-'));
  fs.rmSync(directory, { recursive: true, force: true });
}

test('unknown runtime fails explicitly without modifying it or producing a fallback', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-runtime-patch-'));
  const executable = path.join(directory, 'unknown.exe');
  fs.writeFileSync(executable, patch.filter);
  try {
    await assert.rejects(stageOpenCodeRuntime({ executable, dataDir: directory }), /当前可执行文件不匹配/);
    assert.equal(fs.readFileSync(executable, 'utf8'), patch.filter);
    assert.equal(fs.existsSync(path.join(directory, 'opencode-runtime')), false);
  } finally { removeFixture(directory); }
});

test('invalid replacement plans fail before changing any bytes', () => {
  for (const manifest of [
    { filter: 'missing' },
    { filter: 'one', replacements: [{ id: 'duplicate', find: 'two', replace: '' }] },
    { filter: 'one', replacements: [{ id: 'too-long', find: 'three', replace: 'longer' }] },
    { filter: 'one', replacements: [{ id: 'overlap', find: 'one two', replace: '' }] }
  ]) {
    const original = Buffer.from('one two three two');
    const bytes = Buffer.from(original);
    assert.throws(() => applyRuntimeReplacements(bytes, manifest));
    assert.equal(bytes.equals(original), true);
  }
});

test('stages only the pinned registry and Windows lifecycle changes, shares work, and repairs a corrupt cache', {
  skip: process.platform !== 'win32' || process.arch !== 'x64'
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-runtime-patch-'));
  const executable = path.resolve('node_modules/opencode-windows-x64/bin/opencode.exe');
  const options = { executable, dataDir: directory };
  const sourceStat = fs.statSync(executable);
  try {
    const first = stageOpenCodeRuntime(options);
    assert.equal(stageOpenCodeRuntime(options), first);
    const target = await first;
    assert.notEqual(target, executable);
    const source = fs.readFileSync(executable);
    const output = fs.readFileSync(target);
    const offset = source.indexOf(patch.filter);
    assert.ok(offset > 0);
    const changes = [{ find: patch.filter, replace: '' }, ...patch.replacements]
      .map(change => ({ ...change, offset: source.indexOf(change.find) })).sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    for (const change of changes) {
      assert.ok(change.offset >= cursor);
      assert.equal(output.subarray(cursor, change.offset).equals(source.subarray(cursor, change.offset)), true);
      assert.equal(output.subarray(change.offset, change.offset + change.find.length).toString(),
        change.replace.padEnd(change.find.length, ' '));
      cursor = change.offset + change.find.length;
    }
    assert.equal(output.subarray(cursor).equals(source.subarray(cursor)), true);
    assert.equal(crypto.createHash('sha256').update(output).digest('hex'), patch.binaries[0].patchedSha256);
    const cachedStat = fs.statSync(target);
    assert.equal(await stageOpenCodeRuntime(options), target);
    assert.equal(fs.statSync(target).mtimeMs, cachedStat.mtimeMs);

    const fd = fs.openSync(target, 'r+');
    try { fs.writeSync(fd, Buffer.from('x'), 0, 1, offset); } finally { fs.closeSync(fd); }
    assert.equal(await stageOpenCodeRuntime(options), target);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), patch.binaries[0].patchedSha256);
    assert.equal(fs.statSync(executable).mtimeMs, sourceStat.mtimeMs);
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), patch.binaries[0].sourceSha256);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['opencode.exe']);
  } finally { removeFixture(directory); }
});
