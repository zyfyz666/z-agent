(function (root) {
  'use strict';
  let host, lastConfig, refresh = 0, initialized = false, entries = [], mode = 'main', loading = 0, saving = false;
  const $ = id => document.getElementById(id);
  const key = value => JSON.stringify([value.providerId, value.supplierId]);
  const t = value => document.documentElement.lang === 'en' ? root.YanI18n?.translate(value) || value : value;
  const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
  const observer = () => host.config?.observer || { model: null, judgeEvery: 6 };
  function render() {
    const current = host.config?.agentModel || {};
    const entry = entries.find(item => key(item) === key(current));
    $('zApiName').textContent = entry?.name || current.providerId || t('选择连接');
    $('zApiPill').title = t('切换 API 连接') + (entry ? ` · ${entry.name}` : '');
    $('zObserverName').textContent = observer().model?.name || t('规则');
    $('zObserverPill').title = `${t('观察者')} · ${observer().model?.name || t('规则模式')} · ${observer().judgeEvery || 6}`;
  }
  function models(preferred) {
    const ruleOnly = mode === 'observer' && $('zConnectionSelect').value === 'rules';
    const selected = entries.find(item => key(item) === $('zConnectionSelect').value);
    $('zConnectionModelField').hidden = ruleOnly;
    $('zConnectionModel').replaceChildren(...(selected?.models || []).map(item => option(item.id, item.name)));
    if (selected?.models.some(item => item.id === preferred)) $('zConnectionModel').value = preferred;
    $('zConnectionSave').disabled = !ruleOnly && !selected?.models.length;
  }
  async function open(nextMode) {
    if (saving) return;
    mode = nextMode;
    const sequence = ++loading;
    $('zConnectionTitle').textContent = t(mode === 'observer' ? '观察者设置' : '切换 API');
    $('zConnectionDescription').textContent = t(mode === 'observer'
      ? '规则模式无需模型。选择独立模型后，观察者会在后台分析任务摘要并提供建议。修改从下一轮任务生效。'
      : '在这里切换主模型使用的 API 和模型。正在执行的任务继续使用原来的连接。');
    $('zObserverDetails').hidden = mode !== 'observer';
    $('zObserverEvery').value = observer().judgeEvery || 6;
    $('zObserverEvery').disabled = mode !== 'observer';
    $('zConnectionNotice').textContent = t('正在读取连接…');
    $('zConnectionSelect').disabled = true;
    $('zConnectionSave').disabled = true;
    $('zConnectionSelect').replaceChildren(); $('zConnectionModel').replaceChildren();
    $('zConnectionModelField').hidden = false;
    if (!$('zConnectionDialog').open) $('zConnectionDialog').showModal();
    try {
      const result = await host.api.listModelConnections();
      if (sequence !== loading || !$('zConnectionDialog').open) return;
      entries = result.connections || [];
      const current = mode === 'observer' ? result.observer?.model : host.config?.agentModel;
      if (mode === 'observer') $('zObserverEvery').value = result.observer?.judgeEvery || 6;
      $('zConnectionSelect').replaceChildren(
        ...(mode === 'observer' ? [option('rules', t('仅规则观察（不调用模型）'))] : []),
        ...entries.map(entry => option(key(entry), entry.name))
      );
      if (current && entries.some(item => key(item) === key(current))) $('zConnectionSelect').value = key(current);
      else if (mode === 'observer') $('zConnectionSelect').value = 'rules';
      models(current?.modelId);
      $('zConnectionNotice').textContent = current && !entries.some(item => key(item) === key(current))
        ? t('原连接已不可用，请重新选择。') : entries.length ? '' : t('尚无可用连接，请先在设置中添加 API。');
      render();
    } catch { $('zConnectionNotice').textContent = t('读取连接失败，请重试。'); }
    finally { if (sequence === loading) $('zConnectionSelect').disabled = false; }
  }
  function close() { if (!saving) { loading++; $('zConnectionDialog').close(); } }
  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const entry = entries.find(item => key(item) === $('zConnectionSelect').value);
    const selected = entry?.models.find(item => item.id === $('zConnectionModel').value);
    if (!(mode === 'observer' && $('zConnectionSelect').value === 'rules') && !selected) return;
    saving = true;
    $('zConnectionSave').disabled = true;
    $('zConnectionSelect').disabled = true; $('zConnectionModel').disabled = true; $('zObserverEvery').disabled = true;
    $('zConnectionNotice').textContent = t('正在保存…');
    try {
      if (mode === 'observer') {
        const result = await host.api.configureObserver({
          judgeEvery: Number($('zObserverEvery').value),
          model: selected ? { providerId: entry.providerId, supplierId: entry.supplierId, modelId: selected.id } : null
        });
        if (result.error) throw new Error(result.error);
        host.onObserverChange(result.observer);
      } else {
        const result = await host.api.setModelRole(entry.providerId, selected.id, 'text', entry.supplierId);
        if (result.error) throw new Error(result.error);
        host.onMainChange(result);
      }
      host.onNotice(t(mode === 'observer' ? '观察者设置已保存，下轮任务生效' : 'API 和模型已切换'));
      saving = false; close();
    } catch (error) { $('zConnectionNotice').textContent = t(error.message || '保存失败，请重试。'); }
    finally {
      saving = false; $('zConnectionSave').disabled = false;
      $('zConnectionSelect').disabled = false; $('zConnectionModel').disabled = false;
      $('zObserverEvery').disabled = mode !== 'observer';
    }
  }
  root.ZConnectionControls = { mount(options) {
    host = options;
    if (!initialized) {
      initialized = true;
      const layoutObserver = new ResizeObserver(() => host.onLayoutChange?.());
      layoutObserver.observe(document.querySelector('.composer-toolbar-controls'));
      $('zApiPill').addEventListener('click', () => open('main'));
      $('zObserverPill').addEventListener('click', () => open('observer'));
      document.addEventListener('click', event => { if (event.target.closest('[data-observer-config]')) open('observer'); });
      $('zConnectionSelect').addEventListener('change', () => models($('zConnectionModel').value));
      $('zConnectionForm').addEventListener('submit', save);
      $('zConnectionClose').addEventListener('click', close);
      $('zConnectionCancel').addEventListener('click', close);
      $('zConnectionDialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); else loading++; });
    }
    if (host.config !== lastConfig) {
      lastConfig = host.config;
      const sequence = ++refresh;
      void host.api.listModelConnections().then(result => {
        if (sequence !== refresh) return;
        entries = result.connections || []; render();
      }).catch(() => {});
    }
    render();
  } };
})(window);
