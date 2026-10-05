'use strict';

// Durable model identity contains display metadata and the per-session output cap. Endpoints and keys
// are always resolved from the current connection store at execution time.
function sessionModelSnapshot(value) {
  if (!value || typeof value !== 'object' || (value.modelType && value.modelType !== 'text')) return null;
  const capabilities = {};
  for (const [key, item] of Object.entries(value.capabilities || {})) {
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) capabilities[key] = item;
  }
  return {
    providerId: String(value.providerId || '').trim(),
    supplierId: String(value.supplierId || '').trim(),
    modelId: String(value.modelId || value.model || '').trim(),
    modelType: 'text',
    name: String(value.name || value.modelName || value.modelId || value.model || '').trim(),
    ...(Object.hasOwn(value, 'maxOutputTokens') ? { maxOutputTokens:
      Number.isSafeInteger(Number(value.maxOutputTokens)) && Number(value.maxOutputTokens) > 0
        ? Number(value.maxOutputTokens) : 0 } : {}),
    capabilities
  };
}

function inferSessionModelSelection(session, defaultSelection, candidates = []) {
  const stored = sessionModelSnapshot(session?.modelSelection);
  if (stored) return stored;
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const selection = sessionModelSnapshot(message?.modelSelection)
      || sessionModelSnapshot(message?.role === 'assistant' ? message.agentRun : null);
    if (!selection?.modelId) continue;
    if (!selection.supplierId || !selection.providerId) {
      // Legacy assistant run records often omitted supplierId; the user turn
      // carries the exact frozen identity. Do not guess a different provider.
      const earlier = messages.slice(0, index).reverse().map(item => sessionModelSnapshot(item?.modelSelection))
        .find(item => item?.modelId === selection.modelId && item.providerId && item.supplierId
          && (!selection.providerId || item.providerId === selection.providerId));
      if (earlier) {
        selection.providerId = earlier.providerId;
        selection.supplierId = earlier.supplierId;
      } else {
        const matching = candidates.filter(item => item.modelId === selection.modelId
          && (!selection.providerId || item.providerId === selection.providerId)
          && (!selection.supplierId || item.supplierId === selection.supplierId));
        if (matching.length === 1) {
          selection.providerId = matching[0].providerId;
          selection.supplierId = matching[0].supplierId;
        }
      }
    }
    // Even a removed provider/model remains the historical identity. Runtime
    // validation must report it unavailable instead of choosing another model.
    return selection;
  }
  return sessionModelSnapshot(defaultSelection) || sessionModelSnapshot({});
}

function createSessionWriteQueue() {
  const pending = new Map();
  return function withSessionWrite(id, operation) {
    const key = String(id || '');
    const prior = pending.get(key) || Promise.resolve();
    const result = prior.then(operation);
    const settled = result.then(() => {}, () => {});
    pending.set(key, settled);
    return result.finally(() => {
      if (pending.get(key) === settled) pending.delete(key);
    });
  };
}

module.exports = { sessionModelSnapshot, inferSessionModelSelection, createSessionWriteQueue };
