(function exposeBrowserSessionState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZBrowserSessionState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function normalizeBrowserSessionUrl(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > 32768 || /[\u0000-\u001f\u007f]/.test(text)) return '';
    try {
      const url = new URL(text);
      if (url.username || url.password) return '';
      if (url.protocol === 'about:') return url.href === 'about:blank' ? 'about:blank' : '';
      return ['http:', 'https:', 'file:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }

  function safeTabId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : '';
  }

  // Persist only navigation/display metadata. Runtime run IDs, webContents,
  // credentials, and any other live browser handles must stay in memory.
  function normalizeBrowserSessionState(value) {
    if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.tabs)) return null;
    const tabs = [];
    const ids = new Set();
    for (const item of value.tabs) {
      if (!item || typeof item !== 'object') continue;
      const id = safeTabId(item.id);
      const url = normalizeBrowserSessionUrl(item.url);
      if (!id || !url || ids.has(id)) continue;
      ids.add(id);
      const title = typeof item.title === 'string'
        ? item.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 512) : '';
      const tab = { id, url, title: title || url };
      const favicon = normalizeBrowserSessionUrl(item.favicon);
      if (favicon) tab.favicon = favicon;
      if (typeof item.agentOwned === 'boolean') tab.agentOwned = item.agentOwned;
      if (typeof item.workspace === 'string' && item.workspace.trim()
        && item.workspace.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(item.workspace)) {
        tab.workspace = item.workspace.trim();
      }
      tabs.push(tab);
    }
    return {
      version: 1,
      tabs,
      activeTabId: ids.has(value.activeTabId) ? value.activeTabId : null,
      selectedTabId: ids.has(value.selectedTabId) ? value.selectedTabId : null
    };
  }

  return { normalizeBrowserSessionState, normalizeBrowserSessionUrl };
}));
