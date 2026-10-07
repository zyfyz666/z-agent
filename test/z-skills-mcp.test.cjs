'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const skillRegistry = require('../lib/skill-registry');

const appRoot = path.resolve(__dirname, '..');

function createClient(dataDir, config = { customSkills: [] }) {
  const skillsRoot = path.join(dataDir, 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config), 'utf8');
  // The desktop prepares SkillStore before starting this MCP. Do the same
  // here so the RPC deadline measures reading, not cold Windows fixture I/O.
  // Store creation itself remains covered by skill-manifest.test.cjs.
  const prepared = skillRegistry.syncSkillStore(config, appRoot, dataDir);
  assert.equal(prepared.ok, true, prepared.error);
  const child = spawn(process.execPath, [path.join(appRoot, 'lib', 'z-skills-mcp.js')], {
    cwd: appRoot,
    windowsHide: true,
    env: {
      ...process.env,
      Z_SKILLS_ROOT: skillsRoot,
      Z_SKILLS_DATA_DIR: dataDir,
      Z_SKILLS_CONFIG_PATH: path.join(dataDir, 'config.json'),
      Z_SKILLS_APP_ROOT: appRoot,
      Z_SKILLS_CLI: path.join(appRoot, 'node_modules', 'skills', 'bin', 'cli.mjs'),
      Z_SKILLS_ALLOW_NETWORK: 'false',
      Z_INPUT_TOKENS_PER_SECOND: '10000'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let stderr = '';
  let terminalError;
  const pending = new Map();
  const rejectPending = error => {
    terminalError = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_192); });
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    rejectPending(new Error(`Skills MCP closed (code=${code}, signal=${signal})${stderr ? `: ${stderr}` : ''}`));
    resolve();
  }));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let message;
        try { message = JSON.parse(line); } catch (error) {
          rejectPending(new Error(`Invalid Skills MCP response: ${error.message}`));
          return;
        }
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (terminalError) return reject(terminalError);
    const requestId = ++id;
    const operation = [method, params.name, params.arguments?.id].filter(Boolean).join(' ');
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`MCP timeout: ${operation}${stderr ? `; stderr: ${stderr}` : ''}`));
    }, 10_000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Skills MCP did not close after termination')), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  return { request, close };
}

