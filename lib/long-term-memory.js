const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workspaceStatePath } = require('./storage-layout');
const { executeMemoryOperation } = require('./memory-database');

const MEMORY_VERSION = 2;
const VALID_TYPES = new Set([
  'preference',
  'environment',
  'project',
  'decision',
  'procedure',
  'failure_solution',
  'work_state'
]);
const VALID_SCOPES = new Set(['global', 'machine', 'workspace', 'task']);
const DEFAULT_MAX_CONTEXT_CHARS = 3600;
const MAX_MEMORY_CONTENT_CHARS = 800;
const MAX_EVIDENCE_CHARS = 500;
const MAX_KEYWORDS = 16;
const RETRIEVAL_STOP_TOKENS = new Set([
  '帮我', '这个', '那个', '一下', '进行', '使用', '运行', '打开', '项目', '文件', '任务', '工作', '测试',
  '游戏', '网页', '网站', '代码', '程序', '问题', '错误', '正常', '修复', '检查', '验证',
  'please', 'help', 'with', 'this', 'that', 'use', 'run', 'open', 'project', 'file', 'task', 'test',
  'game', 'website', 'code', 'program', 'problem', 'error', 'normal', 'fix', 'check', 'verify'
]);
const SENSITIVE_MEMORY_MARKERS = Object.freeze([
  'api key:',
  'api key=',
  'apikey:',
  'apikey=',
  'access_token=',
  'refresh_token=',
  'authorization: bearer ',
  'password:',
  'password=',
  'passwd:',
  'passwd=',
  'private key-----',
  '密钥：',
  '密钥=',
  '密码：',
  '密码='
]);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function clip(value, max) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function normalizeWorkspace(workspace) {
  const value = String(workspace || '').trim();
  if (!value) return '';
  try { return path.resolve(value).toLowerCase(); } catch { return value.toLowerCase(); }
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function memoryId() {
  return `mem_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function tokenize(value) {
  const normalized = normalizeText(value);
  const tokens = new Set();
  const latin = normalized.match(/[a-z0-9][a-z0-9._:\\/-]{1,}/g) || [];
  for (const token of latin) {
    tokens.add(token);
    for (const part of token.split(/[._:\\/-]+/)) {
      if (part.length >= 2) tokens.add(part);
    }
  }
  const cjkRuns = normalized.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 12) tokens.add(run);
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens].slice(0, 160);
}

function containsUnsafeMemoryText(value) {
  const text = normalizeText(value);
  if (!text) return true;
  return [
    /ignore (?:all |any )?(?:previous|prior) instructions?/i,
    /reveal (?:the )?(?:system|developer) prompt/i,
    /<\/?(?:system|developer|assistant|tool)[^>]*>/i,
    /忽略(?:之前|以上|所有).{0,12}(?:指令|提示词)/,
    /泄露.{0,12}(?:系统|开发者).{0,8}(?:提示词|指令)/
  ].some(pattern => pattern.test(text));
}

function containsSensitiveMemoryText(value) {
  const text = normalizeText(value).replace(/\\+["']/g, '"');
  return SENSITIVE_MEMORY_MARKERS.some(marker => text.includes(marker))
    || /["']?(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|authorization|private[_-]?key|secret)["']?\s*[:=]\s*\S/i.test(text);
}

function emptyStore() {
  return { version: MEMORY_VERSION, memories: [], updatedAt: 0 };
}

function migrateLegacyStore(raw, defaultScope = 'global', workspace = '') {
  if (Array.isArray(raw?.memories)) {
    return {
      version: MEMORY_VERSION,
      memories: raw.memories.filter(item => item && typeof item === 'object'),
      updatedAt: Number(raw.updatedAt) || 0
    };
  }
  const facts = Array.isArray(raw?.facts) ? raw.facts : [];
  const now = Date.now();
  return {
    version: MEMORY_VERSION,
    memories: facts.map((fact, index) => {
      const content = clip(typeof fact === 'string' ? fact : fact?.content, MAX_MEMORY_CONTENT_CHARS);
      return {
        id: `legacy_${stableHash(`${content}:${index}`).slice(0, 16)}`,
        key: '',
        type: 'project',
        scope: defaultScope,
        workspace: defaultScope === 'workspace' ? normalizeWorkspace(workspace) : '',
        content,
        keywords: tokenize(content).slice(0, MAX_KEYWORDS),
        evidence: 'Migrated from Z Agent legacy memory.',
        confidence: 0.7,
        status: 'active',
        occurrences: 1,
        createdAt: Number(fact?.ts) || now,
        updatedAt: Number(fact?.ts) || now,
        source: { kind: 'legacy' }
      };
    }).filter(item => item.content),
    updatedAt: Number(raw?.updatedAt) || now
  };
}

function workspaceMemoryPath(workspace, zagentDir = '.zagent') {
  const value = String(workspace || '').trim();
  return value ? workspaceStatePath(value, ['memory.json'], zagentDir) : '';
}

function normalizeTaskState(input, source) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const state = {
    version: 1,
    sessionId: source.sessionId,
    branchId: clip(input.branchId, 120),
    conversationRevision: source.conversationRevision,
    goal: clip(input.goal, 1000),
    status: clip(input.status, 80)
  };
  for (const key of ['constraints', 'verified', 'unresolved', 'nextSteps']) {
    state[key] = (Array.isArray(input[key]) ? input[key] : [])
      .slice(0, 10).flatMap(item => {
        if (typeof item === 'string') return [clip(item, 220)];
        if (key !== 'verified' || !item || typeof item !== 'object' || !item.text) return [];
        return [{ text: clip(item.text, 220), evidence: (Array.isArray(item.evidence) ? item.evidence : []).slice(0, 4).map(evidence => ({
          runId: clip(evidence?.runId, 120), toolCallId: clip(evidence?.toolCallId, 120), kind: clip(evidence?.kind, 40)
        })) }];
      });
  }
  state.sources = (Array.isArray(input.sources) ? input.sources : []).slice(0, 12).map(item => (
    typeof item === 'string' ? clip(item, 200) : {
      messageId: clip(item?.messageId || item?.sourceMessageId, 160),
      runId: clip(item?.runId, 120),
      sessionId: clip(item?.sessionId, 120)
    }
  ));
  while (JSON.stringify(state).length > 6000) {
    const longest = ['sources', 'verified', 'constraints', 'unresolved', 'nextSteps']
      .sort((a, b) => JSON.stringify(state[b]).length - JSON.stringify(state[a]).length)[0];
    if (!state[longest].length) break;
    state[longest].pop();
  }
  return state;
}

function normalizeRecord(input = {}, options = {}) {
  const content = clip(input.content, MAX_MEMORY_CONTENT_CHARS);
  const evidence = clip(input.evidence, MAX_EVIDENCE_CHARS);
  if (!content || containsUnsafeMemoryText(content) || containsSensitiveMemoryText(content)) return null;
  if (evidence && (containsUnsafeMemoryText(evidence) || containsSensitiveMemoryText(evidence))) return null;
  const requestedScope = String(input.scope || options.defaultScope || 'global').toLowerCase();
  const requestedType = String(input.type || 'project').toLowerCase();
  const type = VALID_TYPES.has(requestedType) ? requestedType : 'project';
  const scope = type === 'work_state' ? 'task' : (VALID_SCOPES.has(requestedScope) ? requestedScope : 'global');
  const workspace = scope === 'workspace' || scope === 'task' ? normalizeWorkspace(options.workspace || input.workspace) : '';
  if (scope === 'workspace' && !workspace) return null;
  const suppliedKeywords = Array.isArray(input.keywords) ? input.keywords : [];
  const keywords = [...new Set([
    ...suppliedKeywords.map(keyword => normalizeText(keyword)).filter(Boolean),
    ...tokenize(content)
  ])].slice(0, MAX_KEYWORDS);
  const key = normalizeKey(input.key);
  const now = Date.now();
  const source = {
    kind: clip(options.sourceKind || input.source?.kind || 'background_review', 40),
    sessionId: clip(options.sessionId || input.sessionId || input.source?.sessionId, 120),
    runId: clip(options.runId || input.source?.runId, 120),
    refinementId: clip(options.refinementId || input.source?.refinementId, 120),
    conversationRevision: Math.max(0, Math.floor(Number(options.conversationRevision ?? input.conversationRevision ?? input.source?.conversationRevision) || 0)),
    runStartedAt: Math.max(0, Number(options.runStartedAt ?? input.runStartedAt ?? input.source?.runStartedAt) || now),
    messageId: clip(options.sourceMessageId || input.sourceMessageId || input.source?.sourceMessageId || input.source?.messageId, 160)
  };
  source.sourceMessageId = source.messageId;
  const messageIndex = options.sourceMessageIndex ?? input.sourceMessageIndex ?? input.source?.sourceMessageIndex;
  if (Number.isFinite(Number(messageIndex)) && messageIndex != null) source.sourceMessageIndex = Math.max(0, Math.floor(Number(messageIndex)));
  if (scope === 'task' && !source.sessionId) return null;
  return {
    id: memoryId(),
    key,
    type,
    scope,
    workspace,
    content,
    keywords,
    evidence,
    basis: clip(input.basis, 40),
    verified: input.verified === true,
    confidence: clamp(input.confidence, 0.1, 1, 0.75),
    status: 'active',
    occurrences: 1,
    createdAt: now,
    updatedAt: now,
    contentUpdatedAt: now,
    contentSource: source,
    sessionId: scope === 'task' ? source.sessionId : '',
    conversationRevision: source.conversationRevision,
    runStartedAt: source.runStartedAt,
    sourceMessageId: source.messageId,
    taskState: type === 'work_state' ? normalizeTaskState(input.taskState, source) : undefined,
    source,
    sources: [source]
  };
}

function sameSourceRun(a = {}, b = {}) {
  return !!a.runId && !!b.runId && a.runId === b.runId;
}

function sameSourceReference(a = {}, b = {}) {
  if (a.refinementId && b.refinementId) return a.refinementId === b.refinementId;
  return sameSourceRun(a, b);
}

function upsertIntoStore(store, record) {
  const memories = Array.isArray(store.memories) ? store.memories : [];
  const active = memories.filter(item => item?.status === 'active');
  const samePartition = item => (
    item.scope === record.scope
    && normalizeWorkspace(item.workspace) === normalizeWorkspace(record.workspace)
    && (record.scope !== 'task' || (
      item.sessionId === record.sessionId && item.conversationRevision === record.conversationRevision
    ))
  );
  const fingerprint = stableHash(normalizeText(record.content));
  const duplicate = active.find(item => (
    samePartition(item)
    && item.type === record.type
    && stableHash(normalizeText(item.content)) === fingerprint
  ));
  if (duplicate) {
    const previousContext = JSON.stringify([duplicate.evidence, duplicate.source, duplicate.taskState]);
    const sources = Array.isArray(duplicate.sources) && duplicate.sources.length
      ? duplicate.sources
      : [duplicate.source || {}];
    const sourceIndex = sources.findIndex(sourceItem => sameSourceReference(sourceItem, record.source));
    if (sourceIndex >= 0) sources[sourceIndex] = record.source;
    else sources.push(record.source);
    duplicate.sources = sources.slice(-40);
    duplicate.source = duplicate.sources.at(-1);
    duplicate.occurrences = Math.max(1, duplicate.sources.length);
    duplicate.confidence = Math.max(Number(duplicate.confidence) || 0, record.confidence);
    duplicate.updatedAt = Date.now();
    duplicate.runStartedAt = Math.max(Number(duplicate.runStartedAt) || 0, record.runStartedAt || 0);
    duplicate.sourceMessageId = record.sourceMessageId || duplicate.sourceMessageId;
    if (record.taskState) duplicate.taskState = record.taskState;
    duplicate.keywords = [...new Set([...(duplicate.keywords || []), ...record.keywords])].slice(0, MAX_KEYWORDS);
    if (record.evidence) duplicate.evidence = record.evidence;
    if (previousContext !== JSON.stringify([duplicate.evidence, duplicate.source, duplicate.taskState])) {
      duplicate.contentUpdatedAt = duplicate.updatedAt;
      duplicate.contentSource = record.source;
    }
    return { store: { ...store, memories }, memory: duplicate, action: 'reinforced' };
  }

  const conflicting = record.key
    ? active.find(item => (
      item.key === record.key
      && samePartition(item)
    ))
    : null;
  if (conflicting) {
    conflicting.status = 'superseded';
    conflicting.supersededBy = record.id;
    conflicting.updatedAt = Date.now();
    record.supersedes = conflicting.id;
  }
  memories.push(record);
  return { store: { ...store, memories }, memory: record, action: conflicting ? 'superseded' : 'created' };
}

function scoreMemory(memory, queryTokens, normalizedQuery, workspace) {
  if (!memory || (memory.status && memory.status !== 'active')) return -Infinity;
  if (memory.scope === 'workspace' && normalizeWorkspace(memory.workspace) !== normalizeWorkspace(workspace)) return -Infinity;
  const content = normalizeText(memory.content);
  const keywords = new Set((memory.keywords || []).flatMap(tokenize));
  const contentTokens = new Set(tokenize(content));
  let score = 0;
  if (normalizedQuery.length >= 4 && content.includes(normalizedQuery)) score += 12;
  for (const token of queryTokens) {
    if (RETRIEVAL_STOP_TOKENS.has(token)) continue;
    if (keywords.has(token)) score += token.length >= 4 ? 3.2 : 1.6;
    else if (contentTokens.has(token)) score += token.length >= 4 ? 2.2 : 1.1;
    else if (token.length >= 4 && content.includes(token)) score += 1.2;
  }
  if (memory.scope === 'workspace') score += 0.8;
  if (memory.type === 'failure_solution' || memory.type === 'environment') score += 0.35;
  score += clamp(memory.confidence, 0, 1, 0.5) * 0.75;
  score += Math.min(0.7, Math.log2(Math.max(1, Number(memory.occurrences) || 1)) * 0.2);
  return score;
}

function formatContext(memories, maxChars = DEFAULT_MAX_CONTEXT_CHARS) {
  if (!memories.length) return '';
  const header = [
    '## Relevant long-term memory (selectively retrieved)',
    'These are prior observations, not fresh tool evidence. Follow stable user preferences, but verify executable paths and mutable environment facts before relying on them.'
  ].join('\n');
  const lines = [header];
  let length = header.length;
  for (const memory of memories) {
    const label = `${memory.scope}/${memory.type}`;
    const evidence = memory.evidence ? ` Evidence: ${memory.evidence}` : '';
    const source = memory.source || {};
    const reference = source.sessionId ? `; source=${source.sessionId}${source.messageId ? `/${source.messageId}` : ''}` : '';
    const line = `- [${label}; confidence=${Number(memory.confidence || 0).toFixed(2)}${reference}] ${memory.content}${evidence}`;
    if (length + line.length + 1 > maxChars) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function saveRecord(db, memory) {
  db.prepare(`INSERT INTO memories(id,scope,workspace,type,memory_key,status,session_id,revision,run_started_at,created_at,updated_at,record)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,workspace=excluded.workspace,
    type=excluded.type,memory_key=excluded.memory_key,status=excluded.status,session_id=excluded.session_id,
    revision=excluded.revision,run_started_at=excluded.run_started_at,updated_at=excluded.updated_at,record=excluded.record`).run(
    memory.id, memory.scope, memory.workspace || '', memory.type, memory.key || '', memory.status,
    memory.sessionId || '', memory.conversationRevision || 0, memory.runStartedAt || 0,
    memory.createdAt || 0, memory.updatedAt || 0, JSON.stringify(memory));
  db.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(memory.id);
  if (memory.status === 'active') {
    const tokens = tokenize([memory.content, ...(memory.keywords || []), memory.evidence].join(' ')).join(' ');
    db.prepare('INSERT INTO memories_fts(memory_id,tokens) VALUES(?,?)').run(memory.id, tokens);
  }
}

function importLegacyFile(db, filePath, scope, workspace) {
  if (!filePath) return;
  const marker = `import:${normalizeWorkspace(filePath)}`;
  if (db.prepare('SELECT value FROM memory_metadata WHERE key=?').get(marker) || !fs.existsSync(filePath)) return;
  // Do not mark a damaged file as imported. The source remains untouched and a
  // later repair can still be imported without silently losing its records.
  const oldStore = migrateLegacyStore(JSON.parse(fs.readFileSync(filePath, 'utf8')), scope, workspace);
  for (const old of oldStore.memories) {
    if (!old?.content) continue;
    const normalized = normalizeRecord(old, {
      workspace: workspace || old.workspace,
      sessionId: old.sessionId || old.source?.sessionId || (old.type === 'work_state' ? 'legacy-unassigned' : ''),
      runStartedAt: old.runStartedAt || old.source?.runStartedAt || old.createdAt || old.updatedAt || 0
    });
    if (!normalized) continue;
    const memory = { ...old, ...normalized,
      id: `import_${stableHash(`${marker}:${old.id || old.content}`).slice(0, 24)}`,
      createdAt: Number(old.createdAt) || Date.now(), updatedAt: Number(old.updatedAt) || Date.now(),
      contentUpdatedAt: Number(old.contentUpdatedAt || old.editedAt || old.createdAt || old.updatedAt) || Date.now(),
      status: ['active','superseded','disabled','deleted','legacy'].includes(old.status) ? old.status : 'active',
      sources: Array.isArray(old.sources) && old.sources.length ? old.sources : [normalized.source],
      migration: { path: filePath, originalId: old.id || '', importedAt: Date.now() }
    };
    if (old.type === 'work_state' && !(old.sessionId || old.source?.sessionId)) {
      memory.status = 'legacy'; memory.sessionId = ''; memory.source.sessionId = '';
      memory.source.kind = 'legacy'; memory.sources = [memory.source];
    }
    if (old.supersededBy) memory.supersededBy = `import_${stableHash(`${marker}:${old.supersededBy}`).slice(0, 24)}`;
    if (old.supersedes) memory.supersedes = `import_${stableHash(`${marker}:${old.supersedes}`).slice(0, 24)}`;
    saveRecord(db, memory);
  }
  db.prepare('INSERT INTO memory_metadata(key,value) VALUES(?,?)').run(marker,
    JSON.stringify({ importedAt: Date.now(), count: oldStore.memories.length }));
}

function readRecords(db, options = {}) {
  const where = [], params = [];
  if (!options.allWorkspaces) {
    where.push("(scope IN ('global','machine') OR (scope='workspace' AND workspace=?) OR (scope='task' AND session_id=? AND workspace=?))");
    params.push(normalizeWorkspace(options.workspace), String(options.sessionId || ''), normalizeWorkspace(options.workspace));
    if (!options.sessionId) where.push("scope<>'task'");
  }
  if (!(options.includeInactive || options.includeSuperseded)) where.push("status='active'");
  if (options.sessionId && options.conversationRevision !== undefined) {
    where.push("(scope<>'task' OR revision=?)");
    params.push(Math.max(0, Math.floor(Number(options.conversationRevision) || 0)));
  }
  return db.prepare(`SELECT record FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC,id`)
    .all(...params).map(row => JSON.parse(row.record));
}

function canAccess(memory, options = {}) {
  if (!memory) return false;
  if (options.allWorkspaces || memory.scope === 'global' || memory.scope === 'machine') return true;
  if (normalizeWorkspace(memory.workspace) !== normalizeWorkspace(options.workspace)) return false;
  return memory.scope !== 'task' || (memory.sessionId === String(options.sessionId || '')
    && (options.conversationRevision === undefined || memory.conversationRevision === Number(options.conversationRevision)));
}
function getRecord(db, id, options) {
  const row = db.prepare('SELECT record FROM memories WHERE id=?').get(String(id || ''));
  const record = row ? JSON.parse(row.record) : null;
  return canAccess(record, options) ? record : null;
}
function beforeCutoff(memory, options) {
  if (options.cutoff == null || !Number.isFinite(Number(options.cutoff))) return true;
  const own = source => options.sessionId && source?.sessionId === options.sessionId
    && Number(source.conversationRevision || 0) === Number(options.conversationRevision || 0);
  return own(memory.contentSource || memory.source)
    || Number(memory.contentUpdatedAt || memory.editedAt || memory.createdAt || 0) <= Number(options.cutoff);
}

function executeStoreOperation(db, operation, args = {}, options = {}) {
  importLegacyFile(db, options.globalPath, 'global', '');
  const workspace = args.options?.workspace || args.workspace || args.input?.workspace || '';
  if (workspace) importLegacyFile(db, workspaceMemoryPath(workspace, options.zagentDir), 'workspace', workspace);
  if (operation === 'list') return readRecords(db, args);
  if (operation === 'get') return getRecord(db, args.id, args.options);
  if (operation === 'getStores') {
    const records = readRecords(db, { workspace: args.workspace, includeInactive: true });
    return { global: { ...emptyStore(), memories: records.filter(m => m.scope !== 'workspace') },
      local: { ...emptyStore(), memories: records.filter(m => m.scope === 'workspace') },
      localPath: workspaceMemoryPath(args.workspace, options.zagentDir) };
  }
  if (operation === 'upsert') {
    const record = normalizeRecord(args.input, args.options);
    if (!record) return { ok: false, code: 'INVALID_MEMORY', error: 'Memory was empty, unsafe, or missing its workspace/task identity.' };
    if (record.type === 'work_state') record.key = 'work.state.current';
    const samePartition = readRecords(db, { workspace: record.workspace, sessionId: record.sessionId,
      conversationRevision: record.conversationRevision, includeInactive: true })
      .filter(m => m.scope === record.scope && normalizeWorkspace(m.workspace) === normalizeWorkspace(record.workspace));
    const blocked = samePartition.find(m => ['deleted','disabled'].includes(m.status) && m.removalReason !== 'source_rollback' && (
      (record.key && m.key === record.key) || normalizeText(m.content) === normalizeText(record.content)));
    if (blocked) return { ok: false, code: 'MEMORY_SUPPRESSED', error: 'This memory has been disabled or deleted.', memory: blocked };
    if (record.type === 'work_state') {
      const newer = samePartition.find(m => m.type === 'work_state' && m.status === 'active'
        && Number(m.runStartedAt || 0) > record.runStartedAt);
      if (newer) return { ok: false, code: 'STALE_MEMORY_WRITE', error: 'A newer task state already exists.', memory: newer };
    }
    if (record.source.sessionId) {
      const newerFact = samePartition.find(memory => memory.status === 'active'
        && ((record.key && memory.key === record.key) || normalizeText(memory.content) === normalizeText(record.content))
        && [memory.source, memory.contentSource, ...(memory.sources || [])].some(source => (
          source?.sessionId === record.source.sessionId
          && Number(source.conversationRevision || 0) === record.conversationRevision
          && Number(source.runStartedAt || 0) > record.runStartedAt
        )));
      if (newerFact) return { ok: false, code: 'STALE_MEMORY_WRITE', error: 'A newer observation from this task already exists.', memory: newerFact };
    }
    const previous = new Map(samePartition.map(memory => [memory.id, JSON.stringify(memory)]));
    const result = upsertIntoStore({ memories: samePartition }, record);
    for (const memory of result.store.memories) {
      if (previous.get(memory.id) !== JSON.stringify(memory)) saveRecord(db, memory);
    }
    return { ok: true, action: result.action, memory: result.memory };
  }
  if (operation === 'query') {
    const normalizedQuery = normalizeText(args.query), queryTokens = tokenize(normalizedQuery);
    const candidates = readRecords(db, { ...args, includeInactive: false, includeSuperseded: false }).filter(memory => (
      !(args.excludeSourceKinds || []).some(kind => [memory.source, ...(memory.sources || [])].some(source => source?.kind === kind))
      && !containsUnsafeMemoryText(memory.content) && !containsSensitiveMemoryText(memory.content)
      && (!memory.evidence || (!containsUnsafeMemoryText(memory.evidence) && !containsSensitiveMemoryText(memory.evidence)))
      && beforeCutoff(memory, args)
      && (memory.type !== 'work_state' || (args.sessionId && memory.sessionId === args.sessionId
        && memory.conversationRevision === Math.max(0, Math.floor(Number(args.conversationRevision) || 0))))
    ));
    const always = [
      ...candidates.filter(m => m.type === 'work_state').sort((a,b) => b.runStartedAt - a.runStartedAt).slice(0,1),
      ...candidates.filter(m => m.scope === 'global' && m.type === 'preference' && m.confidence >= 0.75).slice(0,4)
    ].map(m => ({ ...m, relevance: 100 }));
    const ftsTokens = queryTokens.filter(t => !RETRIEVAL_STOP_TOKENS.has(t)).slice(0,40), ranks = new Map();
    if (ftsTokens.length) {
      const expression = ftsTokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      db.prepare(`SELECT memory_id,bm25(memories_fts) rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 240`)
        .all(expression).forEach((m,index) => ranks.set(m.memory_id, 0.8 / (1 + index * 0.05)));
    }
    const limit = Math.max(1, Math.min(30, Number(args.limit) || 12)), alwaysIds = new Set(always.map(m => m.id));
    const boosted = args.boostRunIds instanceof Set ? args.boostRunIds : new Set(args.boostRunIds || []);
    const scored = candidates.filter(m => !alwaysIds.has(m.id) && m.type !== 'work_state').map(memory => {
      const bonus = [memory.source, ...(memory.sources || [])].some(s => boosted.has(s?.runId)) ? 0.4 : 0;
      return { ...memory, relevance: scoreMemory(memory, queryTokens, normalizedQuery, args.workspace) + (ranks.get(memory.id) || 0) + bonus };
    }).filter(m => queryTokens.length && m.relevance >= 2.6).sort((a,b) => b.relevance-a.relevance || b.updatedAt-a.updatedAt);
    const selected = [...always,...scored].slice(0,limit), memories = [];
    const maxChars = Math.max(600,Math.min(12000,Number(args.maxChars) || DEFAULT_MAX_CONTEXT_CHARS));
    // Only expose records that were actually placed in the context budget.
    for (const memory of selected) {
      const next = formatContext([...memories,memory],maxChars);
      if (!next || next === formatContext(memories,maxChars)) break;
      memories.push(memory);
    }
    return { memories, context: formatContext(memories,maxChars), total: candidates.length, retrieval: 'sqlite-fts5-keywords' };
  }
  if (['update','setStatus','remove'].includes(operation)) {
    const memory = getRecord(db,args.id,args.options);
    if (!memory) return { ok:false,code:'MEMORY_NOT_FOUND',error:'Memory not found in this task or workspace.' };
    if (operation === 'update') {
      const patch = args.patch || {};
      const allowed = Object.fromEntries(['content','evidence','keywords','confidence'].filter(k => k in patch).map(k => [k,patch[k]]));
      if (Object.keys(allowed).length) {
        const checked = normalizeRecord({ ...memory,...allowed }, { ...memory.source,workspace:memory.workspace,
          sessionId:memory.sessionId || memory.source?.sessionId });
        if (!checked) return { ok:false,code:'INVALID_MEMORY',error:'Memory content is empty, unsafe, or sensitive.' };
        for (const key of ['content','evidence','keywords','confidence']) memory[key] = checked[key];
        memory.editedAt = Date.now();
        memory.contentUpdatedAt = memory.editedAt;
        memory.contentSource = { ...memory.source, kind: 'manual_edit',
          sessionId: clip(args.options?.sessionId || memory.source?.sessionId, 120),
          runStartedAt: memory.editedAt,
          conversationRevision: Math.max(0, Number(args.options?.conversationRevision ?? memory.conversationRevision) || 0) };
        if (memory.type === 'work_state') {
          memory.runStartedAt = memory.editedAt;
          // A manually rewritten summary is authoritative. Its old structured
          // goal/constraints must not contradict it in the Observer prompt.
          if (Object.hasOwn(allowed, 'content')) delete memory.taskState;
        }
      }
    }
    const status = operation === 'remove' ? 'deleted' : operation === 'setStatus' ? args.status : args.patch?.status;
    if (status !== undefined) {
      if (!['active','disabled','deleted'].includes(status)) return { ok:false,error:'Invalid memory status.' };
      if (status === 'active' && memory.type === 'work_state' && !memory.sessionId) return { ok:false,error:'Legacy task state has no task identity.' };
      if (status === 'active' && memory.status === 'superseded') return { ok:false,error:'A superseded memory cannot replace its correction.' };
      if (status === 'active' && memory.key) {
        const current = readRecords(db, { workspace: memory.workspace, sessionId: memory.sessionId,
          conversationRevision: memory.conversationRevision }).find(other => other.id !== memory.id
          && other.scope === memory.scope && other.key === memory.key);
        if (current) return { ok:false,code:'MEMORY_CONFLICT',error:'A newer active memory already occupies this key.' };
      }
      memory.status = status;
    }
    memory.updatedAt = Date.now(); saveRecord(db,memory); return { ok:true,memory };
  }
  if (operation === 'maintain') {
    const now = Number(args.now) || Date.now();
    const records = readRecords(db, args).filter(memory => memory.type !== 'work_state'
      && memory.type !== 'preference' && now - Number(memory.metadata?.decayedAt || 0) >= 24 * 60 * 60 * 1000);
    const { planDecay, applyDecay } = require('./agi/memory-consolidation');
    const plan = planDecay(records, { now });
    const updatedIds = new Set(plan.items.map(item => item.id));
    const result = applyDecay({ memories: records }, plan, { now });
    for (const memory of records) if (updatedIds.has(memory.id)) saveRecord(db, memory);
    return result;
  }
  if (operation === 'removeBySource') {
    const selectors = ['refinementId','runId','sessionId'].filter(key => args[key]);
    if (!selectors.length) return { removed:0 };
    const records = readRecords(db,{ ...args,includeInactive:true }), removedActiveIds = new Set();
    let removed = 0;
    for (const memory of records) {
      if (memory.status === 'deleted') continue;
      const sources = memory.sources?.length ? memory.sources : [memory.source || {}];
      const retained = sources.filter(source => !selectors.every(key => source[key] === args[key]));
      if (retained.length === sources.length) continue;
      if (!retained.length) {
        if (memory.status === 'active') removedActiveIds.add(memory.id);
        memory.status = 'deleted'; memory.removalReason = 'source_rollback'; removed++;
      } else { memory.sources = retained; memory.source = retained.at(-1); memory.occurrences = retained.length; }
      memory.updatedAt = Date.now(); saveRecord(db,memory);
    }
    for (const memory of records) {
      if (memory.status === 'superseded' && removedActiveIds.has(memory.supersededBy)) {
        memory.status = 'active'; delete memory.supersededBy; memory.updatedAt = Date.now(); saveRecord(db,memory);
      }
    }
    return { removed };
  }
  if (operation === 'clear') {
    const scope = args.scope || 'all';
    for (const memory of readRecords(db,{ ...args,includeInactive:true })) {
      if (scope !== 'all' && memory.scope !== scope) continue;
      memory.status = 'deleted'; memory.updatedAt = Date.now(); saveRecord(db,memory);
    }
    return true;
  }
  throw new Error(`Unknown memory store operation: ${operation}`);
}

class LongTermMemoryStore {
  constructor({ globalPath,dbPath,zagentDir='.zagent',appRoot,forceWorker=false } = {}) {
    if (!dbPath && !globalPath) throw new Error('A memory database path is required.');
    this.globalPath = globalPath || '';
    this.dbPath = dbPath || path.join(path.dirname(globalPath),'memory.sqlite');
    this.zagentDir = zagentDir;
    this.options = { globalPath:this.globalPath,zagentDir,appRoot,forceWorker };
  }
  _run(operation,args={}) { return executeMemoryOperation(this.dbPath,`store.${operation}`,args,this.options); }
  getStores(workspace) { return this._run('getStores',{ workspace }); }
  list(options={}) { return this._run('list',options); }
  upsert(input,options={}) { return this._run('upsert',{ input,options }); }
  query(options={}) { return this._run('query',options); }
  removeBySource(options={}) { return this._run('removeBySource',options); }
  clear(options={}) { return this._run('clear',options); }
  get(id,options={}) { return this._run('get',{ id,options }); }
  update(id,patch,options={}) { return this._run('update',{ id,patch,options }); }
  setStatus(id,status,options={}) { return this._run('setStatus',{ id,status,options }); }
  remove(id,options={}) { return this._run('remove',{ id,options }); }
  maintain(options={}) { return this._run('maintain',options); }
}

module.exports = {
  LongTermMemoryStore,
  executeStoreOperation,
  MEMORY_VERSION,
  containsUnsafeMemoryText,
  containsSensitiveMemoryText,
  formatContext,
  migrateLegacyStore,
  normalizeRecord,
  normalizeWorkspace,
  scoreMemory,
  tokenize,
  upsertIntoStore,
  workspaceMemoryPath
};
