'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const compat = require('../lib/legacy-compat');
const {
  LEGACY_NAMESPACE,
  LEGACY_STORAGE,
  LEGACY_FIELDS,
  readCompatibleField,
  normalizeEventType,
  normalizeProviderEvent,
  normalizeStoredEvent
} = compat;
const previousPrefix = String.fromCodePoint(121, 97, 110);

test('storage aliases preserve the on-disk contracts without creating or moving data', () => {
  assert.deepEqual(Array.from(LEGACY_NAMESPACE.lower, char => char.codePointAt(0)), [121, 97, 110]);
  assert.equal(LEGACY_STORAGE.stableDataDir, `${LEGACY_NAMESPACE.title}Data`);
  assert.equal(LEGACY_STORAGE.coreDir, `${previousPrefix}-core`);
  assert.equal(LEGACY_STORAGE.workspaceDir, `.${previousPrefix}agent`);
  assert.equal(LEGACY_STORAGE.browserPartition, `persist:${previousPrefix}-browser`);
  assert.equal(LEGACY_STORAGE.skillManifest, `.${previousPrefix}-skill.json`);
  assert.equal(LEGACY_STORAGE.sidebarMetaKey, `${previousPrefix}.workspace-sidebar-meta.v1`);
  assert.equal(LEGACY_STORAGE.sidebarCollapsedKey, `${previousPrefix}.workspace-sidebar-collapsed.v1`);
  assert.equal(LEGACY_STORAGE.composerHeightKey, `${previousPrefix}.composer.height`);
  assert.equal(Object.isFrozen(LEGACY_NAMESPACE), true);
  assert.equal(Object.isFrozen(LEGACY_STORAGE), true);
});

test('old native session metadata remains usable without rewriting the session', () => {
  const metadata = Object.freeze({
    [LEGACY_FIELDS.zModeIsolation]: 1,
    [LEGACY_FIELDS.zWorkMode]: 'normal',
    [LEGACY_FIELDS.zSessionID]: 'sess_existing',
    [LEGACY_FIELDS.zHasUserWorkspace]: false
  });
  assert.equal(readCompatibleField(metadata, 'zModeIsolation'), 1);
  assert.equal(readCompatibleField(metadata, 'zWorkMode'), 'normal');
  assert.equal(readCompatibleField(metadata, 'zSessionID'), 'sess_existing');
  assert.equal(readCompatibleField(metadata, 'zHasUserWorkspace', true), false);
  assert.equal(Object.hasOwn(metadata, 'zModeIsolation'), false);
});

test('current explicit values win over old metadata, including falsy and cleared values', () => {
  for (const value of [false, 0, '', null, undefined]) {
    const record = { zWorkMode: value, [LEGACY_FIELDS.zWorkMode]: 'agi' };
    assert.equal(readCompatibleField(record, 'zWorkMode', 'fallback'), value);
  }
  assert.equal(readCompatibleField({}, 'zWorkMode', 'normal'), 'normal');
});

test('field compatibility does not infer aliases for arbitrary supplier IDs or user fields', () => {
  const supplierId = `${previousPrefix}-custom-provider`;
  const config = {
    providerId: supplierId,
    [previousPrefix + 'CustomSetting']: 'user-owned',
    baseUrl: `https://example.test/${previousPrefix}/api`,
    apiKey: `secret-${previousPrefix}`
  };
  assert.equal(readCompatibleField(config, 'providerId'), supplierId);
  assert.equal(readCompatibleField(config, 'zCustomSetting', 'missing'), 'missing');
  assert.equal(readCompatibleField(config, 'baseUrl'), config.baseUrl);
  assert.equal(readCompatibleField(config, 'apiKey'), config.apiKey);
});

test('field reads ignore inherited data and do not execute accessors', () => {
  const inherited = Object.create({ zWorkMode: 'agi', [LEGACY_FIELDS.zWorkMode]: 'agi' });
  assert.equal(readCompatibleField(inherited, 'zWorkMode', 'normal'), 'normal');
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'zWorkMode', { get() { getterCalls += 1; return 'agi'; } });
  assert.equal(readCompatibleField(accessor, 'zWorkMode', 'normal'), 'normal');
  assert.equal(getterCalls, 0);
  for (const invalid of [null, undefined, [], 'text', 42]) {
    assert.equal(readCompatibleField(invalid, 'zWorkMode', 'normal'), 'normal');
  }
});

test('old verification receipts keep exact file revisions and stale status', () => {
  const receipt = Object.freeze({ files: { 'src/a.js': 'sha-existing' }, status: 'stale' });
  const metadata = { [LEGACY_FIELDS.zVerification]: receipt };
  assert.equal(readCompatibleField(metadata, 'zVerification'), receipt);
  assert.equal(readCompatibleField(metadata, 'zVerification').status, 'stale');
});

