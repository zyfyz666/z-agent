'use strict';

const crypto = require('node:crypto');

// Called inside the memory database transaction, in either Node or the bundled
// SQLite worker. Jobs contain bounded conversation evidence, never credentials
// or a saved provider configuration.
function executeReviewJobOperation(db, operation, args = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_review_jobs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
    status TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
  ); CREATE INDEX IF NOT EXISTS memory_review_ready ON memory_review_jobs(status, available_at);
  CREATE TABLE IF NOT EXISTS memory_retrieval_usage (
    session_id TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL,
    used_at INTEGER NOT NULL, items TEXT NOT NULL, PRIMARY KEY(session_id, revision)
  );`);
  const now = Number(args.now) || Date.now();
  const row = value => value ? { id: value.id, sessionId: value.session_id,
    conversationRevision: value.revision, status: value.status, attempts: value.attempts,
    availableAt: value.available_at, leaseUntil: value.lease_until, error: value.error,
    createdAt: value.created_at, updatedAt: value.updated_at,
    ...(args.includePayload || operation === 'claim' ? { payload: JSON.parse(value.payload) } : {}) } : null;
  if (operation === 'enqueue') {
    const job = args.job;
    if (!job?.id || !job.sessionId || !Number.isSafeInteger(job.conversationRevision)) throw new Error('Invalid memory review job');
    const payload = JSON.stringify(job.payload || {});
    if (payload.length > 500_000) throw new Error('Memory review evidence exceeds the queue limit');
    db.prepare(`INSERT INTO memory_review_jobs(id,session_id,revision,status,payload,available_at,created_at,updated_at)
      VALUES(?,?,?,'pending',?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(job.id, job.sessionId, job.conversationRevision, payload, now, now, now);
    return row(db.prepare('SELECT * FROM memory_review_jobs WHERE id=?').get(job.id));
  }
  if (operation === 'claim') {
    db.prepare("UPDATE memory_review_jobs SET status='pending',owner=NULL WHERE status='running' AND lease_until<=?").run(now);
    const ready = db.prepare("SELECT * FROM memory_review_jobs WHERE status='pending' AND available_at<=? ORDER BY created_at,id LIMIT 1").get(now);
    if (!ready) return null;
    db.prepare("UPDATE memory_review_jobs SET status='running',attempts=attempts+1,owner=?,lease_until=?,updated_at=? WHERE id=?")
      .run(args.owner, now + (Number(args.leaseMs) || 90_000), now, ready.id);
    return row(db.prepare('SELECT * FROM memory_review_jobs WHERE id=?').get(ready.id));
  }
  if (operation === 'renew') {
    return { changed: db.prepare("UPDATE memory_review_jobs SET lease_until=?,updated_at=? WHERE id=? AND owner=? AND status='running' AND lease_until>?")
      .run(now + (Number(args.leaseMs) || 90_000), now, args.id, args.owner, now).changes };
  }
  if (operation === 'owns') {
    return !!db.prepare("SELECT 1 FROM memory_review_jobs WHERE id=? AND owner=? AND status='running' AND lease_until>?")
      .get(args.id, args.owner, now);
  }
  if (operation === 'finish') {
    const status = args.skipped ? 'skipped' : 'done';
    return { changed: db.prepare("UPDATE memory_review_jobs SET status=?,payload='{}',owner=NULL,lease_until=0,updated_at=?,error=? WHERE id=? AND owner=? AND status='running'")
      .run(status, now, String(args.reason || '').slice(0, 400), args.id, args.owner).changes };
  }
  if (operation === 'fail') {
    const job = db.prepare("SELECT attempts FROM memory_review_jobs WHERE id=? AND owner=? AND status='running'").get(args.id, args.owner);
    if (!job) return { changed: 0 };
    const exhausted = job.attempts >= (Number(args.maxAttempts) || 4);
    const delay = Math.min(300_000, 15_000 * 2 ** Math.max(0, job.attempts - 1));
    return { changed: db.prepare('UPDATE memory_review_jobs SET status=?,owner=NULL,lease_until=0,available_at=?,updated_at=?,error=? WHERE id=?')
      .run(exhausted ? 'failed' : 'pending', now + delay, now, String(args.error || '记忆整理失败').slice(0, 400), args.id).changes };
  }
  if (operation === 'release') {
    return { changed: db.prepare("UPDATE memory_review_jobs SET status='pending',owner=NULL,lease_until=0,available_at=?,updated_at=? WHERE owner=? AND status='running'")
      .run(now, now, args.owner).changes };
  }
  if (operation === 'list') return db.prepare('SELECT * FROM memory_review_jobs WHERE session_id=? AND revision=? ORDER BY created_at DESC LIMIT 12')
    .all(args.sessionId, args.conversationRevision || 0).map(row);
  if (operation === 'usage-save') {
    db.prepare(`INSERT INTO memory_retrieval_usage(session_id,revision,run_id,used_at,items) VALUES(?,?,?,?,?)
      ON CONFLICT(session_id,revision) DO UPDATE SET run_id=excluded.run_id,used_at=excluded.used_at,items=excluded.items
      WHERE excluded.used_at>=memory_retrieval_usage.used_at`)
      .run(args.sessionId, args.conversationRevision || 0, args.runId, now, JSON.stringify((args.items || []).slice(0, 30)));
    return { ok: true };
  }
  if (operation === 'usage-get') {
    const usage = db.prepare('SELECT * FROM memory_retrieval_usage WHERE session_id=? AND revision=?').get(args.sessionId, args.conversationRevision || 0);
    return usage ? { runId: usage.run_id, usedAt: usage.used_at, items: JSON.parse(usage.items) } : { items: [] };
  }
  throw new Error(`Unknown memory review operation: ${operation}`);
}

