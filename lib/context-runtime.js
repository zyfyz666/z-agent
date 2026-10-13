'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { ContextStore } = require('./context-store');
const { contextContentDigest, contextError, pointReference, validRef } = require('./context-state');

function worker({ appRoot, dataDir, signal, ...input }) {
  const runtime = require('./codegraph-runtime').resolveNodeCommand(appRoot);
  if (!runtime.ok) return Promise.reject(contextError('用于恢复上下文的本地运行环境不可用。'));
  const script = path.join(__dirname, 'context-native-worker.cjs').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return new Promise((resolve, reject) => {
    const child = execFile(runtime.command, ['--disable-warning=ExperimentalWarning', script], {
      windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal,
      env: { ...global.process.env, ELECTRON_RUN_AS_NODE: undefined }
    }, (error, stdout) => {
      if (error) return reject(error);
      try { const result = JSON.parse(stdout); if (!result.ok) throw contextError(result.error, result.code); resolve(result); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...input, dataDir,
      dbPath: path.join(dataDir, 'opencode-runtime', 'data', 'opencode', 'opencode.db') }));
  });
}

async function resolveContextBoundary({ source, prefix, selected, includeSelected = true, ...options }) {
  const last = prefix.at(-1);
  const fullHead = prefix.length === source.messages?.length && prefix.every((m, i) => m === source.messages[i])
    ? source.contextState?.head : '';
  const reference = fullHead || (!includeSelected && selected ? pointReference(source, selected)
    : last?.role === 'user' ? source.contextState?.points?.[`after-user:${require('./context-state').boundaryKey(last)}`]
      : last?.agentRun?.historyBoundaryAt ? '' : pointReference(source, last));
  if (validRef(reference)) { new ContextStore(options.dataDir).read(reference); return reference; }
  if (!prefix.length) return new ContextStore(options.dataDir).capture([], { directory: options.directory, zSessionId: source.id });
  return (await worker({ ...options, source, prefix, operation: 'migrate' })).ref;
}

async function restoreContextSnapshot({ client, ref, request, permission, directory, appRoot, dataDir, signal, onEvent = () => {} }) {
  const { manifest, messages: expected } = new ContextStore(dataDir).read(ref);
  const nonce = crypto.randomBytes(20).toString('hex');
  const unwrap = value => { if (value?.error) throw contextError('创建独立上下文会话失败。'); return value?.data ?? value; };
  let session;
  try {
    session = unwrap(await client.session.create({ directory, title: String(request.title || request.prompt || 'Z task').slice(0, 120),
      agent: request.workMode === 'plan' ? 'plan' : 'build', permission,
      model: { id: request.modelId, providerID: request.providerId }, metadata: {
        zSessionID: request.zSessionId, zWorkMode: request.workMode || 'normal', zModeIsolation: 1,
        zHasUserWorkspace: !!request.hasUserWorkspace, zContextVersion: 2, zContextImport: { nonce, ref }
      } }, { signal }));
    await worker({ appRoot, dataDir, signal, directory, operation: 'import', sessionId: session.id, nonce, ref });
    const messages = unwrap(await client.session.messages({ sessionID: session.id, directory }, { signal }));
    if (messages.length !== manifest.messageCount || contextContentDigest(messages) !== manifest.contentDigest) {
      const error = contextError('恢复后的模型上下文与保存的快照不同，已停止发送。', 'CONTEXT_STATE_MISMATCH');
      error.expectedCount = manifest.messageCount; error.actualCount = messages.length;
      error.changedFields = expected.flatMap((message, i) => {
        const actual = messages[i];
        return Object.keys(message.info).filter(k => !['id', 'sessionID', 'parentID'].includes(k)
          && JSON.stringify(message.info[k]) !== JSON.stringify(actual?.info?.[k])).map(k => `message[${i}].info.${k}`)
          .concat(message.parts.flatMap((p, j) => [...new Set([...Object.keys(p), ...Object.keys(actual?.parts[j] || {})])]
            .filter(k => !['id', 'sessionID', 'messageID', 'tail_start_id'].includes(k)
              && JSON.stringify(p[k]) !== JSON.stringify(actual?.parts[j]?.[k])).map(k => `message[${i}].part[${j}].${k}`)));
      });
      throw error;
    }
    onEvent({ type: 'z.context.state.restored', data: { sessionID: session.id, ref, messageCount: messages.length } });
    return { session, messages };
  } catch (error) {
    if (session?.id) { try { await client.session.delete({ sessionID: session.id, directory }); } catch {} }
    throw error;
  }
}

module.exports = { resolveContextBoundary, restoreContextSnapshot };
