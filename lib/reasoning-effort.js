'use strict';

const REASONING_SPEED_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const LEGACY_REASONING_SPEED_MAP = Object.freeze({
  fast: 'low',
  balanced: 'medium',
  smart: 'high'
});

// Model-specific reasoning budgets. A model that silently treats unknown
// values as its maximum (GLM-5.3-Flash 官方文档：仅 low/high/max，其他值按 max)
// turns a user's "medium" into the slowest tier — so we map explicitly to the
// NEAREST supported value (ties round UP: quality-preserving, never dumber
// than requested, and strictly faster than the official silent-max fallback).
const MODEL_REASONING_CAPABILITIES = Object.freeze({
  'glm-5.3': Object.freeze({ supported: Object.freeze(['low', 'high', 'max']), tieBreak: 'up' }),
  'qwen3.8-max': Object.freeze({ supported: Object.freeze(['low', 'medium', 'xhigh']), tieBreak: 'up' }),
  'qwen3.8-flash-next': Object.freeze({ supported: Object.freeze(['low', 'medium', 'xhigh']), tieBreak: 'up' }),
  'kimi-k3': Object.freeze({ supported: Object.freeze(['low', 'high', 'max']), tieBreak: 'up' })
});

function normalizeReasoningSpeed(value, { thinking = false } = {}) {
  const normalized = String(value || '').trim().toLowerCase();
  if (REASONING_SPEED_LEVELS.includes(normalized)) return normalized;
  if (LEGACY_REASONING_SPEED_MAP[normalized]) return LEGACY_REASONING_SPEED_MAP[normalized];
  return thinking ? 'high' : 'medium';
}

function reasoningSpeedEnablesThinking(value) {
  return ['high', 'xhigh', 'max'].includes(normalizeReasoningSpeed(value));
}