test('read_skill returns a structured per-task skip without failing MCP', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-skills-mcp-'));
  const largeSkillId = 'lossless-large';
  const largeSkillDirectory = path.join(dataDir, 'skills', largeSkillId);
  fs.mkdirSync(largeSkillDirectory, { recursive: true });
  fs.writeFileSync(path.join(largeSkillDirectory, 'SKILL.md'), [
    '---',
    `name: ${largeSkillId}`,
    'description: Large deterministic Skill fixture',
    '---',
    '',
    '# Lossless fixture',
    ...Array.from({ length: 1_500 }, (_, index) => `Rule ${index}: preserve this exact UTF-8 text 测试 ${index}.`),
    ''
  ].join('\n'), 'utf8');
  const client = createClient(dataDir);
  t.after(async () => {
    await client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const listed = await client.request('tools/list');
  const readSkill = listed.result.tools.find(tool => tool.name === 'read_skill');
  const readResource = listed.result.tools.find(tool => tool.name === 'read_skill_resource');
  const readResources = listed.result.tools.find(tool => tool.name === 'read_skill_resources');
  assert.equal(readSkill.inputSchema.properties.task_id.type, 'string');
  assert.equal(readResource.inputSchema.properties.chunk_index.type, 'integer');
  assert.equal(readResources.inputSchema.properties.chunks.type, 'array');
  assert.deepEqual(readSkill.inputSchema.required, ['id', 'task_id']);

  const available = await client.request('tools/call', {
    name: 'read_skill',
    arguments: { id: 'z-react-bits', task_id: 'run-success' }
  });
  assert.equal(available.result.isError, false);
  assert.equal(available.result.structuredContent.ok, true);
  assert.match(available.result.structuredContent.instructions, /React Bits/i);
  assert.equal(available.result.structuredContent.delivery, 'inline');
  assert.equal(available.result.structuredContent.complete, true);
  assert.equal('skillDocument' in available.result.structuredContent, false);

  const hallmark = await client.request('tools/call', {
    name: 'read_skill',
    arguments: { id: largeSkillId, task_id: 'run-hallmark' }
  });
  const hallmarkResult = hallmark.result.structuredContent;
  assert.equal(hallmark.result.isError, false);
  assert.equal(hallmarkResult.delivery, 'chunked');
  assert.equal(hallmarkResult.complete, false);
  assert.equal(hallmarkResult.inputTokensPerSecond, 10_000);
  assert.equal(hallmarkResult.chunkBytes, 64 * 1024);
  assert.equal(hallmarkResult.chunkCount >= 2, true);
  assert.equal(hallmarkResult.chunkPlan.length, hallmarkResult.chunkCount);
  assert.equal('instructions' in hallmarkResult, false);
  assert.equal('skillDocument' in hallmarkResult, false);
  assert.equal(Buffer.byteLength(JSON.stringify(hallmarkResult), 'utf8') < 16 * 1024, true);

  const chunks = await Promise.all(hallmarkResult.chunkPlan.map(plan => client.request('tools/call', {
    name: 'read_skill_resource',
    arguments: { id: largeSkillId, task_id: 'run-hallmark', ...plan }
  })));
  const batched = await client.request('tools/call', {
    name: 'read_skill_resources',
    arguments: {
      id: largeSkillId,
      task_id: 'run-hallmark',
      chunks: hallmarkResult.chunkPlan
    }
  });
  assert.equal(batched.result.isError, false);
  assert.equal(batched.result.structuredContent.count, hallmarkResult.chunkCount);
  assert.equal(batched.result.structuredContent.chunks.length, hallmarkResult.chunkCount);
  const reconstructed = chunks
    .map(response => response.result.structuredContent)
    .sort((left, right) => left.chunkIndex - right.chunkIndex)
    .map(chunk => chunk.content)
    .join('');
  assert.equal(
    crypto.createHash('sha256').update(reconstructed, 'utf8').digest('hex'),
    hallmarkResult.instructionSha256
  );
  for (const response of chunks) {
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.contentBytes <= 64 * 1024, true);
    assert.equal(response.result.structuredContent.chunkBytes, hallmarkResult.chunkBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(response.result.structuredContent), 'utf8') < 72 * 1024, true);
  }

  const cachedHallmark = await client.request('tools/call', {
    name: 'read_skill',
    arguments: { id: largeSkillId, task_id: 'run-hallmark' }
  });
  assert.equal(cachedHallmark.result.structuredContent.cacheHit, true);

  // A slow learned speed is now respected as a real tier instead of being
  // floored to the 10k baseline: 1k tokens/s delivers 16KB chunks.
  const conservative = await client.request('tools/call', {
    name: 'read_skill',
    arguments: { id: largeSkillId, task_id: 'run-conservative', input_tokens_per_second: 1_000 }
  });
  assert.equal(conservative.result.structuredContent.chunkBytes, 16 * 1024);
  assert.equal(conservative.result.structuredContent.inputTokensPerSecond, 1_000);

  const called = await client.request('tools/call', {
    name: 'read_skill',
    arguments: { id: 'definitely-missing-skill', task_id: 'run-test' }
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.ok, false);
  assert.equal(called.result.structuredContent.skipped, true);
  assert.equal(called.result.structuredContent.attempts, 1);
  assert.match(called.result.structuredContent.skipNotice, /1 次/);

  const repeated = await client.request('tools/call', {
    name: 'read_skill',
    arguments: { id: 'definitely-missing-skill', task_id: 'run-test' }
  });
  assert.deepEqual(repeated.result.structuredContent, called.result.structuredContent);
});

