'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function inspectDiskCompletion({ appRoot, dataDir, record }) {
  const unknown = error => ({ status: 'unknown', result: '', completedAt: 0, consumed: false, ...(error ? { error } : {}) });
  const dbPath = path.join(dataDir, 'opencode-runtime', 'data', 'opencode', 'opencode.db');
  if (!fs.existsSync(dbPath)) return Promise.resolve(unknown());
  const runtime = require('../codegraph-runtime').resolveNodeCommand(appRoot);
  if (!runtime.ok) return Promise.resolve(unknown(runtime.error));
  const worker = path.join(__dirname, 'completion-disk-worker.cjs').replace(
    `${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  // Electron 31 uses Node 20. The shipped Node worker supplies SQLite and
  // keeps database contention and parsing off the desktop's main thread.
  return new Promise(resolve => {
    const child = execFile(runtime.command, ['--disable-warning=ExperimentalWarning', worker], {
      windowsHide: true, shell: false, timeout: 5000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    }, (error, stdout) => {
      if (error) return resolve(unknown(error.message));
      try { resolve(JSON.parse(stdout)); } catch { resolve(unknown('子代理只读恢复返回无效记录')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ dbPath, record: {
      parentSessionID: record.parentSessionID, childSessionID: record.childSessionID, directory: record.directory,
      callId: record.callId, startedAt: record.startedAt
    } }));
  });
}

module.exports = { inspectDiskCompletion };
