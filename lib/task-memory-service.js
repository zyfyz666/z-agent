'use strict';

const crypto = require('node:crypto');
const { containsSensitiveMemoryText, containsUnsafeMemoryText } = require('./long-term-memory');

function safeText(value, limit = 800) {
  if (value == null) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const inspection = text.replace(/\\+["']/g, '"');
  if (containsSensitiveMemoryText(inspection)
    || /(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN [^-]*PRIVATE KEY-----)/.test(inspection)
    || /["']?(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|token|password|passwd|client[_-]?secret|authorization|private[_-]?key|credential|secret)["']?\s*[:=]\s*\S/i.test(inspection)
    || /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(inspection)) return '';
  return text.replace(/\r\n?/g, '\n').trim().slice(0, limit);
}

function safeLines(value, limit = 6) {
  return (Array.isArray(value) ? value : []).filter(item => typeof item === 'string')
    .map(item => safeText(item, 200)).filter(Boolean).slice(0, limit);
}

function safeVerified(value) {
  return (Array.isArray(value) ? value : []).slice(-8).flatMap(item => {
    if (typeof item === 'string') return safeText(item, 200) ? [safeText(item, 200)] : [];
    const text = safeText(item?.text, 200);
    return text ? [{ text, evidence: (Array.isArray(item.evidence) ? item.evidence : []).slice(0, 4).map(evidence => ({
      runId: safeText(evidence?.runId, 120), toolCallId: safeText(evidence?.toolCallId, 120), kind: 'tool_result'
    })) }] : [];
  });
}

function summarizeHarnessBaselines(baselines) {
  const result = {};
  let remaining = 1800;
  for (const scope of ['global', 'workspace']) {
    const state = baselines?.[scope];
    if (!state || !Number.isSafeInteger(state.revision)) continue;
    const entryFingerprints = {};
    for (const kind of ['prompt', 'memory', 'skill', 'subagent']) {
      entryFingerprints[kind] = {};
      for (const [id, entry] of Object.entries(state.entries?.[kind] || {}).slice(0, 500)) {
        // A missing baseline fingerprint fails the conflict check safely when
        // a revision changed. Keep the durable review queue payload bounded.
        if (!remaining || id.length > 100) continue;
        remaining--;
        // Match ContinualHarnessStore's conflict check without persisting its
        // prompt contents, refinement history, metadata, or provider secrets.
        const comparable = entry && typeof entry === 'object' ? { ...entry } : entry || null;
        if (comparable && typeof comparable === 'object') {
          delete comparable.updatedAt;
          if (comparable.metadata && typeof comparable.metadata === 'object') {
            comparable.metadata = { ...comparable.metadata };
            delete comparable.metadata.usage;
          }
        }
        entryFingerprints[kind][id] = crypto.createHash('sha256').update(JSON.stringify(comparable)).digest('hex');
      }
    }
    result[scope] = { revision: state.revision, entryFingerprints };
  }
  return result;
}

function safeRefinementRequest(request) {
  if (!request || !['refine', 'rollback'].includes(request.action)) return null;
  return { action: request.action, scope: request.scope === 'workspace' ? 'workspace' : 'global',
    runId: safeText(request.runId, 120), rollbackId: safeText(request.rollbackId, 120),
    instructions: safeText(request.instructions, 3000) };
}

function taskMemoryIdentity(session = {}) {
  const identity = { sessionId: String(session.id || ''), branchId: String(session.id || ''),
    conversationRevision: Number.isSafeInteger(session.conversationRevision) ? session.conversationRevision : 0,
    workspace: String(session.workspace || '') };
  const boundary = session.contextReset || session.forkedFrom;
  if (boundary) {
    const count = Math.max(0, Number(boundary.messageCount) || 0);
    const prefix = (session.messages || []).slice(0, count);
    identity.cutoff = Number(prefix.at(-1)?.ts) || 0;
  }
  return identity;
}

function taskSource(session, request = {}, runId = '', runStartedAt = Date.now()) {
  const index = Number.isInteger(request.requestMessageIndex) && request.requestMessageIndex >= 0 ? request.requestMessageIndex
    : (session.messages || []).findLastIndex(message => message.role === 'user');
  const message = session.messages?.[index];
  const sourceMessageId = safeText(request.sourceMessageId, 160) || message?.id || (message ? crypto.createHash('sha256')
    .update(JSON.stringify([message.role, message.ts, message.content])).digest('hex') : '');
  return { ...taskMemoryIdentity(session), runId, runStartedAt, sourceMessageId, sourceMessageIndex: index };
}

function buildTaskProgressRecord({ session, request = {}, result, runId, runStartedAt, previous }) {
  const source = taskSource(session, request, runId, runStartedAt);
  const sameTask = (previous?.sessionId || previous?.taskState?.sessionId) === source.sessionId
    && Number(previous?.conversationRevision ?? previous?.taskState?.conversationRevision ?? 0) === source.conversationRevision;
  const prior = sameTask ? previous?.taskState : null;
  const previousGoal = safeText(prior?.goal, 700) || (sameTask ? safeText(previous?.content, 700) : '');
  const latestUser = [...(session.messages || [])].reverse().find(message => message.role === 'user');
  const prompt = safeText(request.prompt || latestUser?.content, 700);
  const continuing = /^(?:继续|好的?|continue|go on|ok)[。.!！\s]*$/i.test(prompt);
  const goal = (continuing && previousGoal) || prompt || previousGoal;
  if (!goal || containsUnsafeMemoryText(goal)) return null;
  const todos = Array.isArray(result?.todos) ? result.todos : [];
  const pending = todos.filter(todo => todo.done !== true && !['done', 'completed', 'cancelled'].includes(todo.status))
    .map(todo => safeText(todo.text || todo.content || todo.title, 200)).filter(Boolean).slice(0, 6);
  const constraints = [...new Set([...safeLines(prior?.constraints), ...prompt.split(/\n|(?<=[。；])/)
    .filter(line => /必须|不要|不得|请勿|保留|only|must|never/i.test(line))
    .map(line => safeText(line, 200)).filter(Boolean)])].slice(-8);
  const verified = [...safeVerified(prior?.verified), ...(result?.toolCalls || []).filter(call => call.ok === true).slice(-4).map(call => ({
    text: `工具调用成功：${safeText(call.name, 80)}`,
    evidence: [{ runId, toolCallId: String(call.id || call.callId || ''), kind: 'tool_result' }]
  }))].slice(-8);
  const status = result ? String(result.status || 'interrupted') : 'running';
  const summary = safeText(result?.text, 330);
  const unresolved = Array.isArray(result?.todos) ? pending : safeLines(prior?.unresolved);
  if (status === 'error') unresolved.push('上次执行遇到错误，需要根据执行记录核实原因。');
  else if (result?.userRequestedFinish) unresolved.push('上次执行已由用户中止，继续前核对当前进度。');
  const taskState = { version: 1, ...source, goal, constraints, verified, unresolved,
    nextSteps: unresolved.length ? [unresolved[0]] : !result ? safeLines(prior?.nextSteps) : [],
    sources: [{ sessionId: source.sessionId, runId, sourceMessageId: source.sourceMessageId }], status };
  const content = [`目标：${goal.slice(0, 230)}`, `状态：${status}`, summary ? `最近输出摘要：${summary}` : '',
    unresolved.length ? `未决：${unresolved.join('；').slice(0, 180)}` : ''].filter(Boolean).join('；').slice(0, 800);
  return { key: 'work.state.current', type: 'work_state', scope: 'task', content, confidence: 0.8,
    evidence: `session=${source.sessionId}; run=${runId}; message=${source.sourceMessageId}; status=${status}`,
    basis: 'task_execution_snapshot', verified: false, taskState, ...source };
}

function buildReviewJobPayload({ session, request, selection, result, prompt, workspace, runId, runStartedAt, evolutionMode, harnessBaselines, refinementRequest }) {
  const text = (value, size) => safeText(value, size);
  const source = taskSource(session, request, runId, runStartedAt);
  return {
    selection: { providerId: text(selection.providerId, 120), modelId: text(selection.modelId, 160) },
    request: { conversationRevision: source.conversationRevision, workMode: request.workMode,
      requestMessageIndex: source.sourceMessageIndex, sourceMessageId: source.sourceMessageId,
      history: (request.history || []).slice(-12).map(message => ({ role: message.role, content: text(message.content, 1200) })) },
    result: { status: result.status, userRequestedFinish: result.userRequestedFinish === true,
      text: text(result.text, 3000), todos: (result.todos || []).slice(0, 30).map(todo => ({
        text: text(todo.text || todo.content || todo.title, 250), done: todo.done === true, status: todo.status })),
      toolCalls: (result.toolCalls || []).slice(-20).map(call => ({ name: text(call.name, 120), status: call.status,
        ok: call.ok === true, args: text(call.args, 600), output: text(call.output, 900) })),
      changes: (result.changes || []).slice(0, 20).map(change => ({ file: text(change.file || change.path, 500),
        status: change.status, additions: change.additions, deletions: change.deletions })) },
    prompt: text(prompt, 3000), workspace, zSessionId: source.sessionId, runId, runStartedAt,
    evolutionMode: evolutionMode === true,
    // Baselines contain change revision/fingerprints, not API credentials.
    harnessBaselines: evolutionMode ? summarizeHarnessBaselines(harnessBaselines) : {},
    refinementRequest: safeRefinementRequest(refinementRequest)
  };
}

module.exports = { safeText, taskMemoryIdentity, taskSource, buildTaskProgressRecord, buildReviewJobPayload, summarizeHarnessBaselines };
