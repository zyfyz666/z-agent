'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const patch = require('../vendor/opencode/runtime-patch.json');

const pending = new Map();

function applyRuntimeReplacements(bytes, manifest = patch) {
  const replacements = [{ id: 'all-file-tools', find: manifest.filter, replace: '' }, ...(manifest.replacements || [])];
  const ranges = replacements.map(replacement => {
    const source = Buffer.from(replacement.find, 'utf8');
    const target = Buffer.from(replacement.replace, 'utf8');
    const offset = source.length ? bytes.indexOf(source) : -1;
    if (offset < 0 || bytes.indexOf(source, offset + source.length) !== -1) {
      throw new Error(`OpenCode 补丁 ${replacement.id} 不是唯一匹配，拒绝应用内核补丁。`);
    }
    if (target.length > source.length) throw new Error(`OpenCode 补丁 ${replacement.id} 超出原始区块长度。`);
    return { offset, length: source.length, target };
  }).sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].offset < ranges[index - 1].offset + ranges[index - 1].length) {
      throw new Error('OpenCode 补丁区块重叠，拒绝修改内核。');
    }
  }
  for (const { offset, length, target } of ranges) {
    bytes.fill(0x20, offset, offset + length);
    target.copy(bytes, offset);
  }
  return bytes;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function matchesBinary(file, spec) {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() && stat.size === spec.size && await sha256(file) === spec.patchedSha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function stageRuntime(executable, dataDir) {
  const sourceHash = await sha256(executable);
  const spec = patch.binaries.find(binary => binary.sourceSha256 === sourceHash);
  if (!spec) {
    // Windows x64 is the only binary the runtime patches are calibrated
    // against. Other platforms keep the official OpenCode executable.
    if (process.platform !== 'win32') return executable;
    throw new Error(`Z 的运行时补丁仅支持已校验的 OpenCode ${patch.upstreamVersion} 内核；当前可执行文件不匹配，请更新内核补丁清单。SHA-256: ${sourceHash}`);
  }

  const directory = path.join(dataDir, 'opencode-runtime', 'bin', `${patch.revision}-${spec.patchedSha256.slice(0, 16)}`);
  const target = path.join(directory, path.basename(executable));
  if (await matchesBinary(target, spec)) return target;

  const bytes = await fs.promises.readFile(executable);
  // Recheck the buffer we actually patch in case npm replaced the source
  // between the initial fingerprint and this read.
  if (bytes.length !== spec.size || crypto.createHash('sha256').update(bytes).digest('hex') !== spec.sourceSha256) {
    throw new Error('OpenCode 内核在准备补丁时发生变化，请重试。');
  }
  // The official Bun executable embeds JavaScript source. Equal-length
  // padded replacements preserve every bundled offset. Each complete source
  // block is unique and the full input/output executable hashes are pinned.
  applyRuntimeReplacements(bytes);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== spec.patchedSha256) {
    throw new Error('OpenCode 运行时补丁校验失败。');
  }

  await fs.promises.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${path.basename(executable)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o700 });
    if (!await matchesBinary(temporary, spec)) throw new Error('OpenCode 补丁文件写入校验失败。');
    // A second app process may have staged and started the same executable.
    if (await matchesBinary(target, spec)) return target;
    try {
      await fs.promises.rename(temporary, target);
    } catch (error) {
      if (!await matchesBinary(target, spec)) throw error;
    }
    return target;
  } finally {
    await fs.promises.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function stageOpenCodeRuntime({ executable, dataDir }) {
  const source = path.resolve(executable);
  const root = path.resolve(dataDir);
  const key = JSON.stringify([source, root]);
  if (!pending.has(key)) {
    pending.set(key, stageRuntime(source, root).finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

module.exports = { stageOpenCodeRuntime, applyRuntimeReplacements };
