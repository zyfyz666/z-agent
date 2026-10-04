'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LEGACY_STORAGE } = require('./legacy-compat');

// Existing databases stay in place. Renaming a product must not create an
// empty profile or move an open Chromium/Git database underneath its owner.
function existingChild(root, current, previous) {
  const next = path.join(root, current);
  const old = path.join(root, previous);
  return !fs.existsSync(next) && fs.existsSync(old) ? old : next;
}

function dataRoot(userData) {
  return existingChild(userData, 'ZData', LEGACY_STORAGE.stableDataDir);
}

function coreRoot(dataDirectory) {
  return existingChild(dataDirectory, 'z-core', LEGACY_STORAGE.coreDir);
}

function browserPartition(userData) {
  const previous = LEGACY_STORAGE.browserPartition.slice('persist:'.length);
  return fs.existsSync(path.join(userData, 'Partitions', previous))
    ? LEGACY_STORAGE.browserPartition : 'persist:z-browser';
}

function workspaceStateRoot(workspace, directory = '.zagent') {
  if (directory !== '.zagent') return path.join(workspace, directory);
  return existingChild(workspace, directory, LEGACY_STORAGE.workspaceDir);
}

function workspaceStatePath(workspace, parts, directory = '.zagent') {
  if (directory !== '.zagent') return path.join(workspace, directory, ...parts);
  const current = path.join(workspace, directory, ...parts);
  const previous = path.join(workspace, LEGACY_STORAGE.workspaceDir, ...parts);
  if (fs.existsSync(current)) return current;
  if (fs.existsSync(previous)) return previous;
  return path.join(workspaceStateRoot(workspace, directory), ...parts);
}

module.exports = { dataRoot, coreRoot, browserPartition, workspaceStateRoot, workspaceStatePath };
