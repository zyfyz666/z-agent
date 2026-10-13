'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { createGuidanceMessageId } = require('./live-guidance');
const { readWithDeadline } = require('./run-health');

function contextPromptParts(parts) {
  return parts.map(part => ({ ...part, id: part.id || createGuidanceMessageId().replace(/^msg_/, 'prt_') }));
}

function contextMessageReady(message, { sessionID, messageID, partIds }) {
  return message?.info?.id === messageID && message.info.sessionID === sessionID && message.info.role === 'user'
    && Array.isArray(message.parts) && partIds.every(id => message.parts.some(part => part.id === id));
}

function pendingMessageError() {
  return Object.assign(new Error('内核已接收请求，用户消息仍在保存。'), { code: 'CONTEXT_MESSAGE_PENDING' });
}

function isNotFound(error, status) {
  return status === 404 || error?.name === 'NotFoundError' || error?.type === 'NotFoundError'
    || /\bNotFoundError\b|\bMessage not found\b/.test(String(error?.message || error?.data?.message || ''));
}

// prompt_async acknowledges dispatch, not a committed message. Message info
// can become visible before its parts. Read only, with an overall deadline;
// never retry submission to repair a missing context receipt.
async function waitForContextMessage({ client, directory, sessionID, messageID, partIds, signal,
  timeoutMs = 3000, pollMs = 50 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const result = await readWithDeadline(readSignal => client.session.message({ sessionID, directory, messageID },
        { signal: readSignal }), Math.max(1, deadline - Date.now()), signal);
      if (result?.error) {
        if (!isNotFound(result.error, result.response?.status)) {
          const error = new Error(result.error.message || result.error.data?.message || '读取用户消息回执失败。');
          error.cause = result.error; throw error;
        }
      } else {
        const message = result?.data ?? result;
        if (contextMessageReady(message, { sessionID, messageID, partIds })) return message;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw pendingMessageError();
      if (!isNotFound(error)) throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(pollMs, remaining), undefined, { signal });
  }
  throw pendingMessageError();
}

module.exports = { contextPromptParts, contextMessageReady, waitForContextMessage };
