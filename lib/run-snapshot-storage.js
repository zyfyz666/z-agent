'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { workspaceStatePath } = require('./storage-layout');
const { writeAtomic } = require('./z-core/store');

function snapshotDirectory(workspace, sessionId) {
  return path.join(workspace, '.zagent', 'snapshots', sessionId);
}

function consumedSnapshot(workspace, sessionId, runId) {
  return fs.existsSync(path.join(snapshotDirectory(workspace, sessionId), '.consumed', `${runId}.json`));
}

function resolveRunSnapshotPath(workspace, sessionId, runId) {
  if (consumedSnapshot(workspace, sessionId, runId)) return null;
  return workspaceStatePath(workspace, ['snapshots', sessionId, `${runId}.json`]);
}

async function listRunSnapshotPaths(workspace, sessionId) {
  const seen = new Set();
  const files = [];
  const directory = snapshotDirectory(workspace, sessionId);
  let entries = [];
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const runId = entry.name.slice(0, -5);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(runId)) continue;
    const key = process.platform === 'win32' ? runId.toLowerCase() : runId;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!consumedSnapshot(workspace, sessionId, runId)) files.push(path.join(directory, entry.name));
  }
  return files;
}

function consumeRunSnapshot(workspace, sessionId, runId) {
  // Prevent the snapshot from becoming available again after an explicit undo.
  const marker = path.join(snapshotDirectory(workspace, sessionId), '.consumed', `${runId}.json`);
  writeAtomic(marker, { version: 1, sessionId, runId, consumedAt: Date.now() });
}

module.exports = { resolveRunSnapshotPath, listRunSnapshotPaths, consumeRunSnapshot };
