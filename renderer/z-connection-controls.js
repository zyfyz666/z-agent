(function (root) {
  'use strict';
  let host, initialized = false, entries = [], loading = 0, saving = false;
  const $ = id => document.getElementById(id);
  const key = value => JSON.stringify([value.providerId, value.supplierId]);
  const t = value => document.documentElement.lang === 'en' ? root.YanI18n?.translate(value) || value : value;
  const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
  const observer = () => host.config?.observer || { model: null, judgeEvery: 6 };
  function render() {
    $('zObserverName').textContent = observer().model?.name || t('规则');
    $('zObserverPill').title = `${t('观察者')} · ${observer().model?.name || t('规则模式')} · ${observer().judgeEvery || 6}`;
  }
  function models(preferred) {
    const ruleOnly = $('zConnectionSelect').value === 'rules';
    const selected = entries.find(item => key(item) === $('zConnectionSelect').value);
    $('zConnectionModelField').hidden = ruleOnly;
    $('zConnectionModel').replaceChildren(...(selected?.models || []).map(item => option(item.id, item.name)));
    if (selected?.models.some(item => item.id === preferred)) $('zConnectionModel').value = preferred;
    $('zConnectionSave').disabled = !ruleOnly && !selected?.models.length;
  }
  async function open() {
    if (saving) return;
    const sequence = ++loading;
    $('zConnectionTitle').textContent = t('观察者设置');
    $('zConnectionDescription').textContent = t('规则模式无需模型。选择独立模型后，观察者会在后台分析任务摘要并提供建议。修改从下一轮任务生效。');
    $('zObserverDetails').hidden = false;
    $('zObserverEvery').value = observer().judgeEvery || 6;
    $('zObserverEvery').disabled = false;
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
      const current = result.observer?.model;
      $('zObserverEvery').value = result.observer?.judgeEvery || 6;
      $('zConnectionSelect').replaceChildren(
        option('rules', t('仅规则观察（不调用模型）')),
        ...entries.map(entry => option(key(entry), entry.name))
      );
      if (current && entries.some(item => key(item) === key(current))) $('zConnectionSelect').value = key(current);
      else $('zConnectionSelect').value = 'rules';
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
    if ($('zConnectionSelect').value !== 'rules' && !selected) return;
    saving = true;
    $('zConnectionSave').disabled = true;
    $('zConnectionSelect').disabled = true; $('zConnectionModel').disabled = true; $('zObserverEvery').disabled = true;
    $('zConnectionNotice').textContent = t('正在保存…');
    try {
      const result = await host.api.configureObserver({
        judgeEvery: Number($('zObserverEvery').value),
        model: selected ? { providerId: entry.providerId, supplierId: entry.supplierId, modelId: selected.id } : null
      });
      if (result.error) throw new Error(result.error);
      host.onObserverChange(result.observer);
      host.onNotice(t('观察者设置已保存，下轮任务生效'));
      saving = false; close();
    } catch (error) { $('zConnectionNotice').textContent = t(error.message || '保存失败，请重试。'); }
    finally {
      saving = false; $('zConnectionSave').disabled = false;
      $('zConnectionSelect').disabled = false; $('zConnectionModel').disabled = false;
      $('zObserverEvery').disabled = false;
    }
  }
  root.ZConnectionControls = { mount(options) {
    host = options;
    if (!initialized) {
      initialized = true;
      const layoutObserver = new ResizeObserver(() => host.onLayoutChange?.());
      layoutObserver.observe(document.querySelector('.composer-toolbar-controls'));
      $('zObserverPill').addEventListener('click', open);
      document.addEventListener('click', event => { if (event.target.closest('[data-observer-config]')) open(); });
      $('zConnectionSelect').addEventListener('change', () => models($('zConnectionModel').value));
      $('zConnectionForm').addEventListener('submit', save);
      $('zConnectionClose').addEventListener('click', close);
      $('zConnectionCancel').addEventListener('click', close);
      $('zConnectionDialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); else loading++; });
    }
    render();
  } };
})(window);
