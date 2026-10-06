'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let NativeDatabase;
function nativeDatabase() {
  if (NativeDatabase !== undefined) return NativeDatabase;
  try { NativeDatabase = require('node:sqlite').DatabaseSync; } catch { NativeDatabase = null; }
  return NativeDatabase;
}

function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      memory_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0,
      run_started_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, workspace, status);
    CREATE INDEX IF NOT EXISTS memories_task ON memories(session_id, revision, type, status);
    CREATE INDEX IF NOT EXISTS memories_key ON memories(memory_key, scope, workspace);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, tokens, tokenize='unicode61');
  `);
}

function withMemoryDatabase(dbPath, operation) {
  const DatabaseSync = nativeDatabase();
  if (!DatabaseSync) throw new Error('The memory database requires the bundled Node SQLite runtime.');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');
    try {
      initializeDatabase(db);
      const result = operation(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  } finally {
    db.close();
  }
}

function workerPath() {
  return path.join(__dirname, 'memory-worker.cjs').replace(
    `${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`
  );
}

// Electron 31 embeds Node 20. Reuse the Node runtime already shipped for
// CodeGraph instead of introducing a platform-specific SQLite native binding.
function executeMemoryOperation(dbPath, operation, args = {}, options = {}) {
  if (nativeDatabase() && !options.forceWorker) {
    return withMemoryDatabase(dbPath, db => {
      if (operation.startsWith('review.')) {
        return require('./memory-review-jobs').executeReviewJobOperation(db, operation.slice(7), args);
      }
      if (operation.startsWith('store.')) {
        return require('./long-term-memory').executeStoreOperation(db, operation.slice(6), args, options);
      }
      throw new Error(`Unknown memory operation: ${operation}`);
    });
  }
  const appRoot = options.appRoot || path.resolve(__dirname, '..').replace(/app\.asar\.unpacked$/, 'app.asar');
  const runtime = require('./codegraph-runtime').resolveNodeCommand(appRoot);
  if (!runtime.ok) throw new Error(`Memory SQLite runtime unavailable: ${runtime.error}`);
  const payload = JSON.stringify({ dbPath, operation, args, options: { ...options, forceWorker: false } },
    (_key, value) => value instanceof Set ? { __memorySet: [...value] } : value);
  const result = spawnSync(runtime.command, ['--disable-warning=ExperimentalWarning', workerPath()], {
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  });
  if (result.error) throw new Error(`Memory database worker failed: ${result.error.message}`);
  let reply;
  try { reply = JSON.parse(result.stdout || '{}'); } catch {
    throw new Error(`Memory database worker returned invalid output (exit ${result.status}).`);
  }
  if (result.status !== 0 || !reply.ok) {
    const error = new Error(reply.error || `Memory database worker exited with code ${result.status}.`);
    if (reply.code) error.code = reply.code;
    throw error;
  }
  return reply.result;
}

module.exports = { executeMemoryOperation, withMemoryDatabase };
