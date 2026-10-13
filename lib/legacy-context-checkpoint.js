'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Older rewinds removed the native session handle. Recover only through exact
// retained part IDs and verified transcript coverage, never workspace/title
// similarity or timestamps. All database access stays read-only in a worker.
async function recoverLegacyDesktopCheckpoint({ appRoot, dataDir, request = {}, directory, signal } = {}) {
  const messages = request.forkHistory?.messages;
  if (signal?.aborted || !Array.isArray(messages) || !messages.length || !dataDir || !directory) return null;
  const dbPath = path.join(dataDir, 'opencode-runtime', 'data', 'opencode', 'opencode.db');
  if (!fs.existsSync(dbPath)) return null;
  const runtime = require('./codegraph-runtime').resolveNodeCommand(appRoot);
  if (!runtime.ok) return null;
  const worker = path.join(__dirname, 'legacy-context-checkpoint-worker.cjs').replace(
    `${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const input = JSON.stringify({ dbPath, directory, messages, request: {
    zSessionId: request.zSessionId, branchId: request.branchId,
    conversationRevision: request.conversationRevision, workMode: request.workMode
  } });
  if (Buffer.byteLength(input, 'utf8') > 40 * 1024 * 1024) return null;
  return new Promise(resolve => {
    const child = execFile(runtime.command, ['--disable-warning=ExperimentalWarning', worker], {
      windowsHide: true, shell: false, timeout: 15_000, maxBuffer: 12 * 1024 * 1024,
      signal,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout).checkpoint || null); } catch { resolve(null); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

module.exports = { recoverLegacyDesktopCheckpoint };
