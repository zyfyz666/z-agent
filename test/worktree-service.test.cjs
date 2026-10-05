'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const worktrees = require('../lib/worktree-service');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-worktree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'z@example.com']);
  git(root, ['config', 'user.name', 'Z Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

test('sanitizeTaskId normalizes and rejects unusable ids', () => {
  assert.equal(worktrees.sanitizeTaskId(' Auth Module '), 'auth-module');
  assert.throws(() => worktrees.sanitizeTaskId('///'));
  assert.throws(() => worktrees.sanitizeTaskId(''));
  assert.throws(() => worktrees.sanitizeTaskId('.hidden'));
  assert.throws(() => worktrees.sanitizeTaskId('x'.repeat(60)));
});

test('create, list, and status task worktrees; main status stays clean', async t => {
  const root = makeRepo(t);
  const created = await worktrees.createTaskWorktree(root, { taskId: 'Auth Module' });
  assert.equal(created.branch, 'z-task-auth-module');
  assert.ok(fs.existsSync(path.join(created.path, 'README.md')));

  const list = await worktrees.listTaskWorktrees(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, 'auth-module');
  assert.equal(list[0].branch, 'z-task-auth-module');

  const status = await worktrees.taskWorktreeStatus(root, { taskId: 'auth-module' });
  assert.equal(status.dirty, false);

  const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.includes('.zagent/'));
  const rawStatus = git(root, ['status', '--porcelain']);
  assert.equal(rawStatus.trim(), '', 'nested worktree must not pollute the main git status');

  await assert.rejects(() => worktrees.createTaskWorktree(root, { taskId: 'auth-module' }), /already exists/);
});

test('mergeTaskWorktree merges committed builder work and reports the commit', async t => {
  const root = makeRepo(t);
  const created = await worktrees.createTaskWorktree(root, { taskId: 'feature' });
  fs.writeFileSync(path.join(created.path, 'feature.js'), 'module.exports = 1;\n');
  git(created.path, ['add', '.']);
  git(created.path, ['commit', '-m', 'add feature']);

  const result = await worktrees.mergeTaskWorktree(root, { taskId: 'feature', message: 'merge feature' });
  assert.equal(result.merged, true);
  assert.ok(fs.existsSync(path.join(root, 'feature.js')));
  const log = git(root, ['log', '--oneline']);
  assert.ok(log.includes('merge feature'));
});

test('mergeTaskWorktree reports conflicts, aborts cleanly, and keeps the main tree intact', async t => {
  const root = makeRepo(t);
  fs.writeFileSync(path.join(root, 'README.md'), '# main version\n');
  git(root, ['commit', '-am', 'main edits']);
  const created = await worktrees.createTaskWorktree(root, { taskId: 'clash', base: 'main~1' });
  fs.writeFileSync(path.join(created.path, 'README.md'), '# worktree version\n');
  git(created.path, ['commit', '-am', 'worktree edits']);

  const result = await worktrees.mergeTaskWorktree(root, { taskId: 'clash' });
  assert.equal(result.merged, false);
  assert.equal(result.reason, 'conflicts');
  assert.ok(result.conflicts.some(file => file.replace(/\\/g, '/').includes('README.md')));
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), '# main version\n');
  assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'conflicted merge must be fully aborted');
});

test('mergeTaskWorktree refuses to run on a dirty main tree', async t => {
  const root = makeRepo(t);
  const created = await worktrees.createTaskWorktree(root, { taskId: 'clean-task' });
  fs.writeFileSync(path.join(created.path, 'ok.txt'), 'x\n');
  git(created.path, ['add', '.']);
  git(created.path, ['commit', '-m', 'work']);
  fs.writeFileSync(path.join(root, 'README.md'), '# uncommitted\n');

  const result = await worktrees.mergeTaskWorktree(root, { taskId: 'clean-task' });
  assert.equal(result.merged, false);
  assert.equal(result.reason, 'main-tree-dirty');
  assert.ok(result.dirtyFiles.length >= 1);
});

test('removeTaskWorktree guards dirty worktrees, unmerged branches survive', async t => {
  const root = makeRepo(t);
  const created = await worktrees.createTaskWorktree(root, { taskId: 'temp' });
  fs.writeFileSync(path.join(created.path, 'wip.txt'), 'wip\n');

  const refused = await worktrees.removeTaskWorktree(root, { taskId: 'temp' });
  assert.equal(refused.removed, false);
  assert.equal(refused.reason, 'dirty');

  git(created.path, ['add', '.']);
  git(created.path, ['commit', '-m', 'unfinished']);
  const removed = await worktrees.removeTaskWorktree(root, { taskId: 'temp' });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchKept, true, 'unmerged z-task branch must be kept');
  const branches = git(root, ['branch', '--list', 'z-task-temp']);
  assert.ok(branches.includes('z-task-temp'));
  assert.equal(fs.existsSync(created.path), false);
});

test('mergeTaskWorktree fails clearly when the task worktree does not exist', async t => {
  const root = makeRepo(t);
  await assert.rejects(() => worktrees.mergeTaskWorktree(root, { taskId: 'ghost' }), /No worktree found/);
});

