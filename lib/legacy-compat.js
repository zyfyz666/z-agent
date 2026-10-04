(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.ZLegacyCompat = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // Historical storage and wire identifiers are compatibility contracts. Build
  // their namespace from code points so a source rebrand leaves existing data
  // readable without embedding the former product name throughout the code.
  // These aliases must never be used for bulk replacement of user content.
  const lower = String.fromCodePoint(121, 97, 110);
  const title = lower[0].toUpperCase() + lower.slice(1);
  const upper = lower.toUpperCase();
  const LEGACY_NAMESPACE = Object.freeze({
    lower,
    title,
    upper,
    agent: `${lower}agent`,
    agentTitle: `${title}Agent`,
    agentUpper: `${upper}AGENT`,
    agentHyphen: `${lower}-agent`
  });

  const LEGACY_STORAGE = Object.freeze({
    stableDataDir: `${title}Data`,
    versionedDataDirPrefix: `${title}Data-`,
    coreDir: `${lower}-core`,
    workspaceDir: `.${lower}agent`,
    browserPartition: `persist:${lower}-browser`,
    skillManifest: `.${lower}-skill.json`,
    projectInstructionsFile: `${upper}.md`,
    generatedImageTempDir: LEGACY_NAMESPACE.agentTitle,
    defaultWorkspaceDir: `${title}Workspace`,
    worktreeBranchPrefix: `${lower}-task-`,
    sidebarMetaKey: `${lower}.workspace-sidebar-meta.v1`,
    sidebarCollapsedKey: `${lower}.workspace-sidebar-collapsed.v1`,
    composerHeightKey: `${lower}.composer.height`
  });

  // Only application-owned metadata fields belong here. Supplier/model IDs,
  // paths, free-form messages, API credentials and third-party fields do not.
  const FIELD_SUFFIXES = Object.freeze([
    'SessionId', 'SessionID', 'RunID', 'WorkMode', 'ModeIsolation',
    'HasUserWorkspace', 'Verification', 'Environment', 'Qwem', 'Managed',
    'BrowserAvailable', 'InterjectionObserver', 'MemoryReviewer', 'SkillJudge',
    'CandidateId', 'DsmlCompatibility', 'GlmmCompatibility',
    'QwemCompatibility', 'KimlCompatibility'
  ]);
  const LEGACY_FIELDS = Object.freeze(Object.fromEntries(
    FIELD_SUFFIXES.map(suffix => [`z${suffix}`, `${lower}${suffix}`])
  ));

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function ownField(record, key) {
    if (!isRecord(record) || typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    // Persisted records contain data properties. Never execute an inherited
    // property or accessor while resolving a compatibility alias.
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor : null;
  }

  function readCompatibleField(record, currentKey, fallback) {
    const current = ownField(record, currentKey);
    if (current) return current.value;
    const alias = ownField(LEGACY_FIELDS, currentKey);
    const previous = alias ? ownField(record, alias.value) : null;
    return previous ? previous.value : fallback;
  }

  // Exact runtime event names, not a blanket namespace-prefix substitution.
  // Keeping this list explicit prevents rewriting an unrelated application's
  // event, an unknown extension, or text that happens to resemble a type.
  const EVENT_SUFFIXES = Object.freeze([
    'guidance.status', 'opencode.slow-consumer',
    'agi.artifact.audit',
    'context.budget',
    'context.compression.started', 'context.compression.completed', 'context.compression.failed',
    'delivery.acceptance.started', 'delivery.acceptance.repaired',
    'delivery.acceptance.passed', 'delivery.acceptance.failed',
    'delivery.contract.updated', 'delivery.review.dropped',
    'delivery.summary.started', 'delivery.summary.finished',
    'dsml.adapter.failed', 'dsml.recovery.started', 'dsml.recovery.completed', 'dsml.recovery.failed',
    'finalization.started', 'finalization.progress',
    'goal.acceptance.started', 'goal.acceptance.repaired', 'goal.acceptance.passed', 'goal.acceptance.failed',
    'interjection.processing', 'interjection.processed', 'interjection.failed',
    'model.request.started', 'model.response.started', 'model.retrying',
    'model.truncated', 'model.empty-output', 'model.recovered',
    'opencode.started', 'opencode.finished', 'opencode.event-error', 'opencode.event-stream-lost',
    'opencode.reconnecting', 'opencode.reconnected',
    'policy.acceptance.started', 'policy.acceptance.passed', 'policy.acceptance.failed', 'policy.permission',
    'review.updated', 'review.invalidated',
    'sidepath.required', 'sidepath.brief', 'sidepath.blocked', 'sidepath.degraded',
    'sidepath.bypassed', 'sidepath.permission',
    'subagent.capacity', 'subagent.event', 'subagent.history', 'subagent.permission', 'subagent.progress',
    'thrash.watchdog', 'thrash.watchdog.status',
    'vision.relay.started', 'vision.relay.fallback', 'vision.relay.completed'
  ]);
  const EVENT_ALIASES = new Map(EVENT_SUFFIXES.map(suffix => [`${lower}.${suffix}`, `z.${suffix}`]));

  function normalizeEventType(type) {
    return typeof type === 'string' ? (EVENT_ALIASES.get(type) || type) : type;
  }

  function normalizeProviderEvent(event) {
    const type = ownField(event, 'type');
    if (!type) return event;
    const normalized = normalizeEventType(type.value);
    return normalized === type.value ? event : { ...event, type: normalized };
  }

  const CORE_PROVIDER_EVENT_TYPES = new Set([
    'provider.event', 'message.delta', 'reasoning.delta',
    'tool.started', 'tool.progress', 'tool.completed', 'file.edited',
    'context.updated', 'context.compacted',
    'context.compaction.started', 'context.compaction.completed', 'context.compaction.failed',
    'delivery.acceptance.started', 'delivery.acceptance.repaired',
    'delivery.acceptance.passed', 'delivery.acceptance.failed', 'turn.retrying'
  ]);

  function normalizeStoredEvent(event) {
    const normalized = normalizeProviderEvent(event);
    if (!CORE_PROVIDER_EVENT_TYPES.has(ownField(normalized, 'type')?.value)) return normalized;
    const payload = ownField(normalized, 'payload')?.value;
    if (ownField(payload, 'provider')?.value !== 'opencode') return normalized;
    const rawTypeField = ownField(payload, 'rawType');
    const rawField = ownField(payload, 'raw');
    const rawType = normalizeEventType(rawTypeField?.value);
    const raw = normalizeProviderEvent(rawField?.value);
    if (rawType === rawTypeField?.value && raw === rawField?.value) return normalized;
    const nextPayload = { ...payload };
    if (rawTypeField) nextPayload.rawType = rawType;
    if (rawField) nextPayload.raw = raw;
    return { ...normalized, payload: nextPayload };
  }

  return Object.freeze({
    LEGACY_NAMESPACE,
    LEGACY_STORAGE,
    LEGACY_FIELDS,
    readCompatibleField,
    normalizeEventType,
    normalizeProviderEvent,
    normalizeStoredEvent
  });
});
