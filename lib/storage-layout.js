'use strict';

const path = require('node:path');

function dataRoot(userData) {
  return path.join(userData, 'ZData');
}

function coreRoot(dataDirectory) {
  return path.join(dataDirectory, 'z-core');
}

function browserPartition(userData) {
  return 'persist:z-browser';
}

function workspaceStateRoot(workspace, directory = '.zagent') {
  return path.join(workspace, directory);
}

function workspaceStatePath(workspace, parts, directory = '.zagent') {
  return path.join(workspace, directory, ...parts);
}

module.exports = { dataRoot, coreRoot, browserPartition, workspaceStateRoot, workspaceStatePath };
