'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');

function taskWorkspaceRoot({ documentsDirectory, userDataDirectory, isolated = false }) {
  const base = String(isolated ? userDataDirectory : documentsDirectory || '').trim();
  if (!base) throw new Error('Task storage directory is unavailable.');
  return path.join(path.resolve(base), 'Z Agent', 'Tasks');
}

function defaultTaskWorkspace(root, sessionId) {
  const id = String(sessionId || '').trim();
  if (!/^sess_[A-Za-z0-9_-]{4,160}$/.test(id)) throw new Error('Invalid task ID.');
  return path.join(path.resolve(root), id);
}

function legacyRuntimeWorkspace(dataDirectory, sessionId) {
  const key = crypto.createHash('sha256').update(String(sessionId || 'anonymous')).digest('hex');
  return path.join(dataDirectory, 'opencode-runtime', 'no-workspace', key);
}

function samePath(left, right) {
  const normalize = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

// A save from an older renderer can still carry workspace: ''. Preserve the
// authoritative folder in that case. Clearing a folder deliberately is done
// through session:set-workspace, which calls this without a previous session.
function resolveTaskWorkspace(session, { root, previousSession } = {}) {
  const defaultDirectory = defaultTaskWorkspace(root, session?.id);
  const requested = String(session?.workspace || '').trim();
  const previous = String(previousSession?.workspace || '').trim();
  const workspace = path.resolve(requested || previous || defaultDirectory);
  const inheritedDefault = previousSession?.workspaceKind === 'default'
    && previous && samePath(previous, workspace);
  return {
    workspace,
    workspaceKind: samePath(workspace, defaultDirectory) || inheritedDefault ? 'default' : 'selected',
    ...(session?.legacyRuntimeWorkspace || previousSession?.legacyRuntimeWorkspace
      ? { legacyRuntimeWorkspace: String(session?.legacyRuntimeWorkspace || previousSession.legacyRuntimeWorkspace) }
      : {})
  };
}

async function ensureTaskWorkspace(session, options = {}) {
  const resolved = resolveTaskWorkspace(session, options);
  // Never silently create a missing user-selected project folder. Automatic
  // task folders are durable and may be recreated after an empty one is removed.
  if (resolved.workspaceKind === 'default') await fs.mkdir(resolved.workspace, { recursive: true });
  if (!String(session?.workspace || '').trim() && options.dataDirectory && !resolved.legacyRuntimeWorkspace) {
    const legacy = legacyRuntimeWorkspace(options.dataDirectory, session.id);
    const stat = await fs.stat(legacy).catch(() => null);
    // Keep old files exactly where they are; recording their location avoids
    // a potentially large recursive move during conversation loading.
    if (stat?.isDirectory()) resolved.legacyRuntimeWorkspace = legacy;
  }
  return resolved;
}

module.exports = { taskWorkspaceRoot, defaultTaskWorkspace, legacyRuntimeWorkspace, resolveTaskWorkspace, ensureTaskWorkspace };
