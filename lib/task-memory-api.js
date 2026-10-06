'use strict';

const { taskMemoryIdentity } = require('./task-memory-service');

function createTaskMemoryApi({ store, readSession, withSessionWrite, readUsage = () => ({ items: [] }), readJobs = () => [] }) {
  async function selected(payload) {
    if (!/^sess_[A-Za-z0-9_-]{4,160}$/.test(String(payload?.sessionId || ''))) throw new Error('任务 ID 无效。');
    const session = await readSession(payload.sessionId);
    if (!session) throw new Error('任务不存在或已被删除。');
    return session;
  }
  const errorResult = error => ({ ok: false, error: String(error?.message || error), code: error?.code });
  async function annotate(items) {
    const titles = new Map();
    for (const item of items) {
      const id = item.source?.sessionId;
      if (id && !titles.has(id)) {
        const source = await readSession(id);
        titles.set(id, String(source?.title || '来源任务已删除'));
      }
    }
    return items.map(item => ({ ...item, sourceTitle: titles.get(item.source?.sessionId) || '' }));
  }
  return {
    async list(payload = {}) {
      try {
        const session = await selected(payload);
        const identity = taskMemoryIdentity(session);
        const query = String(payload.query || '').trim().toLowerCase().slice(0, 500);
        const all = await annotate(store.list({ ...identity, includeInactive: true }).filter(item => item.status !== 'deleted'));
        const items = all.filter(item => !query || `${item.content} ${item.evidence || ''} ${(item.keywords || []).join(' ')} ${item.sourceTitle} ${item.source?.sessionId || ''} ${item.source?.runId || ''}`.toLowerCase().includes(query));
        const usage = readUsage(identity);
        const usedItems = (usage?.items || []).map(entry => entry.content ? entry : store.get(entry.id, { ...identity, includeInactive: true })).filter(Boolean);
        return { ok: true, sessionId: session.id, conversationRevision: identity.conversationRevision,
          items, usage: { ...usage, items: await annotate(usedItems) },
          reviews: readJobs(identity), storage: { path: store.dbPath } };
      } catch (error) { return errorResult(error); }
    },
    async update(payload = {}) {
      try {
        await selected(payload);
        return await withSessionWrite(payload.sessionId, async () => {
          const session = await readSession(payload.sessionId, { sessionLocked: true });
          if (!session) throw new Error('任务不存在。');
          const identity = taskMemoryIdentity(session);
          if (payload.conversationRevision !== identity.conversationRevision) throw Object.assign(new Error('对话已回退，请重新打开任务记忆。'), { code: 'SESSION_REVISION_CHANGED' });
          const current = store.get(String(payload.id || ''), { ...identity, includeInactive: true });
          if (!current || current.status === 'deleted') throw new Error('这条记忆不属于当前任务范围或已删除。');
          const patch = {};
          if (Object.hasOwn(payload, 'content')) {
            if (typeof payload.content !== 'string' || !payload.content.trim() || payload.content.length > 800) throw new Error('记忆内容需为 1–800 个字符。');
            patch.content = payload.content;
          }
          if (Object.hasOwn(payload, 'status')) {
            if (!['active', 'disabled'].includes(payload.status)) throw new Error('记忆状态无效。');
            patch.status = payload.status;
          }
          if (!Object.keys(patch).length) throw new Error('没有需要保存的修改。');
          return store.update(current.id, patch, { ...identity, sourceKind: 'user_edit' });
        });
      } catch (error) { return errorResult(error); }
    },
    async remove(payload = {}) {
      try {
        await selected(payload);
        return await withSessionWrite(payload.sessionId, async () => {
          const session = await readSession(payload.sessionId, { sessionLocked: true });
          if (!session) throw new Error('任务不存在。');
          const identity = taskMemoryIdentity(session);
          if (payload.conversationRevision !== identity.conversationRevision) throw Object.assign(new Error('对话已回退，请重新打开任务记忆。'), { code: 'SESSION_REVISION_CHANGED' });
          const current = store.get(String(payload.id || ''), { ...identity, includeInactive: true });
          if (!current) throw new Error('这条记忆不属于当前任务范围。');
          return store.remove(current.id, identity);
        });
      } catch (error) { return errorResult(error); }
    }
  };
}

module.exports = { createTaskMemoryApi };
