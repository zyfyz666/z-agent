'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../lib/skill-registry');
const store = require('../lib/skill-store');
const appRoot = path.resolve(__dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-skill-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function packageAt(root, directory, manifest, prompt = 'Keep the user prompt unchanged.') {
  const folder = path.join(root, 'skills', directory);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.z-skill.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${directory}\ndescription: "fixture"\n---\n\n${prompt}\n`);
  return folder;
}

test('a managed manifest identifies the install and updates it in place', t => {
  const root = fixture(t);
  const folder = packageAt(root, 'custom-package', { id: 'custom-package', source: 'z-user', zManaged: true });
  const scanned = registry.scanZUserSkills(root)[0];
  assert.equal(scanned.id, 'custom-package');
  assert.equal(scanned.source, 'z-user');
  assert.equal(scanned.zManaged, true);
  const result = registry.installZUserSkill(root, { ...scanned, prompt: 'Updated prompt.' });
  assert.equal(result.directory, folder);
  assert.deepEqual(fs.readdirSync(path.join(root, 'skills')), ['custom-package']);
  assert.equal(registry.scanZUserSkills(root)[0].prompt, 'Updated prompt.');
});

test('an explicit unmanaged flag prevents overwrite and a broken manifest never grants ownership', t => {
  const root = fixture(t);
  const folder = packageAt(root, 'user-package', { id: 'user-package', zManaged: false });
  assert.equal(registry.scanZUserSkills(root)[0].zManaged, false);
  const result = registry.installZUserSkill(root, { id: 'user-package', prompt: 'Do not overwrite.' });
  assert.equal(result.preserved, true);
  assert.equal(registry.scanZUserSkills(root)[0].prompt, 'Keep the user prompt unchanged.');
  fs.writeFileSync(path.join(folder, '.z-skill.json'), '{');
  const scanned = registry.scanZUserSkills(root)[0];
  assert.equal(scanned.id, 'user-package');
  assert.equal(scanned.zManaged, false);
});

test('skill metadata normalization keeps custom content and does not mutate its caller', () => {
  const original = { id: 'My-Custom-Tool', source: ' https://example.invalid/custom ',
    prompt: 'Do not rewrite z-codegraph in this user document.', createdBy: 'z-skill-creator', zManaged: true };
  const normalized = registry.normalizeSkillMetadata(original);
  assert.equal(normalized.id, 'my-custom-tool');
  assert.equal(normalized.source, 'https://example.invalid/custom');
  assert.equal(normalized.prompt, original.prompt);
  assert.equal(normalized.createdBy, 'z-skill-creator');
  assert.equal(normalized.zManaged, true);
  assert.equal(original.id, 'My-Custom-Tool', 'normalizing metadata does not mutate its caller');
  assert.equal(registry.isGeneratedSkill(normalized), true);
  assert.equal(registry.isGeneratedSkill({ createdBy: 'z-skill-creator-custom' }), false);
  const cfg = { customSkills: [{ id: 'z-codegraph', name: 'Current metadata', desc: 'current', prompt: 'current', source: 'bundled' }] };
  registry.hydrateInstalledSkillMetadata(cfg, appRoot, os.tmpdir());
  assert.equal(registry.hydrateInstalledSkillMetadata(cfg, appRoot, os.tmpdir()), false, 'normalization is idempotent');
  assert.equal(cfg.customSkills[0].name, 'Current metadata');
});

test('bundled shadow cleanup removes app-managed copies and preserves user-owned packages', t => {
  const root = fixture(t);
  const managed = packageAt(root, 'z-prompt-optimizer', { id: 'z-prompt-optimizer', source: 'Z Agent' });
  const custom = packageAt(root, 'user-copy', { id: 'z-codegraph', source: 'custom' });
  const result = registry.migrateBundledSkillShadows(root, appRoot, ['z-prompt-optimizer', 'z-codegraph']);
  assert.deepEqual(result.removedIds, ['z-prompt-optimizer']);
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.existsSync(custom), true);
});

test('SkillStore cleans only obsolete generated entries and marks the ones it creates', t => {
  const root = fixture(t);
  const owned = path.join(root, 'SkillStore', 'installed', 'old-generated');
  const foreign = path.join(root, 'SkillStore', 'installed', 'user-owned');
  for (const folder of [owned, foreign]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(owned, '.z-skill-entry'), 'generated\n');
  fs.writeFileSync(path.join(foreign, 'keep.md'), 'user content');
  const result = store.syncSkillStore(root, [{ id: 'z-new-entry', prompt: 'Current generated entry.', source: 'custom' }]);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(path.join(foreign, 'keep.md')), true);
  const created = path.join(root, 'SkillStore', result.index.entries[0].storePath);
  assert.equal(fs.existsSync(path.join(created, '.z-skill-entry')), true);
});
