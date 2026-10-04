'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LEGACY_STORAGE } = require('./legacy-compat');
const { workspaceStatePath } = require('./storage-layout');
const { writeAtomic } = require('./z-core/store');

function snapshotDirectories(workspace, sessionId) {
  return ['.zagent', LEGACY_STORAGE.workspaceDir]
    .map(directory => path.join(workspace, directory, 'snapshots', sessionId));
}

function consumedSnapshot(workspace, sessionId, runId) {
  return snapshotDirectories(workspace, sessionId)
    .some(directory => fs.existsSync(path.join(directory, '.consumed', `${runId}.json`)));
}

function resolveRunSnapshotPath(workspace, sessionId, runId) {
  if (consumedSnapshot(workspace, sessionId, runId)) return null;
  return workspaceStatePath(workspace, ['snapshots', sessionId, `${runId}.json`]);
}

async function listRunSnapshotPaths(workspace, sessionId) {
  const seen = new Set();
  const files = [];
  // Prefer a current snapshot even if a stale copy remains in the preceding
  // directory. A later JSON parse failure must not revive the older snapshot.
  for (const directory of snapshotDirectories(workspace, sessionId)) {
    let entries = [];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const runId = entry.name.slice(0, -5);
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(runId)) continue;
      const key = process.platform === 'win32' ? runId.toLowerCase() : runId;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!consumedSnapshot(workspace, sessionId, runId)) files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function consumeRunSnapshot(workspace, sessionId, runId) {
  // Keep older copies in place, but prevent any copy from becoming available
  // again after the selected snapshot has been consumed by an explicit undo.
  const marker = path.join(snapshotDirectories(workspace, sessionId)[0], '.consumed', `${runId}.json`);
  writeAtomic(marker, { version: 1, sessionId, runId, consumedAt: Date.now() });
}

module.exports = { resolveRunSnapshotPath, listRunSnapshotPaths, consumeRunSnapshot };