test('known observation, subagent and compression event types normalize exactly', () => {
  for (const suffix of ['thrash.watchdog.status', 'subagent.event', 'subagent.history',
    'context.compression.completed', 'interjection.processed', 'model.retrying', 'guidance.status']) {
    assert.equal(normalizeEventType(`${previousPrefix}.${suffix}`), `z.${suffix}`);
    assert.equal(normalizeEventType(`z.${suffix}`), `z.${suffix}`);
  }
});

test('unknown event names and free-form strings remain unchanged', () => {
  const values = [
    `${previousPrefix}.custom.extension`, `${previousPrefix}.subagent.future-event`,
    `${previousPrefix}.subagent.`, `${previousPrefix}.composer.height`,
    `text ${previousPrefix}.model.retrying`, `${previousPrefix}.model.retrying.extra`,
    'message.part.delta', 'session.status', 'turn.started', null, undefined, 12
  ];
  for (const value of values) assert.equal(normalizeEventType(value), value);
});

test('normalizing a provider event preserves all observation data and user text by identity', () => {
  const data = Object.freeze({
    status: 'observe', reason: `User mentioned ${previousPrefix}.model.retrying`,
    message: { type: `${previousPrefix}.subagent.event` },
    metadata: { [LEGACY_FIELDS.zVerification]: { status: 'passed' } }
  });
  const original = Object.freeze({ type: `${previousPrefix}.thrash.watchdog.status`, data });
  const normalized = normalizeProviderEvent(original);
  assert.equal(normalized.type, 'z.thrash.watchdog.status');
  assert.equal(normalized.data, data);
  assert.equal(original.type, `${previousPrefix}.thrash.watchdog.status`);
  assert.equal(normalizeProviderEvent(normalized), normalized);
});

test('journal normalization handles mapped Core events as well as provider.event', () => {
  const data = Object.freeze({ beforeTokens: 123, afterTokens: 45 });
  for (const coreType of ['provider.event', 'context.compaction.completed', 'context.updated', 'turn.retrying']) {
    const raw = Object.freeze({ type: `${previousPrefix}.context.compression.completed`, data });
    const payload = Object.freeze({ provider: 'opencode', rawType: raw.type, raw, data });
    const event = Object.freeze({ type: coreType, sequence: 42, eventId: 'evt_existing', payload });
    const normalized = normalizeStoredEvent(event);
    assert.equal(normalized.type, coreType);
    assert.equal(normalized.sequence, 42);
    assert.equal(normalized.eventId, 'evt_existing');
    assert.equal(normalized.payload.rawType, 'z.context.compression.completed');
    assert.equal(normalized.payload.raw.type, 'z.context.compression.completed');
    assert.equal(normalized.payload.raw.data, data);
    assert.equal(normalized.payload.data, data);
    assert.equal(event.payload, payload);
    assert.equal(normalizeStoredEvent(normalized), normalized);
  }
});

test('flattened journal records retain data and do not gain a fabricated raw event', () => {
  const data = { runID: 'run_existing', status: 'observe' };
  const event = { type: 'provider.event', payload: {
    provider: 'opencode', rawType: `${previousPrefix}.thrash.watchdog`, data
  } };
  const normalized = normalizeStoredEvent(event);
  assert.equal(normalized.payload.rawType, 'z.thrash.watchdog');
  assert.equal(normalized.payload.data, data);
  assert.equal(Object.hasOwn(normalized.payload, 'raw'), false);
});

test('journal normalization never recurses through user content or unknown envelopes', () => {
  const raw = { type: `${previousPrefix}.model.retrying`, data: {} };
  const values = [
    { type: 'message.updated', data: { rawType: raw.type, raw } },
    { type: 'item.created', payload: { provider: 'opencode', rawType: raw.type, raw } },
    { type: 'provider.event', payload: { provider: 'external', rawType: raw.type, raw } },
    { type: 'provider.event', payload: { rawType: raw.type, raw } },
    { type: 'provider.event', payload: { provider: 'opencode', rawType: 'message.updated', raw: { type: 'message.updated', data: { raw } } } }
  ];
  for (const value of values) assert.equal(normalizeStoredEvent(value), value);
});

test('malformed and already-current events pass through without mutation', () => {
  for (const value of [null, undefined, false, 42, 'message', [], {}, { type: 'z.model.retrying' }]) {
    assert.equal(normalizeProviderEvent(value), value);
    assert.equal(normalizeStoredEvent(value), value);
  }
  const inherited = Object.create({ type: `${previousPrefix}.model.retrying` });
  assert.equal(normalizeProviderEvent(inherited), inherited);
});

test('browser and CommonJS callers share the same compatibility behavior', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/legacy-compat.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'legacy-compat.js' });
  assert.equal(context.ZLegacyCompat.LEGACY_STORAGE.browserPartition, LEGACY_STORAGE.browserPartition);
  assert.equal(context.ZLegacyCompat.normalizeEventType(`${previousPrefix}.subagent.history`), 'z.subagent.history');
  assert.equal(source.toLowerCase().includes(previousPrefix), false);
  assert.equal(Object.isFrozen(context.ZLegacyCompat), true);
});
