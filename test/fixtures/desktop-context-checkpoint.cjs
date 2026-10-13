'use strict';

const { createDesktopContextCheckpoint } = require('../../lib/desktop-context-checkpoint');

function checkpointForSession(session, count, summary = 'VERIFIED_OLDER_SUMMARY') {
  return createDesktopContextCheckpoint({
    messages: session.messages.slice(0, count),
    request: { zSessionId: session.id, branchId: session.id,
      conversationRevision: session.conversationRevision || 0, workMode: 'normal' },
    nativeSessionId: 'ses_checkpoint_source', directory: session.workspace || '/fixture', createdAt: 100,
    restoredNativeContext: { ok: true, checkpointId: 'a'.repeat(64), coversUntilMessageId: 'native_covered',
      context: { summary, tail: [{ id: 'native_tail', role: 'assistant',
        parts: [{ id: 'tail_part', type: 'text', text: 'EXACT_RETAINED_NATIVE_TAIL' }] }] } }
  });
}

module.exports = { checkpointForSession };
