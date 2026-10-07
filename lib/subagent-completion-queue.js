'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TERMINAL = new Set(['completed', 'error']);
const CLOSED = new Set(['consumed', 'cancelled', 'accepted', 'settled', 'uncertain']);
const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, limit = 512) => String(value || '').slice(0, limit);
const revision = value => Number.isSafeInteger(value) && value >= 0 ? value : -1;
const failure = (code, error) => ({ ok: false, code, error });

// A receipt precedes the provider call. Never copy over the durable file on a
// failed rename: a partial receipt would permit the same wake to run twice.
function writeQueueAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

class SubagentCompletionQueue {
  constructor({ file, now = Date.now, onChange = () => {}, onClose = () => {}, write = writeQueueAtomic,
    claimMs = 90_000, maxRecords = 10_000, maxObserveMs = 6 * 60 * 60_000 } = {}) {
    this.file = file;
    this.now = now;
    this.onChange = onChange;
    this.onClose = onClose;
    this.write = write;
    this.claimMs = claimMs;
    this.maxRecords = maxRecords;
    this.maxObserveMs = maxObserveMs;
    this.state = { version: 1, parents: {}, records: {}, warnings: {} };
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.version !== 1 || !saved.parents || !saved.records || Array.isArray(saved.records)) {
        throw new Error('Invalid subagent completion queue; refusing to discard delivery receipts.');
      }
      this.state = saved;
      this.state.warnings ||= {};
      this.change(next => {
        for (const parent of Object.values(next.parents)) {
          if (parent.status === 'running') parent.status = 'interrupted';
        }
        for (const record of Object.values(next.records)) {
          if (record.delivery === 'accepted') record.delivery = 'uncertain';
          else if (record.delivery === 'claimed') record.delivery = 'pending';
          delete record.claimToken;
          delete record.claimUntil;
          if (next.parents[record.parentRunId]?.status !== 'done' && !CLOSED.has(record.delivery)) {
            record.delivery = 'cancelled';
            record.reason = 'parent_interrupted';
          }
        }
      });
    }
  }

  change(operation) {
    const next = clone(this.state);
    const result = operation(next);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return result;
    this.write(this.file, next);
    const previous = this.state;
    this.state = next;
    const changed = new Set();
    for (const [id, record] of Object.entries(next.records)) {
      if (JSON.stringify(record) !== JSON.stringify(previous.records[id])
        || JSON.stringify(next.parents[record.parentRunId]) !== JSON.stringify(previous.parents[record.parentRunId])) {
        changed.add(record.zSessionId);
      }
      if (CLOSED.has(record.delivery) && !CLOSED.has(previous.records[id]?.delivery)) this.onClose(clone(record));
    }
    for (const [id, warning] of Object.entries(next.warnings || {})) {
      if (JSON.stringify(warning) !== JSON.stringify(previous.warnings?.[id])) changed.add(warning.sessionId);
    }
    for (const id of changed) this.onChange(id);
    return result;
  }

  authorizeParent({ parentRunId, zSessionId, conversationRevision, startedAt }) {
    if (!parentRunId || !zSessionId || revision(conversationRevision) < 0 || !Number.isFinite(startedAt)) return false;
    return this.change(next => {
      if (next.parents[parentRunId]) return false;
      next.parents[parentRunId] = { parentRunId, zSessionId, conversationRevision, startedAt, status: 'running' };
      return true;
    });
  }

  bindParent(parentRunId, parentSessionID) {
    if (!parentSessionID) return;
    this.change(next => {
      const parent = next.parents[parentRunId];
      if (parent?.status === 'running' && !parent.parentSessionID) parent.parentSessionID = text(parentSessionID);
    });
  }

  recordLifecycle(event = {}) {
    const parent = this.state.parents[event.parentRunId];
    if (!parent || !['running', 'done'].includes(parent.status)
      || parent.zSessionId !== event.zSessionId || parent.conversationRevision !== event.conversationRevision
      || !event.callId || !event.parentSessionID || !event.childSessionID
      || !Number.isFinite(event.startedAt) || event.startedAt < parent.startedAt - 1_000
      || (parent.parentSessionID && parent.parentSessionID !== event.parentSessionID)) return false;
    const id = `subagent_${crypto.createHash('sha256').update(JSON.stringify([
      parent.parentRunId, parent.zSessionId, parent.conversationRevision,
      event.parentSessionID, event.callId, event.startedAt
    ])).digest('hex')}`;
    const previous = this.state.records[id];
    // After the parent closes, only tasks registered while it was alive may
    // finish. Replayed historical task cards never acquire new authorization.
    if (!previous && parent.status !== 'running') return false;
    if (!previous && Object.keys(this.state.records).length >= this.maxRecords) {
      this.change(next => {
        next.warnings[parent.zSessionId] = { id: `capacity_${parent.zSessionId}`, sessionId: parent.zSessionId,
          zSessionId: parent.zSessionId, parentRunId: parent.parentRunId, conversationRevision: parent.conversationRevision,
          delivery: 'uncertain', reason: 'queue_capacity', result: '子代理完成记录已达上限，请手动继续查看结果。' };
      });
      return false;
    }
    if (previous && (previous.childSessionID !== event.childSessionID || CLOSED.has(previous.delivery))) return false;
    return this.change(next => {
      const record = next.records[id] || {
        id, intentId: `wake_${id}`, parentRunId: parent.parentRunId,
        zSessionId: parent.zSessionId, sessionId: parent.zSessionId,
        conversationRevision: parent.conversationRevision,
        parentSessionID: text(event.parentSessionID), childSessionID: text(event.childSessionID),
        callId: text(event.callId), startedAt: event.startedAt, registeredAt: this.now(),
        directory: text(event.directory, 8_192), delivery: 'pending', status: 'running'
      };
      record.role = text(event.role || record.role);
      record.title = text(event.title || record.title, 2_000);
      if (TERMINAL.has(event.status)) {
        record.status = event.status;
        record.completedAt = Number(event.completedAt) || this.now();
        record.result = text(event.result || event.error || record.result, 64_000);
      }
      if (event.consumed === true) { record.consumed = true; record.delivery = 'consumed'; }
      next.records[id] = record;
      return true;
    });
  }

  settleParent(parentRunId, result = {}) {
    this.change(next => {
      const parent = next.parents[parentRunId];
      if (!parent || parent.status !== 'running') return;
      parent.status = result.status === 'done' && result.userRequestedFinish !== true ? 'done' : 'cancelled';
      parent.completedAt = this.now();
      if (parent.status !== 'done') {
        for (const record of Object.values(next.records)) {
          if (record.parentRunId === parentRunId && !CLOSED.has(record.delivery)) {
            record.delivery = 'cancelled'; record.reason = 'parent_stopped';
          }
        }
      }
    });
  }

  cancelSession(sessionId, reason = 'user_cancelled') {
    return this.change(next => {
      let cancelled = 0;
      if (reason === 'user_message') {
        for (const record of Object.values(next.records)) {
          if (record.zSessionId !== sessionId || record.delivery !== 'claimed') continue;
          record.delivery = 'pending'; delete record.claimToken; delete record.claimUntil;
        }
        return { ok: true, cancelled: 0, deferred: true };
      }
      delete next.warnings?.[sessionId];
      for (const parent of Object.values(next.parents)) {
        if (parent.zSessionId === sessionId) parent.status = 'cancelled';
      }
      for (const record of Object.values(next.records)) {
        if (record.zSessionId !== sessionId || ['consumed', 'cancelled', 'settled'].includes(record.delivery)) continue;
        record.delivery = 'cancelled'; record.reason = text(reason); cancelled += 1;
        delete record.claimToken; delete record.claimUntil;
      }
      return { ok: true, cancelled };
    });
  }

  reconcileSession(sessionId, currentRevision) {
    const obsolete = Object.values(this.state.records).some(record => record.zSessionId === sessionId
      && record.conversationRevision !== currentRevision && !['cancelled', 'consumed', 'settled'].includes(record.delivery));
    if (currentRevision === null || obsolete) this.cancelSession(sessionId, currentRevision === null ? 'session_deleted' : 'revision_changed');
  }

  expireClaims() {
    this.change(next => {
      for (const record of Object.values(next.records)) {
        if (record.delivery === 'claimed' && record.claimUntil <= this.now()) {
          record.delivery = 'pending'; delete record.claimToken; delete record.claimUntil;
        }
      }
    });
  }

  ready(record) {
    return record && TERMINAL.has(record.status) && !record.consumed && !record.waitingForInspection
      && this.state.parents[record.parentRunId]?.status === 'done';
  }

  list({ sessionId } = {}) {
    this.expireClaims();
    const records = Object.values(this.state.records).filter(record => !sessionId || record.zSessionId === sessionId);
    const visible = record => { const result = clone(record); delete result.claimToken; delete result.claimUntil; return result; };
    return { ok: true,
      wakes: records.filter(record => record.delivery === 'pending' && this.ready(record))
        .sort((a, b) => a.completedAt - b.completedAt).map(visible),
      uncertain: [...records.filter(record => record.delivery === 'uncertain'),
        ...Object.values(this.state.warnings || {}).filter(warning => !sessionId || warning.sessionId === sessionId)].map(visible) };
  }

  validateClaim({ id, claimToken, sessionId, conversationRevision, intentId }) {
    const record = this.state.records[id];
    if (!record || record.zSessionId !== sessionId || record.conversationRevision !== conversationRevision
      || (intentId !== undefined && intentId !== record.intentId)) {
      return failure('SUBAGENT_WAKE_STALE', '子代理结果所属对话或版本已经变化。');
    }
    if (record.delivery !== 'claimed' || record.claimToken !== claimToken || record.claimUntil <= this.now() || !this.ready(record)) {
      return failure('SUBAGENT_WAKE_UNAVAILABLE', '子代理结果已处理、取消或由其他窗口接收。');
    }
    return { ok: true, wake: clone(record) };
  }

  claim({ id, sessionId, conversationRevision }) {
    this.expireClaims();
    const record = this.state.records[id];
    if (!record || record.zSessionId !== sessionId || record.conversationRevision !== conversationRevision
      || record.delivery !== 'pending' || !this.ready(record)) return failure('SUBAGENT_WAKE_UNAVAILABLE', '子代理结果暂时无法接收。');
    return this.change(next => {
      const claimed = next.records[id];
      claimed.delivery = 'claimed'; claimed.claimToken = crypto.randomUUID(); claimed.claimUntil = this.now() + this.claimMs;
      return { ok: true, wake: clone(claimed), claimToken: claimed.claimToken };
    });
  }

  release({ id, claimToken }) {
    return this.change(next => {
      const record = next.records[id];
      if (!record || record.delivery !== 'claimed' || record.claimToken !== claimToken) return { ok: false };
      record.delivery = 'pending'; delete record.claimToken; delete record.claimUntil;
      return { ok: true };
    });
  }

  accept(payload, runId) {
    const validation = this.validateClaim(payload);
    if (!validation.ok) return validation;
    return this.change(next => {
      const record = next.records[payload.id];
      record.delivery = 'accepted'; record.acceptedRunId = runId; record.acceptedAt = this.now();
      delete record.claimToken; delete record.claimUntil;
      return { ok: true, wake: clone(record) };
    });
  }

  settleDelivery(runId) {
    this.change(next => {
      for (const record of Object.values(next.records)) {
        if (record.acceptedRunId === runId && ['accepted', 'uncertain'].includes(record.delivery)) record.delivery = 'settled';
      }
    });
  }

  failClaim({ id, claimToken }, reason) {
    this.change(next => {
      const record = next.records[id];
      if (record?.delivery !== 'claimed' || record.claimToken !== claimToken) return;
      record.delivery = 'uncertain'; record.reason = text(reason);
      delete record.claimToken; delete record.claimUntil;
    });
  }

  pollable(limit = 4) {
    const expired = Object.values(this.state.records).filter(record => record.delivery === 'pending'
      && (!TERMINAL.has(record.status) || record.waitingForInspection) && this.state.parents[record.parentRunId]?.status === 'done'
      && record.unknownSince && this.now() - record.unknownSince > this.maxObserveMs);
    if (expired.length) this.change(next => {
      for (const record of expired) { next.records[record.id].delivery = 'uncertain'; next.records[record.id].reason = 'observation_expired'; }
    });
    return Object.values(this.state.records).filter(record => record.delivery === 'pending'
      && (!TERMINAL.has(record.status) || record.waitingForInspection) && this.state.parents[record.parentRunId]?.status === 'done'
      && (!record.inspectionRetryAt || record.inspectionRetryAt <= this.now()))
      .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0)).slice(0, limit).map(clone);
  }

  applyInspection(record, result = {}) {
    result = result && typeof result === 'object' ? result : { status: 'unknown' };
    const current = this.state.records[record.id];
    if (!current || CLOSED.has(current.delivery)) return;
    this.recordLifecycle({ ...current, ...result });
    this.change(next => {
      const observed = next.records[record.id];
      observed.lastCheckedAt = this.now(); observed.checkCount = (observed.checkCount || 0) + 1;
      if (!['completed', 'error', 'running'].includes(result.status) && result.consumed !== true) {
        // A saved final result says nothing about whether a later parent turn
        // consumed it. An unavailable native read must never grant a wake.
        observed.waitingForInspection = true;
        observed.unknownSince ||= this.now();
        observed.unknownCount = (observed.unknownCount || 0) + 1;
        observed.inspectionRetryAt = this.now() + Math.min(300_000, 10_000 * 2 ** Math.min(5, observed.unknownCount - 1));
      } else {
        delete observed.unknownSince; delete observed.unknownCount;
        delete observed.waitingForInspection; delete observed.inspectionRetryAt;
        if (result.status === 'running') observed.status = 'running';
      }
    });
  }
}

module.exports = { SubagentCompletionQueue, writeQueueAtomic };
