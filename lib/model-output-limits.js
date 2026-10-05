(function exposeModelOutputLimits(root, factory) {
  const gpt = typeof module === 'object' && module.exports
    ? require('./gpt-model-profile') : root?.ZGptModelProfile;
  const api = factory(gpt);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZModelOutputLimits = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, gpt => {
  'use strict';

  const DEFAULT_OUTPUT_TOKENS = 32_768;
  const CHECKED_ON = '2026-10-05';
  // Published decimal limits for synchronous Messages, including thinking.
  // Evidence and retrieval limitations: docs/model-output-limits.md.
  const CLAUDE = Object.freeze({
    'claude-opus-4-7': 128000,
    'claude-opus-4-6': 128000,
    'claude-sonnet-4-6': 128000,
    'claude-opus-4-5': 64000,
    'claude-opus-4-5-20251101': 64000,
    'claude-sonnet-4-5': 64000,
    'claude-sonnet-4-5-20250929': 64000,
    'claude-haiku-4-5': 64000,
    'claude-haiku-4-5-20251001': 64000,
    'claude-sonnet-5': 128000,
    'claude-opus-5': 128000,
    'claude-opus-5-5': 128000
  });

  function normalizeOutputTokens(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  }

  function getOutputProfile(modelId) {
    const wireId = String(modelId || '').trim();
    const id = wireId.toLowerCase();
    // A small explicit set of gateway wrappers; never change the wire model ID
    // or extrapolate future Claude versions from a substring match.
    let reference = id.replace(/^(?:anthropic\/|openai\/|claude-kr-)/, '').replace(/\[1m\]$/, '');
    reference = reference.replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)(?=-|$)/, 'claude-$1-$2-$3');
    if (Object.hasOwn(CLAUDE, reference)) {
      const canonical = reference.replace(/-\d{8}$/, '');
      return { modelId: wireId, referenceModelId: reference, maximum: CLAUDE[reference],
        source: id === reference ? 'official' : 'alias-reference', verified: id === reference,
        sourceUrl: `https://platform.claude.com/docs/en/models/${canonical.slice(7)}/overview`,
        checkedOn: CHECKED_ON, reasoningSharesOutputBudget: true };
    }
    // Preserve the existing OpenAI compatibility data while its official
    // documentation is inaccessible. These are not newly verified limits.
    const inherited = gpt?.profileFor(reference);
    if (inherited?.maxOutputTokens > 0) {
      return { modelId: wireId, referenceModelId: reference, maximum: inherited.maxOutputTokens,
        source: 'legacy', verified: false, sourceUrl: '', checkedOn: '',
        reasoningSharesOutputBudget: inherited.reasoning === true };
    }
    return { modelId: wireId, referenceModelId: '', maximum: 0,
      source: 'unknown', verified: false, sourceUrl: '', checkedOn: '' };
  }

  function resolveOutputLimit({ modelId, capabilities = {}, maxOutputTokens, contextWindow, native = false } = {}) {
    const profile = getOutputProfile(modelId);
    let { maximum, source, verified } = profile;
    const declared = normalizeOutputTokens(capabilities?.maxOutputTokens);
    // Decorations are computed metadata, not a provider declaration. Only a
    // smaller explicitly declared gateway limit may lower a known ceiling.
    const inferred = ['official', 'alias-reference', 'legacy', 'unknown'].includes(capabilities?.outputLimitSource);
    if (declared && !inferred && (!maximum || declared < maximum)) {
      maximum = declared;
      source = 'declared';
      verified = true;
    }
    const requested = normalizeOutputTokens(maxOutputTokens);
    const context = normalizeOutputTokens(contextWindow);
    const contextMaximum = context ? Math.max(1, context - 1) : Number.MAX_SAFE_INTEGER;
    // Out-of-scope families retain their previous automatic 32K request
    // budget (or a smaller supplier cap). Manual overrides are opt-in.
    const fallback = native ? 32_000 : DEFAULT_OUTPUT_TOKENS;
    const automatic = profile.maximum ? maximum : Math.min(maximum || fallback, fallback);
    const tokens = Math.min(requested || automatic, maximum || Number.MAX_SAFE_INTEGER, contextMaximum);
    return { ...profile, tokens, maximum: maximum ? Math.min(maximum, contextMaximum) : 0,
      source: requested ? 'manual' : source, verified,
      automaticSource: source, requested, contextLimited: contextMaximum < (requested || automatic) };
  }

  function validateOutputTokens(value, options = {}) {
    const number = Number(value ?? 0);
    if (!Number.isSafeInteger(number) || number < 0) return '输出额度须为 0（自动）或正整数';
    const limit = resolveOutputLimit({ ...options, maxOutputTokens: 0 });
    if (number > 0 && limit.maximum > 0 && number > limit.maximum) {
      return `输出额度不能超过当前模型额度 ${limit.maximum.toLocaleString('en-US')} tokens`;
    }
    return '';
  }

  return { DEFAULT_OUTPUT_TOKENS, CHECKED_ON, getOutputProfile, normalizeOutputTokens, resolveOutputLimit, validateOutputTokens };
}));
