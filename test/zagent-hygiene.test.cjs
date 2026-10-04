'use strict';

// Workspace hygiene contract: Z runtime output stays inside .zagent, the
// folder hides itself from git without touching the project .gitignore, and
// the agent is told to keep scratch artifacts there and clean them up.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');
const sidecarSrc = fs.readFileSync(path.join(appRoot, 'lib', 'opencode-sidecar.js'), 'utf8');
const deliverySrc = fs.readFileSync(path.join(appRoot, 'lib', 'delivery-policy.js'), 'utf8');
const { understandAnythingOutputDir } = require('../lib/codegraph-to-understand-anything');
const { pruneZagentEvidence, EVIDENCE_TTL_MS } = require('../lib/zagent-evidence');

test('Understand Anything output defaults into .zagent/ua', () => {
  assert.equal(
    understandAnythingOutputDir(path.join('C:', 'ws')).toLowerCase(),
    path.join('C:', 'ws', '.zagent', 'ua').toLowerCase()
  );
  assert.equal(
    understandAnythingOutputDir(path.join('C:', 'ws'), path.join('C:', 'custom')).toLowerCase(),
    path.join('C:', 'custom').toLowerCase()
  );
});

test('ensureZagent writes a self-ignoring .gitignore, a scratch dir and the evidence dir', () => {
  const guard = mainSrc.match(/function ensureZagent\(workspace\) \{[\s\S]*?\n\}/);
  assert.ok(guard, 'ensureZagent must exist');
  assert.match(guard[0], /\['logs', 'snapshots', 'scratch', 'evidence'\]/, 'evidence dir must be prepared');
  assert.match(guard[0], /pruneZagentEvidence\(root\)/, 'ensureZagent must bound the evidence store');
  assert.match(guard[0], /\.gitignore/, 'a .gitignore must be written');
  assert.match(guard[0], /writeFileSync\(ignore, '\*\\n'/);
});

test('a .zagent folder with the written ignore file stays invisible to git', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'z-gitignore-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    const dir = path.join(repo, '.zagent');
    fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.txt'), 'z', 'utf8');
    fs.writeFileSync(path.join(dir, 'memory.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'app.js'), 'const a = 1;\n', 'utf8');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(status.includes('.zagent'), false, `git status leaked .zagent: ${status}`);
    assert.ok(status.includes('app.js'), 'normal project files must stay visible');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('reusable evidence survives the run but is bounded by TTL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-evidence-'));
  try {
    const dir = path.join(root, 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    const fresh = path.join(dir, 'acceptance.png');
    const stale = path.join(dir, 'old-frame.png');
    fs.writeFileSync(fresh, 'fresh', 'utf8');
    fs.writeFileSync(stale, 'stale', 'utf8');
    const old = new Date(Date.now() - EVIDENCE_TTL_MS - 60_000);
    fs.utimesSync(stale, old, old);
    assert.deepEqual(pruneZagentEvidence(root), { removed: 1 });
    assert.equal(fs.existsSync(fresh), true, 'fresh evidence must be kept');
    assert.equal(fs.existsSync(stale), false, 'expired evidence must be pruned');
    assert.deepEqual(pruneZagentEvidence(path.join(root, 'missing')), { removed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool output and agent guidance separate evidence from scratch cleanup', () => {
  assert.match(mainSrc, /'--output-dir', '\.zagent\/playwright'/, 'Playwright MCP must write under .zagent');
  assert.match(sidecarSrc, /put every temporary artifact[\s\S]{0,200}\.zagent\//, 'workspace rule must name .zagent');
  assert.match(sidecarSrc, /\.zagent\/evidence\//, 'workspace rule must keep reusable evidence');
  assert.match(sidecarSrc, /keep them under <workspace>\/\.zagent\/ and delete the ones you created/, 'mapper rule must clean up');
  assert.match(deliverySrc, /交付前清点工作区/, 'delivery policy must require a scratch cleanup pass');
  assert.match(deliverySrc, /\.zagent\/evidence\//, 'delivery policy must route reusable evidence');
});