test('squash conflict restores clean main HEAD while preserving task changes', async t => {
  const root = makeRepo(t);
  const task = await worktrees.createTaskWorktree(root, { taskId: 'squash-conflict' });
  fs.writeFileSync(path.join(task.path, 'README.md'), 'task version\n');
  git(task.path, ['commit', '-am', 'task']);
  fs.writeFileSync(path.join(root, 'README.md'), 'main version\n');
  git(root, ['commit', '-am', 'main']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const result = await worktrees.mergeTaskWorktree(root, { taskId: task.taskId, squash: true });
  assert.equal(result.reason, 'conflicts');
  assert.equal(result.recovered, true);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '');
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.readFileSync(path.join(task.path, 'README.md'), 'utf8').trim(), 'task version');
});

test('concurrent task merges serialize and retain both results', async t => {
  const root = makeRepo(t);
  const tasks = [];
  for (const taskId of ['one', 'two']) {
    const task = await worktrees.createTaskWorktree(root, { taskId });
    fs.writeFileSync(path.join(task.path, `${taskId}.txt`), taskId);
    git(task.path, ['add', '.']);
    git(task.path, ['commit', '-m', taskId]);
    tasks.push(task);
  }
  const results = await Promise.all(tasks.map(task => worktrees.mergeTaskWorktree(root, { taskId: task.taskId, squash: true })));
  assert.ok(results.every(result => result.merged));
  for (const task of tasks) assert.equal(fs.readFileSync(path.join(root, `${task.taskId}.txt`), 'utf8'), task.taskId);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '');
});

test('worktrees registered directly with git stay in place and remain manageable', async t => {
  const root = makeRepo(t);
  const taskId = 'existing-task';
  const directory = path.join(worktrees.worktreeRoot(root), taskId);
  const branch = `z-task-${taskId}`;
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  git(root, ['worktree', 'add', '-b', branch, directory]);
  const beforeRegistration = fs.readFileSync(path.join(directory, '.git'), 'utf8');
  const listed = await worktrees.listTaskWorktrees(root);
  assert.equal(listed.length, 1);
  // Git expands Windows short paths and junctions; compare the actual
  // directories rather than the spelling returned by the temp environment.
  const canonicalPath = value => {
    const resolved = fs.realpathSync.native(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  assert.equal(canonicalPath(listed[0].path), canonicalPath(directory));
  assert.equal(listed[0].branch, branch);
  assert.equal((await worktrees.taskWorktreeStatus(root, { taskId })).dirty, false);
  await assert.rejects(() => worktrees.createTaskWorktree(root, { taskId }), error => error.code === 'WORKTREE_EXISTS');
  assert.equal((await worktrees.listTaskWorktrees(root)).length, 1);
  assert.equal(fs.readFileSync(path.join(directory, '.git'), 'utf8'), beforeRegistration);

  fs.writeFileSync(path.join(directory, 'compat.txt'), 'preserved work');
  assert.equal((await worktrees.taskWorktreeStatus(root, { taskId })).dirty, true);
  assert.equal((await worktrees.removeTaskWorktree(root, { taskId })).reason, 'dirty');
  git(directory, ['add', 'compat.txt']);
  git(directory, ['commit', '-m', 'preserved work']);
  const merged = await worktrees.mergeTaskWorktree(root, { taskId });
  assert.equal(merged.merged, true, 'the .zagent metadata directory is excluded from main-tree dirtiness');
  assert.equal(fs.readFileSync(path.join(root, 'compat.txt'), 'utf8'), 'preserved work');
  const removed = await worktrees.removeTaskWorktree(root, { taskId });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchKept, false);
});

test('only .zagent task worktrees are discovered; external checkouts are not adopted', async t => {
  const root = makeRepo(t);
  const external = path.join(root, 'outside-worktrees', 'unrelated');
  fs.mkdirSync(path.dirname(external), { recursive: true });
  git(root, ['worktree', 'add', '-b', 'unrelated-branch', external]);
  const created = await worktrees.createTaskWorktree(root, { taskId: 'current' });
  assert.equal(path.dirname(created.path), path.join(root, '.zagent', 'worktrees'));
  assert.equal(created.branch, 'z-task-current');
  const list = await worktrees.listTaskWorktrees(root);
  assert.deepEqual(list.map(entry => entry.taskId), ['current']);
  assert.ok(fs.existsSync(path.join(external, '.git')));
});

test('a task id matching two registered worktrees refuses destructive management', async t => {
  const root = makeRepo(t);
  const byDirectory = path.join(worktrees.worktreeRoot(root), 'duplicate');
  const byBranch = path.join(worktrees.worktreeRoot(root), 'second');
  fs.mkdirSync(worktrees.worktreeRoot(root), { recursive: true });
  git(root, ['worktree', 'add', '-b', 'manual-branch', byDirectory]);
  git(root, ['worktree', 'add', '-b', 'z-task-duplicate', byBranch]);
  await assert.rejects(() => worktrees.removeTaskWorktree(root, { taskId: 'duplicate' }), error => error.code === 'WORKTREE_AMBIGUOUS');
  assert.equal((await worktrees.listTaskWorktrees(root)).length, 2);
});