test('high-throughput Hallmark delivery keeps the root document in one model payload', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-skills-speed-'));
  const hallmarkDirectory = path.join(dataDir, 'skills', 'hallmark');
  fs.mkdirSync(hallmarkDirectory, { recursive: true });
  // This case checks root-document delivery; copying all 108 companion files
  // adds cold disk work unrelated to its assertions. Resource reads are below.
  fs.copyFileSync(path.join(appRoot, 'lib', 'skills', 'hallmark', 'SKILL.md'), path.join(hallmarkDirectory, 'SKILL.md'));
  const client = createClient(dataDir);
  try {
    const listed = await client.request('tools/call', {
      name: 'read_skill',
      arguments: { id: 'hallmark', task_id: 'speed-test', input_tokens_per_second: 10_000 }
    });
    assert.equal(listed.result.isError, false);
    assert.equal(listed.result.structuredContent.delivery, 'inline');
    assert.equal(listed.result.structuredContent.complete, true);
    assert.ok(listed.result.structuredContent.instructionBytes > 60_000);
  } finally {
    await client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('bundled Hallmark ignores a legacy two-file shadow and serves packaged resources', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-skills-bundled-shadow-'));
  const shadowDirectory = path.join(dataDir, 'skills', 'hallmark');
  fs.mkdirSync(shadowDirectory, { recursive: true });
  fs.writeFileSync(path.join(shadowDirectory, 'SKILL.md'), [
    '---',
    'name: hallmark',
    'description: Legacy incomplete Hallmark shadow',
    '---',
    '',
    'This stale prompt must never win over the packaged Skill.',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(shadowDirectory, '.z-skill.json'), JSON.stringify({
    schema: 1,
    id: 'hallmark',
    name: 'Hallmark',
    source: 'bundled'
  }, null, 2), 'utf8');

  const client = createClient(dataDir, {
    customSkills: [{
      id: 'hallmark',
      name: 'Hallmark',
      desc: 'Bundled Hallmark',
      source: 'bundled',
      version: 110
    }]
  });
  try {
    const loaded = await client.request('tools/call', {
      name: 'read_skill',
      arguments: { id: 'hallmark', task_id: 'bundled-shadow-test', input_tokens_per_second: 10_000 }
    });
    assert.equal(loaded.result.isError, false);
    assert.equal(loaded.result.structuredContent.ok, true);
    assert.match(loaded.result.structuredContent.instructions, /21 named themes/);
    assert.doesNotMatch(loaded.result.structuredContent.instructions, /stale prompt/);

    const resource = await client.request('tools/call', {
      name: 'read_skill_resource',
      arguments: {
        id: 'hallmark',
        task_id: 'bundled-shadow-test',
        path: 'references/macrostructures.md',
        chunk_index: 0,
        input_tokens_per_second: 10_000
      }
    });
    assert.equal(resource.result.isError, false);
    assert.equal(resource.result.structuredContent.ok, true);
    assert.match(resource.result.structuredContent.content, /Twenty-one named landing-page shapes/);
  } finally {
    await client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('learned input speed selects real chunk tiers for the same Skill', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-skills-tiers-'));
  const skillId = 'tier-fixture';
  const skillDirectory = path.join(dataDir, 'skills', skillId);
  fs.mkdirSync(skillDirectory, { recursive: true });
  // ~40KB of unique ASCII lines: 16KB tier -> 3 chunks, 24KB tier -> 2 chunks,
  // 48KB+ tier -> one inline payload.
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), [
    '---',
    `name: ${skillId}`,
    'description: Tier fixture with roughly 40KB of instructions',
    '---',
    '',
    '# Tier fixture',
    ...Array.from({ length: 500 }, (_, index) => `Tier rule ${String(index).padStart(4, '0')}: keep this deterministic line exactly as written for chunking.`),
    ''
  ].join('\n'), 'utf8');
  const client = createClient(dataDir);
  try {
    const slow = await client.request('tools/call', {
      name: 'read_skill',
      arguments: { id: skillId, task_id: 'tier-slow', input_tokens_per_second: 1_000 }
    });
    assert.equal(slow.result.isError, false);
    assert.equal(slow.result.structuredContent.inputTokensPerSecond, 1_000);
    assert.equal(slow.result.structuredContent.delivery, 'chunked');
    assert.equal(slow.result.structuredContent.chunkBytes, 16 * 1024);
    assert.equal(slow.result.structuredContent.chunkCount, 3);

    const medium = await client.request('tools/call', {
      name: 'read_skill',
      arguments: { id: skillId, task_id: 'tier-medium', input_tokens_per_second: 3_000 }
    });
    assert.equal(medium.result.isError, false);
    assert.equal(medium.result.structuredContent.chunkBytes, 24 * 1024);
    assert.equal(medium.result.structuredContent.chunkCount, 2);

    const fast = await client.request('tools/call', {
      name: 'read_skill',
      arguments: { id: skillId, task_id: 'tier-fast', input_tokens_per_second: 60_000 }
    });
    assert.equal(fast.result.isError, false);
    assert.equal(fast.result.structuredContent.delivery, 'inline');
    assert.equal(fast.result.structuredContent.complete, true);
  } finally {
    await client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
