'use strict';

// Hash-chained audit log, byte-compatible with python/src/thrash_watchdog/audit.py.
// Tamper-evident, not tamper-proof: without an external anchor, truncating the
// tail or rewriting the whole file is not detectable.

const fs = require('node:fs');
const path = require('node:path');
const { CRITERIA_SHA256, canonical, sha256Hex } = require('./index');

const GENESIS = '0'.repeat(64);
const SCHEMA = 2;
const int = x => Math.trunc(Number(x) || 0);

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

function lastHash(file) {
  const lines = readLines(file);
  if (!lines.length) return GENESIS;
  try {
    return JSON.parse(lines[lines.length - 1]).hash ?? GENESIS;
  } catch {
    return GENESIS;
  }
}

// Append a verdict. Returns the record, or null when action is "none".
function appendAudit(file, d, { traceId = '', step = 0, tsMs = Date.now() } = {}) {
  if (!d || (d.action || 'none') === 'none') return null;
  const record = {
    v: SCHEMA,
    ts: int(tsMs),
    trace: String(traceId),
    step: int(step),
    action: d.action,
    rules: [...(d.rules || [])],
    advisories: [...(d.advisories || [])],
    severity: int(d.severity),
    streak: int(d.streak),
    spec: CRITERIA_SHA256,
    prev: lastHash(file)
  };
  record.hash = sha256Hex(canonical(record));
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.appendFileSync(file, canonical(record) + '\n');
  return record;
}

// Walk the chain. Returns {ok, count, specs} or {ok: false, index, reason}.
function verifyChain(file) {
  let prev = GENESIS;
  const specs = new Set();
  const lines = readLines(file);
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      rec = null;
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !Object.hasOwn(rec, 'hash')) {
      return { ok: false, index: i, reason: 'unparseable record' };
    }
    const { hash: stored, ...body } = rec;
    if (body.prev !== prev) return { ok: false, index: i, reason: 'prev mismatch' };
    if (sha256Hex(canonical(body)) !== stored) return { ok: false, index: i, reason: 'hash mismatch' };
    if (body.spec) specs.add(body.spec);
    prev = stored;
  }
  return { ok: true, count: lines.length, specs: [...specs].sort() };
}

module.exports = { GENESIS, SCHEMA, appendAudit, verifyChain, lastHash };