class MemoryReviewQueue {
  constructor({ dbPath, execute, processJob, onError = () => {}, owner = `${process.pid}:${crypto.randomUUID()}` }) {
    Object.assign(this, { dbPath, execute, processJob, onError, owner });
    this.running = false;
    this.stopped = false;
    this.timer = null;
  }
  operation(name, args = {}) { return this.execute(this.dbPath, `review.${name}`, { ...args, owner: this.owner }); }
  enqueue(job) { const result = this.operation('enqueue', { job }); this.wake(); return result; }
  start() { this.stopped = false; this.wake(); }
  wake(delay = 0) {
    if (this.stopped || this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, delay);
    this.timer.unref?.();
  }
  async drain() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const job = this.operation('claim');
        if (!job) break;
        const controller = new AbortController();
        this.controller = controller;
        const isCurrent = () => !this.stopped && !controller.signal.aborted
          && this.operation('owns', { id: job.id });
        const renewal = setInterval(() => {
          try {
            if (this.stopped || !this.operation('renew', { id: job.id }).changed) controller.abort();
          } catch (error) { controller.abort(); this.onError(error); }
        }, 25_000);
        renewal.unref?.();
        try {
          const result = await this.processJob(job, { isCurrent, signal: controller.signal });
          if (!isCurrent()) continue;
          if (result?.ok === false) throw new Error(result.error || '记忆整理失败');
          this.operation('finish', { id: job.id, skipped: result?.skipped, reason: result?.reason });
        } catch (error) {
          if (isCurrent()) {
            this.operation('fail', { id: job.id, error: String(error?.message || error) });
            this.onError(error);
          }
        } finally { clearInterval(renewal); if (this.controller === controller) this.controller = null; }
      }
    } catch (error) { this.onError(error); }
    finally { this.running = false; if (!this.stopped) this.wake(30_000); }
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.timer = null;
    this.operation('release');
  }
}

module.exports = { executeReviewJobOperation, MemoryReviewQueue };
