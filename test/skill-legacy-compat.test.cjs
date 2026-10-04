'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../lib/skill-registry');
const store = require('../lib/skill-store');
const { LEGACY_NAMESPACE, LEGACY_STORAGE, LEGACY_FIELDS } = require('../lib/legacy-compat');
const appRoot = path.resolve(__dirname, '..');
const oldId = suffix => `${LEGACY_NAMESPACE.lower}-${suffix}`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-skill-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function packageAt(root, directory, manifest, prompt = 'Keep the user prompt unchanged.') {
  const folder = path.join(root, 'skills', directory);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, LEGACY_STORAGE.skillManifest), JSON.stringify(manifest));
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${directory}\ndescription: "fixture"\n---\n\n${prompt}\n`);
  return folder;
}

test('the preceding manifest identifies managed installs and updates in place using the current manifest', t => {
  const root = fixture(t);
  const folder = packageAt(root, 'custom-package', { id: 'custom-package', source: oldId('user'), [LEGACY_FIELDS.zManaged]: true });
  const scanned = registry.scanZUserSkills(root)[0];
  assert.equal(scanned.id, 'custom-package');
  assert.equal(scanned.source, 'z-user');
  assert.equal(scanned.zManaged, true);
  const result = registry.installZUserSkill(root, { ...scanned, prompt: 'Updated prompt.' });
  assert.equal(result.directory, folder);
  assert.equal(fs.existsSync(path.join(folder, '.z-skill.json')), true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'skills')), ['custom-package']);
  assert.equal(registry.scanZUserSkills(root)[0].prompt, 'Updated prompt.');
});

test('an explicit unmanaged flag survives the preceding manifest and prevents overwrite', t => {
  const root = fixture(t);
  packageAt(root, 'user-package', { id: 'user-package', [LEGACY_FIELDS.zManaged]: false });
  const scanned = registry.scanZUserSkills(root)[0];
  assert.equal(scanned.zManaged, false);
  const result = registry.installZUserSkill(root, { id: 'user-package', prompt: 'Do not overwrite.' });
  assert.equal(result.preserved, true);
  assert.equal(registry.scanZUserSkills(root)[0].prompt, 'Keep the user prompt unchanged.');
});

test('a current manifest takes precedence, including explicit false and invalid data', t => {
  const root = fixture(t);
  const folder = packageAt(root, 'original-name', { id: 'old-manifest-id', [LEGACY_FIELDS.zManaged]: true });
  const filename = path.join(folder, '.z-skill.json');
  fs.writeFileSync(filename, JSON.stringify({ id: 'current-id', zManaged: false, [LEGACY_FIELDS.zManaged]: true }));
  let scanned = registry.scanZUserSkills(root)[0];
  assert.equal(scanned.id, 'current-id');
  assert.equal(scanned.zManaged, false);
  fs.writeFileSync(filename, '{');
  scanned = registry.scanZUserSkills(root)[0];
  assert.equal(scanned.id, 'original-name');
  assert.equal(scanned.zManaged, false, 'a broken current manifest must not reactivate old ownership');
});

test('all renamed builtins resolve exactly while current config wins duplicate identities', t => {
  const root = fixture(t);
  const suffixes = ['codegraph', 'prompt-optimizer', 'serena', 'understand-anything', 'react-bits', 'uiverse'];
  const cfg = { customSkills: suffixes.map(suffix => ({ id: oldId(suffix), name: suffix, desc: suffix,
    prompt: `fixture-${suffix}`, source: `${LEGACY_NAMESPACE.title} Agent` })) };
  cfg.customSkills.push({ id: 'z-codegraph', name: 'Current metadata', desc: 'current', prompt: 'current', source: 'bundled' });
  assert.equal(registry.hydrateInstalledSkillMetadata(cfg, appRoot, root), true);
  assert.equal(cfg.customSkills.length, suffixes.length);
  assert.equal(cfg.customSkills.find(skill => skill.id === 'z-codegraph').name, 'Current metadata');
  assert.equal(registry.hydrateInstalledSkillMetadata(cfg, appRoot, root), false, 'normalization is idempotent');
  const catalog = registry.getInstalledSkills(cfg, appRoot, root);
  for (const suffix of suffixes) {
    assert.equal(catalog.filter(skill => skill.id === `z-${suffix}`).length, 1);
    const resolved = registry.resolveSkill(oldId(suffix), cfg, appRoot, root, { allowFuzzy: false });
    assert.equal(resolved.skill.id, `z-${suffix}`);
    assert.equal(resolved.fuzzy, false);
  }
});

test('app-generated skill ownership and managed fields are normalized without changing custom content', () => {
  const original = { id: oldId('my-custom-tool'), source: 'https://example.invalid/custom',
    prompt: `Do not rewrite ${oldId('codegraph')} in this user document.`,
    createdBy: oldId('skill-creator'), [LEGACY_FIELDS.zManaged]: true };
  const normalized = registry.normalizeSkillMetadata(original);
  assert.equal(normalized.id, original.id);
  assert.equal(normalized.source, original.source);
  assert.equal(normalized.prompt, original.prompt);
  assert.equal(normalized.createdBy, 'z-skill-creator');
  assert.equal(normalized.zManaged, true);
  assert.equal(Object.hasOwn(normalized, LEGACY_FIELDS.zManaged), false);
  assert.equal(original.createdBy, oldId('skill-creator'), 'normalizing metadata does not mutate its caller');
  assert.equal(registry.isGeneratedSkill(original), true);
  assert.equal(registry.isGeneratedSkill(normalized), true);
  assert.equal(registry.isGeneratedSkill({ createdBy: `${oldId('skill-creator')}-custom` }), false);
});

test('bundled shadow cleanup recognizes old metadata and preserves user-owned packages', t => {
  const root = fixture(t);
  const managed = packageAt(root, oldId('prompt-optimizer'), { id: oldId('prompt-optimizer'), source: `${LEGACY_NAMESPACE.title} Agent` });
  const custom = packageAt(root, 'user-copy', { id: 'z-codegraph', source: 'custom' });
  const result = registry.migrateBundledSkillShadows(root, appRoot, ['z-prompt-optimizer', 'z-codegraph']);
  assert.deepEqual(result.removedIds, ['z-prompt-optimizer']);
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.existsSync(custom), true);
});

test('SkillStore cleans only obsolete generated entries in either marker format', t => {
  const root = fixture(t);
  const owned = path.join(root, 'SkillStore', 'installed', 'old-generated');
  const foreign = path.join(root, 'SkillStore', 'installed', 'user-owned');
  for (const folder of [owned, foreign]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(owned, `.${LEGACY_NAMESPACE.lower}-skill-entry`), 'generated\n');
  fs.writeFileSync(path.join(foreign, 'keep.md'), 'user content');
  const result = store.syncSkillStore(root, [{ id: 'z-new-entry', prompt: 'Current generated entry.', source: 'custom' }]);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(path.join(foreign, 'keep.md')), true);
  const created = path.join(root, 'SkillStore', result.index.entries[0].storePath);
  assert.equal(fs.existsSync(path.join(created, '.z-skill-entry')), true);
});
