'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readProjectInstructions } = require('../lib/project-instructions');
const { resolveModelContextSettings } = require('../lib/context-settings');
const { classifyCommand, summarizeVerification } = require('../lib/verification-state');
const { fileRevision } = require('../lib/verification-state');
const { projectEnvironment } = require('../lib/project-environment');
const { buildRepoMapBackground } = require('../lib/analysis/repo-map-background');
function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-environment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'ROOT_RULE');
  fs.writeFileSync(path.join(root, 'Z.md'), 'Z_OVERRIDE');
  fs.writeFileSync(path.join(root, 'src', 'AGENTS.md'), 'SOURCE_RULE');
  return root;
}
test('project rules resolve directory order and refresh edits/deletes without crossing workspace', t => {
  const root = repo(t);
  const target = path.join(root, 'src', 'new.js');
  assert.deepEqual(readProjectInstructions(root, target).map(record => record.text), ['ROOT_RULE', 'Z_OVERRIDE', 'SOURCE_RULE']);
  fs.writeFileSync(path.join(root, 'src', 'AGENTS.md'), 'CHANGED');
  assert.equal(readProjectInstructions(root, target).at(-1).text, 'CHANGED');
  fs.unlinkSync(path.join(root, 'src', 'AGENTS.md'));
  assert.equal(readProjectInstructions(root, target).length, 2);
  assert.throws(() => readProjectInstructions(root, path.join(root, '..', 'outside')));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(30000));
  assert.equal(readProjectInstructions(root)[0].truncated, true);
});
test('manual model window and threshold remain authoritative', () => {
  assert.deepEqual(resolveModelContextSettings({ contextWindow: 300000, compactionThreshold: 220000,
    capabilities: { contextWindow: 200000 } }), { maxTokens: 300000, compactionThreshold: 220000, source: 'manual' });
  assert.equal(resolveModelContextSettings({ capabilities: { contextWindow: 200000 } }).maxTokens, 200000);
  assert.equal(resolveModelContextSettings({}).maxTokens, 128000);
});
test('checks reject version probes, failures, unknown exits, and stale results', () => {
  assert.equal(classifyCommand('node --version'), 'environment');
  assert.equal(classifyCommand('echo npm test'), 'unknown');
  assert.equal(classifyCommand('npm test || true'), 'unknown');
  const tool = (name, command, exit, status = 'completed') => ({ parts: [{ type: 'tool', tool: name,
    state: { status, input: { command }, metadata: { exit }, output: '' } }] });
  assert.equal(summarizeVerification([tool('bash', 'npm test', 1)]).status, 'failed');
  assert.equal(summarizeVerification([tool('bash', 'npm test', undefined)]).status, 'unknown');
  const pass = tool('bash', 'npm test', 0);
  assert.equal(summarizeVerification([pass]).hasCurrentPass, true);
  assert.equal(summarizeVerification([pass, tool('edit')]).status, 'stale');
  assert.equal(summarizeVerification([tool('bash', 'npm test', 1), tool('bash', 'npm run lint', 0)]).hasCurrentPass, false);
  assert.equal(summarizeVerification([tool('bash', 'npm test', 1), pass]).hasCurrentPass, true);
});

test('file receipts invalidate a check after an external modification', t => {
  const root = repo(t);
  const file = path.join(root, 'src', 'a.js');
  fs.writeFileSync(file, 'const x = 1;');
  const messages = [{ parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'node --check src/a.js' },
    metadata: { exit: 0, zVerification: { files: { [file]: fileRevision(file) } } } } }] }];
  assert.equal(summarizeVerification(messages, { workspace: root }).status, 'passed');
  fs.writeFileSync(file, 'const x = ;');
  assert.equal(summarizeVerification(messages, { workspace: root }).status, 'stale');
});

