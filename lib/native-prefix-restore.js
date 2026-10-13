'use strict';

const { recoverNativePrefix, nativePrefixDigest, nativePrefixContentDigest } = require('./native-prefix-recovery');

function unwrap(result) {
  if (result?.error) throw new Error('Native context operation failed');
  return result?.data ?? result;
}

// Copy a proven conversation boundary into a new native session. The source
// is never resumed, reverted or modified. Readback is mandatory: a concurrent
// source change or a kernel with different fork semantics must fail closed.
async function restoreForkNativePrefix({ client, appRoot, dataDir, request, directory,
  permission, signal, onEvent = () => {}, log = {}, recover = recoverNativePrefix } = {}) {
  if (!request?.forkHistory || !client?.session?.fork || signal?.aborted) return null;
  const candidate = await recover({ appRoot, dataDir, request, directory, signal });
  if (!candidate || candidate.desktopTail?.length || !candidate.sourceMessageCount
    || !candidate.messageID || signal?.aborted) return null;
  let copied;
  let ownedSessionId = '';
  let accepted = false;
  let stage = 'fork';
  try {
    copied = unwrap(await client.session.fork({ sessionID: candidate.sourceSessionId,
      directory, messageID: candidate.messageID }, { signal }));
    if (!copied?.id || copied.id === candidate.sourceSessionId) {
      copied = null;
      throw new Error('Native fork did not create an independent session');
    }
    ownedSessionId = copied.id;
    stage = 'readback';
    const messages = unwrap(await client.session.messages({ sessionID: copied.id, directory }, { signal }));
    if (signal?.aborted) throw new Error('Native context recovery cancelled');
    if (!Array.isArray(messages) || messages.length !== candidate.sourceMessageCount
      || nativePrefixDigest(messages) !== candidate.sourceHash) {
      throw new Error(`Copied native history differs from the verified retained prefix (expected ${candidate.sourceMessageCount} messages, received ${Array.isArray(messages) ? messages.length : 'invalid'})`);
    }
    stage = 'metadata';
    copied = unwrap(await client.session.update({ sessionID: copied.id, directory,
      title: String(request.title || request.prompt || 'Z task').slice(0, 120),
      permission,
      metadata: {
        zSessionID: String(request.zSessionId || ''),
        zConversationRevision: Number(request.conversationRevision) || 0,
        zWorkMode: String(request.workMode || 'normal'), zModeIsolation: 1,
        zHasUserWorkspace: !!request.hasUserWorkspace,
        zNativePrefix: {
          version: 1, sourceSessionId: candidate.sourceSessionId,
          boundaryMessageId: candidate.boundaryMessageId,
          messageCount: candidate.sourceMessageCount, sourceHash: candidate.sourceHash,
          contentHash: nativePrefixContentDigest(messages),
          desktopPrefix: candidate.desktopPrefix
        }
      }
    }, { signal }));
    if (copied?.id !== ownedSessionId) throw new Error('Native fork metadata update was not confirmed');
    if (signal?.aborted) throw new Error('Native context recovery cancelled');
    stage = 'notification';
    onEvent({ type: 'z.context.native-prefix.restored', data: {
      sessionID: copied.id, sourceSessionID: candidate.sourceSessionId,
      coveredMessageCount: candidate.desktopPrefix.messageCount,
      nativeMessageCount: messages.length
    } });
    accepted = true;
    return { session: copied, messages };
  } catch (error) {
    log.warn?.(`[context] Native prefix recovery failed at ${stage}: ${error?.message || error}`);
    if (signal?.aborted) return null;
    // A verified native source exists. Replaying the UI archive here would
    // resurrect pruned tool results, so a failed copy must stop this send.
    throw Object.assign(new Error('回退上下文恢复校验未通过，已停止本次发送，避免重新载入已清理的旧历史。原对话和文件均已保留。', { cause: error }), {
      code: 'CONTEXT_NATIVE_RESTORE_FAILED', contextRestoreStage: stage
    });
  } finally {
    if (!accepted && ownedSessionId && ownedSessionId !== candidate.sourceSessionId) {
      // Only the new, unbound fork belongs to this operation. Never delete or
      // roll back the source, even when cancellation wins during validation.
      try { await client.session.delete({ sessionID: ownedSessionId, directory }); } catch {}
    }
  }
}

module.exports = { restoreForkNativePrefix };
