'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('task-memory preload forwards the selected session and revision through dedicated channels', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'z') api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on() {}, removeListener() {} }, webUtils: {} })
  });
  const list = { sessionId: 'sess_other', query: 'scope', includeInactive: true };
  const edit = { sessionId: 'sess_other', id: 'memory_1', content: 'A constraint', conversationRevision: 4 };
  const remove = { sessionId: 'sess_other', id: 'memory_1', conversationRevision: 4 };
  await api.listTaskMemories(list);
  await api.updateTaskMemory(edit);
  await api.deleteTaskMemory(remove);
  assert.deepEqual(calls, [['memory:task-list', list], ['memory:task-update', edit], ['memory:task-delete', remove]]);
});

test('memory display classifies task progress separately and preserves plain content', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = renderer.indexOf('function taskMemoryText(');
  const end = renderer.indexOf('async function openTaskMemoryDialog(', start);
  assert.ok(start > 0 && end > start);
  const sandbox = vm.createContext({});
  vm.runInContext(renderer.slice(start, end), sandbox);
  assert.equal(sandbox.taskMemoryText('<script>unsafe</script>'), '<script>unsafe</script>');
  assert.equal(sandbox.taskMemoryText(null), '');
  assert.equal(sandbox.taskMemoryText({ goal: 'Done' }), '{\n  "goal": "Done"\n}');
  assert.equal(sandbox.taskMemoryIsProgress({ scope: 'task', type: 'decision' }), true);
  assert.equal(sandbox.taskMemoryIsProgress({ scope: 'workspace', type: 'work_state' }), true);
  assert.equal(sandbox.taskMemoryIsProgress({ scope: 'workspace', type: 'decision' }), false);
  assert.equal(sandbox.taskMemoryScopeLabel('machine'), '本机');
  assert.equal(sandbox.taskMemoryScopeLabel('workspace'), '本项目');
  assert.equal(sandbox.taskMemoryStatusLabel('disabled'), '已停用');
  assert.equal(sandbox.taskMemoryStatusLabel('legacy'), '旧版记录');
});
