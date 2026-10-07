'use strict';

const Workflow = require('./workflow-state');
const { SubagentCompletionTracker } = require('./completion-runtime');

// Owned by one parent run. This module observes sessions; it never dispatches
// prompts, changes OpenCode configuration or starts another agent.
class SubagentEventBridge {
  constructor({ runId, sessionID, directory, childSessions, onEvent, ...identity }) {
    this.sessionID = sessionID;
    this.directory = directory;
    this.children = childSessions;
    this.onEvent = onEvent;
    this.state = { runId, timeline: [], subagents: [] };
    this.completions = new SubagentCompletionTracker({ runId, sessionID, directory, onEvent, ...identity });
  }

  register(id, info = {}) {
    if (!id || id === this.sessionID) return null;
    // A direct-parent session event can be an old session replay. Only a fresh
    // task call grants membership in this turn; never attach children by role.
    if (this.completions.startedAt && !this.children.has(id)
      && ![...this.completions.records.values()].some(record => record.childSessionID === id && record.callId)) return null;
    const child = this.children.get(id) || { id, parentID: this.sessionID, directory: this.directory };
    if (info.callId) child.callId = info.callId;
    if (info.role || info.agent) child.agent = info.role || info.agent;
    if (info.title) child.title = info.title;
    if (info.prompt) child.prompt = info.prompt;
    if (info.directory) child.directory = info.directory;
    if (info.startedAt) child.startedAt = info.startedAt;
    this.children.set(id, child);
    return child;
  }

  accepts(event) { return this.completions.accepts(event); }

  observe(event, options = {}) {
    if (!this.completions.accepts(event, options)) return false;
    const completion = this.completions.observe(event, options);
    const { record } = Workflow.consume(this.state, event);
    if (record?.childSessionID) {
      const child = this.register(record.childSessionID, { ...record, startedAt: completion?.startedAt || record.startedAt });
      this.forward(child, null);
    }
    return true;
  }

  forward(child, event) {
    if (!child) return;
    const data = Workflow.dataOf(event);
    if (event?.type === 'message.updated' && data.info?.agent) child.agent = data.info.agent;
    const envelope = { type: 'z.subagent.event', data: {
      sessionID: this.sessionID, childSessionID: child.id, callId: child.callId || '',
      subagentType: child.agent || '', title: child.title || '', prompt: child.prompt || '', event
    } };
    Workflow.consume(this.state, envelope);
    this.onEvent(envelope);
  }

  async catchUp(client, toolCalls = [], { signal, timeoutMs = 3500, parentMessages = [] } = {}) {
    // Final parent task metadata can reveal a session whose creation SSE was
    // missed. Hydrate each direct child once, with bounded concurrency/time.
    for (const tool of toolCalls) {
      if (tool.name !== 'task') continue;
      this.observe({ type: 'message.part.updated', data: { part: { type: 'tool', tool: 'task', callID: tool.callId,
        messageID: tool.messageID,
        state: { input: tool.args, output: tool.output, metadata: tool.metadata,
          time: { start: tool.startedAt, end: tool.completedAt },
          status: tool.status || (tool.ok === false ? 'error' : 'completed') } } } }, { trusted: true });
    }
    this.completions.reconcile(parentMessages);
    const children = [...this.children.values()];
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(); }, Math.max(1, timeoutMs));
    });
    let onAbort;
    const cancelled = new Promise(resolve => {
      onAbort = resolve;
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let cursor = 0;
    const pending = new Set(children.map(child => child.id));
    const workers = Array.from({ length: Math.min(3, children.length) }, async () => {
      while (cursor < children.length && !controller.signal.aborted) {
        const child = children[cursor++];
        let messages = [];
        let historyError = '';
        try {
          const response = await client.session.messages({ sessionID: child.id, directory: child.directory || this.directory }, { signal: controller.signal });
          if (response?.error) throw new Error(Workflow.dataOf(response.error).message || '读取失败');
          const rawMessages = Array.isArray(response?.data) ? response.data
            : Array.isArray(response?.data?.messages) ? response.data.messages
              : Array.isArray(response?.messages) ? response.messages : [];
          messages = rawMessages.filter(message => {
            const info = message?.info || message?.properties?.info || message?.data?.info || message;
            return String(info?.role || '').toLowerCase() === 'assistant'
              && (!this.completions.startedAt || Number(info?.time?.created) >= Number(child.startedAt || this.completions.startedAt));
          });
        } catch (error) { historyError = error?.message || String(error); }
        if (controller.signal.aborted) return;
        pending.delete(child.id);
        const envelope = { type: 'z.subagent.history', data: { sessionID: this.sessionID,
          childSessionID: child.id, callId: child.callId || '', subagentType: child.agent || '', messages, historyError } };
        Workflow.consume(this.state, envelope);
        this.onEvent(envelope);
      }
    });
    try { await Promise.race([Promise.all(workers), timeout, cancelled]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
    for (const id of pending) {
      const record = this.state.subagents.find(item => item.childSessionID === id);
      if (record) record.historyError = signal?.aborted ? '读取工作记录已取消' : '读取工作记录超时';
    }
    return this.state.subagents;
  }
}

module.exports = { SubagentEventBridge };
