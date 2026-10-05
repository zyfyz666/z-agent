(function (root) {
  'use strict';
  let host, initialized = false, entries = [], loading = 0, saving = false, outputSelectionKey = '';
  const $ = id => document.getElementById(id);
  const key = value => JSON.stringify([value.providerId, value.supplierId]);
  const t = value => document.documentElement.lang === 'en' ? root.ZI18n?.translate(value) || value : value;
  const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
  const reasoningLabels = Object.freeze({ low: '轻度', medium: '中', high: '高', xhigh: '极高', max: '最高' });
  const reasoningEffort = value => {
    const normalized = String(value || '').trim().toLowerCase();
    return Object.hasOwn(reasoningLabels, normalized) ? normalized : 'max';
  };
  const observer = () => host.config?.observer || { model: null, judgeEvery: 6, reasoningEffort: 'max' };
  function outputLimitState(selection = {}, value = 0, { native = false } = {}) {
    const raw = String(value ?? '').trim();
    const requested = raw ? Number(raw) : 0;
    if (!Number.isSafeInteger(requested) || requested < 0) return { error: t('请输入 0 或正整数。') };
    const resolve = root.ZModelOutputLimits?.resolveOutputLimit;
    if (!resolve) return { error: t('输出额度信息暂不可用，请重新打开。') };
    const options = { modelId: selection.modelId || selection.id || '', capabilities: selection.capabilities || {},
      contextWindow: selection.contextWindow, native };
    const automatic = resolve({ ...options, maxOutputTokens: 0 });
    if (requested && automatic.maximum > 0 && requested > automatic.maximum) {
      return { requested, automatic, error: `${t(automatic.verified ? '不能超过已确认上限' : '不能超过当前额度')} ${Number(automatic.maximum).toLocaleString()} tokens` };
    }
    const resolution = requested ? resolve({ ...options, maxOutputTokens: requested }) : automatic;
    const labels = { official: '官方资料', 'alias-reference': '型号参考（未确认）', declared: '连接声明',
      legacy: '兼容默认（未确认）', unknown: '上限未确认', manual: '手动' };
    const origin = t(labels[automatic.source] || '上限未确认');
    const tokens = Number(resolution.tokens);
    const amount = Number.isFinite(tokens) && tokens > 0 ? `${tokens.toLocaleString()} tokens` : t('未确认');
    const unverified = !automatic.verified && !origin.includes(t('未确认')) ? ` · ${t('上限未确认')}` : '';
    return { requested, automatic, resolution,
      summary: `${t(requested ? '手动' : '自动')} · ${amount} · ${origin}${unverified}` };
  }
  function renderOutputControl() {
    const input = $('zObserverOutputTokens');
    const summary = $('zObserverOutputSummary');
    const ruleOnly = $('zConnectionSelect').value === 'rules';
    const entry = entries.find(item => key(item) === $('zConnectionSelect').value);
    const selected = entry?.models.find(item => item.id === $('zConnectionModel').value);
    const identity = ruleOnly ? 'rules' : JSON.stringify([entry?.providerId, entry?.supplierId, selected?.id]);
    if (outputSelectionKey && outputSelectionKey !== identity) input.value = '';
    outputSelectionKey = identity;
    input.disabled = saving || ruleOnly || !selected;
    input.removeAttribute('max');
    const status = ruleOnly ? { summary: t('规则模式不调用模型。') } : outputLimitState(selected || {}, input.value);
    if (status.automatic?.maximum > 0) input.max = String(status.automatic.maximum);
    input.setCustomValidity(status.error || '');
    summary.textContent = status.error || status.summary;
    summary.dataset.error = String(!!status.error);
  }
  function render() {
    $('zObserverName').textContent = observer().model?.name || t('规则');
    const effortLabel = observer().model ? ` · ${t('观察者思考强度')}：${t(reasoningLabels[reasoningEffort(observer().reasoningEffort)])}` : '';
    $('zObserverPill').title = `${t('观察者')} · ${observer().model?.name || t('规则模式')}${effortLabel} · ${observer().judgeEvery || 6}`;
  }
  function renderReasoningControl() {
    const ruleOnly = $('zConnectionSelect').value === 'rules';
    $('zObserverReasoning').disabled = saving || ruleOnly;
    $('zObserverReasoningHint').textContent = t(ruleOnly
      ? '规则模式不调用模型；选择观察者模型后可调整思考强度。'
      : '与主模型独立设置，默认最高。仅用于模型观察，从下一轮任务生效。');
    renderOutputControl();
  }
  function models(preferred) {
    const ruleOnly = $('zConnectionSelect').value === 'rules';
    const selected = entries.find(item => key(item) === $('zConnectionSelect').value);
    $('zConnectionModelField').hidden = ruleOnly;
    $('zConnectionModel').replaceChildren(...(selected?.models || []).map(item => option(item.id, item.name)));
    if (selected?.models.some(item => item.id === preferred)) $('zConnectionModel').value = preferred;
    $('zConnectionSave').disabled = !ruleOnly && !selected?.models.length;
    renderReasoningControl();
  }
  async function open() {
    if (saving) return;
    const sequence = ++loading;
    $('zConnectionTitle').textContent = t('观察者设置');
    $('zConnectionDescription').textContent = t('规则模式无需模型。选择独立模型后，观察者会在后台分析任务摘要并提供建议。修改从下一轮任务生效。');
    $('zObserverDetails').hidden = false;
    $('zObserverEvery').value = observer().judgeEvery || 6;
    $('zObserverEvery').disabled = false;
    $('zObserverReasoning').value = reasoningEffort(observer().reasoningEffort);
    $('zObserverReasoning').disabled = true;
    outputSelectionKey = '';
    $('zObserverOutputTokens').value = observer().maxOutputTokens > 0 ? String(observer().maxOutputTokens) : '';
    $('zObserverOutputTokens').disabled = true;
    $('zObserverOutputTokens').setCustomValidity('');
    $('zObserverOutputSummary').textContent = '';
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
      $('zObserverReasoning').value = reasoningEffort(result.observer?.reasoningEffort);
      $('zObserverOutputTokens').value = result.observer?.maxOutputTokens > 0 ? String(result.observer.maxOutputTokens) : '';
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
    const output = selected ? outputLimitState(selected, $('zObserverOutputTokens').value) : { requested: 0 };
    if (output.error) {
      $('zConnectionNotice').textContent = output.error;
      $('zObserverOutputTokens').reportValidity();
      return;
    }
    saving = true;
    $('zConnectionSave').disabled = true;
    $('zConnectionSelect').disabled = true; $('zConnectionModel').disabled = true; $('zObserverEvery').disabled = true;
    $('zObserverReasoning').disabled = true;
    $('zObserverOutputTokens').disabled = true;
    $('zConnectionNotice').textContent = t('正在保存…');
    try {
      const result = await host.api.configureObserver({
        judgeEvery: Number($('zObserverEvery').value),
        reasoningEffort: reasoningEffort($('zObserverReasoning').value),
        maxOutputTokens: output.requested,
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
      renderReasoningControl();
    }
  }
  root.ZConnectionControls = { outputLimitState, mount(options) {
    host = options;
    if (!initialized) {
      initialized = true;
      const layoutObserver = new ResizeObserver(() => host.onLayoutChange?.());
      layoutObserver.observe(document.querySelector('.composer-toolbar-controls'));
      $('zObserverPill').addEventListener('click', open);
      document.addEventListener('click', event => { if (event.target.closest('[data-observer-config]')) open(); });
      $('zConnectionSelect').addEventListener('change', () => models($('zConnectionModel').value));
      $('zConnectionModel').addEventListener('change', renderOutputControl);
      $('zObserverOutputTokens').addEventListener('input', renderOutputControl);
      $('zConnectionForm').addEventListener('submit', save);
      $('zConnectionClose').addEventListener('click', close);
      $('zConnectionCancel').addEventListener('click', close);
      $('zConnectionDialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); else loading++; });
    }
    render();
  } };
})(window);
