'use strict';

const { createHash } = require('node:crypto');

// Runtime health is evidence about transport/tools, not a judgment that the
// agent's plan is wrong. It never aborts, replays, or sends model guidance.
const HEALTH_INTERVAL_MS = 20_000;
const TERMINAL_TOOLS = new Set(['completed', 'error', 'failed', 'cancelled', 'canceled', 'interrupted']);
const text = (value, limit = 200) => String(value ?? '').slice(0, limit);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const signature = value => {
  const string = typeof value === 'string' ? value : '';
  return `${string.length}:${createHash('sha256').update(string.slice(0, 128)).update(string.slice(-1024)).digest('base64')}`;
};
const properties = event => event?.properties || event?.data || {};
const sessionId = data => String(data.sessionID || data.sessionId || data.part?.sessionID || data.info?.sessionID || '');

function declaredToolTimeout(part) {
  const input = part?.state?.input || {};
  // Native bash.timeout is milliseconds. Do not guess units for arbitrary
  // MCP tools whose equally named timeout may mean seconds or a poll limit.
  return positive(input.timeoutMs) || positive(input.timeout_ms)
    || (/^(?:bash|shell|powershell)$/i.test(String(part?.tool || '')) ? positive(input.timeout) : 0);
}

async function readWithDeadline(read, timeoutMs = 2500, signal) {
  const controller = new AbortController();
  let timer;
  let aborted;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw signal.reason || new Error('Read cancelled');
        return read(controller.signal);
      }),
      new Promise((_, reject) => {
        aborted = () => reject(signal?.reason || new Error('Read cancelled'));
        signal?.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => reject(new Error('Runtime state read timed out')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
    controller.abort();
  }
}

function promptReplaySafe(messages, previousMessageIDs = new Set()) {
  if (!Array.isArray(messages)) return false;
  const fresh = messages.filter(message => !previousMessageIDs.has(message?.info?.id));
  const assistants = fresh.filter(message => message?.info?.role === 'assistant');
  // Earlier completed steps are already in native history. Any unsettled
  // call, even in an earlier response, makes side effects uncertain.
  if (assistants.some(message => (message.parts || []).some(part => part?.type === 'tool'
    && !TERMINAL_TOOLS.has(String(part.state?.status || ''))))) return false;
  const last = assistants.at(-1);
  if (!last) return true;
  if ((last.parts || []).some(part => part?.type === 'tool')) return false;
  // A successful final response is not a failed prompt to replay.
  if (last.info?.time?.completed && !last.info?.error) return false;
  return true;
}

class RunHealthMonitor {
  constructor({ startedAt = Date.now(), now = Date.now, intervalMs = HEALTH_INTERVAL_MS,
    graceMs = 5000, unknownAfterMs = 10 * 60_000, silentAfterMs = 3 * 60_000,
    readTimeoutMs = 2500 } = {}) {
    this.now = now;
    this.startedAt = startedAt;
    this.intervalMs = Math.max(5, Number(intervalMs) || HEALTH_INTERVAL_MS);
    this.graceMs = Math.max(0, Number(graceMs) || 0);
    this.unknownAfterMs = Math.max(1, Number(unknownAfterMs) || 1);
    this.silentAfterMs = Math.max(1, Number(silentAfterMs) || 1);
    this.readTimeoutMs = Math.max(1, Number(readTimeoutMs) || 2500);
    this.sessionID = '';
    this.baselineIDs = new Set();
    this.messageIDs = new Set();
    this.messageRoles = new Map();
    this.parts = new Map();
    this.tools = new Map();
    this.retiredToolIDs = new Set();
    this.permissions = new Map();
    this.questions = new Map();
    this.lastProgressAt = startedAt;
    this.requestStartedAt = 0;
    this.lastWaitEndedAt = 0;
    this.stage = 'starting';
    this.closed = false;
    this.timer = null;
    this.refreshPending = false;
    this.controller = new AbortController();
  }

  setSession(id, baselineIDs = new Set()) {
    if (this.closed) return;
    this.sessionID = String(id || '');
    this.baselineIDs = new Set(baselineIDs);
  }

  beginRequest(at = this.now()) {
    if (!this.closed) { this.requestStartedAt = at; this.stage = 'working'; }
  }

  endRequest() {
    if (!this.closed) { this.requestStartedAt = 0; this.stage = 'finishing'; }
  }

  progress(at) {
    this.lastProgressAt = Math.max(this.lastProgressAt, at);
  }

  observePart(part, at, messageID = '') {
    const key = String(part?.id || part?.callID || `${messageID}:${part?.type || ''}`);
    if (part?.type === 'tool') {
      const callId = String(part.callID || part.id || '');
      if (!callId || this.retiredToolIDs.has(callId)) return;
      const previous = this.tools.get(callId);
      if (previous && (at < previous.observedAt || (TERMINAL_TOOLS.has(previous.status)
        && !TERMINAL_TOOLS.has(String(part.state?.status || ''))))) return;
      const status = String(part.state?.status || 'unknown');
      const output = signature(part.state?.output ?? part.state?.metadata?.output ?? '');
      const changed = !previous || previous.status !== status || previous.output !== output;
      const startedAt = status === 'pending' ? 0
        : positive(part.state?.time?.start) || previous?.startedAt || at;
      const timeoutMs = previous?.timeoutMs || declaredToolTimeout(part);
      const pausedMs = previous?.pausedMs || 0;
      const tool = { callId, name: text(part.tool || part.name || 'tool'), status, startedAt,
        timeoutMs, deadlineAt: timeoutMs && startedAt ? startedAt + timeoutMs + pausedMs : 0,
        lastProgressAt: changed ? at : previous.lastProgressAt, observedAt: at,
        output, confirmations: changed ? 0 : previous.confirmations, confirmedAt: previous?.confirmedAt || 0,
        pausedMs, pauseStartedAt: previous?.pauseStartedAt || 0, lastResumedAt: previous?.lastResumedAt || 0 };
      for (const wait of [...this.permissions.values(), ...this.questions.values()]) {
        if (!wait.callId || wait.callId === callId) tool.pauseStartedAt ||= wait.at;
      }
      if (tool.deadlineAt && at >= tool.deadlineAt + this.graceMs
        && !tool.pauseStartedAt
        && (tool.confirmations === 0 || at - tool.confirmedAt >= this.intervalMs)) {
        tool.confirmations += 1;
        tool.confirmedAt = at;
      }
      this.tools.set(callId, tool);
      if (changed) this.progress(at);
      if (TERMINAL_TOOLS.has(status)) {
        for (const waits of [this.permissions, this.questions]) {
          for (const [id, wait] of waits) if (wait.callId === callId) waits.delete(id);
        }
      }
      if (this.tools.size > 256) {
        for (const [id, saved] of this.tools) {
          if (TERMINAL_TOOLS.has(saved.status)) { this.tools.delete(id); this.retiredToolIDs.add(id); }
          if (this.tools.size <= 256) break;
        }
      }
    } else if (['text', 'reasoning'].includes(part?.type)) {
      const value = signature(part.text);
      const previous = this.parts.get(key);
      if (previous && at < previous.at) return;
      if (part.text && previous?.value !== value) this.progress(at);
      this.parts.set(key, { value, at });
      // Keep compact fingerprints for observed identities. Evicting a part
      // would make a full-history reread invent fresh progress on old text.
    }
  }

  observeMessages(messages, at = this.now()) {
    if (this.closed || !Array.isArray(messages)) return;
    for (const message of messages) {
      const info = message?.info || {};
      if (!info.id || this.baselineIDs.has(info.id) || info.role !== 'assistant'
        || (info.sessionID && info.sessionID !== this.sessionID)) continue;
      this.messageIDs.add(info.id);
      for (const part of message.parts || []) this.observePart(part, at, info.id);
    }
  }

  resolveWait(kind, requestID, at = this.now()) {
    if (this.closed) return;
    const waits = kind === 'question' ? this.questions : this.permissions;
    if (!waits.delete(String(requestID || ''))) return;
    this.lastWaitEndedAt = at;
    const remaining = [...this.permissions.values(), ...this.questions.values()];
    for (const tool of this.tools.values()) {
      if (!tool.pauseStartedAt || remaining.some(wait => !wait.callId || wait.callId === tool.callId)) continue;
      if (tool.startedAt) tool.pausedMs += Math.max(0, at - Math.max(tool.pauseStartedAt, tool.startedAt));
      tool.deadlineAt = tool.timeoutMs && tool.startedAt ? tool.startedAt + tool.timeoutMs + tool.pausedMs : 0;
      tool.pauseStartedAt = 0;
      tool.lastResumedAt = at;
      tool.confirmations = 0;
      tool.confirmedAt = 0;
    }
  }

  observeChildProgress(callId, event, at = this.now()) {
    if (this.closed) return;
    const tool = this.tools.get(String(callId || ''));
    if (!tool || TERMINAL_TOOLS.has(tool.status)) return;
    const data = properties(event);
    const type = String(event?.type || '');
    let changed = false;
    if ((type === 'message.part.delta' && ['text', 'reasoning'].includes(data.field))
      || ['session.next.text.delta', 'session.next.reasoning.delta'].includes(type)) {
      changed = typeof data.delta === 'string' && data.delta.length > 0;
    } else if (type === 'message.part.updated' && data.part) {
      const part = data.part;
      const key = `child:${callId}:${part.id || part.callID || data.messageID || part.messageID}`;
      const value = part.type === 'tool'
        ? `${part.state?.status}:${signature(part.state?.output ?? part.state?.metadata?.output)}`
        : ['text', 'reasoning'].includes(part.type) ? signature(part.text) : '';
      changed = !!value && this.parts.get(key)?.value !== value;
      if (value) this.parts.set(key, { value, at });
    }
    if (changed) { tool.lastProgressAt = at; tool.confirmations = 0; this.progress(at); }
  }

  observeEvent(event, at = this.now()) {
    if (this.closed || !this.sessionID) return;
    const data = properties(event);
    const id = sessionId(data);
    const messageID = String(data.messageID || data.part?.messageID || data.info?.id || '');
    if (id ? id !== this.sessionID : !this.messageIDs.has(messageID)) return;
    if (this.baselineIDs.has(messageID)) return;
    const type = String(event?.type || '');
    if (type === 'message.updated' && messageID) {
      this.messageRoles.set(messageID, data.info?.role);
      if (data.info?.role === 'assistant') this.messageIDs.add(messageID);
    } else if (type === 'message.part.updated') {
      if (this.messageRoles.get(messageID) !== 'user'
        && (this.messageIDs.has(messageID) || data.part?.type === 'tool')) this.observePart(data.part, at, messageID);
    } else if ((type === 'message.part.delta' && ['text', 'reasoning'].includes(data.field))
      || ['session.next.text.delta', 'session.next.reasoning.delta'].includes(type)) {
      if ((this.messageIDs.has(messageID) || type.startsWith('session.next.'))
        && typeof data.delta === 'string' && data.delta.length) this.progress(at);
    }
    const kind = type.startsWith('question.') ? 'question' : type.startsWith('permission.') ? 'permission' : '';
    if (!kind) return;
    const requestID = String(data.requestID || data.requestId || data.permissionID || data.id || '');
    if (!requestID) return;
    if (/\.(?:asked|updated)$/.test(type)) {
      const waits = kind === 'question' ? this.questions : this.permissions;
      const wait = waits.get(requestID) || { callId: String(data.tool?.callID || data.metadata?.callID || ''), at };
      waits.set(requestID, wait);
      for (const tool of this.tools.values()) {
        if (!TERMINAL_TOOLS.has(tool.status) && (!wait.callId || wait.callId === tool.callId)) tool.pauseStartedAt ||= wait.at;
      }
    } else if (/\.(?:replied|rejected|resolved|cancelled)$/.test(type)) this.resolveWait(kind, requestID, at);
  }

  snapshot(at = this.now()) {
    const pending = [...this.tools.values()].filter(tool => !TERMINAL_TOOLS.has(tool.status));
    const overdue = pending.find(tool => tool.deadlineAt && at >= tool.deadlineAt + this.graceMs
      && tool.confirmations >= 2);
    const candidate = overdue || pending.find(tool => tool.deadlineAt && at >= tool.deadlineAt + this.graceMs)
      || pending[0];
    let state = 'working';
    let message = candidate ? '工具正在执行，等待返回。' : this.stage === 'starting' ? '正在准备任务。' : '任务正在进行。';
    if (this.permissions.size || this.questions.size) {
      state = 'waiting_user';
      message = '任务正在等待用户回复或授权，巡检不会自动回答或重试。';
    } else if (overdue) {
      state = 'overdue';
      message = '工具已超过声明的执行时限，复核后仍未结束；执行结果尚未确认，未自动重放或终止。';
    } else if (candidate && candidate.deadlineAt && at >= candidate.deadlineAt + this.graceMs) {
      state = 'unknown';
      message = '工具已超过声明的执行时限，正在复核状态；尚未确认结果。';
    } else if (candidate && at - Math.max(candidate.lastProgressAt, candidate.lastResumedAt) >= this.unknownAfterMs) {
      state = 'unknown';
      message = '工具长时间没有新的可见进展；可能仍在处理，当前不能确认卡住。';
    } else if (!candidate && this.requestStartedAt
      && at - Math.max(this.requestStartedAt, this.lastProgressAt, this.lastWaitEndedAt) >= this.silentAfterMs) {
      state = 'silent';
      message = '模型长时间没有新的可见输出；连接心跳不代表任务进展，当前仅记录状态。';
    }
    const health = { state, checkedAt: at, lastProgressAt: this.lastProgressAt, message,
      waitingPermissions: this.permissions.size, waitingQuestions: this.questions.size };
    if (candidate) {
      const { output, confirmations, confirmedAt, observedAt, pausedMs, pauseStartedAt, lastResumedAt, ...tool } = candidate;
      health.tool = { ...tool };
    }
    return health;
  }

  start({ isActive = () => true, onStatus = () => {}, readMessages } = {}) {
    if (this.timer || this.closed) return;
    const emit = () => {
      if (!this.closed && isActive()) {
        try { onStatus(this.snapshot()); } catch {}
      }
    };
    const tick = () => {
      if (this.closed) return;
      if (!isActive()) { this.dispose(); return; }
      emit();
      if (!readMessages || this.refreshPending || !this.sessionID) return;
      this.refreshPending = true;
      const observedAt = this.now();
      readWithDeadline(signal => readMessages(signal), this.readTimeoutMs, this.controller.signal)
        .then(messages => {
          if (this.closed || !isActive()) return;
          const before = this.snapshot();
          this.observeMessages(messages, observedAt);
          const after = this.snapshot();
          before.checkedAt = after.checkedAt;
          if (JSON.stringify(before) !== JSON.stringify(after)) emit();
        }).catch(() => {}).finally(() => { this.refreshPending = false; });
    };
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    tick();
  }

  dispose() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    this.controller.abort();
  }

  stop(outcome) {
    if (this.finalSnapshot) return this.finalSnapshot;
    const snapshot = this.snapshot();
    this.dispose();
    this.finalSnapshot = { ...snapshot, state: 'completed', message: outcome === 'error'
      ? '任务发生错误，运行巡检已停止。' : outcome === 'interrupted'
        ? '任务已中断，运行巡检已停止。' : '任务已结束，运行巡检已停止。' };
    return this.finalSnapshot;
  }
}

module.exports = { HEALTH_INTERVAL_MS, RunHealthMonitor, declaredToolTimeout, promptReplaySafe, readWithDeadline };