test('package context stays scoped and background maps can be cancelled', async t => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'src', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const context = projectEnvironment(root, path.join(root, 'src', 'a.js'));
  assert.equal(context.packages[0].checks[0].command, 'node --test');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'function hello() {}');
  assert.match(await buildRepoMapBackground(root), /a\.js/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildRepoMapBackground(root, { signal: controller.signal }), /cancelled/);
  await assert.rejects(buildRepoMapBackground(root, { timeoutMs: 1 }), /timed out/);
});
test('kernel hooks load rules for parent and child and block a first scoped edit before mutation', async t => {
  const root = repo(t);
  const factory = (await import(pathToFileURL(path.resolve('lib/coding-environment-plugin.mjs')))).default;
  const plugin = await factory({ directory: root, client: { session: { get: async () => ({ data: { id: 'session', permission: [{ permission: 'read', pattern: '*', action: 'allow' }] } }) } } });
  for (const sessionID of ['parent', 'child']) {
    const output = { system: [] };
    await plugin['experimental.chat.system.transform']({ sessionID }, output);
    assert.match(output.system.join('\n'), /ROOT_RULE/);
    assert.doesNotMatch(output.system.join('\n'), /SOURCE_RULE/);
    const input = { sessionID, tool: 'edit' };
    const args = { args: { filePath: path.join(root, 'src', 'new.js') } };
    await assert.rejects(plugin['tool.execute.before'](input, args), /SOURCE_RULE/);
    await plugin['tool.execute.before'](input, args);
    fs.writeFileSync(path.join(root, 'src', 'AGENTS.md'), 'SOURCE_RULE_UPDATED');
    await assert.rejects(plugin['tool.execute.before'](input, args), /SOURCE_RULE_UPDATED/);
    fs.writeFileSync(path.join(root, 'src', 'AGENTS.md'), 'SOURCE_RULE');
  }
});
test('read-denied sessions receive no project text', async t => {
  const root = repo(t);
  const factory = (await import(pathToFileURL(path.resolve('lib/coding-environment-plugin.mjs')))).default;
  const plugin = await factory({ directory: root, client: { session: { get: async () => ({ data: { id: 'session', permission: [{ permission: 'read', pattern: '*', action: 'deny' }] } }) } } });
  const output = { system: [] };
  await plugin['experimental.chat.system.transform']({ sessionID: 'denied' }, output);
  assert.deepEqual(output.system, []);
});

test('external file tools defer to native permissions without loading external context', async t => {
  const root = repo(t);
  // A sibling with the same path prefix must still count as external.
  const outside = `${root}-external`;
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'AGENTS.md'), 'EXTERNAL_RULE_MUST_WAIT_FOR_NATIVE_AUTHORIZATION');
  fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const file = path.join(outside, 'sample.js');
  const original = 'const value = 1;\n';
  fs.writeFileSync(file, original);
  const factory = (await import(pathToFileURL(path.resolve('lib/coding-environment-plugin.mjs')))).default;
  for (const externalAction of ['allow', 'ask', 'deny']) {
    const permissions = Object.freeze([
      Object.freeze({ permission: 'read', pattern: '*', action: 'allow' }),
      Object.freeze({ permission: 'edit', pattern: '*', action: externalAction === 'deny' ? 'deny' : 'allow' }),
      Object.freeze({ permission: 'external_directory', pattern: '*', action: externalAction })
    ]);
    const plugin = await factory({ directory: root, client: { session: { get: async () => ({ data: { id: 'session', permission: permissions } }) } } });
    const actions = [
      ['read', { filePath: file }],
      ['read', { path: path.relative(root, file) }],
      ['edit', { filePath: file, oldString: '1', newString: '2' }],
      ['write', { filePath: path.join(outside, 'new.js'), content: 'const added = true;' }],
      ['apply_patch', { patchText: `*** Begin Patch\n*** Update File: ${file}\n*** Move to: ${path.join(outside, 'renamed.js')}\n@@\n-const value = 1;\n+const value = 2;\n*** Delete File: ${file}\n*** Add File: ${path.join(outside, 'new.js')}\n+const added = true;\n*** End Patch` }]
    ];
    for (const [tool, args] of actions) {
      const input = { sessionID: 'session', callID: `${externalAction}-${tool}`, tool, args };
      const before = { args: structuredClone(args) };
      await plugin['tool.execute.before'](input, before);
      assert.deepEqual(before.args, args, 'context discovery must not rewrite native arguments or authorize a tool');
      const after = { output: 'Native tool result', metadata: {} };
      await plugin['tool.execute.after'](input, after);
      assert.deepEqual(after, { output: 'Native tool result', metadata: {} }, 'external results must not be replaced by workspace context errors');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'the plugin only observes; native tools perform authorized operations');
    assert.equal(permissions.at(-1).action, externalAction);
  }
});

test('automatic context still rejects a workspace symlink escape', async t => {
  const root = repo(t);
  const outside = repo(t);
  const link = path.join(root, 'linked-project');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const factory = (await import(pathToFileURL(path.resolve('lib/coding-environment-plugin.mjs')))).default;
  const plugin = await factory({ directory: root, client: { session: { get: async () => ({ data: { id: 'session', permission: [{ permission: '*', pattern: '*', action: 'allow' }] } }) } } });
  for (const filePath of [path.join(link, 'AGENTS.md'), path.join(link, 'new.js')]) {
    await assert.rejects(plugin['tool.execute.before']({ sessionID: 'session', tool: 'read' }, { args: { filePath } }), /Symlink outside workspace/);
  }
  assert.throws(() => readProjectInstructions(root, outside), /Path outside workspace/,
    'the scoped instruction reader must not become a general external-file reader');
});