// Resolve the effort value actually safe to send for a given model.
// Returns { effort, adjusted, requested?, model? } — adjusted=true means the
// requested tier is not supported by this model and was mapped explicitly.
function resolveReasoningForModel(modelId, requested, { thinking = false, supported = null, capabilityLabel = '' } = {}) {
  const effort = normalizeReasoningSpeed(requested, { thinking });
  const key = String(modelId || '').toLowerCase();
  const explicitSupported = Array.isArray(supported)
    ? [...new Set(supported.map(value => String(value || '').trim().toLowerCase()))]
      .filter(value => REASONING_SPEED_LEVELS.includes(value))
    : [];
  const capability = explicitSupported.length
    ? [String(capabilityLabel || modelId || 'model'), { supported: explicitSupported, tieBreak: 'up' }]
    : Object.entries(MODEL_REASONING_CAPABILITIES).find(([id]) => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[/\\s])${escaped}(?:[-:\\s]|\\[|$)`, 'i').test(key);
    });
  if (!capability) return { effort, adjusted: false };
  const [id, spec] = capability;
  if (spec.supported.includes(effort)) return { effort, adjusted: false };
  const order = REASONING_SPEED_LEVELS;
  const rank = order.indexOf(effort);
  let nearest = null;
  let nearestDistance = Infinity;
  for (const candidate of spec.supported) {
    const distance = Math.abs(order.indexOf(candidate) - rank);
    if (distance < nearestDistance
      || (distance === nearestDistance && spec.tieBreak === 'up'
        && order.indexOf(candidate) > order.indexOf(nearest))) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return { effort: nearest, adjusted: true, requested: effort, model: id };
}

function claudeReasoningProfile(modelId) {
  const id = String(modelId || '').toLowerCase().split('/').at(-1);
  const modern = /^claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d{1,2})(?!\d))?(?=$|[-:@\s\[])/.exec(id);
  const legacy = /^claude-(\d+)(?:[.-](\d{1,2})(?!\d))?-(opus|sonnet|haiku)(?=$|[-:@\s\[])/.exec(id);
  if (!modern && !legacy) return null;
  const suffix = modern ? id.slice(modern[0].length) : '';
  if (modern && !modern[3] && /^[.-]\d/.test(suffix)
      && !/^-\d{8}(?=$|[-:@\s\[])/.test(suffix)) return null;
  const family = modern ? modern[1] : legacy[3];
  const version = `${Number(modern ? modern[2] : legacy[1])}.${Number((modern ? modern[3] : legacy[2]) || 0)}`;
  // Match the pinned OpenCode Anthropic variants and the documented effort
  // table. Unknown future versions are not assumed to accept these options.
  // https://platform.claude.com/docs/en/build-with-claude/effort
  // https://platform.claude.com/docs/en/build-with-claude/thinking
  if (family === 'opus' && version === '4.7') {
    return { mode: 'adaptive', supported: REASONING_SPEED_LEVELS, display: 'summarized' };
  }
  if (['opus', 'sonnet'].includes(family) && version === '4.6') {
    return { mode: 'adaptive', supported: ['low', 'medium', 'high', 'max'] };
  }
  if (family === 'opus' && version === '4.5') {
    return { mode: 'budget', supported: ['low', 'medium', 'high'], effort: true };
  }
  if (version === '4.5'
      || (['opus', 'sonnet'].includes(family) && version === '4.0')
      || (family === 'opus' && version === '4.1')
      || (family === 'sonnet' && version === '3.7')) {
    return { mode: 'budget', supported: ['high', 'max'] };
  }
  return null;
}

// Return resolution metadata separately instead of adding new diagnostic
// fields to SDK options. Compatible adapters retain their existing contract.
function resolveProviderReasoning(modelId, requested, {
  apiFormat = 'openai', supported = null, capabilityLabel = '', outputLimit = 32_768,
  reasoning = true
} = {}) {
  const requestedEffort = normalizeReasoningSpeed(requested);
  const nativeClaude = apiFormat === 'anthropic' && /(?:^|\/)claude-/i.test(String(modelId || ''));
  if (!nativeClaude) {
    const resolved = resolveReasoningForModel(modelId, requested, { supported, capabilityLabel });
    return {
      options: { reasoningEffort: resolved.effort,
        ...(resolved.adjusted ? { reasoningEffortAdjusted: { requested: resolved.requested, model: resolved.model } } : {}) },
      metadata: { requested: requestedEffort, effective: resolved.effort, mode: 'effort', adjusted: resolved.adjusted }
    };
  }
  const profile = reasoning !== false ? claudeReasoningProfile(modelId) : null;
  if (!profile) return { options: {}, metadata: { requested: requestedEffort, effective: null,
    mode: 'provider-default', adjusted: true, reason: reasoning === false ? 'reasoning-disabled' : 'unverified-claude-model' } };
  const declared = Array.isArray(supported) ? supported.map(value => String(value).toLowerCase()) : [];
  const allowed = profile.supported.filter(value => !declared.length || declared.includes(value));
  const resolved = resolveReasoningForModel(modelId, requested, {
    supported: allowed.length ? allowed : profile.supported, capabilityLabel
  });
  const metadata = { requested: requestedEffort, effective: resolved.effort,
    mode: profile.mode, adjusted: resolved.adjusted };
  if (profile.mode === 'adaptive') return {
    options: { thinking: { type: 'adaptive', ...(profile.display ? { display: profile.display } : {}) }, effort: resolved.effort },
    metadata
  };
  // These are the pinned kernel's legacy Claude variants: Opus 4.5 uses
  // effort plus the high budget; earlier thinking models use high/max budgets.
  const limit = Math.max(0, Math.floor(Number(outputLimit) || 0));
  const budgetTokens = resolved.effort === 'max'
    ? Math.min(31_999, limit - 1)
    : Math.min(16_000, Math.floor(limit / 2 - 1));
  if (budgetTokens < 1024) return { options: {}, metadata: { ...metadata, effective: null,
    mode: 'provider-default', adjusted: true, reason: 'output-limit-below-thinking-minimum' } };
  return { options: { thinking: { type: 'enabled', budgetTokens }, ...(profile.effort ? { effort: resolved.effort } : {}) },
    metadata: { ...metadata, budgetTokens } };
}

module.exports = {
  LEGACY_REASONING_SPEED_MAP,
  MODEL_REASONING_CAPABILITIES,
  REASONING_SPEED_LEVELS,
  normalizeReasoningSpeed,
  reasoningSpeedEnablesThinking,
  resolveReasoningForModel,
  resolveProviderReasoning
};
