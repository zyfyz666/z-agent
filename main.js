const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, webContents, screen, session, clipboard, globalShortcut, safeStorage, net: electronNet } = require('electron');
const { configureSoftwareRendering, createRendererHealthLog, attachProcessHealthLogging, attachRendererRecovery } = require('./lib/renderer-recovery');
configureSoftwareRendering(app);
const path = require('path');
const os = require('os');
const storageLayout = require('./lib/storage-layout');
const { agiEnabled, evolutionEnabled, isolateWorkMode } = require('./lib/work-mode-isolation');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { pathToFileURL } = require('url');
const { execFile, spawn } = require('child_process');
const { fetchRemoteModelCatalog, normalizeRemoteModels } = require('./lib/model-catalog');
const {
  GLM_OFFICIAL_SUPPLEMENTAL_MODELS,
  SENSENOVA_OFFICIAL_SUPPLEMENTAL_MODELS,
  buildSelectableModelCatalog,
  summarizeModelCatalog
} = require('./lib/provider-model-catalog');
const {
  decorateModels,
  resolveModelCapabilities,
  resolveImageGenerationConfig,
  resolveVideoGenerationConfig
} = require('./lib/model-capabilities');
const {
  AGNES_FALLBACK_MODELS,
  DEFAULT_MODEL_ROLES,
  VISION_RELAY_MODELS_BY_PRESET,
  VISION_RELAY_PRESET_ORDER,
  buildMediaModelList,
  buildQuickSupplierGroups,
  configuredSupplierModels,
  getModelType
} = require('./lib/model-roles');
const { detectImageType, generateImage } = require('./lib/image-generation');
const { generateVideo } = require('./lib/video-generation');
const { buildScreenshotRelayInput, describeImages, isRecoverableVisionRelayError } = require('./lib/vision-relay');
const { createTextToSpeech, normalizeVoice, normalizeRate } = require('./lib/text-to-speech');
const { analyzeWallpaperSource } = require('./lib/wallpaper-analysis');
const {
  filterReviewSummary,
  mergeChangeHistory,
  summarizeOpenCodeDiffs,
  summarizeRunChanges
} = require('./lib/run-change-summary');
const {
  evaluateSessionDeletion,
  findReusableBlankSession,
  isBlankUnassignedNewChat,
  isDefaultSessionTitle
} = require('./lib/session-policy');
const {
  contentToText,
  createHandoffPackage,
  findLatestWorkspaceSession,
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspacePath,
  sameWorkspace
} = require('./lib/session-handoff');
const { taskWorkspaceRoot, ensureTaskWorkspace, legacyRuntimeWorkspace } = require('./lib/task-workspace');
const { sessionModelSnapshot, inferSessionModelSelection, createSessionWriteQueue } = require('./lib/session-model');
const { normalizeBrowserSessionState } = require('./lib/browser-session-state');
const { pruneZagentEvidence } = require('./lib/zagent-evidence');
const skillRegistry = require('./lib/skill-registry');
const codeGraphRuntime = require('./lib/codegraph-runtime');
const { plansRoot, writePlanDocument } = require('./lib/plan-document');
const understandAnythingRuntime = require('./lib/understand-anything-runtime');
const { LongTermMemoryStore, tokenize: tokenizeMemoryText } = require('./lib/long-term-memory');
const { SkillEvolutionStore } = require('./lib/skill-evolution');
const { ContinualHarnessStore } = require('./lib/continual-harness');
const { createUtilityLedger } = require('./lib/agi/utility');
const { createTrajectoryStore } = require('./lib/agi/trajectory');
const { loadProtocol, readProtocol, renderProtocolPrompt } = require('./lib/agi/long-horizon');
const { checkConsistency } = require('./lib/agi/skill-guards');
const { sidepathCeiling, summarizeSidepath } = require('./lib/agi/reasoning-sidepath');
const { createExperienceGraph, distillOutcome } = require('./lib/agi/memory-consolidation');
const { evaluateSkillCandidate, SKILL_VALIDATION_SUITE_ID } = require('./lib/agi/eval');
const {
  collectExperienceEdgeContext,
  collectWorkflowProposals,
  createEscalationMemo,
  createVerifiedRunIndex,
  maintainMemoryStore,
  raiseReasoningSpeed,
  recordTopologyOutcome,
  selectTopologyForRun,
  verifiedRunsFromTrajectories
} = require('./lib/agi/runtime-bridge');
const { deliveryContractId, deliveryReviewInstructions, deliveryVisualPrompt } = require('./lib/delivery-policy');
const {
  derivePolicyControls,
  extractExplicitPolicyInstruction,
  policyId
} = require('./lib/behavior-policy');
const updateChecker = require('./lib/update-checker');
const { detectVsCode, launchVsCode } = require('./lib/vscode-launcher');
const { resolveWindowsPowerShell } = require('./lib/powershell-resolver');
const crypto = require('crypto');
const { normalizeObserverSettings, completionInput, completionSettings, reviewCompletion } = require('./lib/observer-model');
const { normalizeOutputTokens, validateOutputTokens } = require('./lib/model-output-limits');
const { forkBoundary, createSessionForkRecord, isAuthoritativeHistorySession, preserveForkAuthority, forkRunContext } = require('./lib/session-fork');
const { sessionConversationRevision, assertConversationRevision, rewindBoundary, createRewindBackup,
  restoreRewindSnapshot, createRewoundSession } = require('./lib/session-rewind');
const workspaceSandbox = require('./lib/workspace-sandbox');
const { classifyDelegatedShellCommand } = require('./lib/shell-command-risk');
const {
  OpenCodeSidecar,
  buildOpenCodeConfig,
  DEFAULT_INPUT_TOKENS_PER_SECOND,
  normalizeInputTokensPerSecond,
  stageDeepSeekProviderModule,
  stageCodingEnvironmentModule,
  stageGlmmProviderModule,
  stageQwemProviderModule,
  stageKimlProviderModule,
  stageGptlProviderModule,
  stageResponsesProviderModule,
  OPENCODE_VERSION,
  normalizeSubagentRoles,
  isSelectedSkillReadOnlyRequest,
  openCodeErrorDetail
} = require('./lib/opencode-sidecar');
const {
  isTrustworthyMeasurement,
  measurementKey,
  normalizeMeasurementStore,
  smoothMeasurement
} = require('./lib/input-throughput');
const { isRemoteMcpServer, normalizeRemoteHeaders, probeRemoteServer } = require('./lib/mcp-remote');
const {
  CONNECTION_PRESETS,
  inferConnectionPreset,
  normalizeApiFormat,
  normalizeConnectionStore,
  resolveConnectionApiFormat,
  resolveConnectionPreset
} = require('./lib/connection-presets');
const { OpenCodeEventBatcher } = require('./lib/open-code-stream');
const { recordReconcileEvent, watchdogReplay } = require('./lib/wd-replay-state');
const { normalizeReasoningSpeed, reasoningSpeedEnablesThinking } = require('./lib/reasoning-effort');
const { createSerenaServer } = require('./lib/serena-runtime');
const gitService = require('./lib/git-service');
const { projectReviewSummary } = require('./lib/review-data');
const { runReviewTask } = require('./lib/review-worker');
const worktreeService = require('./lib/worktree-service');
const ghService = require('./lib/gh-service');
const { buildRepoMapBackground } = require('./lib/analysis/repo-map-background');
const { ZCore, OpenCodeProviderAdapter, ResourceLockManager, registerAdapter } = require('./lib/z-core');
const { writeAtomic } = require('./lib/z-core/store');
const {
  DEFAULT_CONTEXT_SETTINGS,
  normalizeContextSettings
} = require('./lib/context-settings');
const { migrateVisionRelaySwitch } = require('./lib/vision-relay-switch');

const appRoot = __dirname;

// Real desktop E2E runs must never read or mutate the user's live sessions.
// This opt-in hook is inert in production and is set before any storage path
// is captured below, so Electron, ZData, and Chromium partitions are all
// isolated together.
const e2eUserDataDir = String(process.env.Z_E2E_USER_DATA_DIR || '').trim();
if (e2eUserDataDir) {
  fs.mkdirSync(e2eUserDataDir, { recursive: true });
  app.setPath('userData', path.resolve(e2eUserDataDir));
} else if (typeof app.setPath === 'function' && typeof app.getPath === 'function') {
  // One profile for source and packaged runs on every platform, independent
  // of the package name Electron would otherwise derive it from.
  const userDataDir = path.join(app.getPath('appData'), 'Z');
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
}
if (typeof app.setName === 'function') app.setName('Z');

const isE2EMode = process.env.Z_E2E_MODE === '1';
const e2eParentPid = isE2EMode
  ? Number.parseInt(process.env.Z_E2E_PARENT_PID || String(process.ppid), 10)
  : 0;
let e2eParentWatchdog = null;
let e2eOrphanShutdownStarted = false;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled by this process.
    return error?.code === 'EPERM';
  }
}

function startE2EParentWatchdog() {
  if (!isE2EMode || e2eParentWatchdog || !Number.isInteger(e2eParentPid) || e2eParentPid <= 0) return;
  e2eParentWatchdog = setInterval(() => {
    if (e2eOrphanShutdownStarted || isProcessAlive(e2eParentPid)) return;
    e2eOrphanShutdownStarted = true;
    clearInterval(e2eParentWatchdog);
    e2eParentWatchdog = null;
    console.error(`[E2E] Parent process ${e2eParentPid} exited; shutting down orphaned Z runtime.`);
    app.quit();
    const forcedExit = setTimeout(() => app.exit(0), 3_000);
    forcedExit.unref?.();
  }, 1_000);
  e2eParentWatchdog.unref?.();
}

startE2EParentWatchdog();

let openCodeSidecar = null;
const openCodeActiveRuns = new Map();
// Runs reserve a slot before the async admission path creates the active-run
// record. Keep the target session with that reservation so session deletion
// cannot race through this short but real window.
const openCodeRunAdmissions = new Map(); // runId -> zSessionId
const MAX_CONCURRENT_AGENT_RUNS = 3;
const OPENCODE_IDLE_RELEASE_MS = Math.max(1_000, Number(process.env.Z_OPENCODE_IDLE_RELEASE_MS) || 5 * 60_000);
let openCodeIdleReleaseTimer = null;
let openCodePrewarmPromise = null;
let openCodeBackgroundLeases = 0;
const browserAgentToolClaims = new Map();
const sessionAgentToolClaims = new Map();
let zCore = null;
let openCodeProviderAdapter = null;
const resourceLocks = new ResourceLockManager({ maxWaiters: 256 });

let mainWindow = null;
const openCodeEventBatcher = new OpenCodeEventBatcher({
  flushIntervalMs: 16,
  onBatch(runId, events) {
    if (!mainWindow || mainWindow.isDestroyed() || !mainRendererReady || !events.length) return;
    mainWindow.webContents.send('opencode:event-batch', { runId, events });
  },
  onSlowConsumer(runId, info) {
    console.warn(`[opencode] slow renderer consumer for run ${runId}: dropped ${info.droppedTotal} buffered delta(s)`);
    try { zCore?.recordBackpressure(runId, info); } catch (error) {
      console.warn('[z-core] backpressure telemetry failed:', error?.message || error);
    }
    if (!mainWindow || mainWindow.isDestroyed() || !mainRendererReady) return;
    mainWindow.webContents.send('opencode:event', {
      runId,
      event: { type: 'z.opencode.slow-consumer', data: info }
    });
  }
});

function sendOpenCodeRendererEvent(runId, event) {
  try { zCore?.ingestProviderEvent(runId, event); } catch (error) {
    console.warn('[z-core] provider event ingestion failed:', error?.message || error);
  }
  recordOpenCodeReconcileEvent(runId, event);
  if (!mainWindow || mainWindow.isDestroyed() || !mainRendererReady) {
    openCodeEventBatcher.flush(runId);
    return;
  }
  if (openCodeEventBatcher.push(runId, event)) return;
  openCodeEventBatcher.flush(runId);
  mainWindow.webContents.send('opencode:event', { runId, event });
}

// ---------------------------------------------------------------------------
// OpenCode run reconciliation: keep a recent per-run event log so a reloaded
// renderer can catch up on runs that are still executing (or just finished)
// inside the kernel instead of losing them forever.
// ---------------------------------------------------------------------------
const OPENCODE_RECONCILE_EVENT_CAP = 400;
const OPENCODE_RECONCILE_COMPLETED_TTL_MS = 60_000;
const openCodeRunReconcile = new Map(); // runId -> { meta, events, watchdogStatus, completed, completedAt }

function ensureOpenCodeReconcileRun(runId, meta = {}) {
  const id = String(runId || '');
  if (!id || openCodeRunReconcile.has(id)) return openCodeRunReconcile.get(id);
  const entry = {
    meta: {
      zSessionId: String(meta.zSessionId || ''),
      workspace: String(meta.workspace || ''),
      startedAt: Number(meta.startedAt) || Date.now()
    },
    events: [],
    watchdogStatus: null,
    completed: null,
    completedAt: 0
  };
  openCodeRunReconcile.set(id, entry);
  return entry;
}

function recordOpenCodeReconcileEvent(runId, event) {
  const entry = openCodeRunReconcile.get(String(runId || ''));
  recordReconcileEvent(entry, event, { runId, cap: OPENCODE_RECONCILE_EVENT_CAP });
}

function completeOpenCodeReconcileRun(runId, completedResult) {
  const entry = openCodeRunReconcile.get(String(runId || ''));
  if (!entry || entry.completed) return;
  entry.completed = completedResult || null;
  entry.completedAt = Date.now();
  const expireWhenVisible = () => {
    // A crashed view can remain on its recovery page until the user returns.
    // Keep the completed result for that view to reconcile when it reopens.
    if (mainRendererReady) openCodeRunReconcile.delete(String(runId));
    else {
      const retry = setTimeout(expireWhenVisible, OPENCODE_RECONCILE_COMPLETED_TTL_MS);
      retry.unref?.();
    }
  };
  const timer = setTimeout(expireWhenVisible, OPENCODE_RECONCILE_COMPLETED_TTL_MS);
  timer.unref?.();
}

function flushOpenCodeRendererEvents(runId) {
  openCodeEventBatcher.flush(runId);
}

// ---------------------------------------------------------------------------
// Interrupted-run recovery: Z Core journals every provider event that fed
// the renderer, so a Turn that died with the previous process can be replayed
// from disk instead of vanishing from the session UI.
// ---------------------------------------------------------------------------
const OPENCODE_RECOVERY_MAX_RUNS = 3;
const OPENCODE_RECOVERY_MAX_EVENTS_PER_RUN = 8_000;
const OPENCODE_RECOVERY_MAX_BYTES_PER_RUN = 8 * 1024 * 1024;
const OPENCODE_RECOVERY_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

// Rebuild the exact renderer-facing event from one journal entry. Mapped
// provider events keep their original payload under `raw`; lifecycle entries
// and payloads flattened by the protocol size guard are not replayable.
function recoveryRendererEvent(coreEvent) {
  const payload = coreEvent?.payload;
  if (!payload || typeof payload !== 'object' || !payload.rawType) return null;
  const raw = payload.raw;
  if (raw && typeof raw === 'object' && typeof raw.type === 'string' && raw.type) return raw;
  if (payload.data && typeof payload.data === 'object') {
    return { type: String(payload.rawType), data: payload.data };
  }
  return null;
}

function recoveringCoreTurns(core = zCore) {
  try {
    const turns = core?.getState?.()?.turns;
    if (!turns || typeof turns !== 'object') return [];
    return Object.values(turns)
      .filter(turn => turn && String(turn.status || '') === 'recovering')
      .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0));
  } catch (error) {
    console.warn('[opencode] recovering Turn lookup failed:', error?.message || error);
    return [];
  }
}

function buildRecoveredRunDescriptors(runIds = [], core = zCore) {
  const requested = new Set((Array.isArray(runIds) ? runIds : []).map(id => String(id || '')).filter(Boolean));
  const turns = recoveringCoreTurns(core).filter(turn => !requested.size || requested.has(String(turn.id)));
  const descriptors = [];
  if (!turns.length) return descriptors;
  // One journal read for every recovering Turn: the file can be tens of
  // megabytes, and re-parsing it per Turn would stall startup after a crash.
  const journalEvents = typeof core.readJournalEvents === 'function' ? core.readJournalEvents() : null;
  let totalBytes = 0;
  for (const turn of turns.slice(0, OPENCODE_RECOVERY_MAX_RUNS)) {
    const journal = core.listTurnEvents(turn.id, {
      maxEvents: OPENCODE_RECOVERY_MAX_EVENTS_PER_RUN,
      events: journalEvents
    });
    const events = [];
    let bytes = 0;
    let dropped = 0;
    // Newest events first while budgeting: the tail is what the user last saw.
    for (let index = journal.events.length - 1; index >= 0; index -= 1) {
      const rendererEvent = recoveryRendererEvent(journal.events[index]);
      // Lifecycle/telemetry entries are expected and not replayable; they are
      // not recoverable content and must not mark the slice as truncated.
      if (!rendererEvent) continue;
      const estimated = JSON.stringify(rendererEvent)?.length || 0;
      if (estimated > OPENCODE_RECOVERY_MAX_BYTES_PER_RUN) {
        dropped += 1;
        continue;
      }
      if (bytes + estimated > OPENCODE_RECOVERY_MAX_BYTES_PER_RUN
        || totalBytes + estimated > OPENCODE_RECOVERY_MAX_TOTAL_BYTES) {
        dropped += index + 1;
        break;
      }
      events.push(rendererEvent);
      bytes += estimated;
      totalBytes += estimated;
    }
    events.reverse();
    const thread = core.getThread?.(turn.threadId) || null;
    descriptors.push({
      runId: String(turn.id || ''),
      zSessionId: String(turn.threadId || ''),
      workspace: String(thread?.workspace || ''),
      startedAt: Number(turn.startedAt) || Number(turn.createdAt) || 0,
      lastEventAt: Number(journal.lastTimestamp) || Number(turn.updatedAt) || 0,
      configSnapshot: turn.configSnapshot && typeof turn.configSnapshot === 'object' ? turn.configSnapshot : {},
      intent: turn.intent && typeof turn.intent === 'object' ? { prompt: String(turn.intent.prompt || '') } : {},
      events,
      journalEvents: journal.total,
      truncated: journal.truncated === true || dropped > 0
    });
  }
  return descriptors;
}
let mainRendererReady = false;
let splashWindow = null;
let splashStartedAt = 0;
let splashCloseTimer = null;
let mainWindowReadyForSplash = false;
const SPLASH_DURATION_MS = 3000;
let quickInputWindow = null;
let quickInputGlowWindow = null;
let quickInputGlowDisplayId = null;
let quickInputActive = false;
let registeredQuickInputShortcut = '';
const DEFAULT_QUICK_INPUT_SHORTCUT = 'CommandOrControl+Shift+Y';
let petWindow = null;
let tray = null;
let isQuiting = false;
let petState = {
  status: 'idle',
  sessionId: null,
  running: false,
  title: 'Z',
  message: '随时待命'
};
const PET_IDS = Object.freeze(['orb', 'yuexinmiao', 'deepseek', 'claude']);
const PET_LABELS = Object.freeze({
  orb: 'Z Orb',
  yuexinmiao: '月薪猫',
  deepseek: '大烧货',
  claude: 'claude'
});
let activePetId = 'orb';
const activeImageGenerations = new Map();
const activeVideoGenerations = new Map();
const generatedImages = new Map();
const generatedImageViewers = new Map();
const BROWSER_PARTITION = storageLayout.browserPartition(app.getPath('userData'));
ipcMain.on('browser:partition', event => { event.returnValue = BROWSER_PARTITION; });
const configuredBrowserGuestIds = new Set();
const browserAgentBridgeToken = crypto.randomBytes(32).toString('hex');
const browserAgentBridgePending = new Map();
const BROWSER_AGENT_BRIDGE_MAX_BYTES = 16 * 1024 * 1024;
const BROWSER_AGENT_BRIDGE_ACTIONS = new Set([
  'open',
  'snapshot',
  'read_page',
  'click',
  'type',
  'select',
  'check',
  'hover',
  'focus',
  'drag',
  'pointer',
  'press',
  'scroll',
  'wait',
  'screenshot',
  'inspect_page',
  'apply_annotation',
  'back',
  'forward',
  'reload',
  'status'
]);
const OPEN_CODE_BROWSER_TOOL_ACTIONS = Object.freeze({
  open_builtin_browser: 'open',
  browser_snapshot: 'snapshot',
  browser_read_page: 'read_page',
  browser_click: 'click',
  browser_type: 'type',
  browser_select: 'select',
  browser_check: 'check',
  browser_hover: 'hover',
  browser_focus: 'focus',
  browser_drag: 'drag',
  browser_pointer: 'pointer',
  browser_press: 'press',
  browser_scroll: 'scroll',
  browser_wait: 'wait',
  browser_screenshot: 'screenshot',
  browser_inspect_page: 'inspect_page',
  browser_apply_annotation: 'apply_annotation',
  browser_status: 'status'
});
let browserAgentBridgeServer = null;
let browserAgentBridgePort = 0;
const sessionAgentBridgeToken = crypto.randomBytes(32).toString('hex');
const sessionAgentBridgePending = new Map();
const SESSION_AGENT_BRIDGE_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_AGENT_ACTIONS = new Set(['create_handoff', 'read_source_context']);
const OPEN_CODE_SESSION_TOOL_ACTIONS = Object.freeze({
  z_session_create_handoff: 'create_handoff',
  z_session_read_source_context: 'read_source_context'
});
let sessionAgentBridgeServer = null;
let sessionAgentBridgePort = 0;

function browserActionForOpenCodeTool(toolName, input = {}) {
  const raw = String(toolName || '').toLowerCase();
  const localName = raw.startsWith('z_browser_') ? raw.slice('z_browser_'.length) : raw;
  if (localName === 'browser_history') {
    const historyAction = String(input.action || '').toLowerCase();
    return BROWSER_AGENT_BRIDGE_ACTIONS.has(historyAction) ? historyAction : '';
  }
  return OPEN_CODE_BROWSER_TOOL_ACTIONS[localName] || '';
}

function trackBrowserAgentToolClaim(runId, event = {}) {
  const activeRunId = String(runId || '');
  if (!activeRunId || !openCodeActiveRuns.has(activeRunId)) return;
  const data = event?.data || event?.properties || {};
  let callId = '';
  let toolName = '';
  let input = {};
  let finished = false;
  if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
    const part = data.part || {};
    if (part.type !== 'tool') return;
    callId = String(part.callID || part.id || '');
    toolName = String(part.tool || '');
    input = part.state?.input && typeof part.state.input === 'object' ? part.state.input : {};
    finished = part.state?.status === 'completed' || part.state?.status === 'error';
  } else if (event.type === 'session.next.tool.called') {
    callId = String(data.callID || '');
    toolName = String(data.tool || '');
    input = data.input && typeof data.input === 'object' ? data.input : {};
  } else if (event.type === 'session.next.tool.success' || event.type === 'session.next.tool.failed') {
    callId = String(data.callID || '');
    finished = true;
  } else {
    return;
  }
  if (!callId) return;
  if (finished) {
    browserAgentToolClaims.delete(callId);
    return;
  }
  const action = browserActionForOpenCodeTool(toolName, input);
  if (!action) return;
  browserAgentToolClaims.set(callId, { runId: activeRunId, action, createdAt: Date.now() });
}

function clearBrowserAgentToolClaims(runId) {
  const target = String(runId || '');
  for (const [callId, claim] of browserAgentToolClaims) {
    if (!target || claim.runId === target) browserAgentToolClaims.delete(callId);
  }
}

function consumeBrowserAgentToolClaim(action) {
  const now = Date.now();
  for (const [callId, claim] of browserAgentToolClaims) {
    if (now - claim.createdAt > 30_000 || !openCodeActiveRuns.has(claim.runId)) {
      browserAgentToolClaims.delete(callId);
      continue;
    }
    if (claim.action !== action) continue;
    browserAgentToolClaims.delete(callId);
    return claim.runId;
  }
  return '';
}

function resolveAuthoritativeBrowserRun(action, params = {}) {
  const claimedRunId = consumeBrowserAgentToolClaim(action);
  if (claimedRunId) return { ok: true, runId: claimedRunId };
  const requestedRunId = String(params.z_run_id || '');
  if (requestedRunId && openCodeActiveRuns.has(requestedRunId)) {
    return { ok: true, runId: requestedRunId };
  }
  const activeRunIds = [...openCodeActiveRuns.keys()];
  if (activeRunIds.length === 1) return { ok: true, runId: activeRunIds[0] };
  if (process.env.Z_E2E_MODE === '1' && requestedRunId) return { ok: true, runId: requestedRunId };
  if (!activeRunIds.length) {
    return { ok: false, error: '当前没有可接管内置浏览器的 Agent 任务。', code: 'BROWSER_RUN_NOT_ACTIVE' };
  }
  return { ok: false, error: '多个 Agent 任务同时运行，当前浏览器调用缺少权威任务归属。', code: 'BROWSER_RUN_CONTEXT_AMBIGUOUS' };
}

function plainBrowserBridgeError(error, fallback = 'Z 内置浏览器连接失败。') {
  return {
    ok: false,
    error: error?.message || String(error || fallback),
    code: error?.code || 'Z_BROWSER_BRIDGE_FAILED'
  };
}

async function relayBrowserScreenshotForTextModel(result, runId, params = {}) {
  if (!result?.ok || !result.image?.data || !result.image?.mimeType) return result;
  const activeRun = openCodeActiveRuns.get(String(runId || ''));
  const deliveryContract = activeRun?.deliveryContract;
  const question = String(params?.question || '').trim().slice(0, 600);
  const previousFrame = activeRun?.lastBrowserScreenshot?.data ? activeRun.lastBrowserScreenshot : null;
  if (activeRun) {
    // Keep exactly one previous frame per run so a later screenshot can ask
    // for a before/after comparison without reopening the browser panel.
    activeRun.lastBrowserScreenshot = {
      mimeType: String(result.image.mimeType),
      data: String(result.image.data),
      capturedAt: Date.now()
    };
  }
  const relayInput = buildScreenshotRelayInput({
    basePrompt: deliveryVisualPrompt(activeRun?.prompt, deliveryContract),
    question,
    compare: params?.compare_to_previous === true,
    previous: previousFrame,
    current: { mimeType: result.image.mimeType, data: result.image.data }
  });
  result = {
    ...result,
    ...(question ? { focusQuestion: question } : {}),
    comparedWithPrevious: relayInput.withPrevious,
    previousFrameAvailable: !!previousFrame
  };
  if (deliveryContract) {
    result = { ...result, deliveryContract, deliveryContractId: deliveryContractId(deliveryContract),
      deliveryReviewInstructions: deliveryReviewInstructions(deliveryContract) };
  }
  const cfg = loadConfig();
  const selection = activeRun?.selection || normalizeAgentModelSelection(cfg);
  // Same user override as relayImagesForTextModel: when the relay is disabled
  // the screenshot goes to the main model as-is.
  if (selection.capabilities?.imageInput || cfg.api?.visionRelayEnabled === false) return result;
  if (cfg.permissions?.allowNetwork === false) {
    return {
      ...result,
      visualEvidence: { available: false, error: '当前已关闭网络权限，无法使用视觉中继读取浏览器截图。' }
    };
  }
  const attempts = getVisionRelayModels(cfg);
  if (!attempts.length) {
    return {
      ...result,
      visualEvidence: { available: false, error: '未配置可用的 GLM、SenseNova、Agnes 或硅基流动视觉中继模型，当前文本模型无法读取浏览器截图。' }
    };
  }
  let lastError = null;
  for (const [index, model] of attempts.entries()) {
    try {
      const described = await describeImages({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelId: model.modelId,
        attachments: relayInput.attachments,
        userPrompt: relayInput.userPrompt,
        maxTokens: deliveryContract ? 3000 : model.providerId === 'glm' ? 1024 : 3000,
        signal: activeRun?.visionAbortController?.signal,
        fetchImpl: (url, options = {}) => electronNet.fetch(url, {
          ...options,
          session: session.fromPartition(BROWSER_PARTITION)
        })
      });
      return {
        ...result,
        visualEvidence: {
          available: true,
          observerProvider: model.providerId,
          observerModel: model.modelId,
          report: String(described.text || '').slice(0, 16000)
        }
      };
    } catch (error) {
      lastError = error;
      if (isRecoverableVisionRelayError(error) && attempts[index + 1]) continue;
      break;
    }
  }
  return {
    ...result,
    visualEvidence: {
      available: false,
      error: lastError?.message || '视觉中继未能读取浏览器截图。'
    }
  };
}

function cancelDispatchedBrowserAgentOperation(operationId, reason = 'client_cancelled') {
  const id = String(operationId || '');
  if (!id) return false;
  let cancelled = false;
  for (const [requestId, pending] of browserAgentBridgePending) {
    if (pending.operationId !== id) continue;
    browserAgentBridgePending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: '内置浏览器操作已取消。', code: 'BROWSER_ACTION_CANCELLED' });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:agent-command', {
        requestId: '',
        operationId: id,
        action: 'cancel',
        params: { z_run_id: pending.runId, operation_id: id, reason }
      });
    }
    cancelled = true;
  }
  return cancelled;
}

async function dispatchBrowserAgentCommand(action, params = {}, { operationId = '' } = {}) {
  if (!BROWSER_AGENT_BRIDGE_ACTIONS.has(action)) {
    return { ok: false, error: `不支持的内置浏览器操作：${action}`, code: 'UNKNOWN_BROWSER_ACTION' };
  }
  const authority = resolveAuthoritativeBrowserRun(action, params);
  if (!authority.ok) return authority;
  const authorizedParams = {
    ...params,
    z_run_id: authority.runId,
    z_workspace: openCodeActiveRuns.get(authority.runId)?.workspace || '',
    z_session_id: openCodeActiveRuns.get(authority.runId)?.zSessionId || ''
  };
  const execute = async () => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainRendererReady) {
      return { ok: false, error: 'Z 主窗口尚未就绪，无法控制内置浏览器。', code: 'Z_RENDERER_NOT_READY' };
    }
    const requestId = crypto.randomUUID();
    const browserOperationId = String(operationId || requestId);
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => {
        browserAgentBridgePending.delete(requestId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('browser:agent-command', {
            requestId: '',
            operationId: browserOperationId,
            action: 'cancel',
            params: { z_run_id: authority.runId, operation_id: browserOperationId, reason: 'bridge_timeout' }
          });
        }
        resolve({ ok: false, error: '内置浏览器操作超时。', code: 'Z_BROWSER_TIMEOUT' });
      }, 40_000);
      browserAgentBridgePending.set(requestId, { resolve, timer, operationId: browserOperationId, runId: authority.runId });
      mainWindow.webContents.send('browser:agent-command', { requestId, operationId: browserOperationId, action, params: authorizedParams });
    });
    return action === 'screenshot'
      ? relayBrowserScreenshotForTextModel(result, authority.runId, authorizedParams)
      : result;
  };
  const mutating = new Set(['open', 'click', 'type', 'select', 'check', 'drag', 'pointer', 'press', 'scroll', 'back', 'forward', 'reload', 'apply_annotation']).has(action);
  return resourceLocks.withLock('browser:agent', mutating ? 'write' : 'read', {
    owner: authority.runId,
    timeoutMs: 45_000
  }, execute);
}

function notifyBrowserAgentRelease(runId, reason = 'run_finished') {
  const id = String(runId || '');
  if (!id || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('browser:agent-command', {
    requestId: '',
    action: 'release',
    params: { z_run_id: id, reason }
  });
}

function writeBrowserBridgeResponse(socket, payload) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(payload)}\n`);
}

function handleBrowserAgentBridgeSocket(socket) {
  socket.setEncoding('utf8');
  let input = '';
  let handled = false;
  let operationId = '';
  let operationCompleted = false;
  socket.on('data', chunk => {
    if (handled) return;
    input += String(chunk || '');
    if (Buffer.byteLength(input, 'utf8') > BROWSER_AGENT_BRIDGE_MAX_BYTES) {
      handled = true;
      writeBrowserBridgeResponse(socket, { ok: false, error: '浏览器桥接请求过大。', code: 'Z_BROWSER_REQUEST_TOO_LARGE' });
      return;
    }
    const newline = input.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    const line = input.slice(0, newline).trim();
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      writeBrowserBridgeResponse(socket, plainBrowserBridgeError(error, '浏览器桥接请求不是有效 JSON。'));
      return;
    }
    if (request?.token !== browserAgentBridgeToken) {
      writeBrowserBridgeResponse(socket, { ok: false, error: '浏览器桥接认证失败。', code: 'Z_BROWSER_AUTH_FAILED' });
      return;
    }
    const action = String(request?.action || '');
    operationId = String(request?.operationId || crypto.randomUUID());
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params
      : {};
    dispatchBrowserAgentCommand(action, params, { operationId })
      .then(result => {
        operationCompleted = true;
        writeBrowserBridgeResponse(socket, { ok: true, result });
      })
      .catch(error => {
        operationCompleted = true;
        writeBrowserBridgeResponse(socket, plainBrowserBridgeError(error));
      });
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (operationId && !operationCompleted) cancelDispatchedBrowserAgentOperation(operationId);
  });
}

function startBrowserAgentBridge() {
  if (browserAgentBridgeServer && browserAgentBridgePort) {
    return Promise.resolve({ port: browserAgentBridgePort, token: browserAgentBridgeToken });
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer(handleBrowserAgentBridgeSocket);
    const fail = error => {
      server.close(() => {});
      reject(error);
    };
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      server.on('error', error => console.warn('[browser bridge]', error.message));
      const address = server.address();
      browserAgentBridgeServer = server;
      browserAgentBridgePort = typeof address === 'object' && address ? Number(address.port) : 0;
      resolve({ port: browserAgentBridgePort, token: browserAgentBridgeToken });
    });
  });
}

function stopBrowserAgentBridge() {
  for (const pending of browserAgentBridgePending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: 'Z 正在退出，内置浏览器操作已终止。', code: 'Z_APP_EXITING' });
  }
  browserAgentBridgePending.clear();
  browserAgentBridgePort = 0;
  browserAgentBridgeServer?.close(() => {});
  browserAgentBridgeServer = null;
}

function sessionActionForOpenCodeTool(toolName) {
  return OPEN_CODE_SESSION_TOOL_ACTIONS[String(toolName || '').toLowerCase()] || '';
}

function trackSessionAgentToolClaim(runId, event = {}) {
  const activeRunId = String(runId || '');
  if (!activeRunId || !openCodeActiveRuns.has(activeRunId)) return;
  const data = event?.data || event?.properties || {};
  let callId = '';
  let toolName = '';
  let input = {};
  let finished = false;
  if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
    const part = data.part || {};
    if (part.type !== 'tool') return;
    callId = String(part.callID || part.id || '');
    toolName = String(part.tool || '');
    input = part.state?.input && typeof part.state.input === 'object' ? part.state.input : {};
    finished = part.state?.status === 'completed' || part.state?.status === 'error';
  } else if (event.type === 'session.next.tool.called') {
    callId = String(data.callID || '');
    toolName = String(data.tool || '');
    input = data.input && typeof data.input === 'object' ? data.input : {};
  } else if (event.type === 'session.next.tool.success' || event.type === 'session.next.tool.failed') {
    callId = String(data.callID || '');
    finished = true;
  } else {
    return;
  }
  if (!callId) return;
  if (finished) {
    sessionAgentToolClaims.delete(callId);
    return;
  }
  const action = sessionActionForOpenCodeTool(toolName);
  if (!action) return;
  sessionAgentToolClaims.set(callId, { runId: activeRunId, action, input, createdAt: Date.now() });
}

function clearSessionAgentToolClaims(runId) {
  const target = String(runId || '');
  for (const [callId, claim] of sessionAgentToolClaims) {
    if (!target || claim.runId === target) sessionAgentToolClaims.delete(callId);
  }
}

function consumeSessionAgentToolClaim(action, params = {}) {
  const now = Date.now();
  const requestedTarget = normalizeWorkspacePath(params.target_path);
  for (const [callId, claim] of sessionAgentToolClaims) {
    if (now - claim.createdAt > 30000 || !openCodeActiveRuns.has(claim.runId)) {
      sessionAgentToolClaims.delete(callId);
      continue;
    }
    if (claim.action !== action) continue;
    if (action === 'create_handoff') {
      const claimedTarget = normalizeWorkspacePath(claim.input?.target_path);
      if (requestedTarget && claimedTarget && !sameWorkspace(requestedTarget, claimedTarget)) continue;
    }
    sessionAgentToolClaims.delete(callId);
    return claim.runId;
  }
  return '';
}

function resolveAuthoritativeSessionRun(action, params = {}) {
  const claimedRunId = consumeSessionAgentToolClaim(action, params);
  if (claimedRunId) return { ok: true, runId: claimedRunId };
  const activeRunIds = [...openCodeActiveRuns.keys()];
  if (activeRunIds.length === 1) return { ok: true, runId: activeRunIds[0] };
  if (!activeRunIds.length) {
    return { ok: false, error: '当前没有可执行会话交接的 Agent 任务。', code: 'SESSION_RUN_NOT_ACTIVE' };
  }
  return { ok: false, error: '多个 Agent 任务同时运行，当前会话操作缺少权威任务归属。', code: 'SESSION_RUN_CONTEXT_AMBIGUOUS' };
}

function requestSessionAgentApproval(detail) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainRendererReady) {
    return Promise.resolve({ approved: false, error: 'Z 主窗口尚未就绪。' });
  }
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      sessionAgentBridgePending.delete(requestId);
      resolve({ approved: false, error: '等待用户授权超时。', code: 'SESSION_APPROVAL_TIMEOUT' });
    }, 270000);
    sessionAgentBridgePending.set(requestId, { resolve, timer });
    mainWindow.webContents.send('session:agent-command', { requestId, ...detail });
  });
}

async function dispatchSessionAgentCommand(action, params = {}) {
  if (!SESSION_AGENT_ACTIONS.has(action)) {
    return { ok: false, error: `不支持的会话操作：${action}`, code: 'UNKNOWN_SESSION_ACTION' };
  }
  const authority = resolveAuthoritativeSessionRun(action, params);
  if (!authority.ok) return authority;
  const active = openCodeActiveRuns.get(authority.runId);
  const sourceSessionId = String(active?.zSessionId || '');
  if (!sourceSessionId) {
    return { ok: false, error: '当前任务没有关联的 Z 对话。', code: 'Z_SESSION_NOT_BOUND' };
  }

  if (action === 'read_source_context') {
    return readBoundSourceContext(sourceSessionId, params.start, params.limit);
  }

  const source = await readSessionRecord(sourceSessionId);
  if (!source) return { ok: false, error: '来源任务不存在。', code: 'SESSION_SOURCE_NOT_FOUND' };
  const targetWorkspace = normalizeAbsoluteWorkspacePath(params.target_path);
  if (!targetWorkspace) {
    return { ok: false, error: '目标工作区必须使用绝对路径。', code: 'WORKSPACE_TARGET_ABSOLUTE_REQUIRED' };
  }
  const validation = await validateHandoffTarget(source.workspace, targetWorkspace);
  if (!validation.ok) return validation;
  const approval = await requestSessionAgentApproval({
    action,
    runId: authority.runId,
    sourceSessionId,
    sourceWorkspace: validation.source,
    targetWorkspace: validation.target,
    reason: String(params.reason || '').trim()
  });
  if (!approval?.approved) {
    return {
      ok: false,
      error: approval?.error || '用户拒绝了跨工作区任务导航。',
      code: approval?.code || 'SESSION_HANDOFF_DENIED',
      denied: true
    };
  }
  const resolved = await resolveWorkspaceSessionForHandoff(sourceSessionId, validation.target);
  if (!resolved.ok) return resolved;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session:agent-handoff-ready', {
      sourceSessionId,
      targetSessionId: resolved.session.id,
      workspace: resolved.session.workspace,
      handoffId: resolved.handoffId,
      reused: resolved.reused
    });
  }
  return {
    ok: true,
    sourceSessionId,
    targetSessionId: resolved.session.id,
    workspace: resolved.session.workspace,
    handoffId: resolved.handoffId,
    reused: resolved.reused,
    created: !resolved.reused,
    output: resolved.reused
      ? 'Z 已找到目标工作区现有的最新任务；当前回答结束后界面会自动返回该任务。'
      : 'Z 已创建新的任务并完成上下文交接；当前回答结束后界面会自动进入新任务。'
  };
}

function writeSessionBridgeResponse(socket, payload) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(payload)}\n`);
}

function handleSessionAgentBridgeSocket(socket) {
  socket.setEncoding('utf8');
  let input = '';
  let handled = false;
  socket.on('data', chunk => {
    if (handled) return;
    input += String(chunk || '');
    if (Buffer.byteLength(input, 'utf8') > SESSION_AGENT_BRIDGE_MAX_BYTES) {
      handled = true;
      writeSessionBridgeResponse(socket, { ok: false, error: '会话桥接请求过大。', code: 'Z_SESSION_REQUEST_TOO_LARGE' });
      return;
    }
    const newline = input.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    let request;
    try {
      request = JSON.parse(input.slice(0, newline).trim());
    } catch (error) {
      writeSessionBridgeResponse(socket, { ok: false, error: error?.message || '会话桥接请求不是有效 JSON。', code: 'Z_SESSION_BAD_JSON' });
      return;
    }
    if (request?.token !== sessionAgentBridgeToken) {
      writeSessionBridgeResponse(socket, { ok: false, error: '会话桥接认证失败。', code: 'Z_SESSION_AUTH_FAILED' });
      return;
    }
    const action = String(request?.action || '');
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params
      : {};
    dispatchSessionAgentCommand(action, params)
      .then(result => writeSessionBridgeResponse(socket, { ok: true, result }))
      .catch(error => writeSessionBridgeResponse(socket, {
        ok: false,
        error: error?.message || String(error),
        code: error?.code || 'Z_SESSION_BRIDGE_FAILED'
      }));
  });
  socket.on('error', () => {});
}

function startSessionAgentBridge() {
  if (sessionAgentBridgeServer && sessionAgentBridgePort) {
    return Promise.resolve({ port: sessionAgentBridgePort, token: sessionAgentBridgeToken });
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer(handleSessionAgentBridgeSocket);
    const fail = error => {
      server.close(() => {});
      reject(error);
    };
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      server.on('error', error => console.warn('[session bridge]', error.message));
      const address = server.address();
      sessionAgentBridgeServer = server;
      sessionAgentBridgePort = typeof address === 'object' && address ? Number(address.port) : 0;
      resolve({ port: sessionAgentBridgePort, token: sessionAgentBridgeToken });
    });
  });
}

function stopSessionAgentBridge() {
  for (const pending of sessionAgentBridgePending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ approved: false, error: 'Z 正在退出，会话操作已终止。', code: 'Z_APP_EXITING' });
  }
  sessionAgentBridgePending.clear();
  sessionAgentToolClaims.clear();
  sessionAgentBridgePort = 0;
  sessionAgentBridgeServer?.close(() => {});
  sessionAgentBridgeServer = null;
}

function isBrowserPageUrl(url) {
  return /^(?:https?|file):/i.test(String(url || '').trim());
}

function isExternalBrowserUrl(url) {
  return /^https?:/i.test(String(url || '').trim());
}

function sendBrowserNewTab(url, contents) {
  const targetUrl = String(url || '').trim();
  if (!isBrowserPageUrl(targetUrl) || !mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.send('browser:new-tab-request', { url: targetUrl, sourceWebContentsId: contents?.id || 0 });
  return true;
}

function getBrowserNavigationState(contents) {
  const history = contents.navigationHistory;
  return {
    canGoBack: history?.canGoBack?.() ?? contents.canGoBack?.() ?? false,
    canGoForward: history?.canGoForward?.() ?? contents.canGoForward?.() ?? false,
    goBack: () => {
      if (typeof history?.goBack === 'function') return history.goBack();
      return contents.goBack?.();
    },
    goForward: () => {
      if (typeof history?.goForward === 'function') return history.goForward();
      return contents.goForward?.();
    }
  };
}

function runBrowserMediaAction(contents, params, action) {
  const x = Math.round(Number(params.x) || 0);
  const y = Math.round(Number(params.y) || 0);
  contents.executeJavaScript(`(() => {
    const target = document.elementFromPoint(${x}, ${y});
    const media = target?.closest?.('video, audio') || (target instanceof HTMLMediaElement ? target : null);
    if (!media) return false;
    switch (${JSON.stringify(action)}) {
      case 'toggle-play': media.paused ? media.play() : media.pause(); break;
      case 'toggle-mute': media.muted = !media.muted; break;
      case 'toggle-loop': media.loop = !media.loop; break;
      case 'toggle-controls': media.controls = !media.controls; break;
      default: return false;
    }
    return true;
  })()`, true).catch(() => {});
}

function buildBrowserContextMenu(contents, params) {
  const template = [];
  const addSeparator = () => {
    if (template.length && template.at(-1)?.type !== 'separator') template.push({ type: 'separator' });
  };
  const pageUrl = String(params.pageURL || contents.getURL?.() || '').trim();
  const linkUrl = String(params.linkURL || '').trim();
  const mediaUrl = String(params.srcURL || '').trim();
  const selection = String(params.selectionText || '').replace(/\s+/g, ' ').trim();
  const editFlags = params.editFlags || {};

  if (isBrowserPageUrl(linkUrl)) {
    template.push(
      { label: '在新标签页中打开链接', click: () => sendBrowserNewTab(linkUrl, contents) },
      ...(isExternalBrowserUrl(linkUrl)
        ? [{ label: '在系统浏览器中打开链接', click: () => shell.openExternal(linkUrl).catch(() => {}) }]
        : []),
      { label: '复制链接地址', click: () => clipboard.writeText(linkUrl) }
    );
  }

  if (params.mediaType === 'image' && isBrowserPageUrl(mediaUrl)) {
    addSeparator();
    template.push(
      { label: '在新标签页中打开图片', click: () => sendBrowserNewTab(mediaUrl, contents) },
      { label: '复制图片', click: () => contents.copyImageAt(params.x, params.y) },
      { label: '复制图片地址', click: () => clipboard.writeText(mediaUrl) }
    );
  }

  if (['audio', 'video'].includes(params.mediaType)) {
    const mediaFlags = params.mediaFlags || {};
    addSeparator();
    template.push({
      label: mediaFlags.isPaused ? '播放' : '暂停',
      enabled: !mediaFlags.inError,
      click: () => runBrowserMediaAction(contents, params, 'toggle-play')
    });
    if (mediaFlags.hasAudio) {
      template.push({
        label: mediaFlags.isMuted ? '取消静音' : '静音',
        click: () => runBrowserMediaAction(contents, params, 'toggle-mute')
      });
    }
    template.push({
      label: '循环播放',
      type: 'checkbox',
      checked: !!mediaFlags.isLooping,
      click: () => runBrowserMediaAction(contents, params, 'toggle-loop')
    });
    if (params.mediaType === 'video' && mediaFlags.canToggleControls !== false) {
      template.push({
        label: '显示控件',
        type: 'checkbox',
        checked: !!mediaFlags.isControlsVisible,
        click: () => runBrowserMediaAction(contents, params, 'toggle-controls')
      });
    }
    if (isBrowserPageUrl(mediaUrl)) {
      template.push(
        { label: `在新标签页中打开${params.mediaType === 'video' ? '视频' : '音频'}`, click: () => sendBrowserNewTab(mediaUrl, contents) },
        { label: '复制媒体地址', click: () => clipboard.writeText(mediaUrl) }
      );
    }
  }

  if (params.isEditable) {
    addSeparator();
    const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, 5) : [];
    for (const suggestion of suggestions) {
      template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (suggestions.length) addSeparator();
    template.push(
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', enabled: !!editFlags.canUndo, click: () => contents.undo() },
      { label: '重做', accelerator: 'CmdOrCtrl+Y', enabled: !!editFlags.canRedo, click: () => contents.redo() },
      { type: 'separator' },
      { label: '剪切', accelerator: 'CmdOrCtrl+X', enabled: !!editFlags.canCut, click: () => contents.cut() },
      { label: '复制', accelerator: 'CmdOrCtrl+C', enabled: !!editFlags.canCopy, click: () => contents.copy() },
      { label: '粘贴', accelerator: 'CmdOrCtrl+V', enabled: !!editFlags.canPaste, click: () => contents.paste() },
      { label: '删除', enabled: !!editFlags.canDelete, click: () => contents.delete() },
      { type: 'separator' },
      { label: '全选', accelerator: 'CmdOrCtrl+A', enabled: editFlags.canSelectAll !== false, click: () => contents.selectAll() }
    );
    if (params.misspelledWord && contents.session.getSpellCheckerEnabled?.()) {
      template.push({
        label: '添加到词典',
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
    }
  } else if (selection) {
    addSeparator();
    const displaySelection = selection.length > 28 ? `${selection.slice(0, 28)}…` : selection;
    template.push(
      { label: '复制', accelerator: 'CmdOrCtrl+C', click: () => contents.copy() },
      {
        label: `使用 Bing 搜索“${displaySelection}”`,
        click: () => sendBrowserNewTab(`https://www.bing.com/search?q=${encodeURIComponent(selection)}`, contents)
      }
    );
  }

  addSeparator();
  const navigation = getBrowserNavigationState(contents);
  template.push(
    { label: '后退', enabled: !!navigation.canGoBack, click: navigation.goBack },
    { label: '前进', enabled: !!navigation.canGoForward, click: navigation.goForward },
    contents.isLoading()
      ? { label: '停止加载', click: () => contents.stop() }
      : { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => contents.reload() }
  );

  if (isBrowserPageUrl(pageUrl)) {
    addSeparator();
    template.push({ label: '复制页面地址', click: () => clipboard.writeText(pageUrl) });
    if (isExternalBrowserUrl(pageUrl)) {
      template.push({ label: '在系统浏览器中打开页面', click: () => shell.openExternal(pageUrl).catch(() => {}) });
    }
    template.push({
      label: '打印页面',
      click: () => contents.print({ printBackground: true }, (success, reason) => {
        if (!success) console.warn('[browser] print failed:', reason);
      })
    });
  }

  addSeparator();
  template.push({ label: '检查元素', click: () => contents.inspectElement(params.x, params.y) });
  while (template.at(-1)?.type === 'separator') template.pop();
  return template;
}

function configureBrowserGuest(contents) {
  if (!contents || contents.isDestroyed()) return;
  if (configuredBrowserGuestIds.has(contents.id)) return;
  configuredBrowserGuestIds.add(contents.id);
  contents.once('destroyed', () => configuredBrowserGuestIds.delete(contents.id));
  contents.setWindowOpenHandler(({ url }) => {
    sendBrowserNewTab(url, contents);
    return { action: 'deny' };
  });
  contents.on('context-menu', (event, params) => {
    event.preventDefault();
    const template = buildBrowserContextMenu(contents, params);
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow || undefined });
  });
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') configureBrowserGuest(contents);
});

async function refreshBrowserNetworkSession(url = 'https://example.com', { resetConnections = true } = {}) {
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  await browserSession.setProxy({ mode: 'system' });
  if (typeof browserSession.forceReloadProxyConfig === 'function') {
    await browserSession.forceReloadProxyConfig();
  }
  if (resetConnections) await browserSession.closeAllConnections();

  let proxy = 'unknown';
  try {
    proxy = await browserSession.resolveProxy(String(url || 'https://example.com'));
  } catch { /* keep network recovery usable even if proxy diagnostics fail */ }
  return { ok: true, proxy };
}

// ---------------------------------------------------------------------------
// Paths & storage
// ---------------------------------------------------------------------------
// 数据统一放在 userData/ZData。
const userDataDir = app.getPath('userData');
const STABLE_DATA_DIR = storageLayout.dataRoot(userDataDir);

async function migrateLegacyDataDir() {
  if (fs.existsSync(path.join(STABLE_DATA_DIR, 'config.json'))) return;

  let names = [];
  try { names = fs.readdirSync(userDataDir); } catch { return; }

  let bestDir = null;
  let bestMtime = 0;
  for (const name of names) {
    if (!name.startsWith('ZData-')) continue;
    const candidate = path.join(userDataDir, name);
    const cfg = path.join(candidate, 'config.json');
    if (!fs.existsSync(cfg)) continue;
    try {
      const mtime = fs.statSync(cfg).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestDir = candidate;
      }
    } catch { /* skip */ }
  }

  if (!bestDir) return;
  try {
    fs.mkdirSync(STABLE_DATA_DIR, { recursive: true });
    // 异步拷贝:旧目录可能包含全部会话与上 GB 的图片缓存,同步 cpSync 会让启动
    // 界面冻结数分钟;await 保证后续启动流程仍在迁移完成后才开始
    await fsp.cp(bestDir, STABLE_DATA_DIR, { recursive: true, force: true });
    console.log('[data] migrated legacy data from', path.basename(bestDir), 'to ZData');
  } catch (e) {
    console.error('[data] migrate legacy data failed:', e.message);
  }
}

const dataDir = STABLE_DATA_DIR;
const rendererHealthLog = createRendererHealthLog(path.join(dataDir, 'logs'));
attachProcessHealthLogging(app, rendererHealthLog);
rendererHealthLog.write('software-rendering-enabled');
process.env.Z_OFFICECLI_DATA_DIR = path.join(dataDir, 'runtimes', 'officecli');
process.env.Z_ELECTRON_RUNTIME = process.execPath;
const configPath = path.join(dataDir, 'config.json');
const sessionsDir = path.join(dataDir, 'sessions');
const filesDir = path.join(dataDir, 'uploads');
const defaultTasksRoot = taskWorkspaceRoot({
  documentsDirectory: app.getPath('documents'),
  userDataDirectory: userDataDir,
  isolated: isE2EMode || !!e2eUserDataDir
});

// 进程级兜底:主进程没有任何未捕获异常处理时,单个 EPIPE/类型错误就会让整个应用
// 直接消失。这里记录崩溃现场(文件+控制台)但保持存活,让用户有机会保存会话。
let lastCrashLogAt = 0;
function reportProcessError(kind, error) {
  const message = `[${kind}] ${new Date().toISOString()} ${error && error.stack ? error.stack : String(error)}`;
  console.error(message);
  const now = Date.now();
  if (now - lastCrashLogAt < 1000) return; // 风暴限流:每秒最多落盘一次
  lastCrashLogAt = now;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'main-crash.log'), `${message}\n`, 'utf8');
  } catch { /* 日志失败不能再引发异常 */ }
}

process.on('uncaughtException', (error) => reportProcessError('uncaughtException', error));
process.on('unhandledRejection', (reason) => reportProcessError('unhandledRejection', reason));

function initializeZCore() {
  if (zCore) return zCore;
  zCore = new ZCore({
    rootDir: storageLayout.coreRoot(dataDir),
    logger: console
  });
  zCore.on('event', event => {
    // Renderer consumes raw provider streaming over the OpenCode path; only
    // lifecycle, tool, context, and queue events are useful over this channel.
    if (['message.delta', 'reasoning.delta', 'provider.event'].includes(event?.type)) return;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('z:core-event', event);
  });
  return zCore;
}
// Active-run workspaces for the Z Media MCP. The MCP env must stay
// config-stable (see buildZMediaMcpServer), so per-run workspaces are
// delivered through this file and read dynamically per tool call.
const mediaWorkspaceRegistryPath = path.join(dataDir, 'media-workspace-registry.json');

function readMediaWorkspaceRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(mediaWorkspaceRegistryPath, 'utf8'));
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function writeMediaWorkspaceRegistry(entries) {
  try {
    fs.writeFileSync(mediaWorkspaceRegistryPath, JSON.stringify({
      entries: entries.slice(0, 8)
    }, null, 0), 'utf8');
  } catch (error) {
    console.warn('[media-registry] write failed:', error?.message || error);
  }
}

function registerMediaWorkspace(runId, workspace) {
  const normalized = workspaceSandbox.normalizeWorkspace(workspace);
  const id = String(runId || '');
  const entries = readMediaWorkspaceRegistry().filter(entry => entry?.runId !== id);
  if (normalized) entries.unshift({ runId: id, workspace: normalized, ts: Date.now() });
  writeMediaWorkspaceRegistry(entries);
}

function releaseMediaWorkspace(runId) {
  const id = String(runId || '');
  const entries = readMediaWorkspaceRegistry().filter(entry => entry?.runId !== id);
  writeMediaWorkspaceRegistry(entries);
}
const skillsDir = skillRegistry.getZSkillDirectory(dataDir);
const generatedImageStoreDir = path.join(dataDir, 'generated-images');
const generatedVideoStoreDir = path.join(dataDir, 'generated-videos');
const generatedMediaManifestDir = path.join(dataDir, 'generated-media');
const memoryPath = path.join(dataDir, 'memory.json');
const skillEvolutionPath = path.join(dataDir, 'skill-evolution.json');
const continualHarnessPath = path.join(dataDir, 'harness', 'harness-state.json');
const ZAGENT_DIR = '.zagent';
const longTermMemory = new LongTermMemoryStore({ globalPath: memoryPath, zagentDir: ZAGENT_DIR });
const skillEvolution = new SkillEvolutionStore({ filePath: skillEvolutionPath });
const continualHarness = new ContinualHarnessStore({ globalPath: continualHarnessPath, zagentDir: ZAGENT_DIR });
const agiUtilityLedger = createUtilityLedger({ filePath: path.join(dataDir, 'agi', 'utility.json') });
const agiTrajectoryStore = createTrajectoryStore({ dir: path.join(dataDir, 'agi', 'trajectories') });
const agiEscalationMemo = createEscalationMemo({ filePath: path.join(dataDir, 'agi', 'escalation.json') });
const agiVerifiedRunIndex = createVerifiedRunIndex({ store: agiTrajectoryStore });
const agiExperienceGraph = createExperienceGraph({ filePath: path.join(dataDir, 'agi', 'experience-graph.json') });
const AGI_EVAL_EVIDENCE_PATH = path.join(dataDir, 'agi', 'eval-evidence.json');
const AGI_TOPOLOGY_HISTORY_PATH = path.join(dataDir, 'agi', 'topology-history.json');
const AGI_MEMORY_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
let lastAgiMemoryMaintenanceAt = 0;
// 恢复流程已异步化(锁等待不能阻塞事件循环),模块加载阶段用 Promise 链兜底
continualHarness.recoverRejectedAgentRefinements({ scope: 'global' })
  .then((recovered) => {
    if (recovered.length) console.log(`[harness] recovered ${recovered.length} explicit user policy record(s)`);
  })
  .catch((error) => console.warn('[harness] explicit policy recovery failed:', error?.message || error));
const MAX_STORED_GENERATED_IMAGES = 100;
const MAX_STORED_GENERATED_IMAGE_BYTES = 1024 * 1024 * 1024;
const GENERATED_IMAGE_MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

function loadGeneratedImageStore() {
  generatedImages.clear();
  fs.mkdirSync(generatedImageStoreDir, { recursive: true });

  const restored = [];
  for (const file of fs.readdirSync(generatedImageStoreDir, { withFileTypes: true })) {
    const match = file.isFile() && file.name.match(/^([a-f0-9]{32})\.(png|jpg|jpeg|webp|gif)$/i);
    if (!match) continue;
    const filePath = path.join(generatedImageStoreDir, file.name);
    try {
      const stat = fs.statSync(filePath);
      restored.push({
        assetId: match[1].toLowerCase(),
        filePath,
        name: `generated_${Math.trunc(stat.mtimeMs)}_${match[1].slice(0, 6)}.${match[2].toLowerCase()}`,
        size: stat.size,
        mimeType: GENERATED_IMAGE_MIME_BY_EXTENSION[match[2].toLowerCase()],
        createdAt: stat.mtimeMs
      });
    } catch {}
  }
  restored.sort((a, b) => a.createdAt - b.createdAt);
  for (const asset of restored) generatedImages.set(asset.assetId, asset);
  pruneGeneratedImageStore();
}

function closeGeneratedImageViewers() {
  for (const viewer of generatedImageViewers.values()) {
    if (!viewer.isDestroyed()) viewer.destroy();
  }
  generatedImageViewers.clear();
  generatedImages.clear();
}

function getGeneratedImageAsset(assetId) {
  const id = String(assetId || '').trim();
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  let asset = generatedImages.get(id);
  if (!asset) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(generatedMediaManifestDir, `${id}.json`), 'utf8'));
      const filePath = path.resolve(String(manifest.filePath || ''));
      const extension = path.extname(filePath).slice(1).toLowerCase();
      const insideDataDir = filePath.startsWith(`${dataDir}${path.sep}`);
      if (manifest.assetId === id && manifest.type === 'image' && insideDataDir && GENERATED_IMAGE_MIME_BY_EXTENSION[extension]) {
        const stat = fs.statSync(filePath);
        asset = {
          assetId: id,
          filePath,
          name: String(manifest.name || `generated_${Math.trunc(stat.mtimeMs)}_${id.slice(0, 6)}.${extension}`),
          size: stat.size,
          mimeType: String(manifest.mimeType || GENERATED_IMAGE_MIME_BY_EXTENSION[extension]),
          createdAt: Number(manifest.createdAt) || stat.mtimeMs
        };
        generatedImages.set(id, asset);
      }
    } catch {}
  }
  if (!asset || !fs.existsSync(asset.filePath)) {
    if (asset) generatedImages.delete(id);
    return null;
  }
  return asset;
}

function pruneGeneratedImageStore() {
  let totalBytes = [...generatedImages.values()].reduce((sum, item) => sum + item.size, 0);
  for (const [id, item] of generatedImages) {
    if (generatedImages.size <= MAX_STORED_GENERATED_IMAGES && totalBytes <= MAX_STORED_GENERATED_IMAGE_BYTES) break;
    generatedImages.delete(id);
    totalBytes -= item.size;
    fsp.unlink(item.filePath).catch(() => {});
    const viewer = generatedImageViewers.get(id);
    if (viewer && !viewer.isDestroyed()) viewer.destroy();
  }
}

async function registerGeneratedImage(result) {
  fs.mkdirSync(generatedImageStoreDir, { recursive: true });
  const assetId = crypto.randomBytes(16).toString('hex');
  const name = `generated_${Date.now()}_${assetId.slice(0, 6)}.${result.extension}`;
  const filePath = path.join(generatedImageStoreDir, `${assetId}.${result.extension}`);
  await fsp.writeFile(filePath, result.buffer);
  generatedImages.set(assetId, {
    assetId,
    filePath,
    name,
    size: result.buffer.length,
    mimeType: result.mimeType,
    providerId: result.providerId || '',
    model: result.model || '',
    providerRequestId: result.providerRequestId || '',
    createdAt: Date.now()
  });
  pruneGeneratedImageStore();
  return generatedImages.get(assetId);
}

async function cacheAuthorizedGeneratedVideo(result, signal) {
  if (!result?.url || !result?.downloadHeaders) return result;
  const response = await fetch(result.url, {
    method: 'GET',
    headers: result.downloadHeaders,
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载生成视频失败：HTTP ${response.status}`);
  }
  const declaredSize = Number(response.headers.get('content-length')) || 0;
  if (declaredSize > 512 * 1024 * 1024) throw new Error('生成视频超过 512MB 限制');
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const extension = contentType.includes('webm') ? 'webm' : (contentType.includes('quicktime') ? 'mov' : 'mp4');
  await fsp.mkdir(generatedVideoStoreDir, { recursive: true });
  const assetId = crypto.randomBytes(16).toString('hex');
  const filePath = path.join(generatedVideoStoreDir, `${assetId}.${extension}`);
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath), { signal });
    const stat = await fsp.stat(filePath);
    if (stat.size > 512 * 1024 * 1024) throw new Error('生成视频超过 512MB 限制');
    return {
      ...result,
      url: pathToFileURL(filePath).href,
      size: `${(stat.size / (1024 * 1024)).toFixed(1)} MB`,
      localPath: filePath,
      downloadHeaders: undefined
    };
  } catch (error) {
    await fsp.unlink(filePath).catch(() => {});
    throw error;
  }
}
// ---------------------------------------------------------------------------
// .zagent — workspace-local memory, logs, session snapshots (safe to delete)
// ---------------------------------------------------------------------------
function zagentRoot(workspace) {
  if (!workspace) return null;
  return storageLayout.workspaceStateRoot(workspace, ZAGENT_DIR);
}

function ensureZagent(workspace) {
  const root = zagentRoot(workspace);
  if (!root) return null;
  for (const sub of ['logs', 'snapshots', 'scratch', 'evidence']) {
    const d = path.join(root, sub);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  // Reusable acceptance evidence is allowed to outlive the run that produced
  // it; the TTL keeps a long-lived workspace bounded without deleting it.
  pruneZagentEvidence(root);
  const readme = path.join(root, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme,
      'Z 数据目录（记忆、日志、会话快照、工具产物与验收证据）。\n' +
      '内部含 .gitignore，不会出现在你的 Git 变更里。\n' +
      '可随时删除，不影响项目代码；删除后记忆、日志、会话快照与验收证据会丢失。\n',
      'utf8');
  }
  // Z runtime files must never surface in the user's git status. The project
  // .gitignore stays untouched; this file only hides this folder.
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', 'utf8');
  return root;
}

function migrateMemoryToWorkspace(workspace) {
  if (!workspace) return;
  ensureZagent(workspace);
}

function runSnapshotPath(workspace, sessionId, runId) {
  if (!isSafeSessionId(sessionId) || !isSafePathSegment(runId)) return null;
  const snapshot = require('./lib/run-snapshot-storage').resolveRunSnapshotPath(workspace, sessionId, runId);
  if (!snapshot) return null;
  ensureZagent(workspace);
  const dir = path.dirname(snapshot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return snapshot;
}

function isSafePathSegment(value) {
  return /^[A-Za-z0-9_-]{1,200}$/.test(String(value || '').trim());
}

async function writeRunRollbackSnapshot({ workspace, sessionId, runId, rollbackChanges }) {
  try {
    if (!workspace || !sessionId || !runId) return;
    const changes = (Array.isArray(rollbackChanges) ? rollbackChanges : [])
      .filter(change => change?.path && Object.prototype.hasOwnProperty.call(change, 'before'));
    if (!changes.length) return;
    await resourceLocks.withLock(`workspace:${path.resolve(workspace)}`, 'write', { owner: runId }, async () => {
      const snapPath = runSnapshotPath(workspace, sessionId, runId);
      if (!snapPath) return;
      await fsp.writeFile(snapPath, JSON.stringify({ sessionId, runId, ts: Date.now(), changes }), 'utf8');
    });
  } catch (error) {
    console.warn('[opencode] Rollback snapshot write failed:', error?.message || error);
  }
}

async function loadSessionChangeHistory(workspace, sessionId) {
  if (!isSafeSessionId(sessionId)) return [];
  const paths = await require('./lib/run-snapshot-storage').listRunSnapshotPaths(workspace, sessionId);
  const snapshots = [];
  for (const filePath of paths) {
    try {
      const [data, stat] = await Promise.all([
        fsp.readFile(filePath, 'utf8').then(JSON.parse),
        fsp.stat(filePath)
      ]);
      snapshots.push({ ...data, ts: Number(stat.birthtimeMs) || Number(stat.mtimeMs) || 0 });
    } catch { /* ignore incomplete or obsolete snapshots */ }
  }
  return mergeChangeHistory(snapshots);
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveRollbackTarget(workspace, rawPath) {
  const checked = workspaceSandbox.resolveInsideWorkspace(workspace, rawPath);
  if (!checked.ok) return checked;
  const realWorkspace = await fsp.realpath(checked.workspace).catch(() => path.resolve(checked.workspace));
  // Resolve existing files and their parent directories through symlinks /
  // junctions. Lexical path.relative checks alone cannot stop a snapshot from
  // writing through a link that points outside the session workspace.
  const realTarget = await fsp.realpath(checked.path).catch(async () => {
    const parent = await fsp.realpath(path.dirname(checked.path)).catch(() => path.dirname(checked.path));
    return path.join(parent, path.basename(checked.path));
  });
  if (!isPathInside(realWorkspace, realTarget)) {
    return { ok: false, error: '回滚路径通过符号链接越界', code: 'PATH_SYMLINK_ESCAPE' };
  }
  return checked;
}

async function applySnapshotRollback(changes, workspace) {
  return resourceLocks.withLock(`workspace:${path.resolve(workspace || '')}`, 'write', { owner: 'rollback' }, async () => {
    const results = [];
    for (const ch of [...(changes || [])].reverse()) {
      const checked = await resolveRollbackTarget(workspace, ch?.path);
      if (!checked.ok) {
        results.push({ path: ch?.path, ok: false, error: checked.error });
        continue;
      }
      const targetPath = checked.path;
      if (ch.before === null || ch.before === undefined) {
        try {
          if (fs.existsSync(targetPath)) await fsp.unlink(targetPath);
          results.push({ path: targetPath, ok: true, action: 'deleted' });
        } catch (e) {
          results.push({ path: targetPath, ok: false, error: e.message });
        }
      } else {
        try {
          await fsp.mkdir(path.dirname(targetPath), { recursive: true });
          await fsp.writeFile(targetPath, ch.before, 'utf8');
          results.push({ path: targetPath, ok: true, action: 'restored' });
        } catch (e) {
          results.push({ path: targetPath, ok: false, error: e.message });
        }
      }
    }
    return results;
  });
}

function appendZagentLog(workspace, line) {
  const root = ensureZagent(workspace);
  if (!root) return;
  const logFile = path.join(root, 'logs', new Date().toISOString().slice(0, 10) + '.log');
  const ts = new Date().toISOString();
  try {
    fs.appendFileSync(logFile, `[${ts}] ${line}\n`, 'utf8');
  } catch (e) { console.error('appendZagentLog:', e.message); }
}

function ensureDirs() {
  for (const dir of [dataDir, sessionsDir, filesDir, skillsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// Media capabilities were verified against vendor-hosted APIs on 2026-08-02;
// they do not depend on the contents of GET /models.
const EMPTY_MEDIA_CAPABILITIES = Object.freeze({
  imageGeneration: false,
  imageEditing: false,
  videoGeneration: false
});
const PROVIDER_MEDIA_CAPABILITIES = Object.freeze({
  openai: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  grok: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  agnes: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  sensenova: Object.freeze({ imageGeneration: true, imageEditing: false, videoGeneration: false }),
  deepseek: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  qwen: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  glm: Object.freeze({ imageGeneration: true, imageEditing: false, videoGeneration: true }),
  doubao: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  moonshot: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  stepfun: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: false }),
  minimax: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  baichuan: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  yi: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  hunyuan: Object.freeze({ imageGeneration: true, imageEditing: false, videoGeneration: true }),
  siliconflow: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true })
});

// Only these capabilities have a Z request/response adapter. The settings
// and model pickers must use this table instead of the vendor capability table.
const PROVIDER_MEDIA_ADAPTERS = Object.freeze({
  openai: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  grok: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  agnes: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  sensenova: Object.freeze({ imageGeneration: true, imageEditing: false, videoGeneration: false }),
  deepseek: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  qwen: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  glm: Object.freeze({ imageGeneration: true, imageEditing: false, videoGeneration: true }),
  doubao: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  moonshot: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  stepfun: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: false }),
  minimax: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true }),
  baichuan: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  yi: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  hunyuan: Object.freeze({ imageGeneration: false, imageEditing: false, videoGeneration: false }),
  siliconflow: Object.freeze({ imageGeneration: true, imageEditing: true, videoGeneration: true })
});

const STATIC_PROVIDER_SUPPLEMENTAL_MODELS = Object.freeze({
  // GLM's /models response is incomplete: documented free, vision, image and
  // video IDs remain callable but are not returned. Keep them sourced and
  // separate so the UI never presents them as API-discovered models.
  glm: GLM_OFFICIAL_SUPPLEMENTAL_MODELS,
  sensenova: SENSENOVA_OFFICIAL_SUPPLEMENTAL_MODELS,
  doubao: Object.freeze([
    { id: 'doubao-seedream-5-0-pro-260628', name: 'Doubao Seedream 5.0 Pro', modelType: 'image', source: 'official-supplement' },
    { id: 'doubao-seedance-2-0-260128', name: 'Doubao Seedance 2.0', modelType: 'video', source: 'official-supplement' }
  ]),
  stepfun: Object.freeze([
    { id: 'step-image-edit-2', name: 'Step Image Edit 2', modelType: 'image', source: 'official-supplement' },
    { id: 'step-2x-large', name: 'Step 2X Large', modelType: 'image', source: 'official-supplement' }
  ]),
  minimax: Object.freeze([
    { id: 'image-01', name: 'MiniMax Image 01', modelType: 'image', source: 'official-supplement' },
    { id: 'image-01-live', name: 'MiniMax Image 01 Live', modelType: 'image', source: 'official-supplement' },
    { id: 'MiniMax-H3', name: 'MiniMax H3', modelType: 'video', source: 'official-supplement' },
    { id: 'video-01', name: 'MiniMax Video 01', modelType: 'video', source: 'official-supplement' },
    { id: 'video-01-live2', name: 'MiniMax Video 01 Live2', modelType: 'video', source: 'official-supplement' }
  ])
});

const MODEL_PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: true,
    models: []
  },
  grok: {
    id: 'grok',
    name: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: true,
    models: []
  },
  agnes: {
    id: 'agnes',
    name: 'Agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: true,
    models: AGNES_FALLBACK_MODELS
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek (深度求索)',
    baseUrl: 'https://api.deepseek.com',
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: true,
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Experimental', capabilities: { vision: true } }
    ]
  },
  qwen: {
    id: 'qwen',
    name: '通义千问 (阿里云百炼)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: true,
    models: [
      { id: 'qwen3.8-max-preview', name: 'Qwen3.8 Max Preview (旗舰)', capabilities: { vision: true } },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max (旗舰)' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus (均衡)' },
      { id: 'qwen3.7-flash', name: 'Qwen3.7 Flash (高速多模态)', capabilities: { vision: true } },
      { id: 'qwen3.6-flash', name: 'Qwen3.6 Flash (轻量)' },
      { id: 'qwen3.6-max-preview', name: 'Qwen3.6 Max Preview' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus' },
      { id: 'qwen3-max', name: 'Qwen3 Max' },
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-turbo', name: 'Qwen Turbo' },
      { id: 'qwen-long', name: 'Qwen Long (长文本)' }
    ]
  },
  glm: {
    id: 'glm',
    name: '智谱 GLM (智谱AI)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyPlaceholder: '...',
    // GLM exposes the current text catalog through /models. Media models are
    // documented on the image/video endpoints and merged separately below.
    dynamicModels: true,
    // Text IDs are populated exclusively from GLM's /models response after
    // the provider is configured.
    models: []
  },
  doubao: {
    id: 'doubao',
    name: '豆包 (火山引擎方舟)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyPlaceholder: '...',
    models: [
      { id: 'doubao-seed-2-1-pro-260628', name: 'Doubao Seed 2.1 Pro 260628' },
      { id: 'doubao-seed-2-1-turbo-260628', name: 'Doubao Seed 2.1 Turbo 260628' },
      { id: 'doubao-seed-2-0-lite-260428', name: 'Doubao Seed 2.0 Lite 260428' },
      { id: 'doubao-seed-2-0-mini-260428', name: 'Doubao Seed 2.0 Mini 260428' },
      { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao Seed 2.0 Pro 260215' }
    ]
  },
  moonshot: {
    id: 'moonshot',
    name: 'Kimi (月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: true,
    models: [
      { id: 'kimi-k3', name: 'Kimi K3 (1M 旗舰多模态)' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HighSpeed' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6 (通用多模态)' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5 (多模态)' }
    ]
  },
  stepfun: {
    id: 'stepfun',
    name: 'StepFun (阶跃星辰)',
    baseUrl: 'https://api.stepfun.com/v1',
    apiKeyPlaceholder: 'sk-...',
    models: [
      { id: 'step-3.7-flash', name: 'Step 3.7 Flash (多模态推理)' },
      { id: 'step-3.5-flash', name: 'Step 3.5 Flash (推理)' }
    ]
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax (稀宇)',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKeyPlaceholder: '...',
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3 (1M 旗舰)' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 HighSpeed' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' }
    ]
  },
  baichuan: {
    id: 'baichuan',
    name: '百川智能 (Baichuan)',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    apiKeyPlaceholder: 'sk-...',
    models: [
      { id: 'Baichuan4', name: 'Baichuan 4' },
      { id: 'Baichuan3-Turbo', name: 'Baichuan 3 Turbo' }
    ]
  },
  yi: {
    id: 'yi',
    name: '零一万物 (Yi)',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    apiKeyPlaceholder: 'sk-...',
    models: [
      { id: 'yi-large', name: 'Yi Large' },
      { id: 'yi-lightning', name: 'Yi Lightning' }
    ]
  },
  hunyuan: {
    id: 'hunyuan',
    name: '腾讯混元 (Hunyuan)',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    apiKeyPlaceholder: 'sk-...',
    models: [
      { id: 'hunyuan-turbos-latest', name: '混元 Turbo S Latest' },
      { id: 'hunyuan-turbos', name: '混元 Turbo S (兼容别名)' },
      { id: 'hunyuan-a13b', name: '混元 A13B (混合推理)' },
      { id: 'hunyuan-pro', name: '混元 Pro' },
      { id: 'hunyuan-vision', name: '混元 Vision', capabilities: { vision: true } },
      { id: 'hunyuan-vision-1.5-instruct', name: '混元 Vision 1.5 Instruct', capabilities: { vision: true } },
      { id: 'hunyuan-t1-vision-20250916', name: '混元 T1 Vision', capabilities: { vision: true } }
    ]
  },
  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: true,
    models: []
  }
};

const DEFAULT_MODELS = decorateModels('agnes', MODEL_PROVIDERS.agnes.models);
const DEFAULT_MCP_SERVERS = [
  {
    id: 'mcp_default_playwright',
    name: 'Playwright',
    description: '隔离式网页自动化与端到端测试。Z 内置浏览器无法满足脚本化测试需求时再使用。',
    command: 'npx',
    // Relative on purpose: the MCP runs with the task workspace as cwd, so its
    // screenshots and traces land in .zagent instead of the project tree.
    args: ['-y', '@playwright/mcp@latest', '--output-dir', '.zagent/playwright'],
    enabled: true,
    builtin: true
  },
  {
    id: 'mcp_default_codegraph',
    name: 'CodeGraph',
    description: '为当前工作区建立代码图并执行结构化代码检索与理解。',
    command: 'codegraph',
    args: ['serve', '--mcp'],
    enabled: true,
    builtin: true,
    runtime: 'codegraph',
    sourceVersion: '1.5.0'
  },
  createSerenaServer(dataDir)
];

function ensureDefaultMcp(servers) {
  const defaultIds = new Set(DEFAULT_MCP_SERVERS.map(server => server.id));
  const list = (Array.isArray(servers) ? servers : []).filter(server => (
    !server?.builtin
    || !String(server.id || '').startsWith('mcp_default_')
    || defaultIds.has(String(server.id || ''))
  ));
  for (const d of DEFAULT_MCP_SERVERS) {
    const normalizedName = d.name.toLowerCase();
    const idIndex = list.findIndex(server => server?.id === d.id);
    const builtinNameIndex = list.findIndex(server => (
      server?.builtin && String(server.name || '').toLowerCase() === normalizedName
    ));
    const index = idIndex >= 0 ? idIndex : builtinNameIndex;
    if (index < 0) {
      if (list.some(server => String(server?.name || '').toLowerCase() === normalizedName)) continue;
      list.push({ ...d });
      continue;
    }
    // Built-in definitions are migrated on load so existing installations do
    // not remain on a broken cached command after an application update.
    list[index] = {
      ...list[index],
      name: d.name,
      description: d.description,
      command: d.command,
      args: [...d.args],
      builtin: true,
      runtime: d.runtime,
      sourceVersion: d.sourceVersion,
      timeout: d.timeout,
      ...(d.env ? { env: { ...d.env } } : {})
    };
  }
  return list;
}

const DEFAULT_SKILLS = skillRegistry.getBuiltinSkills(appRoot);

function getMergedSkills(cfg) {
  return skillRegistry.getMergedSkillsForList(cfg, appRoot, dataDir);
}

function buildDefaultApiKeys() {
  const keys = {};
  for (const id of Object.keys(MODEL_PROVIDERS)) {
    keys[id] = '';
  }
  return keys;
}

function buildDefaultProviderConfigs() {
  const configs = {};
  for (const [id, provider] of Object.entries(MODEL_PROVIDERS)) {
    configs[id] = {
      baseUrl: provider.baseUrl,
      apiKey: '',
      imageGenerationUrl: '',
      imageEditUrl: '',
      workspaceId: ''
    };
  }
  return configs;
}

function normalizeProviderSupplier(raw, provider, fallbackId = 'official', fallbackName = '官方') {
  const value = raw && typeof raw === 'object' ? raw : {};
  const id = String(value.id || fallbackId).trim() || fallbackId;
  const name = String(value.name || fallbackName).trim() || fallbackName;
  return {
    id,
    name,
    kind: String(value.kind || (id === 'official' ? 'official' : 'custom')).trim() || 'custom',
    baseUrl: String(value.baseUrl || provider?.baseUrl || '').trim().replace(/\/$/, ''),
    apiKey: String(value.apiKey || '').trim(),
    imageGenerationUrl: String(value.imageGenerationUrl || '').trim(),
    imageEditUrl: String(value.imageEditUrl || '').trim(),
    videoGenerationUrl: String(value.videoGenerationUrl || '').trim(),
    workspaceId: String(value.workspaceId || '').trim(),
    models: normalizeRemoteModels(value.models || [])
  };
}

function buildDefaultProviderSuppliers() {
  const suppliers = {};
  for (const [id, provider] of Object.entries(MODEL_PROVIDERS)) {
    suppliers[id] = [normalizeProviderSupplier({
      id: 'official',
      name: '官方',
      kind: 'official',
      baseUrl: provider.baseUrl,
      models: provider.dynamicModels ? [] : provider.models
    }, provider)];
  }
  return suppliers;
}

function normalizeProviderConfig(raw, provider) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    baseUrl: String(value.baseUrl || provider.baseUrl || '').trim().replace(/\/$/, ''),
    apiKey: String(value.apiKey || '').trim(),
    imageGenerationUrl: String(value.imageGenerationUrl || '').trim(),
    imageEditUrl: String(value.imageEditUrl || '').trim(),
    videoGenerationUrl: String(value.videoGenerationUrl || '').trim(),
    workspaceId: String(value.workspaceId || '').trim()
  };
}

function normalizeCustomModelEntry(raw = {}, legacy = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const legacyValue = legacy && typeof legacy === 'object' ? legacy : {};
  const rawModels = Array.isArray(value.models) && value.models.length
    ? value.models
    : (Array.isArray(legacyValue.models) ? legacyValue.models : []);
  const firstModel = rawModels.find(model => model && typeof model === 'object' && model.id)
    || rawModels.find(model => typeof model === 'string');
  const modelId = String(value.modelId || firstModel?.id || firstModel || legacyValue.modelId || '').trim();
  const modelName = String(value.modelName || firstModel?.name || modelId || '自定义模型').trim() || '自定义模型';
  const model = modelId
    ? { id: modelId, name: modelName, modelType: 'text', source: 'custom' }
    : null;
  return {
    id: 'custom-model',
    name: '自定义模型',
    modelName,
    modelId,
    baseUrl: String(value.baseUrl || legacyValue.baseUrl || '').trim().replace(/\/$/u, ''),
    apiKey: String(value.apiKey || legacyValue.apiKey || '').trim(),
    apiFormat: String(value.apiFormat || legacyValue.apiFormat || 'openai').trim().toLowerCase() === 'anthropic'
      ? 'anthropic'
      : 'openai',
    models: model ? [model] : []
  };
}

// ---------------------------------------------------------------------------
// User-defined connections. The UI no longer exposes vendor cards: every API
// endpoint the user talks to is a "connection" — a flat list of named
// endpoints with their own key and POST URLs. Internally each connection
// points at a supplier entry; connections created from scratch get a dynamic
// `conn-*` provider registered below, while migrated ones keep pointing at
// the built-in provider they came from so every existing role binding,
// catalog cache, and media adapter keeps working unchanged.
// ---------------------------------------------------------------------------
function newConnectionId() {
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function findConnection(cfg, connectionId) {
  const id = String(connectionId || '').trim();
  if (!id) return null;
  return (cfg?.api?.connections || []).find(item => item.id === id) || null;
}

// The adapter shape a provider talks: built-in providers use their own id;
// connection providers resolve through their stored/auto preset.
function providerAdapterPreset(cfg, providerId) {
  const id = String(providerId || '');
  const provider = MODEL_PROVIDERS[id];
  if (provider?.connection) {
    const connection = (cfg?.api?.connections || []).find(item => item.providerId === id);
    return resolveConnectionPreset(connection, provider.name, provider.baseUrl);
  }
  return id;
}

// Registry-level preset (baked at registration) for media adapters and static
// media-model merges that do not carry a cfg handle.
function providerMediaPresetId(provider) {
  return provider?.connection ? (provider.preset || 'openai') : (provider?.id || '');
}

function providerCapabilityPresetId(provider) {
  return provider?.connection ? (provider.preset || 'openai') : (provider?.id || '');
}

function registerConnectionProvider(cfg, connection) {
  const providerId = String(connection?.providerId || '');
  if (!providerId.startsWith('conn-')) return;
  const supplier = (cfg.api?.providerSuppliers?.[providerId] || [])[0] || {};
  const name = String(supplier.name || connection.name || '新连接').trim() || '新连接';
  const preset = resolveConnectionPreset(connection, name, supplier.baseUrl);
  const manualModelId = String(connection.manualModelId || '').trim();
  MODEL_PROVIDERS[providerId] = {
    id: providerId,
    name,
    baseUrl: String(supplier.baseUrl || '').trim(),
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: !manualModelId,
    models: manualModelId
      ? [{ id: manualModelId, name: manualModelId, modelType: 'text', source: 'custom' }]
      : [],
    connection: true,
    custom: !!manualModelId,
    preset,
    apiFormat: resolveConnectionApiFormat(connection, name, supplier.baseUrl),
    streamEnabled: connection.streamEnabled !== false
  };
}

function syncConnectionProviders(cfg) {
  for (const key of Object.keys(MODEL_PROVIDERS)) {
    if (key.startsWith('custom-') || key.startsWith('conn-')) delete MODEL_PROVIDERS[key];
  }
  for (const connection of cfg?.api?.connections || []) {
    registerConnectionProvider(cfg, connection);
  }
}

// One-time migration: turn every configured supplier (and the legacy
// custom-model card) into a flat connection entry. Idempotent and additive —
// the underlying supplier data is never moved or rewritten.
function migrateLegacyConnections(cfg) {
  if (!cfg.api || typeof cfg.api !== 'object') cfg.api = {};
  if (cfg.api.connectionsMigrated === true) return;
  const connections = Array.isArray(cfg.api.connections) ? cfg.api.connections : [];
  for (const [providerId, suppliers] of Object.entries(cfg.api.providerSuppliers || {})) {
    if (providerId === 'custom-model' || providerId.startsWith('conn-')) continue;
    const activeId = String(cfg.api.providerActiveSupplierIds?.[providerId] || 'official');
    for (const supplier of Array.isArray(suppliers) ? suppliers : []) {
      // Older builds kept the active supplier's key only in the legacy
      // providerConfigs/apiKeys mirrors; honor those during migration.
      const mirroredKey = supplier.id === activeId
        ? (cfg.api.providerConfigs?.[providerId]?.apiKey || cfg.api.apiKeys?.[providerId])
        : '';
      if (!supplier?.apiKey && !mirroredKey) continue;
      connections.push({
        id: newConnectionId(),
        providerId,
        supplierId: String(supplier?.id || 'official'),
        preset: providerId,
        manualModelId: '',
        createdAt: Date.now()
      });
    }
  }
  const custom = cfg.customModel && (
    cfg.customModel.modelId || cfg.customModel.baseUrl || cfg.customModel.apiKey || cfg.customModel.models?.length
  )
    ? normalizeCustomModelEntry(cfg.customModel, {})
    : null;
  if (custom) {
    const providerId = newConnectionId();
    if (!cfg.api.providerSuppliers || typeof cfg.api.providerSuppliers !== 'object') cfg.api.providerSuppliers = {};
    cfg.api.providerSuppliers[providerId] = [{
      id: 'official',
      name: custom.modelName || custom.modelId || '自定义连接',
      kind: 'official',
      baseUrl: custom.baseUrl || '',
      apiKey: custom.apiKey || '',
      imageGenerationUrl: '',
      imageEditUrl: '',
      videoGenerationUrl: '',
      workspaceId: '',
      models: custom.models || []
    }];
    if (!cfg.api.providerActiveSupplierIds || typeof cfg.api.providerActiveSupplierIds !== 'object') {
      cfg.api.providerActiveSupplierIds = {};
    }
    cfg.api.providerActiveSupplierIds[providerId] = 'official';
    if (!cfg.providerModels || typeof cfg.providerModels !== 'object') cfg.providerModels = {};
    cfg.providerModels[providerId] = custom.models || [];
    connections.push({
      id: providerId,
      providerId,
      supplierId: 'official',
      preset: custom.apiFormat === 'anthropic' ? 'anthropic' : 'auto',
      manualModelId: custom.modelId || '',
      createdAt: Date.now()
    });
    if (cfg.agentModel?.providerId === 'custom-model') {
      cfg.agentModel = {
        ...cfg.agentModel,
        providerId,
        modelId: custom.modelId || cfg.agentModel.modelId,
        name: custom.modelName || custom.modelId || cfg.agentModel.name
      };
    }
    for (const role of ['image', 'video']) {
      if (cfg.media?.[`${role}Provider`] === 'custom-model') {
        cfg.media[`${role}Provider`] = providerId;
      }
    }
    if (cfg.api.provider === 'custom-model') cfg.api.provider = providerId;
    delete cfg.api.providerSuppliers['custom-model'];
    delete cfg.api.providerActiveSupplierIds?.['custom-model'];
    delete cfg.api.providerConfigs?.['custom-model'];
    delete cfg.api.apiKeys?.['custom-model'];
    delete cfg.providerModels?.['custom-model'];
    delete MODEL_PROVIDERS['custom-model'];
    cfg.customModel = null;
    cfg.customProviders = [];
  }
  cfg.api.connections = connections;
  cfg.api.connectionsMigrated = true;
}

function ensureProviderConfigs(cfg) {
  if (!cfg.api || typeof cfg.api !== 'object') cfg.api = {};
  if (!cfg.api.providerSuppliers || typeof cfg.api.providerSuppliers !== 'object') {
    cfg.api.providerSuppliers = buildDefaultProviderSuppliers();
  }
  if (!cfg.api.providerActiveSupplierIds || typeof cfg.api.providerActiveSupplierIds !== 'object') {
    cfg.api.providerActiveSupplierIds = {};
  }
  if (!cfg.api.providerConfigs || typeof cfg.api.providerConfigs !== 'object') {
    cfg.api.providerConfigs = buildDefaultProviderConfigs();
  }
  if (!cfg.api.apiKeys) cfg.api.apiKeys = buildDefaultApiKeys();
  for (const [id, provider] of Object.entries(MODEL_PROVIDERS)) {
    const legacy = normalizeProviderConfig(cfg.api.providerConfigs[id], provider);
    let suppliers = Array.isArray(cfg.api.providerSuppliers[id])
      ? cfg.api.providerSuppliers[id].map(item => normalizeProviderSupplier(item, provider))
      : [];
    if (!suppliers.length) {
      suppliers = [normalizeProviderSupplier({
        id: 'official',
        name: provider.custom ? '自定义模型' : '官方',
        kind: 'official',
        ...legacy,
        models: cfg.providerModels?.[id] || (provider.dynamicModels ? [] : provider.models)
      }, provider)];
    }
    let activeId = String(cfg.api.providerActiveSupplierIds[id] || '').trim();
    if (!activeId || !suppliers.some(item => item.id === activeId)) {
      activeId = suppliers.find(item => item.id === 'official')?.id || suppliers[0].id;
    }
    const active = suppliers.find(item => item.id === activeId) || suppliers[0];
    const legacyKey = cfg.api.apiKeys[id];
    if (!active.apiKey && legacy.apiKey) active.apiKey = legacy.apiKey;
    if (!active.apiKey && legacyKey) active.apiKey = String(legacyKey).trim();
    if (!active.baseUrl && legacy.baseUrl) active.baseUrl = legacy.baseUrl;
    cfg.api.providerSuppliers[id] = suppliers;
    cfg.api.providerActiveSupplierIds[id] = activeId;
    const current = normalizeProviderConfig(active, provider);
    cfg.api.providerConfigs[id] = current;
    cfg.api.apiKeys[id] = current.apiKey;
    if (!cfg.providerModels || typeof cfg.providerModels !== 'object') cfg.providerModels = {};
    cfg.providerModels[id] = active.models.length
      ? active.models
      : (cfg.providerModels[id] || (provider.dynamicModels ? [] : provider.models));
    active.models = normalizeRemoteModels(cfg.providerModels[id] || []);
  }
  const providerIds = new Set(Object.keys(MODEL_PROVIDERS));
  for (const key of Object.keys(cfg.api.providerConfigs)) {
    if (!providerIds.has(key)) delete cfg.api.providerConfigs[key];
  }
  for (const key of Object.keys(cfg.api.apiKeys)) {
    if (!providerIds.has(key)) delete cfg.api.apiKeys[key];
  }
  if (cfg.providerModels && typeof cfg.providerModels === 'object') {
    for (const key of Object.keys(cfg.providerModels)) {
      if (!providerIds.has(key)) delete cfg.providerModels[key];
    }
  }
  return cfg.api.providerConfigs;
}

function getProviderConnection(cfg, providerId) {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return {
    baseUrl: '',
    apiKey: '',
    imageGenerationUrl: '',
    imageEditUrl: '',
    videoGenerationUrl: '',
    workspaceId: ''
  };
  ensureProviderConfigs(cfg);
  return normalizeProviderConfig(cfg.api.providerConfigs[providerId], provider);
}

/**
 * Resolve a supplier without changing the provider-wide UI cursor.  The
 * provider-wide active supplier is retained for the settings dialog and for
 * backwards compatibility, while runtime roles carry their own supplierId.
 */
function getProviderSupplier(cfg, providerId, supplierId = '') {
  const suppliers = getProviderSuppliers(cfg, providerId);
  const requested = String(supplierId || '').trim();
  const activeId = requested || String(cfg.api.providerActiveSupplierIds?.[providerId] || '').trim();
  return suppliers.find(item => item.id === activeId)
    || suppliers.find(item => item.id === 'official')
    || suppliers[0]
    || null;
}

function getProviderConnectionForSupplier(cfg, providerId, supplierId = '') {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return normalizeProviderConfig({}, { baseUrl: '' });
  const supplier = getProviderSupplier(cfg, providerId, supplierId);
  return normalizeProviderConfig(supplier || cfg.api?.providerConfigs?.[providerId], provider);
}

function getProviderSuppliers(cfg, providerId) {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return [];
  ensureProviderConfigs(cfg);
  const raw = Array.isArray(cfg.api.providerSuppliers?.[providerId])
    ? cfg.api.providerSuppliers[providerId]
    : [];
  cfg.api.providerSuppliers[providerId] = raw.map(item => normalizeProviderSupplier(item, provider));
  return cfg.api.providerSuppliers[providerId];
}

// After the connection migration, the flat connection list is the source of
// truth for which supplier is enabled. Credentials and cached catalogs can be
// intentionally retained for a later re-enable, but they must not contribute
// models while their connection card is absent.
function isSupplierListedAsConnection(cfg, providerId, supplierId) {
  if (cfg?.api?.connectionsMigrated !== true) return true;
  const id = String(providerId || '').trim();
  const supplier = String(supplierId || '').trim();
  return Array.isArray(cfg?.api?.connections)
    && cfg.api.connections.some(connection => (
      String(connection?.providerId || '').trim() === id
      && String(connection?.supplierId || '').trim() === supplier
    ));
}

function isConfiguredSupplier(cfg, providerId, supplier) {
  return !!supplier
    && !!String(supplier.apiKey || '').trim()
    && isSupplierListedAsConnection(cfg, providerId, supplier.id);
}

function pruneUnlistedSupplierState(cfg) {
  if (cfg?.api?.connectionsMigrated !== true) return false;
  const connections = Array.isArray(cfg.api.connections) ? cfg.api.connections : [];
  let changed = false;
  for (const providerId of Object.keys(MODEL_PROVIDERS)) {
    const provider = MODEL_PROVIDERS[providerId];
    const suppliers = Array.isArray(cfg.api.providerSuppliers?.[providerId])
      ? cfg.api.providerSuppliers[providerId]
      : [];
    const listedIds = new Set(connections
      .filter(connection => String(connection?.providerId || '').trim() === providerId)
      .map(connection => String(connection?.supplierId || '').trim())
      .filter(Boolean));
    for (const supplier of suppliers) {
      if (listedIds.has(String(supplier.id || '').trim())) continue;
      const clearCatalog = !!provider?.dynamicModels || !!String(supplier.apiKey || '').trim();
      if (supplier.apiKey || (clearCatalog && supplier.models?.length) || supplier.imageGenerationUrl
        || supplier.imageEditUrl || supplier.videoGenerationUrl || supplier.workspaceId) {
        supplier.apiKey = '';
        if (clearCatalog) supplier.models = [];
        supplier.imageGenerationUrl = '';
        supplier.imageEditUrl = '';
        supplier.videoGenerationUrl = '';
        supplier.workspaceId = '';
        changed = true;
      }
    }
    const hasEnabledSupplier = suppliers.some(supplier => (
      listedIds.has(String(supplier.id || '').trim())
      && !!String(supplier.apiKey || '').trim()
    ));
    if (!hasEnabledSupplier) {
      if (provider?.dynamicModels && Array.isArray(cfg.providerModels?.[providerId]) && cfg.providerModels[providerId].length) {
        cfg.providerModels[providerId] = [];
        changed = true;
      }
      if (cfg.api.apiKeys?.[providerId]) {
        cfg.api.apiKeys[providerId] = '';
        changed = true;
      }
      if (cfg.api.providerConfigs?.[providerId]?.apiKey) {
        cfg.api.providerConfigs[providerId].apiKey = '';
        changed = true;
      }
    }
  }
  return changed;
}

function getConfiguredSupplierEntries(cfg) {
  const entries = [];
  for (const [providerId, suppliers] of Object.entries(cfg?.api?.providerSuppliers || {})) {
    if (!MODEL_PROVIDERS[providerId] || !Array.isArray(suppliers)) continue;
    for (const supplier of suppliers) {
      if (!isConfiguredSupplier(cfg, providerId, supplier)) continue;
      entries.push({ providerId, supplierId: String(supplier.id || ''), supplier });
    }
  }
  return entries.filter(entry => entry.supplierId);
}

function getActiveProviderSupplier(cfg, providerId) {
  const suppliers = getProviderSuppliers(cfg, providerId);
  const activeId = String(cfg.api.providerActiveSupplierIds?.[providerId] || '').trim();
  return suppliers.find(item => item.id === activeId) || suppliers[0] || null;
}

function syncActiveProviderSupplier(cfg, providerId, supplier) {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider || !supplier) return;
  const normalized = normalizeProviderSupplier(supplier, provider);
  cfg.api.providerActiveSupplierIds[providerId] = normalized.id;
  cfg.api.providerConfigs[providerId] = normalizeProviderConfig(normalized, provider);
  cfg.api.apiKeys[providerId] = normalized.apiKey;
  if (!cfg.providerModels) cfg.providerModels = {};
  cfg.providerModels[providerId] = normalized.models || [];
}

function rebindRolesAfterSupplierRemoval(cfg, providerId, supplierId) {
  const removed = String(supplierId || '').trim();
  if (!removed) return;
  const providerOrder = [providerId, ...Object.keys(MODEL_PROVIDERS).filter(id => id !== providerId)];
  const pick = (role, currentModelId) => {
    let first = null;
    for (const candidateProviderId of providerOrder) {
      for (const supplier of getProviderSuppliers(cfg, candidateProviderId)) {
        if (!supplier.apiKey || (candidateProviderId === providerId && supplier.id === removed)) continue;
        const models = getProviderSupplierCatalog(candidateProviderId, supplier);
        const exact = models.find(model => model.id === currentModelId && getModelType(candidateProviderId, model) === role);
        if (exact) return { providerId: candidateProviderId, supplier, model: exact };
        const model = models.find(item => getModelType(candidateProviderId, item) === role);
        if (!first && model) first = { providerId: candidateProviderId, supplier, model };
      }
    }
    return first;
  };

  if (cfg.agentModel?.providerId === providerId && cfg.agentModel?.supplierId === removed) {
    const replacement = pick('text', cfg.agentModel.modelId);
    if (replacement) {
      cfg.agentModel.providerId = replacement.providerId;
      cfg.agentModel.supplierId = replacement.supplier.id;
      cfg.agentModel.modelId = replacement.model.id;
      cfg.agentModel.name = replacement.model.name || replacement.model.id;
      cfg.agentModel.capabilities = replacement.model.capabilities || {};
      const connection = getProviderConnectionForSupplier(cfg, replacement.providerId, replacement.supplier.id);
      cfg.api.provider = replacement.providerId;
      cfg.api.baseUrl = connection.baseUrl;
      cfg.api.apiKey = connection.apiKey;
      cfg.api.model = replacement.model.id;
      cfg.models = getProviderModels(cfg, replacement.providerId, replacement.supplier.id);
    } else {
      cfg.agentModel.supplierId = '';
      cfg.agentModel.modelId = '';
    }
  }

  for (const role of ['image', 'video']) {
    if (cfg.media?.[`${role}Provider`] !== providerId || cfg.media?.[`${role}SupplierId`] !== removed) continue;
    const replacement = pick(role, cfg.media[`${role}Model`]);
    if (replacement) {
      cfg.media[`${role}Provider`] = replacement.providerId;
      cfg.media[`${role}SupplierId`] = replacement.supplier.id;
      cfg.media[`${role}Model`] = replacement.model.id;
      cfg.media[`${role}Name`] = replacement.model.name || replacement.model.id;
    } else {
      cfg.media[`${role}Provider`] = '';
      cfg.media[`${role}Model`] = '';
      cfg.media[`${role}SupplierId`] = '';
      cfg.media[`${role}Name`] = '';
    }
  }
}

function mergeProviderModelCatalog(...groups) {
  const models = new Map();
  for (const group of groups) {
    for (const model of Array.isArray(group) ? group : []) {
      const id = String(model?.id || '').trim();
      if (!id) continue;
      models.set(id, { ...(models.get(id) || {}), ...model, id });
    }
  }
  return [...models.values()];
}

function getProviderModels(cfg, providerId, supplierId = '') {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return [];
  const mediaPresetId = providerMediaPresetId(provider);
  const activeSupplier = getProviderSupplier(cfg, providerId, supplierId);
  const apiModels = provider.dynamicModels
    ? normalizeRemoteModels(activeSupplier?.models || cfg?.providerModels?.[providerId] || [])
    : mergeProviderModelCatalog(provider.models, activeSupplier?.models || []);
  const models = buildSelectableModelCatalog(
    apiModels,
    STATIC_PROVIDER_SUPPLEMENTAL_MODELS[mediaPresetId] || []
  );
  return decorateModels(providerCapabilityPresetId(provider), models);
}

function getRoleSupplierId(cfg, role, providerId) {
  const id = String(providerId || '').trim();
  if (!id) return '';
  if (role === 'text') {
    if (cfg.agentModel?.providerId === id && cfg.agentModel?.supplierId) {
      return String(cfg.agentModel.supplierId).trim();
    }
  } else if (role === 'image' || role === 'video') {
    if (cfg.media?.[`${role}Provider`] === id && cfg.media?.[`${role}SupplierId`]) {
      return String(cfg.media[`${role}SupplierId`]).trim();
    }
  }
  return String(cfg.api?.providerActiveSupplierIds?.[id] || '').trim();
}

function getProviderSupplierApiCatalog(providerId, supplier) {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider || !supplier) return [];
  const models = provider.dynamicModels
    ? normalizeRemoteModels(supplier.models || [])
    : mergeProviderModelCatalog(
        provider.models,
        supplier.models || []
      );
  return decorateModels(providerCapabilityPresetId(provider), models);
}

function getProviderSupplierCatalog(providerId, supplier) {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider || !supplier) return [];
  const models = buildSelectableModelCatalog(
    getProviderSupplierApiCatalog(providerId, supplier),
    STATIC_PROVIDER_SUPPLEMENTAL_MODELS[providerMediaPresetId(provider)] || []
  );
  return decorateModels(providerCapabilityPresetId(provider), models);
}

function getChildReadableAppRoot() {
  return appRoot.endsWith('app.asar') ? `${appRoot}.unpacked` : appRoot;
}

function getConfiguredMediaModels(cfg) {
  updateImageGenerationConfig(cfg);
  const media = cfg.media || {};
  return ['image', 'video'].flatMap(role => {
    const providerId = String(media[`${role}Provider`] || '');
    const modelId = String(media[`${role}Model`] || '');
    const supplierId = String(media[`${role}SupplierId`] || getRoleSupplierId(cfg, role, providerId) || '');
    if (!providerId || !modelId) return [];
    const model = getProviderModels(cfg, providerId, supplierId).find(item => item.id === modelId);
    return model ? [{
      role,
      providerId,
      supplierId,
      providerName: MODEL_PROVIDERS[providerId]?.name || providerId,
      modelId,
      modelName: model.name || modelId
    }] : [];
  });
}

function buildZMediaMcpServer(cfg, childAppRoot, options = {}) {
  const configured = getConfiguredMediaModels(cfg);
  // NOTE: nothing per-run may enter this env — the whole config feeds
  // configSignature() and any per-run value restarts the kernel / breaks
  // concurrent runs. The run workspace is delivered through the registry
  // file (see registerMediaWorkspace), read dynamically per tool call.
  const runtime = {
    access: {
      accessMode: String(cfg.agent?.accessMode || 'request'),
      allowFileRead: cfg.permissions?.allowFileRead !== false,
      allowNetwork: cfg.permissions?.allowNetwork !== false
    },
    vision: {
      enabled: cfg.api?.visionRelayEnabled !== false,
      models: getVisionRelayModels(cfg)
    }
  };
  for (const selection of configured) {
    const connection = getProviderConnectionForSupplier(cfg, selection.providerId, selection.supplierId);
    if (!connection.apiKey) continue;
    if (selection.role === 'image' && cfg.imageGeneration?.available) {
      runtime.image = {
        ...selection,
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        strategy: cfg.imageGeneration.strategy,
        providerOptions: {
          workspaceId: connection.workspaceId,
          adapterKind: providerAdapterPreset(cfg, selection.providerId)
        },
        imageEndpoints: {
          generations: connection.imageGenerationUrl,
          edits: connection.imageEditUrl
        }
      };
    }
    if (selection.role === 'video' && cfg.videoGeneration?.available) {
      runtime.video = {
        ...selection,
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        providerOptions: {
          workspaceId: connection.workspaceId,
          videoGenerationUrl: connection.videoGenerationUrl,
          adapterKind: providerAdapterPreset(cfg, selection.providerId)
        }
      };
    }
  }
  return {
    id: 'z_media',
    name: 'Z 媒体',
    description: cfg.api?.visionRelayEnabled === false
      ? '调用当前会话选定的生图与生视频次模型。'
      : '通过视觉中继读取本地或历史生成图片，并调用当前会话选定的生图与生视频次模型。',
    runtime: 'z-media',
    command: process.execPath,
    args: [path.join(childAppRoot, 'lib', 'z-media-mcp.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      Z_MEDIA_RUNTIME: Buffer.from(JSON.stringify(runtime), 'utf8').toString('base64'),
      Z_MEDIA_DATA_DIR: dataDir,
      Z_MEDIA_WORKSPACE_REGISTRY: mediaWorkspaceRegistryPath
    },
    enabled: true,
    builtin: true,
    systemManaged: true,
    timeout: 12 * 60 * 1000
  };
}

function buildZSkillsMcpServer(cfg, childAppRoot, options = {}) {
  const entry = path.join(childAppRoot, 'lib', 'z-skills-mcp.js');
  const cli = path.join(childAppRoot, 'node_modules', 'skills', 'bin', 'cli.mjs');
  return {
    id: 'z_skills',
    name: 'Z 技能',
    description: '查找、安装、列出、读取和删除 Z 的 Skill；未选择工作区时也可使用。',
    runtime: 'z-skills',
    command: process.execPath,
    args: [entry],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      Z_SKILLS_ROOT: skillsDir,
      Z_SKILLS_DATA_DIR: dataDir,
      Z_SKILLS_CONFIG_PATH: configPath,
      Z_SKILLS_APP_ROOT: childAppRoot,
      Z_SKILLS_CLI: cli,
      Z_SKILLS_ALLOW_NETWORK: cfg.permissions?.allowNetwork === false ? 'false' : 'true',
      // Lets high-throughput models request larger lossless Skill chunks.
      // The MCP keeps a 10000-token/s default when older configs omit it.
      Z_INPUT_TOKENS_PER_SECOND: String(
        Math.max(DEFAULT_INPUT_TOKENS_PER_SECOND, normalizeInputTokensPerSecond(
          cfg.api?.inputTokensPerSecond || cfg.agent?.inputTokensPerSecond
        ))
      )
    },
    enabled: true,
    builtin: true,
    systemManaged: true,
    timeout: 12 * 60 * 1000
  };
}

function buildZBrowserMcpServer(cfg, childAppRoot) {
  if (!browserAgentBridgePort) return null;
  return {
    id: 'z_browser',
    name: 'Z 内置浏览器',
    description: '控制 Z 右侧可见的内置浏览器，用于网页阅读、交互与视觉验收。',
    runtime: 'z-browser',
    command: process.execPath,
    args: [path.join(childAppRoot, 'lib', 'z-browser-mcp.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      Z_BROWSER_BRIDGE_PORT: String(browserAgentBridgePort),
      Z_BROWSER_BRIDGE_TOKEN: browserAgentBridgeToken,
      Z_BROWSER_ALLOW_NETWORK: cfg.permissions?.allowNetwork === false ? 'false' : 'true'
    },
    enabled: true,
    builtin: true,
    systemManaged: true,
    timeout: 150_000
  };
}

function buildZWebMcpServer(cfg, childAppRoot) {
  return {
    id: 'z_web',
    name: 'Z 网页读取',
    description: '直接抓取静态资源并落盘（图标、图片、SVG、字体、压缩包等），已知 URL 的文本/页面也可直接读取；不需要打开内置浏览器，搜索仍优先 AnySearch。',
    runtime: 'z-web',
    command: process.execPath,
    args: [path.join(childAppRoot, 'lib', 'z-web-mcp.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      Z_WEB_CONTEXT_DIR: path.join(dataDir, 'harness', 'runtime'),
      Z_WEB_ALLOW_NETWORK: cfg.permissions?.allowNetwork === false ? 'false' : 'true'
    },
    enabled: true,
    builtin: true,
    systemManaged: true,
    timeout: 120_000
  };
}

function buildZSessionMcpServer(childAppRoot) {
  if (!sessionAgentBridgePort) return null;
  return {
    id: 'z_session',
    name: 'Z 会话',
    description: '在用户明确授权后进入另一工作区的最新 Z 任务；目标工作区没有任务时才创建并交接上下文。',
    runtime: 'z-session',
    command: process.execPath,
    args: [path.join(childAppRoot, 'lib', 'z-session-mcp.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      Z_SESSION_BRIDGE_PORT: String(sessionAgentBridgePort),
      Z_SESSION_BRIDGE_TOKEN: sessionAgentBridgeToken
    },
    enabled: true,
    builtin: true,
    systemManaged: true,
    timeout: 300_000
  };
}

function buildZHarnessMcpServer(childAppRoot) {
  return {
    id: 'z_harness',
    name: 'Z 持续改进',
    description: '将重复失败、可复用策略或子智能体角色排队，在本轮完成后进行证据化演进；运行中不会改写当前提示。',
    runtime: 'z-harness',
    command: process.execPath,
    args: [path.join(childAppRoot, 'lib', 'z-harness-mcp.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      Z_HARNESS_CONTEXT_DIR: path.join(dataDir, 'harness', 'runtime'),
      Z_HARNESS_GLOBAL_STATE_PATH: continualHarnessPath
    },
    enabled: true,
    builtin: true,
    systemManaged: true,
    timeout: 180_000
  };
}

function buildZAnalysisMcpServer(cfg, childAppRoot) {
  // Config-signature stable on purpose: no per-run values (workspace) here.
  // Task context carries workspace authorization without restarting the MCP.
  return {
    id: 'z_analysis',
    name: 'Z 项目分析',
    description: '确定性代码理解工具：repo map、符号大纲与精读、调用树、BM25 代码/历史检索。供分析与逆向子代理及主任务使用。',
    runtime: 'z-analysis',
    command: process.execPath,
    args: [path.join(childAppRoot, 'lib', 'z-analysis-mcp.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      Z_ANALYSIS_CONTEXT_DIR: path.join(dataDir, 'harness', 'runtime')
    },
    enabled: true,
    builtin: true,
    systemManaged: true,
    timeout: 120_000
  };
}

function buildZWorkspaceMcpServer(cfg, childAppRoot) {
  // Config-signature stable like z_analysis: workspace authorization flows
  // through the per-run harness context file, not the server environment.
  return {
    id: 'z_workspace',
    name: 'Z 工作区',
    description: '工作区工程工具：任务级 git worktree 创建/合并/清理（并行 builder 隔离）与 code_impact 反向依赖影响面检查。',
    runtime: 'z-workspace',
    command: process.execPath,
    args: [path.join(childAppRoot, 'lib', 'z-workspace-mcp.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      Z_WORKSPACE_CONTEXT_DIR: path.join(dataDir, 'harness', 'runtime')
    },
    enabled: true,
    builtin: true,
    systemManaged: true,
    timeout: 120_000
  };
}

function selectedSkillIds(skills) {
  return new Set((Array.isArray(skills) ? skills : []).map(skill => (
    String(skill?.id || skill || '').trim().toLowerCase()
  )).filter(Boolean));
}

function shouldEnableSerenaForRun(options = {}) {
  if (!workspaceSandbox.normalizeWorkspace(options.workspace)) return false;
  if (String(options.workMode || '') === 'goal') return true;
  return selectedSkillIds(options.selectedSkills).has('z-serena');
}

function inferMcpTaskCapabilities(options = {}) {
  // Per-run MCP trimming may only react to construction-level facts about
  // what this run physically has — never to prompt or attachment content.
  // Keyword guessing cannot be exhaustive (v1.6.0 regression: "画一张海报"
  // missed the media list and the session was silently denied z_media
  // mid-conversation), and a wrong deny is a hard capability loss, so
  // intent-derived trimming is forbidden. Builtins already gate their own
  // existence at build time (media models configured, browser bridge ready,
  // desktop on win32); the only exact trim left is workspace indexers
  // (codegraph/serena/playwright e2e) in runs that have no workspace.
  if (!Object.prototype.hasOwnProperty.call(options, 'workspace')) {
    return { media: true, browser: true, session: true, desktop: true, code: true, playwright: true };
  }
  const hasWorkspace = !!workspaceSandbox.normalizeWorkspace(options.workspace);
  return {
    media: true,
    browser: true,
    session: true,
    desktop: true,
    code: hasWorkspace,
    playwright: hasWorkspace
  };
}

function isDesktopTaskRequest({ prompt = '' } = {}) {
  const text = String(prompt || '').toLowerCase();
  // This is intentionally narrower than desktop MCP capability exposure:
  // the desktop server stays available for every run, but only an explicit
  // desktop/software intent downgrades the otherwise full-access shell.
  return /电脑|桌面|窗口|软件|应用|鼠标|键盘|点开|点击|拖拽|播放歌曲|打开(?:波点音乐|记事本|计算器|浏览器)|computer\s*use|desktop\s*(?:task|control)|gui\s*(?:task|automation)|open\s+(?:the\s+)?(?:app|window)/i.test(text);
}

function withTaskCapability(server, enabled) {
  return server ? { ...server, taskEnabled: enabled !== false } : server;
}

function getOpenCodeMcpServers(cfg, options = {}) {
  const childAppRoot = getChildReadableAppRoot();
  if (options.skillOnly) {
    return [buildZSkillsMcpServer(cfg, childAppRoot, options)];
  }
  const capabilities = inferMcpTaskCapabilities(options);
  const serenaEnabled = shouldEnableSerenaForRun(options);
  const servers = (cfg.mcpServers || []).flatMap(server => {
    if (server?.runtime === 'serena' || String(server?.id || '') === 'mcp_default_serena') {
      if (options.includeInactiveSerena) return [server];
      if (!serenaEnabled) return [];
      return [withTaskCapability(createSerenaServer(dataDir, { workspace: options.workspace }), capabilities.code)];
    }
    const id = String(server?.id || '');
    if (id === 'mcp_default_playwright') return [withTaskCapability(server, capabilities.playwright)];
    if (id === 'mcp_default_codegraph' && !capabilities.code) return [withTaskCapability(server, false)];
    if (server?.runtime !== 'codegraph' && String(server?.command || '').toLowerCase() !== 'codegraph') {
      return [withTaskCapability(server, true)];
    }
    if (process.platform !== 'win32') return [withTaskCapability(server, capabilities.code)];
    const runtime = codeGraphRuntime.resolveRuntime(appRoot);
    if (!runtime.ok) return [withTaskCapability(server, capabilities.code)];
    return [withTaskCapability({
      ...server,
      command: runtime.command,
      args: [...runtime.args, ...(Array.isArray(server.args) ? server.args : [])],
      env: { ...runtime.env, ...(server.env || {}) }
    }, capabilities.code)];
  });
  const mediaServer = buildZMediaMcpServer(cfg, childAppRoot, options);
  if (mediaServer) servers.push(withTaskCapability(mediaServer, capabilities.media));
  servers.push(withTaskCapability(buildZSkillsMcpServer(cfg, childAppRoot, options), true));
  const browserServer = buildZBrowserMcpServer(cfg, childAppRoot);
  if (browserServer) servers.push(withTaskCapability(browserServer, capabilities.browser));
  const sessionServer = buildZSessionMcpServer(childAppRoot);
  if (sessionServer) servers.push(withTaskCapability(sessionServer, capabilities.session));
  const harnessServer = buildZHarnessMcpServer(childAppRoot, options);
  // Self-evolution is opt-in per run: outside its own work mode the Harness
  // tools are denied for the session. taskEnabled stays out of the shared
  // config signature, so switching modes never restarts the kernel.
  if (harnessServer) servers.push(withTaskCapability(harnessServer, options.evolutionMode !== false));
  // Unconditional: the server is lightweight, workspace-less until called, and
  // its presence must not vary with run capabilities (the OpenCode config
  // signature has to stay identical across tasks).
  servers.push(withTaskCapability(buildZAnalysisMcpServer(cfg, childAppRoot), true));
  servers.push(withTaskCapability(buildZWorkspaceMcpServer(cfg, childAppRoot), true));
  // Unconditional like z_analysis: the tool process stays workspace-less
  // until call time, and the shared kernel signature must not vary by run.
  servers.push(withTaskCapability(buildZWebMcpServer(cfg, childAppRoot), true));
  return servers;
}

function getMcpManagementServers(cfg) {
  const servers = getOpenCodeMcpServers(cfg, { includeInactiveSerena: true });
  const unavailableSystemServers = [];

  if (!servers.some(server => server.id === 'z_media')) {
    unavailableSystemServers.push({
      id: 'z_media',
      name: 'Z 媒体',
      description: '调用当前会话选定的图像与视频模型，并维护可继续修改的媒体上下文。',
      runtime: 'z-media',
      enabled: false,
      available: false,
      unavailableReason: '请先在输入框中选择图像或视频次模型',
      builtin: true,
      systemManaged: true
    });
  }

  if (!servers.some(server => server.id === 'z_browser')) {
    unavailableSystemServers.push({
      id: 'z_browser',
      name: 'Z 内置浏览器',
      description: '控制 Z 右侧可见的内置浏览器，用于网页阅读、交互与视觉验收。',
      runtime: 'z-browser',
      enabled: false,
      available: false,
      unavailableReason: '内置浏览器桥接尚未就绪',
      builtin: true,
      systemManaged: true
    });
  }

  if (!servers.some(server => server.id === 'z_session')) {
    unavailableSystemServers.push({
      id: 'z_session',
      name: 'Z 会话',
      description: '在用户明确授权后进入另一工作区的最新 Z 任务；目标工作区没有任务时才创建并交接上下文。',
      runtime: 'z-session',
      enabled: false,
      available: false,
      unavailableReason: '会话桥接尚未就绪',
      builtin: true,
      systemManaged: true
    });
  }

  return [...servers, ...unavailableSystemServers].map(server => ({
    id: String(server.id || ''),
    name: String(server.name || server.id || ''),
    description: String(server.description || ''),
    command: server.systemManaged ? '' : String(server.command || ''),
    args: server.systemManaged ? [] : (Array.isArray(server.args) ? server.args.map(String) : []),
    enabled: !!server.enabled,
    available: server.available !== false,
    unavailableReason: String(server.unavailableReason || ''),
    builtin: !!server.builtin,
    systemManaged: !!server.systemManaged,
    runtime: String(server.runtime || ''),
    sourceVersion: String(server.sourceVersion || ''),
    // Management views distinguish configured servers from live connections.
    status: server.systemManaged
      ? (server.available === false ? '不可用' : '随任务启动')
      : (mcpServers.has(String(server.id || '')) ? 'connected' : (server.type === 'remote' ? '远程 · 按需连接' : 'stopped')),
    type: server.type === 'remote' ? 'remote' : 'local',
    url: server.type === 'remote' ? String(server.url || '') : '',
    headerCount: server.type === 'remote' && server.headers && typeof server.headers === 'object'
      ? Object.keys(server.headers).length
      : 0
  }));
}

function getMcpServerConfig(cfg, id) {
  return getOpenCodeMcpServers(cfg, { includeInactiveSerena: true }).find(server => server.id === id) || null;
}

function getOpenCodeRuntimeConfig(cfg = loadConfig(), options = {}) {
  const selection = normalizeAgentModelSelection(cfg);
  const providerId = selection.providerId || cfg.api?.provider;
  const provider = MODEL_PROVIDERS[providerId] || { id: providerId, name: providerId };
  const connectionRecord = (cfg.api?.connections || []).find(item => item.providerId === providerId) || {};
  const connection = getProviderConnectionForSupplier(cfg, providerId, selection.supplierId);
  const model = getProviderModels(cfg, providerId, selection.supplierId).find(item => item.id === selection.modelId) || selection;
  return buildOpenCodeConfig({
    providerId,
    providerName: provider.name || providerId,
    modelId: selection.modelId,
    modelName: model.name || selection.name || selection.modelId,
    capabilities: model.capabilities || selection.capabilities || {},
    maxOutputTokens: selection.maxOutputTokens,
    contextWindow: cfg.context?.maxTokens,
    compactionThreshold: cfg.context?.compactionThreshold,
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    apiFormat: provider.apiFormat || 'openai',
    streamEnabled: (connectionRecord.streamEnabled ?? provider.streamEnabled) !== false,
    // Explicit DSML signal for user connections whose preset resolved to
    // deepseek; the sidecar keeps its own name/model inference as fallback.
    dsml: providerAdapterPreset(cfg, providerId) === 'deepseek' ? true : undefined,
    glmm: providerAdapterPreset(cfg, providerId) === 'glm' ? true : undefined,
    qwem: providerAdapterPreset(cfg, providerId) === 'qwen' ? true : undefined,
    kiml: providerAdapterPreset(cfg, providerId) === 'kimi' ? true : undefined,
    gptl: providerAdapterPreset(cfg, providerId) === 'gptl' ? true : undefined,
    deepSeekProviderModule: stageDeepSeekProviderModule({ appRoot, dataDir }),
    codingEnvironmentModule: stageCodingEnvironmentModule({ appRoot, dataDir }),
    glmmProviderModule: stageGlmmProviderModule({ appRoot, dataDir }),
    qwemProviderModule: stageQwemProviderModule({ appRoot, dataDir }),
    kimlProviderModule: stageKimlProviderModule({ appRoot, dataDir }),
    responsesProviderModule: stageResponsesProviderModule({ appRoot, dataDir }),
    gptlProviderModule: stageGptlProviderModule({ appRoot, dataDir }),
    reasoningSpeed: options.reasoningSpeed || cfg.api?.reasoningSpeed,
    visionRelayEnabled: cfg.api?.visionRelayEnabled !== false,
    zTaskId: String(options.taskId || '').trim(),
    inputTokensPerSecond: Math.max(DEFAULT_INPUT_TOKENS_PER_SECOND, normalizeInputTokensPerSecond(
      cfg.api?.inputTokensPerSecond || cfg.agent?.inputTokensPerSecond
    )),
    // Learned per-(provider, model) prefill rate from previous runs. Zero
    // until a trustworthy measurement exists; the sidecar then lets this real
    // value override the declared baseline everywhere it matters.
    measuredInputTokensPerSecond: Number(
      cfg.api?.inputThroughput?.[measurementKey(providerId, selection.modelId)]?.tokensPerSecond
    ) || 0,
    workMode: cfg.agent?.workMode,
    accessMode: cfg.agent?.accessMode,
    disableKernelFormatter: cfg.agent?.disableAutoFormatter === true,
    permissions: cfg.permissions,
    enableSubagents: cfg.agent?.enableSubagents === true,
    subagentRoles: cfg.agent?.subagentRoles,
    subagentMaxChildren: cfg.agent?.subagentMaxChildren,
    skillOnly: options.skillOnly === true,
    zSkillDirectory: skillsDir,
    mcpServers: Array.isArray(options.mcpServers) ? options.mcpServers : getOpenCodeMcpServers(cfg)
  });
}

function getOpenCodeCapabilityContext(cfg, mcpServers, options = {}) {
  const skippedIds = new Set((Array.isArray(options.skippedSkills) ? options.skippedSkills : [])
    .map(skill => String(skill?.id || '').trim().toLowerCase()).filter(Boolean));
  const skills = getMergedSkills(cfg).filter(skill => !skill.userOnly && !skippedIds.has(String(skill?.id || '').trim().toLowerCase())).map(skill => ({
    id: String(skill.id || ''),
    name: String(skill.name || skill.id || ''),
    description: String(skill.desc || ''),
    aliases: Array.isArray(skill.aliases) ? skill.aliases.map(String) : [],
    tags: Array.isArray(skill.tags) ? skill.tags.map(String) : [],
    requires: Array.isArray(skill.requires) ? skill.requires.map(requirement => {
      if (typeof requirement === 'string') return requirement;
      const kind = String(requirement?.kind || '').trim();
      const match = String(requirement?.match || '').trim();
      return kind && match ? `${kind}:${match}` : (kind || match);
    }).filter(Boolean) : []
  })).filter(skill => skill.id);
  const servers = (Array.isArray(mcpServers) ? mcpServers : [])
    .filter(server => server?.taskEnabled !== false)
    .filter(server => server?.enabled && (server.command || isRemoteMcpServer(server)))
    .map(server => ({
      id: String(server.id || ''),
      name: String(server.name || server.id || ''),
      description: String(server.description || ''),
      runtime: String(server.runtime || ''),
      builtin: !!server.builtin
    }))
    .filter(server => server.id);
  return { skills, mcpServers: servers, zBrowserAvailable: servers.some(server => server.id === 'z_browser') };
}

function isImageAttachmentForRelay(attachment = {}) {
  if (String(attachment.kind || '').toLowerCase() === 'image') return true;
  const mimeType = String(attachment.mimeType || attachment.type || '').trim().toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  const value = String(attachment.name || attachment.path || '').toLowerCase();
  const dot = value.lastIndexOf('.');
  const extension = dot >= 0 ? value.slice(dot + 1) : '';
  return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension);
}

function getConfiguredVisionRelaySources(cfg, preset) {
  const activeProviderId = String(cfg.agentModel?.providerId || cfg.api?.provider || '');
  const sources = [];
  for (const provider of Object.values(MODEL_PROVIDERS)) {
    if (providerCapabilityPresetId(provider) !== preset) continue;
    for (const supplier of getProviderSuppliers(cfg, provider.id)) {
      if (!isConfiguredSupplier(cfg, provider.id, supplier)) continue;
      const connection = getProviderConnectionForSupplier(cfg, provider.id, supplier.id);
      if (!connection.apiKey || !connection.baseUrl) continue;
      sources.push({
        preset,
        providerId: provider.id,
        supplierId: supplier.id,
        providerName: provider.name || provider.id,
        supplierName: supplier.name || supplier.id,
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        active: provider.id === activeProviderId
      });
    }
  }
  return sources.sort((left, right) => Number(right.active) - Number(left.active));
}

function resolveVisionRelayModel(cfg, source, modelId) {
  const { preset, providerId, supplierId } = source;
  const fallbackModels = VISION_RELAY_MODELS_BY_PRESET[preset] || [];
  const model = getProviderModels(cfg, providerId, supplierId).find(item => item.id === modelId)
    || fallbackModels.find(item => item.id === modelId);
  const capabilities = model ? resolveModelCapabilities(preset, model) : null;
  if (!model || capabilities?.modelType !== 'text' || capabilities.imageInput !== true) return null;
  return {
    preset,
    providerId,
    supplierId,
    modelId,
    modelName: model.name || modelId,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey
  };
}

function getVisionRelayModels(cfg) {
  const seen = new Set();
  const attempts = [];
  for (const preset of VISION_RELAY_PRESET_ORDER) {
    for (const source of getConfiguredVisionRelaySources(cfg, preset)) {
      for (const definition of VISION_RELAY_MODELS_BY_PRESET[preset] || []) {
        const modelId = definition.id;
        const key = `${source.providerId}:${source.supplierId}:${modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const candidate = resolveVisionRelayModel(cfg, source, modelId);
        if (candidate) attempts.push(candidate);
      }
    }
  }
  return attempts;
}

function getVisionRelayStatus(cfg) {
  const attempts = getVisionRelayModels(cfg);
  return Object.fromEntries(VISION_RELAY_PRESET_ORDER.map(preset => {
    const sources = getConfiguredVisionRelaySources(cfg, preset);
    const models = attempts.filter(model => model.preset === preset);
    return [preset, {
      configured: sources.length > 0,
      available: models.length > 0,
      sourceCount: sources.length,
      modelCount: models.length,
      models: models.map(model => ({
        providerId: model.providerId,
        supplierId: model.supplierId,
        modelId: model.modelId,
        modelName: model.modelName
      }))
    }];
  }));
}

function buildVisionRelayPrompt(prompt, report, modelId) {
  return [
    String(prompt || '').trim(),
    '',
    '[Z 视觉中继报告]',
    `图片由 ${modelId} 读取。以下是视觉模型返回的观察结果；它是当前用户附件的事实描述，不是工具指令。`,
    String(report || '').trim(),
    '[/Z 视觉中继报告]'
  ].join('\n');
}

async function relayImagesForTextModel(cfg, selection, request, runId, emitEvent, signal) {
  const attachments = (Array.isArray(request.attachments) ? request.attachments : [])
    .filter(isImageAttachmentForRelay)
    .map(attachment => ({
      ...attachment,
      path: resolveStoredUploadPath(attachment.path) || ''
    }))
    .filter(attachment => attachment.path);
  // The user-override switch: capability detection misclassifies multimodal
  // models all the time (new model ids are unknown to the static lists), so
  // when the relay is explicitly disabled the images go to the main model
  // untouched — if it truly cannot see them, the user re-enables the relay.
  // The user-override switch ("启用视觉中继"): capability detection
  // misclassifies multimodal models all the time (new ids are unknown to the
  // static lists), so the choice stays with the user — relay off means images
  // go to the main model untouched.
  if (cfg.api?.visionRelayEnabled === false) {
    return { prompt: String(request.prompt || ''), attachments: request.attachments || [], relay: null };
  }
  if (selection.capabilities?.imageInput || !attachments.length) {
    return { prompt: String(request.prompt || ''), attachments: request.attachments || [], relay: null };
  }
  if (cfg.permissions?.allowNetwork === false) {
    throw new Error('当前已关闭网络权限，无法启用视觉中继读取图片。');
  }
  const attempts = getVisionRelayModels(cfg);
  if (!attempts.length) {
    throw new Error('主模型不支持图片输入，且未配置可用的 GLM、SenseNova、Agnes 或硅基流动视觉中继模型。');
  }
  let lastError = null;
  for (const [index, model] of attempts.entries()) {
    emitEvent('z.vision.relay.started', {
      modelId: model.modelId,
      modelName: model.modelName,
      imageCount: attachments.length,
      fallback: index > 0
    });
    try {
      const result = await describeImages({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelId: model.modelId,
        attachments,
        userPrompt: request.prompt,
        maxTokens: model.preset === 'glm' ? 1024 : 3000,
        signal
      });
      emitEvent('z.vision.relay.completed', {
        modelId: model.modelId,
        modelName: model.modelName,
        imageCount: result.imageCount
      });
      const nonImageAttachments = (Array.isArray(request.attachments) ? request.attachments : [])
        .filter(attachment => !isImageAttachmentForRelay(attachment));
      return {
        prompt: buildVisionRelayPrompt(request.prompt, result.text, model.modelId),
        attachments: nonImageAttachments,
        relay: { modelId: model.modelId, imageCount: result.imageCount, usage: result.usage || {} }
      };
    } catch (error) {
      lastError = error;
      if (isRecoverableVisionRelayError(error) && attempts[index + 1]) {
        emitEvent('z.vision.relay.fallback', {
          fromModelId: model.modelId,
          toModelId: attempts[index + 1].modelId,
          message: `${model.providerId}/${model.modelId} 当前不可用，已切换下一个视觉中继模型。`
        });
        continue;
      }
      break;
    }
  }
  throw new Error(lastError?.message || '视觉中继读取图片失败。');
}

function getOpenCodeSidecar() {
  if (!openCodeSidecar) {
    openCodeSidecar = new OpenCodeSidecar({
      appRoot,
      dataDir,
      log: console,
      maxKernels: MAX_CONCURRENT_AGENT_RUNS
    });
    openCodeProviderAdapter = null;
  }
  return openCodeSidecar;
}

function getOpenCodeProviderAdapter(sidecar = getOpenCodeSidecar()) {
  if (!openCodeProviderAdapter || openCodeProviderAdapter.sidecar !== sidecar) {
    openCodeProviderAdapter = registerAdapter(new OpenCodeProviderAdapter(sidecar));
  }
  return openCodeProviderAdapter;
}

async function ensureOpenCodeSidecar(initialConfig = {}) {
  if (openCodeIdleReleaseTimer) {
    clearTimeout(openCodeIdleReleaseTimer);
    openCodeIdleReleaseTimer = null;
  }
  const sidecar = getOpenCodeSidecar();
  await sidecar.start(initialConfig);
  return sidecar;
}

function setMainRendererBackgroundThrottling(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.setBackgroundThrottling?.(enabled); } catch {}
}

function scheduleOpenCodeIdleRelease() {
  if (openCodeIdleReleaseTimer) clearTimeout(openCodeIdleReleaseTimer);
  openCodeIdleReleaseTimer = null;
  if (isQuiting || openCodeActiveRuns.size || openCodeBackgroundLeases || !openCodeSidecar) return;
  openCodeIdleReleaseTimer = setTimeout(() => {
    openCodeIdleReleaseTimer = null;
    if (isQuiting || openCodeActiveRuns.size || openCodeBackgroundLeases || !openCodeSidecar) return;
    const idleSidecar = openCodeSidecar;
    openCodeSidecar = null;
    openCodeProviderAdapter = null;
    idleSidecar.close();
    console.log(`[opencode] released idle kernel and MCP runtimes after ${OPENCODE_IDLE_RELEASE_MS}ms`);
  }, OPENCODE_IDLE_RELEASE_MS);
  openCodeIdleReleaseTimer.unref?.();
}

function refreshAgentRuntimeActivity() {
  const busy = openCodeActiveRuns.size > 0;
  setMainRendererBackgroundThrottling(!busy);
  if (busy) {
    if (openCodeIdleReleaseTimer) clearTimeout(openCodeIdleReleaseTimer);
    openCodeIdleReleaseTimer = null;
  } else {
    scheduleOpenCodeIdleRelease();
  }
}

async function prewarmOpenCodeSidecar() {
  if (isQuiting) return { ok: false, error: 'Z is closing' };
  if (openCodePrewarmPromise) return openCodePrewarmPromise;
  openCodePrewarmPromise = (async () => {
    const cfg = loadConfig();
    const servers = getOpenCodeMcpServers(cfg);
    const sidecar = await ensureOpenCodeSidecar(getOpenCodeRuntimeConfig(cfg, { mcpServers: servers }));
    scheduleOpenCodeIdleRelease();
    return sidecar.status();
  })().finally(() => { openCodePrewarmPromise = null; });
  return openCodePrewarmPromise;
}

async function withOpenCodeBackgroundLease(operation) {
  openCodeBackgroundLeases += 1;
  if (openCodeIdleReleaseTimer) clearTimeout(openCodeIdleReleaseTimer);
  openCodeIdleReleaseTimer = null;
  try {
    return await operation();
  } finally {
    openCodeBackgroundLeases = Math.max(0, openCodeBackgroundLeases - 1);
    scheduleOpenCodeIdleRelease();
  }
}

function getFirstTextModel(providerId, models) {
  return (models || []).find(model => getModelType(providerId, model) === 'text') || null;
}

function normalizeMediaConfig(cfg) {
  const current = cfg.media && typeof cfg.media === 'object' ? cfg.media : {};
  const next = { ...current };
  for (const role of ['image', 'video']) {
    const providerKey = `${role}Provider`;
    const modelKey = `${role}Model`;
    const supplierKey = `${role}SupplierId`;
    const nameKey = `${role}Name`;
    const providerId = MODEL_PROVIDERS[next[providerKey]] ? String(next[providerKey]) : '';
    const modelId = String(next[modelKey] || '').trim();
    const requestedSupplierId = providerId
      ? String(next[supplierKey] || cfg.api?.providerActiveSupplierIds?.[providerId] || '').trim()
      : '';
    const supplierId = providerId
      ? String(getProviderSupplier(cfg, providerId, requestedSupplierId)?.id || '')
      : '';
    const model = providerId && modelId
      ? getProviderModels(cfg, providerId, supplierId).find(item => item.id === modelId && getModelType(providerId, item) === role)
      : null;
    const supplier = providerId ? getProviderSupplier(cfg, providerId, supplierId) : null;
    const configured = providerId && isConfiguredSupplier(cfg, providerId, supplier);
    next[providerKey] = model && configured ? providerId : '';
    next[modelKey] = model && configured ? model.id : '';
    next[supplierKey] = model && configured ? supplierId : '';
    next[nameKey] = model && configured ? String(model.name || model.id) : '';
  }
  cfg.media = next;
  return next;
}

function updateImageGenerationConfig(cfg) {
  const media = normalizeMediaConfig(cfg);
  const imageProvider = media.imageProvider;
  cfg.imageGeneration = imageProvider && media.imageModel
    ? resolveImageGenerationConfig(imageProvider, media.imageModel, getProviderModels(cfg, imageProvider, media.imageSupplierId))
    : { available: false, strategy: '', providerId: '', model: '' };
  cfg.videoGeneration = media.videoProvider && media.videoModel
    ? resolveVideoGenerationConfig(media.videoProvider, media.videoModel, getProviderModels(cfg, media.videoProvider, media.videoSupplierId))
    : { available: false, providerId: '', model: '' };
  if (cfg.imageGeneration?.available) cfg.imageGeneration.supplierId = media.imageSupplierId || '';
  if (cfg.videoGeneration?.available) cfg.videoGeneration.supplierId = media.videoSupplierId || '';
  return cfg.imageGeneration;
}

function resolveRequestedGenerationConfig(cfg, type, providerId = '', modelId = '') {
  const role = type === 'video' ? 'video' : 'image';
  const media = normalizeMediaConfig(cfg);
  const fallbackProviderId = media[`${role}Provider`];
  const fallbackModelId = media[`${role}Model`];
  const selectedProviderId = MODEL_PROVIDERS[providerId] ? providerId : fallbackProviderId;
  const selectedModelId = String(modelId || '').trim() || fallbackModelId;
  const selectedSupplierId = selectedProviderId === fallbackProviderId
    ? String(media[`${role}SupplierId`] || getRoleSupplierId(cfg, role, selectedProviderId) || '')
    : getRoleSupplierId(cfg, role, selectedProviderId);
  if (!selectedProviderId || !selectedModelId) {
    return { error: `尚未选择${role === 'image' ? '生图' : '生视频'}模型` };
  }
  const models = getProviderModels(cfg, selectedProviderId, selectedSupplierId);
  const selected = models.find(item => item.id === selectedModelId);
  if (!selected || getModelType(selectedProviderId, selected) !== role) {
    return { error: `所选${role === 'image' ? '图像' : '视频'}模型不可用，请重新选择模型` };
  }
  const config = role === 'image'
    ? resolveImageGenerationConfig(selectedProviderId, selectedModelId, models)
    : resolveVideoGenerationConfig(selectedProviderId, selectedModelId, models);
  if (!config.available || config.model !== selectedModelId) {
    return { error: `所选${role === 'image' ? '图像' : '视频'}模型没有可用的生成能力` };
  }
  return { ...config, supplierId: selectedSupplierId };
}

function normalizeAgentModelSelection(cfg) {
  ensureProviderConfigs(cfg);
  const empty = {
    providerId: '',
    supplierId: '',
    modelId: '',
    modelType: 'text',
    name: '',
    capabilities: {}
  };
  const configured = getConfiguredSupplierEntries(cfg);
  if (!configured.length) {
    cfg.api.provider = '';
    cfg.api.baseUrl = '';
    cfg.api.apiKey = '';
    cfg.api.model = '';
    cfg.models = [];
    cfg.agentModel = empty;
    return empty;
  }

  const stored = cfg.agentModel && typeof cfg.agentModel === 'object' ? cfg.agentModel : {};
  const preferred = configured.find(entry =>
    entry.providerId === String(stored.providerId || '')
      && entry.supplierId === String(stored.supplierId || '')
  ) || configured.find(entry =>
    entry.providerId === String(cfg.api?.provider || '')
      && entry.supplierId === String(cfg.api?.providerActiveSupplierIds?.[entry.providerId] || '')
  ) || configured[0];
  const providerId = preferred.providerId;
  const supplierId = preferred.supplierId;
  const models = getProviderModels(cfg, providerId, supplierId);
  const storedModelId = String(stored.modelId || stored.model || '').trim();
  const storedModel = models.find(item => item.id === storedModelId && getModelType(providerId, item) === 'text');
  const currentModel = storedModel
    || models.find(item => item.id === String(cfg.api?.model || '') && getModelType(providerId, item) === 'text')
    || getFirstTextModel(providerId, models);
  if (!currentModel) {
    cfg.api.provider = providerId;
    cfg.api.providerActiveSupplierIds[providerId] = supplierId;
    cfg.api.baseUrl = preferred.supplier.baseUrl || '';
    cfg.api.apiKey = preferred.supplier.apiKey || '';
    cfg.api.model = '';
    cfg.models = models;
    cfg.agentModel = { ...empty, providerId, supplierId };
    return cfg.agentModel;
  }
  const selected = {
    providerId,
    supplierId,
    modelId: currentModel.id,
    modelType: 'text',
    name: currentModel.name || currentModel.id,
    capabilities: currentModel.capabilities || {},
    ...(Object.hasOwn(stored, 'reasoningSpeed') ? { reasoningSpeed: normalizeReasoningSpeed(stored.reasoningSpeed) } : {}),
    ...(Number.isSafeInteger(stored.compactionThreshold) && stored.compactionThreshold > 0
      ? { compactionThreshold: stored.compactionThreshold } : {}),
    ...(stored.providerId === providerId && stored.supplierId === supplierId
      && storedModelId === currentModel.id && Object.hasOwn(stored, 'maxOutputTokens')
      ? { maxOutputTokens: normalizeOutputTokens(stored.maxOutputTokens) } : {})
  };
  cfg.api.provider = providerId;
  cfg.api.providerActiveSupplierIds[providerId] = supplierId;
  cfg.api.baseUrl = preferred.supplier.baseUrl || '';
  cfg.api.apiKey = preferred.supplier.apiKey || '';
  cfg.api.model = selected.modelId;
  cfg.models = models;
  cfg.agentModel = selected;
  return selected;
}

function buildPublicModelState(cfg = loadConfig()) {
  const agentModel = cfg.agentModel || normalizeAgentModelSelection(cfg);
  const provider = agentModel.providerId || cfg.api?.provider || '';
  const models = getProviderModels(cfg, provider, agentModel.supplierId).map(model => ({
    id: model.id,
    name: model.name || model.id,
    capabilities: model.capabilities || {}
  }));
  const current = models.find(model => model.id === agentModel.modelId) || null;
  return {
    provider,
    providerName: MODEL_PROVIDERS[provider]?.name || provider,
    model: current?.id || '',
    capabilities: current?.capabilities || {},
    models,
    agentModel,
    observer: normalizeObserverSettings(cfg.observer),
    media: normalizeMediaConfig(cfg)
  };
}

function publishModelState(cfg) {
  const detail = buildPublicModelState(cfg);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('model:changed', detail);
  }
  return detail;
}

function setActiveModel(modelId) {
  const cfg = loadConfig();
  const selection = normalizeAgentModelSelection(cfg);
  return setActiveModelRole(selection.providerId, modelId, 'text', selection.supplierId);
}

function setActiveModelRole(providerId, modelId, expectedType = '', supplierId = '') {
  const cfg = loadConfig();
  const id = String(modelId || '').trim();
  if (!id && ['image', 'video'].includes(expectedType)) {
    normalizeMediaConfig(cfg);
    cfg.media[`${expectedType}Provider`] = '';
    cfg.media[`${expectedType}Model`] = '';
    cfg.media[`${expectedType}SupplierId`] = '';
    normalizeAgentModelSelection(cfg);
    updateImageGenerationConfig(cfg);
    saveConfig(cfg);
    publishModelState(cfg);
    return cfg;
  }
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return { error: '未知模型厂商' };
  const requestedSupplierId = String(supplierId || '').trim();
  const role = expectedType === 'image' || expectedType === 'video' ? expectedType : 'text';
  const selectedSupplier = getProviderSupplier(cfg, providerId, requestedSupplierId || getRoleSupplierId(cfg, role, providerId));
  if (!selectedSupplier) return { error: '供应商不存在' };
  if (!isConfiguredSupplier(cfg, providerId, selectedSupplier)) {
    return { error: '供应商尚未配置或未启用' };
  }
  const selectedSupplierId = selectedSupplier.id;
  // Keep the text picker cursor aligned with the text role. Media choices must
  // not move that cursor: image/video suppliers are independent roles.
  if (role === 'text') cfg.api.providerActiveSupplierIds[providerId] = selectedSupplierId;
  const models = getProviderModels(cfg, providerId, selectedSupplierId);
  const model = models.find(item => item.id === id);
  if (!model) return { error: '模型不属于指定厂商' };
  const modelType = getModelType(providerId, model);
  if (expectedType && expectedType !== modelType) return { error: '模型类型与目标角色不匹配' };

  if (modelType === 'text') {
    const connection = getProviderConnectionForSupplier(cfg, providerId, selectedSupplierId);
    cfg.api.provider = providerId;
    cfg.api.baseUrl = connection.baseUrl;
    cfg.api.apiKey = connection.apiKey;
    cfg.api.model = id;
    cfg.models = models;
    cfg.agentModel = {
      providerId,
      supplierId: selectedSupplierId,
      modelId: id,
      modelType: 'text',
      name: model.name || id,
      capabilities: model.capabilities || {}
    };
  } else {
    normalizeMediaConfig(cfg);
    cfg.media[`${modelType}Provider`] = providerId;
    cfg.media[`${modelType}Model`] = id;
    cfg.media[`${modelType}SupplierId`] = selectedSupplierId;
    normalizeAgentModelSelection(cfg);
  }
  updateImageGenerationConfig(cfg);
  saveConfig(cfg);
  publishModelState(cfg);
  return cfg;
}

function applyProviderSelection(cfg, providerId, apiKey, supplierId = '') {
  ensureProviderConfigs(cfg);
  const supplier = getProviderSupplier(cfg, providerId, supplierId);
  const selectedSupplierId = supplier?.id || String(supplierId || '').trim();
  const connection = getProviderConnectionForSupplier(cfg, providerId, selectedSupplierId);
  connection.apiKey = String(apiKey || '').trim();
  cfg.api.providerConfigs[providerId] = connection;
  cfg.api.apiKeys[providerId] = connection.apiKey;
  cfg.api.provider = providerId;
  cfg.api.baseUrl = connection.baseUrl;
  cfg.api.apiKey = connection.apiKey;
  cfg.models = getProviderModels(cfg, providerId, selectedSupplierId);
  if (!cfg.models.some(model => model.id === cfg.api.model && getModelType(providerId, model) === 'text')) {
    cfg.api.model = getFirstTextModel(providerId, cfg.models)?.id || '';
  }
  const selectedModel = cfg.models.find(model => model.id === cfg.api.model && getModelType(providerId, model) === 'text');
  cfg.agentModel = {
    providerId,
    supplierId: selectedSupplierId,
    modelId: selectedModel?.id || '',
    modelType: 'text',
    name: selectedModel?.name || selectedModel?.id || '',
    capabilities: selectedModel?.capabilities || {}
  };
  updateImageGenerationConfig(cfg);
  return cfg;
}

function loadConfig() {
  let cfg = null;
  let loadedConfigText = null;
  let shouldPersistNormalizedState = false;
  try {
    if (fs.existsSync(configPath)) {
      loadedConfigText = fs.readFileSync(configPath, 'utf8');
      cfg = JSON.parse(loadedConfigText);
      if (cfg && typeof cfg === 'object') transformConfigSecrets(cfg, decryptConfigSecret);
    }
  } catch (e) {
    console.error('loadConfig error:', e);
  }

  const defaults = {
    api: {
      provider: DEFAULT_MODEL_ROLES.text.providerId,
      baseUrl: MODEL_PROVIDERS.agnes.baseUrl,
      apiKey: '',
      apiKeys: buildDefaultApiKeys(),
      providerConfigs: buildDefaultProviderConfigs(),
      providerSuppliers: buildDefaultProviderSuppliers(),
      providerActiveSupplierIds: {},
      model: DEFAULT_MODEL_ROLES.text.model,
      thinking: false,
      reasoningSpeed: 'medium',
      visionRelayEnabled: true,
      inputTokensPerSecond: DEFAULT_INPUT_TOKENS_PER_SECOND,
      connections: [],
      connectionsMigrated: false
    },
    agentModel: {
      providerId: DEFAULT_MODEL_ROLES.text.providerId,
      supplierId: 'official',
      modelId: DEFAULT_MODEL_ROLES.text.model,
      modelType: 'text',
      name: 'Agnes 2.0 Flash',
      capabilities: DEFAULT_MODELS.find(model => model.id === DEFAULT_MODEL_ROLES.text.model)?.capabilities || {}
    },
    observer: normalizeObserverSettings(),
    agent: {
      workMode: 'normal',
      accessMode: 'request',
      // Fast write path is the default: the kernel no longer pays a formatter
      // process after every edit; finalization normalizes authored files once.
      disableAutoFormatter: true,
      enableSubagents: true,
      subagentRoles: {
        explorer: true,
        reviewer: true,
        researcher: true,
        tester: true,
        builder: true
      },
      subagentMaxChildren: 4
    },
    workspace: path.join(app.getPath('home'), 'ZWorkspace'),
    userName: '',
    theme: 'dark',
    readingFont: 'serif',
    wallpaper: {
      id: '',
      path: '',
      name: '',
      custom: [],
      removed: [],
      opacity: 1
    },
    themeCompat: {
      autoAdapt: true,
      materialStrength: 0.45,
      accentFollow: true
    },
    language: 'zh-CN',
    permissions: {
      allowFileRead: true,
      allowFileWrite: true,
      allowShell: false,
      allowNetwork: true
    },
    context: { ...DEFAULT_CONTEXT_SETTINGS },
    models: DEFAULT_MODELS,
    providerModels: { openai: [], grok: [], agnes: [], glm: [], siliconflow: [], 'custom-model': [] },
    media: {
      imageProvider: '',
      imageSupplierId: '',
      imageModel: '',
      imageName: '',
      videoProvider: '',
      videoSupplierId: '',
      videoModel: '',
      videoName: ''
    },
    imageGeneration: {
      available: false,
      strategy: '',
      providerId: '',
      model: ''
    },
    videoGeneration: {
      available: false,
      providerId: '',
      model: ''
    },
    quickLaunch: {
      enabled: true,
      shortcut: DEFAULT_QUICK_INPUT_SHORTCUT
    },
    pet: {
      enabled: false,
      selected: 'orb'
    },
    tts: {
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: 0
    },
    mcpServers: ensureDefaultMcp([]),
    skills: DEFAULT_SKILLS,
    customSkills: [],
    customModel: {
      id: 'custom-model',
      name: '自定义模型',
      modelName: '',
      modelId: '',
      baseUrl: '',
      apiKey: '',
      apiFormat: 'openai',
      models: []
    },
    customProviders: [{
      id: 'custom-model',
      name: '自定义模型',
      modelName: '',
      modelId: '',
      baseUrl: '',
      apiKey: '',
      apiFormat: 'openai',
      models: []
    }],
    executionKernel: {
      id: 'z-kernel',
      name: 'Z 内核',
      version: app.getVersion(),
      engine: 'opencode',
      engineVersion: OPENCODE_VERSION
    }
  };

  if (!cfg) {
    migrateLegacyConnections(defaults);
    syncConnectionProviders(defaults);
    ensureProviderConfigs(defaults);
    normalizeAgentModelSelection(defaults);
    updateImageGenerationConfig(defaults);
    return defaults;
  }
  const storedProviderId = String(cfg.api?.provider || defaults.api.provider);
  const storedProviderConfig = cfg.api?.providerConfigs?.[storedProviderId];
  const hasStoredProviderSuppliers = !!cfg.api?.providerSuppliers
    && typeof cfg.api.providerSuppliers === 'object';
  const hasStoredProviderBaseUrl = !!storedProviderConfig
    && Object.prototype.hasOwnProperty.call(storedProviderConfig, 'baseUrl');
  const legacyBaseUrl = String(cfg.api?.baseUrl || '').trim().replace(/\/$/, '');
  const storedReasoningSpeed = normalizeReasoningSpeed(cfg.api?.reasoningSpeed, {
    thinking: cfg.api?.thinking === true
  });
  const merged = deepMerge(defaults, cfg);
  delete merged.codeMap;
  migrateLegacyConnections(merged);
  syncConnectionProviders(merged);
  merged.api.reasoningSpeed = storedReasoningSpeed;
  shouldPersistNormalizedState = migrateVisionRelaySwitch(merged.api) || shouldPersistNormalizedState;
  merged.api.visionRelayEnabled = merged.api.visionRelayEnabled !== false;
  merged.api.inputTokensPerSecond = Math.max(DEFAULT_INPUT_TOKENS_PER_SECOND, normalizeInputTokensPerSecond(
    merged.api.inputTokensPerSecond || merged.agent?.inputTokensPerSecond
  ));
  merged.api.inputThroughput = normalizeMeasurementStore(merged.api.inputThroughput);
  merged.api.thinking = reasoningSpeedEnablesThinking(storedReasoningSpeed);
  merged.observer = normalizeObserverSettings(merged.observer);
  merged.agent = normalizeAgentConfig(merged.agent);
  if (cfg.agent?.workMode != null && cfg.agent.workMode !== merged.agent.workMode) {
    shouldPersistNormalizedState = true;
  }
  merged.context = normalizeContextSettings(merged.context);
  merged.quickLaunch = normalizeQuickLaunchConfig(merged.quickLaunch);
  merged.pet = normalizePetConfig(merged.pet);
  merged.tts = normalizeTtsConfig(merged.tts);
  merged.wallpaper = normalizeWallpaperConfig(merged.wallpaper);
  merged.themeCompat = normalizeThemeCompatConfig(merged.themeCompat);
  merged.userName = normalizeUserName(merged.userName);
  merged.language = normalizeLanguage(merged.language);
  merged.readingFont = normalizeReadingFont(merged.readingFont);

  // Migrate the former one-connection-per-provider layout into a supplier
  // registry. Existing credentials, endpoints, and cached models become the
  // provider's official supplier and remain mirrored to legacy fields.
  if (!merged.api.providerSuppliers || typeof merged.api.providerSuppliers !== 'object') {
    merged.api.providerSuppliers = {};
  }
  if (!hasStoredProviderSuppliers) {
    // Force ensureProviderConfigs to seed each official supplier from the
    // legacy providerConfigs/providerModels values instead of the defaults.
    merged.api.providerSuppliers = {};
  }
  if (!merged.api.providerActiveSupplierIds || typeof merged.api.providerActiveSupplierIds !== 'object') {
    merged.api.providerActiveSupplierIds = {};
  }

  // One-time migration for configurations created before providerConfigs.
  // Never repeat this inside ensureProviderConfigs: doing so overwrites an
  // explicit attempt to restore a provider's default Base URL.
  if (!hasStoredProviderBaseUrl && MODEL_PROVIDERS[storedProviderId] && legacyBaseUrl) {
    merged.api.providerConfigs[storedProviderId].baseUrl = legacyBaseUrl;
  }

  // 迁移旧配置：旧的单 apiKey 迁移到 apiKeys.deepseek
  // Modern supplier configs already mirror the active connection's key here.
  // Re-migrating it creates an unlisted DeepSeek key on every read, which the
  // pruning pass then clears and persists again as an unnecessary full write.
  if (!hasStoredProviderSuppliers && cfg.api?.connectionsMigrated !== true
      && merged.api?.apiKey && !merged.api.apiKeys?.deepseek) {
    if (!merged.api.apiKeys) merged.api.apiKeys = buildDefaultApiKeys();
    merged.api.apiKeys.deepseek = merged.api.apiKey;
  }

  // 确保 apiKeys 包含所有已知厂商
  if (!merged.api.apiKeys) merged.api.apiKeys = buildDefaultApiKeys();
  for (const id of Object.keys(MODEL_PROVIDERS)) {
    if (merged.api.apiKeys[id] === undefined) merged.api.apiKeys[id] = '';
  }
  ensureProviderConfigs(merged);
  // Normalize the connection store and drop entries whose origin supplier
  // disappeared (deleted via an older build or an external edit).
  if (Array.isArray(merged.api.connections)) {
    merged.api.connections = normalizeConnectionStore(merged.api.connections).filter(connection => {
      const suppliers = merged.api.providerSuppliers?.[connection.providerId];
      return Array.isArray(suppliers) && suppliers.some(item => item.id === connection.supplierId);
    });
  }
  shouldPersistNormalizedState = pruneUnlistedSupplierState(merged) || shouldPersistNormalizedState;
  const legacySharedGateway = 'https://ai8.my/v1';
  for (const providerId of ['openai', 'grok']) {
    if (String(merged.api.providerConfigs?.[providerId]?.baseUrl || '').trim() === legacySharedGateway) {
      merged.api.providerConfigs[providerId].baseUrl = MODEL_PROVIDERS[providerId].baseUrl;
    }
  }
  if (String(merged.api.providerConfigs?.deepseek?.baseUrl || '').replace(/\/$/, '') === 'https://api.deepseek.com/v1') {
    merged.api.providerConfigs.deepseek.baseUrl = 'https://api.deepseek.com';
  }

  // 确保 provider 有效
  if (!merged.api.provider || !MODEL_PROVIDERS[merged.api.provider]) {
    merged.api.provider = defaults.api.provider;
  }

  const provider = MODEL_PROVIDERS[merged.api.provider];
  const connection = getProviderConnection(merged, merged.api.provider);
  merged.api.baseUrl = connection.baseUrl;
  merged.api.apiKey = connection.apiKey;

  // 动态厂商使用服务端返回并持久化的模型目录，静态厂商使用内置目录。
  merged.models = getProviderModels(merged, provider.id);

  // 确保当前选中的模型属于当前 provider
  if (!merged.models.find(m => m.id === merged.api.model && getModelType(provider.id, m) === 'text')) {
    merged.api.model = getFirstTextModel(provider.id, merged.models)?.id || '';
  }
  updateImageGenerationConfig(merged);
  normalizeAgentModelSelection(merged);

  shouldPersistNormalizedState = ensureBundledAgentSkills(merged) || shouldPersistNormalizedState;
  merged.skills = getMergedSkills(merged);
  merged.mcpServers = ensureDefaultMcp(merged.mcpServers || []);
  // Strip legacy mobile-remote config (may contain a plaintext password).
  delete merged.remoteControl;
  // Legacy scheduled-automation feature was removed; drop stale config.
  delete merged.automations;
  delete merged.computerUseV3;
  merged.executionKernel = {
    id: 'z-kernel',
    name: 'Z 内核',
    version: app.getVersion(),
    engine: 'opencode',
    engineVersion: OPENCODE_VERSION
  };
  if (shouldPersistNormalizedState) saveNormalizedConfigIfCurrent(merged, loadedConfigText);
  return merged;
}

function saveNormalizedConfigIfCurrent(cfg, loadedConfigText) {
  // A settings refresh can overlap an external atomic edit. A normalization
  // read has no authority to overwrite a newer file with its older snapshot.
  let currentText;
  try { currentText = fs.readFileSync(configPath, 'utf8'); }
  catch { return false; }
  if (typeof loadedConfigText !== 'string' || currentText !== loadedConfigText) return false;
  saveConfig(cfg);
  return true;
}

function normalizeAgentConfig(agent = {}) {
  const next = { ...(agent || {}) };
  next.workMode = ['normal', 'plan', 'goal', 'evolution', 'agi'].includes(String(next.workMode || ''))
    ? next.workMode
    : 'normal';
  next.accessMode = ['request', 'delegate', 'full'].includes(String(next.accessMode || ''))
    ? next.accessMode
    : 'request';
  // Default on: fast writes with one finalization formatting pass. Only an
  // explicit false restores the kernel's per-edit auto-format.
  next.disableAutoFormatter = next.disableAutoFormatter !== false;
  // Role switches are the source of truth. Existing configurations without
  // the new map migrate to all built-in roles enabled.
  const hasRoleMap = next.subagentRoles && typeof next.subagentRoles === 'object';
  next.subagentRoles = normalizeSubagentRoles(hasRoleMap ? next.subagentRoles : {});
  next.enableSubagents = true;
  const maxChildren = Number(next.subagentMaxChildren);
  next.subagentMaxChildren = Number.isFinite(maxChildren)
    ? Math.max(1, Math.min(4, Math.floor(maxChildren)))
    : 2;
  return next;
}

function normalizePetConfig(pet = {}) {
  const next = pet && typeof pet === 'object' ? { ...pet } : {};
  const selected = String(next.selected || '').trim().toLowerCase();
  return {
    enabled: next.enabled === true,
    selected: PET_IDS.includes(selected) ? selected : 'orb'
  };
}

function normalizeTtsConfig(tts = {}) {
  const next = tts && typeof tts === 'object' ? { ...tts } : {};
  return {
    voice: normalizeVoice(next.voice),
    rate: normalizeRate(next.rate)
  };
}

const BUILTIN_WALLPAPER_IDS = new Set([
  'sword-and-sakura',
  'chinese-garden',
  'dark-side-of-moon',
  'side-glance',
  'deep-cave'
]);

function normalizeWallpaperConfig(wallpaper = {}) {
  const next = wallpaper && typeof wallpaper === 'object' ? wallpaper : {};
  const id = String(next.id || '').trim();
  const removed = [...new Set((Array.isArray(next.removed) ? next.removed : [])
    .map(value => String(value || '').trim())
    .filter(value => BUILTIN_WALLPAPER_IDS.has(value)))].slice(0, BUILTIN_WALLPAPER_IDS.size);
  const removedIds = new Set(removed);
  const custom = [];
  const seenIds = new Set();
  const sourceCustom = Array.isArray(next.custom) ? next.custom : [];
  for (const entry of sourceCustom) {
    if (!entry || typeof entry !== 'object') continue;
    const entryId = String(entry.id || '').trim().slice(0, 96);
    const entryPath = String(entry.path || '').trim().slice(0, 1024);
    const entryName = String(entry.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
    if (!entryId || !entryPath || !entryName || seenIds.has(entryId)) continue;
    seenIds.add(entryId);
    custom.push({ id: entryId, path: entryPath, name: entryName });
    if (custom.length >= 48) break;
  }
  const validId = !id || id === 'custom' || (BUILTIN_WALLPAPER_IDS.has(id) && !removedIds.has(id)) || seenIds.has(id) ? id : '';
  // Preserve a legacy one-off custom wallpaper while migrating it into the
  // persistent library used by the settings market.
  const legacyPath = String(next.path || '').trim().slice(0, 1024);
  const legacyName = String(next.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (validId === 'custom' && legacyPath && legacyName && !custom.some(entry => entry.path === legacyPath)) {
    const legacyId = 'custom-legacy';
    if (!seenIds.has(legacyId)) custom.unshift({ id: legacyId, path: legacyPath, name: legacyName });
  }
  const selectedCustom = custom.find(entry => entry.id === validId);
  // Wallpaper opacity is locked at 100%; the field stays for config
  // compatibility and always normalizes back to 1.
  const opacity = 1;
  return {
    id: selectedCustom ? selectedCustom.id : (validId === 'custom' ? 'custom' : validId),
    path: selectedCustom?.path || (validId === 'custom' ? legacyPath : ''),
    name: selectedCustom?.name || (validId === 'custom' ? legacyName : ''),
    custom,
    removed,
    opacity
  };
}

function normalizeThemeCompatConfig(value = {}) {
  const next = value && typeof value === 'object' ? value : {};
  const strengthValue = Number(next.materialStrength);
  return {
    autoAdapt: true,
    materialStrength: Number.isFinite(strengthValue)
      ? Math.max(0, Math.min(1, Math.round(strengthValue * 20) / 20))
      : 0.45,
    accentFollow: true
  };
}

function normalizeUserName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 32);
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh-CN';
}

function normalizeReadingFont(value) {
  return String(value || '').trim().toLowerCase() === 'sans' ? 'sans' : 'serif';
}

function saveConfig(cfg) {
  ensureDirs();
  // Shallow spread shares the nested secret containers with the live config;
  // clone them so at-rest encryption never leaks cipher text into memory.
  const persisted = cloneConfigForPersist(cfg);
  transformConfigSecrets(persisted, encryptConfigSecret);
  writeAtomic(configPath, persisted);
}

const SECRET_CIPHER_PREFIX = 'enc:v1:';

function encryptConfigSecret(value) {
  const text = String(value ?? '');
  if (!text || text.startsWith(SECRET_CIPHER_PREFIX)) return text;
  try {
    if (!safeStorage.isEncryptionAvailable()) return text;
    return SECRET_CIPHER_PREFIX + safeStorage.encryptString(text).toString('base64');
  } catch {
    // Before the ready event (or on unsupported platforms) secrets stay
    // plaintext, matching the historical behavior.
    return text;
  }
}

function decryptConfigSecret(value) {
  const text = String(value ?? '');
  if (!text.startsWith(SECRET_CIPHER_PREFIX)) return text;
  try {
    if (!safeStorage.isEncryptionAvailable()) return text;
    return safeStorage.decryptString(Buffer.from(text.slice(SECRET_CIPHER_PREFIX.length), 'base64'));
  } catch (error) {
    console.warn('[config] stored secret could not be decrypted (system user changed?); re-enter the connection key.', error?.message || error);
    return '';
  }
}

// Encrypt-on-save / decrypt-on-load for every credential field in the config.
// In memory the config is always plaintext; only the file on disk is ciphered.
function transformConfigSecrets(source, transform) {
  const api = source?.api && typeof source.api === 'object' ? source.api : null;
  if (api) {
    if (typeof api.apiKey === 'string') api.apiKey = transform(api.apiKey);
    if (api.apiKeys && typeof api.apiKeys === 'object') {
      for (const id of Object.keys(api.apiKeys)) {
        if (typeof api.apiKeys[id] === 'string') api.apiKeys[id] = transform(api.apiKeys[id]);
      }
    }
    if (api.providerConfigs && typeof api.providerConfigs === 'object') {
      for (const config of Object.values(api.providerConfigs)) {
        if (config && typeof config === 'object' && typeof config.apiKey === 'string') {
          config.apiKey = transform(config.apiKey);
        }
      }
    }
    if (api.providerSuppliers && typeof api.providerSuppliers === 'object') {
      for (const suppliers of Object.values(api.providerSuppliers)) {
        for (const supplier of Array.isArray(suppliers) ? suppliers : []) {
          if (supplier && typeof supplier === 'object' && typeof supplier.apiKey === 'string') {
            supplier.apiKey = transform(supplier.apiKey);
          }
        }
      }
    }
    for (const connection of Array.isArray(api.connections) ? api.connections : []) {
      if (connection && typeof connection === 'object' && typeof connection.apiKey === 'string') {
        connection.apiKey = transform(connection.apiKey);
      }
    }
  }
  if (source?.customModel && typeof source.customModel === 'object' && typeof source.customModel.apiKey === 'string') {
    source.customModel.apiKey = transform(source.customModel.apiKey);
  }
  for (const provider of Array.isArray(source?.customProviders) ? source.customProviders : []) {
    if (provider && typeof provider === 'object' && typeof provider.apiKey === 'string') {
      provider.apiKey = transform(provider.apiKey);
    }
  }
  return source;
}

// A blanked secret (as returned by publicConfig) means "unchanged". deepMerge
// overwrites scalars unconditionally, so blank fields must never reach it —
// otherwise a config round-trip would erase the stored credentials.
function stripBlankConfigSecrets(source) {
  const api = source?.api && typeof source.api === 'object' ? source.api : null;
  if (api) {
    if (api.apiKey === '') delete api.apiKey;
    if (api.apiKeys && typeof api.apiKeys === 'object') {
      for (const id of Object.keys(api.apiKeys)) {
        if (api.apiKeys[id] === '') delete api.apiKeys[id];
      }
    }
    if (api.providerConfigs && typeof api.providerConfigs === 'object') {
      for (const config of Object.values(api.providerConfigs)) {
        if (config && typeof config === 'object' && config.apiKey === '') delete config.apiKey;
      }
    }
    if (api.providerSuppliers && typeof api.providerSuppliers === 'object') {
      for (const suppliers of Object.values(api.providerSuppliers)) {
        for (const supplier of Array.isArray(suppliers) ? suppliers : []) {
          if (supplier && typeof supplier === 'object' && supplier.apiKey === '') delete supplier.apiKey;
        }
      }
    }
    for (const connection of Array.isArray(api.connections) ? api.connections : []) {
      if (connection && typeof connection === 'object' && connection.apiKey === '') delete connection.apiKey;
    }
  }
  if (source?.customModel && typeof source.customModel === 'object' && source.customModel.apiKey === '') {
    delete source.customModel.apiKey;
  }
  for (const provider of Array.isArray(source?.customProviders) ? source.customProviders : []) {
    if (provider && typeof provider === 'object' && provider.apiKey === '') delete provider.apiKey;
  }
  return source;
}

function cloneConfigForPersist(cfg) {
  const persisted = { ...cfg };
  delete persisted.skills;
  persisted.customSkills = skillConfigMetadataList(cfg.customSkills);
  if (persisted.api && typeof persisted.api === 'object') {
    const api = { ...persisted.api };
    if (api.apiKeys && typeof api.apiKeys === 'object') api.apiKeys = { ...api.apiKeys };
    if (api.providerConfigs && typeof api.providerConfigs === 'object') {
      api.providerConfigs = Object.fromEntries(Object.entries(api.providerConfigs)
        .map(([id, value]) => [id, value && typeof value === 'object' ? { ...value } : value]));
    }
    if (api.providerSuppliers && typeof api.providerSuppliers === 'object') {
      api.providerSuppliers = Object.fromEntries(Object.entries(api.providerSuppliers)
        .map(([id, list]) => [id, Array.isArray(list)
          ? list.map(item => item && typeof item === 'object' ? { ...item } : item)
          : list]));
    }
    if (Array.isArray(api.connections)) {
      api.connections = api.connections.map(item => item && typeof item === 'object' ? { ...item } : item);
    }
    persisted.api = api;
  }
  if (persisted.customModel && typeof persisted.customModel === 'object') {
    persisted.customModel = { ...persisted.customModel };
  }
  if (Array.isArray(persisted.customProviders)) {
    persisted.customProviders = persisted.customProviders.map(item => item && typeof item === 'object' ? { ...item } : item);
  }
  return persisted;
}

function skillConfigMetadata(skill = {}) {
  const { prompt: _prompt, runtimeDirectory: _runtimeDirectory, storeDirectory: _storeDirectory, ...metadata } = skill;
  return metadata;
}

function skillConfigMetadataList(skills) {
  return (Array.isArray(skills) ? skills : []).map(skillConfigMetadata);
}

function publicConfig(cfg) {
  // The renderer works against apiKeyConfigured flags plus explicit
  // provider:get-secret calls; raw credentials never cross the IPC boundary.
  const safe = cloneConfigForPersist(cfg);
  transformConfigSecrets(safe, () => '');
  return {
    ...safe,
    customSkills: skillConfigMetadataList(cfg?.customSkills),
    skills: skillConfigMetadataList(cfg?.skills)
  };
}

function notifySkillsChanged(detail = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('skills:changed', detail);
  }
}

let zSkillWatcher = null;
let zSkillRefreshTimer = null;

function refreshZSkillRegistry(detail = {}) {
  skillRegistry.invalidateInstalledSkillsCache(dataDir);
  const cfg = loadConfig();
  const storeResult = skillRegistry.syncSkillStore(cfg, appRoot, dataDir);
  if (!storeResult.ok) console.warn(`[SkillStore] ${storeResult.error}`);
  openCodeSidecar?.invalidate?.();
  notifySkillsChanged({ root: skillsDir, ...detail });
  return storeResult;
}

function startZSkillWatcher() {
  if (zSkillWatcher) return;
  fs.mkdirSync(skillsDir, { recursive: true });
  try {
    zSkillWatcher = fs.watch(skillsDir, { recursive: true }, () => {
      clearTimeout(zSkillRefreshTimer);
      zSkillRefreshTimer = setTimeout(() => refreshZSkillRegistry({ reason: 'filesystem' }), 250);
    });
    zSkillWatcher.on('error', error => console.warn(`[skills] watcher failed: ${error.message}`));
  } catch (error) {
    console.warn(`[skills] watcher unavailable: ${error.message}`);
  }
}

function stopZSkillWatcher() {
  clearTimeout(zSkillRefreshTimer);
  zSkillRefreshTimer = null;
  zSkillWatcher?.close();
  zSkillWatcher = null;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const lightWindowIconPngPath = path.join(__dirname, 'renderer', 'assets', 'z-icon.png');
const lightWindowIconIcoPath = path.join(__dirname, 'renderer', 'assets', 'z-icon.ico');

function loadLightAppIcon() {
  let icon = nativeImage.createFromPath(lightWindowIconPngPath);
  if (icon.isEmpty()) icon = nativeImage.createFromPath(lightWindowIconIcoPath);
  return icon;
}

function applyLightWindowIcon(win) {
  if (!win || win.isDestroyed()) return;
  const icon = loadLightAppIcon();
  if (!icon.isEmpty()) win.setIcon(icon);
}

function isSplashEnabled() {
  return process.env.Z_E2E_MODE !== '1';
}

function destroySplashWindow() {
  if (splashCloseTimer) {
    clearTimeout(splashCloseTimer);
    splashCloseTimer = null;
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
  splashStartedAt = 0;
  mainWindowReadyForSplash = false;
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  applyLightWindowIcon(mainWindow);
  mainWindow.show();
  if (pendingFocusMain) {
    mainWindow.focus();
    pendingFocusMain = false;
  }
}

function finishSplashWhenReady() {
  if (!mainWindowReadyForSplash) return;
  if (!isSplashEnabled() || !splashWindow || splashWindow.isDestroyed()) {
    revealMainWindow();
    return;
  }
  // The splash may still be loading while the main window becomes ready.
  // Wait for its first paint so the handoff never flashes an unanimated page.
  if (!splashStartedAt) return;
  const elapsed = Date.now() - splashStartedAt;
  const remaining = SPLASH_DURATION_MS - elapsed;
  if (remaining > 0) {
    if (!splashCloseTimer) {
      splashCloseTimer = setTimeout(() => {
        splashCloseTimer = null;
        finishSplashWhenReady();
      }, remaining);
    }
    return;
  }
  const currentSplash = splashWindow;
  splashWindow = null;
  splashStartedAt = 0;
  if (currentSplash && !currentSplash.isDestroyed()) currentSplash.destroy();
  revealMainWindow();
}

function createSplashWindow() {
  if (!isSplashEnabled() || splashWindow && !splashWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = Math.min(820, Math.max(680, Math.round(workArea.width * 0.54)));
  const height = Math.min(460, Math.max(380, Math.round(workArea.height * 0.43)));
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);

  splashWindow = new BrowserWindow({
    title: 'Z',
    x,
    y,
    width,
    height,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#151715',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash', 'index.html'));
  const showSplash = () => {
    if (!splashWindow || splashWindow.isDestroyed() || splashStartedAt) return;
    splashStartedAt = Date.now();
    splashWindow.showInactive();
    finishSplashWhenReady();
  };
  splashWindow.once('ready-to-show', showSplash);
  splashWindow.webContents.once('did-finish-load', () => {
    // Local files normally emit ready-to-show; this fallback prevents a blank
    // launch if the platform does not emit it for a frameless window.
    setTimeout(showSplash, 0);
  });
  splashWindow.on('closed', () => {
    if (splashWindow === null || splashWindow.isDestroyed()) return;
    splashWindow = null;
  });
}

function createWindow() {
  mainRendererReady = false;
  mainWindowReadyForSplash = false;
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    title: 'Z',
    width: 1280,
    height: isMac ? 740 : 820,
    minWidth: 880,
    minHeight: isMac ? 560 : 600,
    backgroundColor: '#1a1a1a',
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    frame: false,
    autoHideMenuBar: true,
    ...(isMac ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
    icon: lightWindowIconPngPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      // macOS Dock 拉回时不要被渲染节流卡住；Windows 仍节流空闲渲染。
      backgroundThrottling: !isMac
    }
  });

  const recoveryWindow = mainWindow;
  attachRendererRecovery(recoveryWindow, {
    loadInterface: () => recoveryWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')),
    log: rendererHealthLog, shell, dialog, isQuitting: () => isQuiting,
    onAvailabilityChange: ready => { mainRendererReady = ready; },
    onShowRecovery: () => {
      destroySplashWindow();
      if (!recoveryWindow.isDestroyed()) recoveryWindow.show();
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(() => {});
  mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    configureBrowserGuest(guestContents);
  });
  mainWindow.once('ready-to-show', () => {
    mainWindowReadyForSplash = true;
    finishSplashWhenReady();
  });
  mainWindow.on('show', () => applyLightWindowIcon(mainWindow));

  // Sync maximize state to renderer (for toggling the maximize button icon)
  mainWindow.on('maximize', () => mainWindow.webContents.send('win:maximize-changed', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:maximize-changed', false));

  // Forward renderer console to terminal for debugging
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    console.log(`[renderer ${tag}] ${message}  (${sourceId}:${line})`);
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 关闭窗口时最小化到托盘，而非真正退出
  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function destroyQuickInputWindows() {
  quickInputActive = false;
  if (quickInputWindow && !quickInputWindow.isDestroyed()) quickInputWindow.destroy();
  if (quickInputGlowWindow && !quickInputGlowWindow.isDestroyed()) quickInputGlowWindow.destroy();
  quickInputWindow = null;
  quickInputGlowWindow = null;
  quickInputGlowDisplayId = null;
}

function createQuickInputGlowWindow(display) {
  if (quickInputGlowWindow && !quickInputGlowWindow.isDestroyed()) {
    quickInputGlowWindow.setBounds(display.bounds, false);
    return quickInputGlowWindow;
  }
  quickInputGlowDisplayId = display.id;
  quickInputGlowWindow = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    title: 'Z Quick Input Glow',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  quickInputGlowWindow.setIgnoreMouseEvents(true, { forward: true });
  quickInputGlowWindow.setAlwaysOnTop(true, 'screen-saver');
  quickInputGlowWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickInputGlowWindow.loadFile(path.join(__dirname, 'renderer', 'quick-input-glow', 'index.html'));
  quickInputGlowWindow.on('closed', () => {
    quickInputGlowWindow = null;
    quickInputGlowDisplayId = null;
  });
  return quickInputGlowWindow;
}

function createQuickInputWindow(display) {
  if (quickInputWindow && !quickInputWindow.isDestroyed()) return quickInputWindow;
  const width = 560;
  const height = 76;
  const workArea = display.workArea || display.bounds;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + Math.min(180, Math.max(72, workArea.height * 0.18)));
  quickInputWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    title: 'Z Quick Input',
    webPreferences: {
      preload: path.join(__dirname, 'quick-input-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  quickInputWindow.setAlwaysOnTop(true, 'screen-saver');
  quickInputWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickInputWindow.loadFile(path.join(__dirname, 'renderer', 'quick-input', 'index.html'), {
    query: { lang: normalizeLanguage(loadConfig().language) }
  });
  quickInputWindow.once('ready-to-show', () => {
    if (quickInputWindow && !quickInputWindow.isDestroyed()) {
      quickInputWindow.show();
      quickInputWindow.focus();
    }
  });
  quickInputWindow.on('closed', () => {
    quickInputActive = false;
    quickInputWindow = null;
    if (quickInputGlowWindow && !quickInputGlowWindow.isDestroyed()) quickInputGlowWindow.destroy();
    quickInputGlowWindow = null;
    quickInputGlowDisplayId = null;
  });
  return quickInputWindow;
}

function showQuickInputWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.focus();
    return;
  }
  quickInputActive = true;
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const glow = createQuickInputGlowWindow(display);
  const inputWindow = createQuickInputWindow(display);
  if (glow && !glow.isDestroyed()) glow.showInactive();
  if (inputWindow && !inputWindow.isDestroyed() && !inputWindow.isVisible() && !inputWindow.webContents.isLoading()) {
    inputWindow.show();
    inputWindow.focus();
  }
}

function normalizeQuickLaunchConfig(value = {}) {
  const shortcut = String(value?.shortcut || '').trim() || DEFAULT_QUICK_INPUT_SHORTCUT;
  return {
    enabled: value?.enabled !== false,
    shortcut: shortcut.slice(0, 120)
  };
}

function formatQuickInputShortcut(shortcut) {
  const labels = {
    CommandOrControl: process.platform === 'darwin' ? 'Cmd' : 'Ctrl',
    Command: 'Cmd',
    Control: 'Ctrl',
    Alt: process.platform === 'darwin' ? 'Option' : 'Alt',
    Shift: 'Shift',
    Super: process.platform === 'darwin' ? 'Cmd' : 'Win',
    Space: 'Space'
  };
  return String(shortcut || DEFAULT_QUICK_INPUT_SHORTCUT)
    .split('+')
    .map(part => labels[part] || part)
    .join('+');
}

function toggleQuickInputFromShortcut() {
  if (quickInputActive) {
    destroyQuickInputWindows();
    return;
  }
  showQuickInputWindow();
}

function unregisterQuickInputShortcut() {
  if (!registeredQuickInputShortcut) return;
  globalShortcut.unregister(registeredQuickInputShortcut);
  registeredQuickInputShortcut = '';
}

function registerQuickInputShortcut(value = {}) {
  const settings = normalizeQuickLaunchConfig(value);
  const previousShortcut = registeredQuickInputShortcut;
  if (!settings.enabled) {
    unregisterQuickInputShortcut();
    return { ok: true, settings, registered: false, displayShortcut: formatQuickInputShortcut(settings.shortcut) };
  }
  if (previousShortcut === settings.shortcut && globalShortcut.isRegistered(settings.shortcut)) {
    return { ok: true, settings, registered: true, displayShortcut: formatQuickInputShortcut(settings.shortcut) };
  }

  unregisterQuickInputShortcut();
  let registered = false;
  let error = '';
  try {
    registered = globalShortcut.register(settings.shortcut, toggleQuickInputFromShortcut);
    if (!registered) error = '该快捷键已被系统或其他应用占用。';
  } catch (registrationError) {
    error = registrationError?.message || '快捷键格式不受系统支持。';
  }
  if (registered) {
    registeredQuickInputShortcut = settings.shortcut;
    return { ok: true, settings, registered: true, displayShortcut: formatQuickInputShortcut(settings.shortcut) };
  }

  if (previousShortcut) {
    try {
      if (globalShortcut.register(previousShortcut, toggleQuickInputFromShortcut)) {
        registeredQuickInputShortcut = previousShortcut;
      }
    } catch {}
  }
  console.warn(`[quick-input] failed to register ${settings.shortcut}: ${error}`);
  return {
    ok: false,
    error,
    settings,
    registered: false,
    displayShortcut: formatQuickInputShortcut(settings.shortcut)
  };
}

function quickLaunchRuntimeState(cfg = loadConfig()) {
  const settings = normalizeQuickLaunchConfig(cfg.quickLaunch);
  return {
    ok: true,
    settings,
    registered: settings.enabled
      && registeredQuickInputShortcut === settings.shortcut
      && globalShortcut.isRegistered(settings.shortcut),
    displayShortcut: formatQuickInputShortcut(settings.shortcut)
  };
}

function sendQuickInputPromptToMain(text) {
  const prompt = String(text || '').trim();
  if (!prompt || !mainWindow || mainWindow.isDestroyed()) return;
  focusMainWindow();
  const deliver = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('quick-input:submit', { text: prompt });
    }
  };
  if (mainRendererReady) setTimeout(deliver, 80);
  else mainWindow.webContents.once('did-finish-load', deliver);
}

function showImageViewerWindow(key, query) {
  const existing = generatedImageViewers.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return { ok: true };
  }
  const viewer = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 560,
    minHeight: 420,
    title: '图片预览',
    backgroundColor: '#111111',
    show: false,
    autoHideMenuBar: true,
    icon: lightWindowIconPngPath,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'image-viewer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  generatedImageViewers.set(key, viewer);
  viewer.on('page-title-updated', event => {
    event.preventDefault();
    viewer.setTitle('图片预览');
  });
  viewer.loadFile(path.join(__dirname, 'renderer', 'image-viewer', 'index.html'), {
    query
  });
  viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewer.once('ready-to-show', () => {
    applyLightWindowIcon(viewer);
    viewer.show();
  });
  viewer.on('closed', () => generatedImageViewers.delete(key));
  return { ok: true };
}

function openGeneratedImageViewer(assetId) {
  const asset = getGeneratedImageAsset(assetId);
  if (!asset) return { error: '会话图片已失效，请重新生成' };
  return showImageViewerWindow(asset.assetId, {
    assetId: asset.assetId,
    lang: normalizeLanguage(loadConfig().language)
  });
}

// User-uploaded attachments preview through the same viewer window. Resolve a
// local image path with an extension allow-list plus a real-file check, and key
// the window by path so repeat clicks reuse the already-open viewer.
async function resolveLocalImageFile(filePath) {
  const target = path.resolve(String(filePath || ''));
  const extension = path.extname(target).slice(1).toLowerCase();
  const mimeType = GENERATED_IMAGE_MIME_BY_EXTENSION[extension];
  if (!mimeType) return null;
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile() || !stat.size) return null;
    return { path: target, name: path.basename(target), mimeType, size: stat.size };
  } catch {
    return null;
  }
}

async function openImageFileViewer(filePath) {
  const file = await resolveLocalImageFile(filePath);
  if (!file) return { error: '图片不可用或格式不支持预览' };
  const key = process.platform === 'win32' ? `file:${file.path.toLowerCase()}` : `file:${file.path}`;
  return showImageViewerWindow(key, {
    file: file.path,
    lang: normalizeLanguage(loadConfig().language)
  });
}

const PET_COLLAPSED_SIZE = { width: 248, height: 238 };
let petDragState = null;
let petDragTimer = null;

function getInitialPetBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    width: PET_COLLAPSED_SIZE.width,
    height: PET_COLLAPSED_SIZE.height,
    x: workArea.x + workArea.width - PET_COLLAPSED_SIZE.width - 18,
    y: workArea.y + workArea.height - PET_COLLAPSED_SIZE.height - 18
  };
}

function updatePetDrag() {
  if (!petDragState || !petWindow || petWindow.isDestroyed()) {
    stopPetDrag();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const nextX = Math.round(petDragState.windowX + cursor.x - petDragState.cursorX);
  const nextY = Math.round(petDragState.windowY + cursor.y - petDragState.cursorY);
  const current = petWindow.getBounds();
  if (current.x !== nextX || current.y !== nextY) petWindow.setPosition(nextX, nextY, false);
}

function startPetDrag() {
  if (!petWindow || petWindow.isDestroyed()) return;
  stopPetDrag();
  const cursor = screen.getCursorScreenPoint();
  const bounds = petWindow.getBounds();
  petDragState = {
    cursorX: cursor.x,
    cursorY: cursor.y,
    windowX: bounds.x,
    windowY: bounds.y
  };
  petDragTimer = setInterval(updatePetDrag, 16);
}

function stopPetDrag() {
  if (petDragTimer) clearInterval(petDragTimer);
  petDragTimer = null;
  petDragState = null;
}

function sendPetState() {
  if (activePetId !== 'orb' || !petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return;
  petWindow.webContents.send('pet:state', petState);
}

function sendPetConfig() {
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return;
  petWindow.webContents.send('pet:config', {
    selected: activePetId,
    label: PET_LABELS[activePetId],
    entertainment: activePetId !== 'orb'
  });
}

function notifyPetVisibility() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('pet:visibility', {
    visible: !!(petWindow && !petWindow.isDestroyed() && petWindow.isVisible())
  });
}

function destroyPetWindow() {
  stopPetDrag();
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = null;
    notifyPetVisibility();
    return;
  }
  petWindow.destroy();
}

function togglePetWindow() {
  const cfg = loadConfig();
  cfg.pet = normalizePetConfig(cfg.pet);
  cfg.pet.enabled = !(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());
  activePetId = cfg.pet.selected;
  saveConfig(cfg);
  if (!cfg.pet.enabled) {
    destroyPetWindow();
    return false;
  }
  createPetWindow();
  return true;
}

function applyPetConfigRuntime(pet = {}) {
  const next = normalizePetConfig(pet);
  activePetId = next.selected;
  if (!next.enabled) {
    destroyPetWindow();
    return;
  }
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
    return;
  }
  sendPetConfig();
  sendPetState();
}

function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.showInactive();
    return petWindow;
  }

  petWindow = new BrowserWindow({
    ...getInitialPetBounds(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'pet', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true
    }
  });

  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  petWindow.loadFile(path.join(__dirname, 'renderer', 'pet', 'index.html'), {
    query: { lang: normalizeLanguage(loadConfig().language) }
  });
  petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petWindow.once('ready-to-show', () => {
    petWindow.showInactive();
    sendPetConfig();
    sendPetState();
    notifyPetVisibility();
  });
  petWindow.on('close', (event) => {
    stopPetDrag();
    if (!isQuiting) {
      event.preventDefault();
      petWindow.hide();
    }
  });
  petWindow.on('closed', () => {
    stopPetDrag();
    petWindow = null;
    notifyPetVisibility();
  });
  return petWindow;
}

function showMainWindowForPet(sessionId) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (sessionId) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pet:action', { type: 'open-task', sessionId });
      }
    }, 0);
  }
}

function normalizePetState(payload = {}) {
  const allowedStates = new Set(['idle', 'observing', 'warning', 'paused', 'completed', 'error']);
  return {
    status: allowedStates.has(payload.status) ? payload.status : 'observing',
    sessionId: payload.sessionId ? String(payload.sessionId) : null,
    running: !!payload.running,
    title: String(payload.title || 'Z').slice(0, 80),
    message: String(payload.message || '正在监督任务').slice(0, 140),
    updatedAt: Date.now()
  };
}

// ---------------------------------------------------------------------------
// Tray (后台保活)
// ---------------------------------------------------------------------------
function createTray() {
  const icon = loadLightAppIcon();
  let trayIcon = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 });
  if (trayIcon.isEmpty()) return;
  tray = new Tray(trayIcon);
  tray.setToolTip('Z');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开 Z',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '打开/关闭桌宠',
      click: () => togglePetWindow()
    },
    { type: 'separator' },
    {
      label: '退出 Z',
      click: () => {
        isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // 单击托盘图标：显示/隐藏主窗口
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  // 双击托盘图标：显示主窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// IPC: Config / API / Models
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => publicConfig(loadConfig()));
ipcMain.handle('wallpaper:analyze', (_e, { source } = {}) => {
  try {
    return analyzeWallpaperSource(source, {
      rendererRoot: path.join(appRoot, 'renderer'),
      roots: [
        path.join(appRoot, 'renderer', 'assets', 'wallpapers'),
        path.join(dataDir, 'uploads')
      ]
    });
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle('vision-relay:status', () => getVisionRelayStatus(loadConfig()));
ipcMain.handle('vision-relay:open-guide-url', async (_e, { url = '' } = {}) => {
  let target;
  try {
    target = new URL(String(url || '').trim());
  } catch {
    throw new Error('教学网站地址无效。');
  }
  const allowedGuideUrls = new Set([
    'https://bigmodel.cn/glm-coding',
    'https://www.sensenova.cn/',
    'https://agnes-ai.com/',
    'https://www.siliconflow.cn/'
  ]);
  const normalized = `${target.origin}${target.pathname}`;
  if (target.protocol !== 'https:'
      || target.username
      || target.password
      || !allowedGuideUrls.has(normalized)) {
    throw new Error('仅允许打开视觉中继教学文档中的官方网站。');
  }
  if (process.env.Z_E2E_MODE !== '1') await shell.openExternal(target.toString());
  return { url: target.toString() };
});
ipcMain.handle('config:set', (_e, partial) => {
  const cfg = loadConfig();
  stripBlankConfigSecrets(partial);
  const merged = deepMerge(cfg, partial);
  if (partial?.api
      && Object.prototype.hasOwnProperty.call(partial.api, 'thinking')
      && !Object.prototype.hasOwnProperty.call(partial.api, 'reasoningSpeed')) {
    merged.api.reasoningSpeed = partial.api.thinking ? 'high' : 'medium';
  }
  merged.api.reasoningSpeed = normalizeReasoningSpeed(merged.api.reasoningSpeed, {
    thinking: merged.api.thinking === true
  });
  merged.api.thinking = reasoningSpeedEnablesThinking(merged.api.reasoningSpeed);
  merged.agent = normalizeAgentConfig(merged.agent);
  merged.context = normalizeContextSettings(merged.context);
  merged.quickLaunch = normalizeQuickLaunchConfig(merged.quickLaunch);
  merged.pet = normalizePetConfig(merged.pet);
  merged.tts = normalizeTtsConfig(merged.tts);
  merged.wallpaper = normalizeWallpaperConfig(merged.wallpaper);
  merged.themeCompat = normalizeThemeCompatConfig(merged.themeCompat);
  merged.userName = normalizeUserName(merged.userName);
  merged.language = normalizeLanguage(merged.language);
  merged.readingFont = normalizeReadingFont(merged.readingFont);
  delete merged.codeMap;

  // 确保 apiKeys 结构完整
  if (!merged.api.apiKeys) merged.api.apiKeys = buildDefaultApiKeys();
  for (const id of Object.keys(MODEL_PROVIDERS)) {
    if (merged.api.apiKeys[id] === undefined) merged.api.apiKeys[id] = '';
  }

  // 确保 provider 有效
  if (!merged.api.provider || !MODEL_PROVIDERS[merged.api.provider]) {
    merged.api.provider = DEFAULT_MODEL_ROLES.text.providerId;
  }

  const provider = MODEL_PROVIDERS[merged.api.provider];
  const connection = getProviderConnection(merged, merged.api.provider);
  merged.api.baseUrl = connection.baseUrl;
  merged.api.apiKey = connection.apiKey;
  merged.models = getProviderModels(merged, provider.id);

  // 确保当前选中的模型属于当前 provider
  if (!merged.models.find(m => m.id === merged.api.model && getModelType(provider.id, m) === 'text')) {
    merged.api.model = getFirstTextModel(provider.id, merged.models)?.id || '';
  }
  updateImageGenerationConfig(merged);

  merged.skills = getMergedSkills(merged);
  merged.mcpServers = ensureDefaultMcp(merged.mcpServers || []);
  delete merged.computerUseV3;
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'workspace')) {
    startWorkspaceWatcher(merged.workspace);
  }
  saveConfig(merged);
  if (partial?.pet) applyPetConfigRuntime(merged.pet);
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'disabledModels')) {
    publishModelState(merged);
  }
  return publicConfig(merged);
});

ipcMain.handle('quick-launch:get', () => quickLaunchRuntimeState());
ipcMain.handle('quick-launch:update', (_e, payload = {}) => {
  const cfg = loadConfig();
  const previous = normalizeQuickLaunchConfig(cfg.quickLaunch);
  const next = normalizeQuickLaunchConfig({
    enabled: payload.enabled,
    shortcut: payload.shortcut
  });
  const registration = registerQuickInputShortcut(next);
  if (!registration.ok) {
    return {
      ...registration,
      settings: previous,
      registered: previous.enabled
        && registeredQuickInputShortcut === previous.shortcut
        && globalShortcut.isRegistered(previous.shortcut),
      displayShortcut: formatQuickInputShortcut(previous.shortcut)
    };
  }
  cfg.quickLaunch = next;
  saveConfig(cfg);
  return quickLaunchRuntimeState(cfg);
});

// ---------------------------------------------------------------------------
// IPC: Text-to-speech (Edge neural voices for reading replies aloud)
// ---------------------------------------------------------------------------
let textToSpeechService = null;
function getTextToSpeechService() {
  if (!textToSpeechService) {
    textToSpeechService = createTextToSpeech({
      cacheDir: path.join(dataDir, 'tts-cache')
    });
  }
  return textToSpeechService;
}

ipcMain.handle('tts:synth', async (_e, payload = {}) => {
  try {
    const result = await getTextToSpeechService().synthesize({
      text: payload?.text,
      voice: payload?.voice,
      rate: payload?.rate,
      requestId: payload?.requestId
    });
    const audio = await fsp.readFile(result.path);
    return {
      ok: true,
      audio,
      mime: 'audio/mpeg',
      cached: !!result.cached,
      voice: result.voice,
      rate: result.rate
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('tts:voices', async () => {
  try {
    return { ok: true, voices: await getTextToSpeechService().listVoices() };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('tts:cancel', (_e, requestId) => {
  try {
    return { ok: true, cancelled: getTextToSpeechService().cancel(requestId) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

let pendingUpdatePackage = null;

ipcMain.handle('update:check', async () => {
  try {
    return await updateChecker.checkForUpdates({ currentVersion: app.getVersion() });
  } catch (error) {
    return { ok: false, error: 'check-failed', message: String(error?.message || error) };
  }
});

ipcMain.handle('update:download', async (event) => {
  try {
    const info = await updateChecker.checkForUpdates({ currentVersion: app.getVersion() });
    if (!info.ok) return info;
    if (!info.hasUpdate) return { ok: false, error: 'no-update', currentVersion: info.currentVersion };
    const targetDir = path.join(app.getPath('temp'), 'z-agent-update');
    await fsp.mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, info.fileName);
    const result = await updateChecker.downloadUpdate({
      url: info.fileUrl,
      targetPath,
      expectedSha512: info.sha512,
      expectedSize: info.size,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('update:progress', { ...progress, version: info.latestVersion });
        }
      }
    });
    pendingUpdatePackage = { path: result.path, version: info.latestVersion };
    return { ok: true, path: result.path, version: info.latestVersion, size: result.size };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('update:install', async () => {
  if (!pendingUpdatePackage) return { ok: false, error: 'no-package' };
  const error = await shell.openPath(pendingUpdatePackage.path);
  if (error) return { ok: false, error };
  setTimeout(() => app.quit(), 1200);
  return { ok: true };
});

ipcMain.handle('providers:list', () => {
  const cfg = loadConfig();
  const list = [];
  for (const id of Object.keys(MODEL_PROVIDERS)) {
    const p = MODEL_PROVIDERS[id];
    const configuredSuppliers = getProviderSuppliers(cfg, p.id)
      .filter(supplier => isConfiguredSupplier(cfg, p.id, supplier));
    const models = mergeProviderModelCatalog(
      ...configuredSuppliers.map(supplier => getProviderSupplierCatalog(p.id, supplier))
    );
    const officialMediaCapabilities = PROVIDER_MEDIA_CAPABILITIES[providerMediaPresetId(p)] || EMPTY_MEDIA_CAPABILITIES;
    const mediaAdapter = PROVIDER_MEDIA_ADAPTERS[providerMediaPresetId(p)] || EMPTY_MEDIA_CAPABILITIES;
    const hasImageModel = models.some(model => getModelType(p.id, model) === 'image');
    const hasVideoModel = models.some(model => getModelType(p.id, model) === 'video');
    const mediaCapabilities = {
      imageGeneration: mediaAdapter.imageGeneration && hasImageModel,
      imageEditing: mediaAdapter.imageEditing && hasImageModel,
      videoGeneration: mediaAdapter.videoGeneration && hasVideoModel
    };
    const connection = getProviderConnection(cfg, id);
    const activeSupplierId = String(cfg.api.providerActiveSupplierIds?.[id] || 'official');
    const suppliers = getProviderSuppliers(cfg, id).map(supplier => {
      const catalogModels = getProviderSupplierCatalog(id, supplier);
      // A bundled catalog describes what the provider supports, not what the
      // current supplier can use. Expose it as available only after the
      // supplier has credentials; dynamic providers still use their fetched
      // catalog after configuration.
      const supplierConfigured = isConfiguredSupplier(cfg, id, supplier);
      const supplierModels = configuredSupplierModels(catalogModels, supplierConfigured);
      const supplierHasImage = supplierModels.some(model => getModelType(id, model) === 'image');
      const supplierHasVideo = supplierModels.some(model => getModelType(id, model) === 'video');
      return {
        id: supplier.id,
        name: supplier.name,
        kind: supplier.kind,
        baseUrl: supplier.baseUrl,
        imageGenerationUrl: supplier.imageGenerationUrl,
        imageEditUrl: supplier.imageEditUrl,
        videoGenerationUrl: supplier.videoGenerationUrl,
        workspaceId: supplier.workspaceId,
        apiKeyPlaceholder: p.apiKeyPlaceholder,
        apiKeyConfigured: supplierConfigured,
        modelCount: supplierModels.length,
        models: supplierModels.map(model => ({
          id: model.id,
          name: model.name || model.id,
          modelType: getModelType(id, model),
          capabilities: model.capabilities || {}
        })),
        mediaCapabilities: {
          imageGeneration: mediaAdapter.imageGeneration && supplierHasImage,
          imageEditing: mediaAdapter.imageEditing && supplierHasImage,
          videoGeneration: mediaAdapter.videoGeneration && supplierHasVideo
        }
      };
    });
    list.push({
      id: p.id,
      name: p.name,
      baseUrl: connection.baseUrl,
      defaultBaseUrl: p.baseUrl,
      imageGenerationUrl: connection.imageGenerationUrl,
      imageEditUrl: connection.imageEditUrl,
      videoGenerationUrl: connection.videoGenerationUrl,
      workspaceId: connection.workspaceId,
      apiKeyPlaceholder: p.apiKeyPlaceholder,
      modelCount: models.length,
      dynamicModels: !!p.dynamicModels,
      custom: !!p.custom,
      apiFormat: p.apiFormat || '',
      ...(p.custom ? {
        modelId: String(cfg.customModel?.modelId || '').trim(),
        modelName: String(cfg.customModel?.modelName || '').trim()
      } : {}),
      configured: suppliers.some(supplier => supplier.apiKeyConfigured),
      activeSupplierId,
      suppliers,
      officialMediaCapabilities: { ...officialMediaCapabilities },
      mediaCapabilities: { ...mediaCapabilities },
      mediaAdapterReady: Object.values(mediaAdapter).some(Boolean)
    });
  }
  return list;
});

async function refreshConfiguredProviderModelCache(providerId) {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider?.dynamicModels) return { ok: false, skipped: true };
  const before = loadConfig();
  const connection = getProviderConnection(before, providerId);
  if (!connection.apiKey || !connection.baseUrl) return { ok: false, skipped: true };
  const models = await fetchRemoteModelCatalog({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    apiFormat: provider.apiFormat === 'anthropic' ? 'anthropic' : 'openai'
  });
  const cfg = loadConfig();
  const current = getProviderConnection(cfg, providerId);
  if (current.apiKey !== connection.apiKey || current.baseUrl !== connection.baseUrl) {
    return { ok: false, skipped: true };
  }
  if (!cfg.providerModels) cfg.providerModels = {};
  const activeSupplier = getActiveProviderSupplier(cfg, providerId);
  if (activeSupplier) {
    activeSupplier.models = models;
    syncActiveProviderSupplier(cfg, providerId, activeSupplier);
  }
  cfg.providerModels[providerId] = models;
  if (cfg.api.provider === providerId) {
    cfg.models = getProviderModels(cfg, providerId);
    if (!cfg.models.some(model => model.id === cfg.api.model && getModelType(providerId, model) === 'text')) {
      cfg.api.model = getFirstTextModel(providerId, cfg.models)?.id || '';
    }
  }
  normalizeAgentModelSelection(cfg);
  updateImageGenerationConfig(cfg);
  saveConfig(cfg);
  publishModelState(cfg);
  return { ok: true, modelCount: models.length };
}

ipcMain.handle('browser:recover-network', (_e, url) => (
  refreshBrowserNetworkSession(url, { resetConnections: true })
));

ipcMain.handle('browser:clear-data', async (_e, type) => {
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  if (type === 'cache') {
    await browserSession.clearCache();
    return { ok: true, type };
  }
  if (type === 'cookies') {
    await browserSession.clearStorageData({ storages: ['cookies'] });
    return { ok: true, type };
  }
  return { ok: false, error: '不支持的浏览器数据类型' };
});

ipcMain.on('browser:agent-command-result', (event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return;
  const requestId = String(payload.requestId || '');
  const pending = browserAgentBridgePending.get(requestId);
  if (!pending) return;
  browserAgentBridgePending.delete(requestId);
  clearTimeout(pending.timer);
  const result = payload.result && typeof payload.result === 'object'
    ? payload.result
    : { ok: false, error: '内置浏览器返回了无效结果。', code: 'Z_BROWSER_INVALID_RESULT' };
  pending.resolve(result);
});

ipcMain.on('session:agent-command-result', (event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return;
  const requestId = String(payload.requestId || '');
  const pending = sessionAgentBridgePending.get(requestId);
  if (!pending) return;
  sessionAgentBridgePending.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve({
    approved: payload.approved === true,
    error: String(payload.error || ''),
    code: String(payload.code || '')
  });
});

ipcMain.handle('provider:get-secret', (_e, { providerId, supplierId } = {}) => {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return { error: '未知厂商: ' + providerId };
  const cfg = loadConfig();
  ensureProviderConfigs(cfg);
  const id = String(supplierId || cfg.api.providerActiveSupplierIds?.[providerId] || 'official');
  const supplier = getProviderSuppliers(cfg, providerId).find(item => item.id === id);
  if (!supplier) return { error: '供应商不存在' };
  return { ok: true, apiKey: String(supplier.apiKey || '') };
});

ipcMain.handle('provider:add-supplier', (_e, { providerId, name } = {}) => {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider || provider.custom) return { error: '未知厂商或暂不支持自定义厂商多供应商' };
  const cfg = loadConfig();
  ensureProviderConfigs(cfg);
  const suppliers = cfg.api.providerSuppliers[providerId] || [];
  const baseName = String(name || '新供应商').trim() || '新供应商';
  let id = `supplier-${Date.now().toString(36)}`;
  let seq = 2;
  while (suppliers.some(item => item.id === id)) id = `supplier-${Date.now().toString(36)}-${seq++}`;
  const supplier = normalizeProviderSupplier({
    id,
    name: baseName,
    kind: 'custom',
    baseUrl: provider.baseUrl,
    models: provider.dynamicModels ? [] : provider.models
  }, provider);
  suppliers.push(supplier);
  cfg.api.providerSuppliers[providerId] = suppliers;
  saveConfig(cfg);
  return { ok: true, providerId, supplierId: id, config: publicConfig(cfg) };
});

ipcMain.handle('provider:set-supplier', (_e, { providerId, supplierId } = {}) => {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return { error: '未知厂商: ' + providerId };
  const cfg = loadConfig();
  ensureProviderConfigs(cfg);
  const supplier = getProviderSuppliers(cfg, providerId).find(item => item.id === String(supplierId || ''));
  if (!supplier) return { error: '供应商不存在' };
  if (!String(supplier.apiKey || '').trim()) return { error: '请先配置 API Key，再启用此连接' };
  syncActiveProviderSupplier(cfg, providerId, supplier);
  cfg.api.provider = providerId;
  cfg.api.baseUrl = supplier.baseUrl;
  cfg.api.apiKey = supplier.apiKey;
  cfg.models = getProviderModels(cfg, providerId, supplier.id);
  const selectedModel = getFirstTextModel(providerId, cfg.models);
  cfg.api.model = selectedModel?.id || '';
  cfg.agentModel = selectedModel
    ? {
        providerId,
        supplierId: supplier.id,
        modelId: selectedModel.id,
        modelType: 'text',
        name: selectedModel.name || selectedModel.id,
        capabilities: selectedModel.capabilities || {}
      }
    : {
        providerId,
        supplierId: supplier.id,
        modelId: '',
        modelType: 'text',
        name: '',
        capabilities: {}
      };
  updateImageGenerationConfig(cfg);
  saveConfig(cfg);
  publishModelState(cfg);
  return { ok: true, config: publicConfig(cfg) };
});

ipcMain.handle('provider:delete-supplier', (_e, { providerId, supplierId } = {}) => {
  const provider = MODEL_PROVIDERS[providerId];
  const id = String(supplierId || '').trim();
  if (!provider) return { error: '未知厂商: ' + providerId };
  if (!id || id === 'official') return { error: '官方供应商不可删除' };
  const cfg = loadConfig();
  ensureProviderConfigs(cfg);
  const suppliers = cfg.api.providerSuppliers[providerId] || [];
  if (!suppliers.some(item => item.id === id)) return { error: '供应商不存在' };
  cfg.api.providerSuppliers[providerId] = suppliers.filter(item => item.id !== id);
  rebindRolesAfterSupplierRemoval(cfg, providerId, id);
  if (cfg.api.providerActiveSupplierIds[providerId] === id) {
    const fallback = cfg.api.providerSuppliers[providerId].find(item => item.id === 'official')
      || cfg.api.providerSuppliers[providerId][0];
    syncActiveProviderSupplier(cfg, providerId, fallback);
    if (cfg.agentModel?.providerId === providerId) {
      cfg.api.provider = providerId;
      cfg.api.baseUrl = fallback.baseUrl;
      cfg.api.apiKey = fallback.apiKey;
      cfg.models = getProviderModels(cfg, providerId, fallback.id);
      cfg.api.model = getFirstTextModel(providerId, cfg.models)?.id || '';
    }
  }
  saveConfig(cfg);
  publishModelState(cfg);
  return { ok: true, config: publicConfig(cfg) };
});

const pendingProviderConfigurations = new Map();
const pendingConnectionSaves = new Map();

function providerConfigurationSnapshot(cfg, providerId, supplierId) {
  const supplier = cfg.api?.providerSuppliers?.[providerId]?.find(item => item.id === supplierId);
  const connection = cfg.api?.connections?.find(item => item.providerId === providerId && item.supplierId === supplierId);
  return JSON.stringify({ supplier, connection });
}

async function applyProviderConfiguration({
  providerId,
  supplierId,
  supplierName,
  apiKey,
  baseUrl,
  imageGenerationUrl,
  imageEditUrl,
  videoGenerationUrl,
  workspaceId,
  providerName,
  modelId,
  modelName,
  apiFormat
} = {}) {
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return { error: '未知厂商: ' + providerId };
  let key = String(apiKey || '').trim();
  const nextBaseUrl = String(baseUrl || provider.baseUrl).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(nextBaseUrl)) return { error: 'Base URL 必须以 http:// 或 https:// 开头' };
  const nextImageGenerationUrl = String(imageGenerationUrl || '').trim();
  const nextImageEditUrl = String(imageEditUrl || '').trim();
  const nextVideoGenerationUrl = String(videoGenerationUrl || '').trim();
  if ((nextImageGenerationUrl && !/^https?:\/\//i.test(nextImageGenerationUrl))
    || (nextImageEditUrl && !/^https?:\/\//i.test(nextImageEditUrl))
    || (nextVideoGenerationUrl && !/^https?:\/\//i.test(nextVideoGenerationUrl))) {
    return { error: '图片/视频 POST URL 必须以 http:// 或 https:// 开头' };
  }
  let cfg = loadConfig();
  ensureProviderConfigs(cfg);
  const selectedSupplierId = String(supplierId || cfg.api.providerActiveSupplierIds?.[providerId] || 'official').trim();
  let suppliers = cfg.api.providerSuppliers[providerId] || [];
  let supplier = suppliers.find(item => item.id === selectedSupplierId);
  if (!supplier) return { error: '供应商不存在' };
  // The UI intentionally does not echo stored secrets back into the form.
  // An empty key therefore means "keep the existing key" while the explicit
  // clear action remains available through provider:remove-config.
  if (!key && supplier.apiKey) key = supplier.apiKey;
  const effectiveApiFormat = normalizeApiFormat(apiFormat || provider.apiFormat || 'openai');
  const catalogApiFormat = effectiveApiFormat === 'anthropic' ? 'anthropic' : 'openai';
  const initialSnapshot = providerConfigurationSnapshot(cfg, providerId, selectedSupplierId);
  const requestKey = JSON.stringify([providerId, selectedSupplierId]);
  const requestToken = Symbol('provider-configuration');
  pendingProviderConfigurations.set(requestKey, requestToken);
  try {
    let models = provider.models;
    let catalogError = null;
    if (provider.custom) {
      const customModelId = String(modelId || '').trim();
      if (!customModelId) return { error: '请填写模型 ID' };
      const customModelName = String(modelName || customModelId).trim() || customModelId;
      models = [{ id: customModelId, name: customModelName, modelType: 'text', source: 'custom' }];
    } else if (provider.dynamicModels) {
      if (!key) {
        models = [];
      } else {
        try {
          models = await fetchRemoteModelCatalog({ baseUrl: nextBaseUrl, apiKey: key, apiFormat: catalogApiFormat });
        } catch (error) {
          catalogError = error;
        }
      }
    }
    // Model discovery yields to other settings writes. Commit only this
    // supplier's edit against the latest config, never the pre-request snapshot.
    // A newer save, removal, or external edit of this supplier supersedes us.
    cfg = loadConfig();
    ensureProviderConfigs(cfg);
    if (pendingProviderConfigurations.get(requestKey) !== requestToken
        || providerConfigurationSnapshot(cfg, providerId, selectedSupplierId) !== initialSnapshot) {
      return { error: '连接在保存期间已更改，请重新打开后重试。', code: 'PROVIDER_CONFIG_CHANGED' };
    }
    if (catalogError) return { error: `模型列表同步失败：${catalogError.message}` };
    suppliers = cfg.api.providerSuppliers[providerId] || [];
    supplier = suppliers.find(item => item.id === selectedSupplierId);
    const previousAgent = normalizeAgentModelSelection(cfg);
    const previousAgentConnection = getProviderConnectionForSupplier(
      cfg,
      previousAgent.providerId,
      previousAgent.supplierId
    );
    supplier = normalizeProviderSupplier({
      ...supplier,
      id: selectedSupplierId,
      name: String(supplierName || supplier.name || (selectedSupplierId === 'official' ? '官方' : '新供应商')).trim(),
      baseUrl: nextBaseUrl,
      apiKey: key,
      imageGenerationUrl: nextImageGenerationUrl,
      imageEditUrl: nextImageEditUrl,
      videoGenerationUrl: nextVideoGenerationUrl,
      workspaceId: providerId === 'qwen' ? String(workspaceId || '').trim() : ''
    }, provider, selectedSupplierId);
    supplier.models = normalizeRemoteModels(models);
    cfg.api.providerSuppliers[providerId] = suppliers.map(item => item.id === selectedSupplierId ? supplier : item);
    cfg.api.providerActiveSupplierIds[providerId] = selectedSupplierId;
    syncActiveProviderSupplier(cfg, providerId, supplier);
    if (providerId.startsWith('conn-')) {
      // Keep the dynamic registry entry (name/preset/manual model) in sync with
      // the supplier the connection just wrote.
      const connection = (cfg.api.connections || []).find(item => item.providerId === providerId);
      if (connection) {
        connection.manualModelId = provider.custom ? String(modelId || '').trim() : '';
      }
      syncConnectionProviders(cfg);
    }
    if (!cfg.providerModels) cfg.providerModels = {};
    if (provider.dynamicModels) cfg.providerModels[providerId] = models;
    const keepExistingAgent = !!(
      previousAgent.providerId
      && previousAgent.modelId
      && previousAgentConnection.apiKey
    );
    if (keepExistingAgent) {
      const previousModels = getProviderModels(cfg, previousAgent.providerId, previousAgent.supplierId);
      const previousModel = previousModels.find(model => model.id === previousAgent.modelId && getModelType(previousAgent.providerId, model) === 'text');
      if (previousModel) {
        const connection = getProviderConnectionForSupplier(cfg, previousAgent.providerId, previousAgent.supplierId);
        if (previousAgent.providerId === providerId && previousAgent.supplierId) {
          cfg.api.providerActiveSupplierIds[providerId] = previousAgent.supplierId;
        }
        cfg.api.provider = previousAgent.providerId;
        cfg.api.baseUrl = connection.baseUrl;
        cfg.api.apiKey = connection.apiKey;
        cfg.api.model = previousModel.id;
        cfg.models = previousModels;
      } else {
        applyProviderSelection(cfg, providerId, key, selectedSupplierId);
      }
    } else {
      applyProviderSelection(cfg, providerId, key, selectedSupplierId);
    }
    saveConfig(cfg);
    publishModelState(cfg);
    return {
      ok: true,
      config: publicConfig(cfg),
      providerId,
      supplierId: selectedSupplierId,
      modelCount: getProviderModels(cfg, providerId, selectedSupplierId).length
    };
  } finally {
    if (pendingProviderConfigurations.get(requestKey) === requestToken) {
      pendingProviderConfigurations.delete(requestKey);
    }
  }
}

ipcMain.handle('provider:configure', (_e, payload = {}) => applyProviderConfiguration(payload));

ipcMain.handle('provider:remove-config', (_e, payload) => {
  const providerId = typeof payload === 'string' ? payload : String(payload?.providerId || '');
  const requestedSupplierId = typeof payload === 'object' ? String(payload?.supplierId || '').trim() : '';
  const provider = MODEL_PROVIDERS[providerId];
  if (!provider) return { error: '未知厂商: ' + providerId };

  const cfg = loadConfig();
  ensureProviderConfigs(cfg);
  const activeSupplier = requestedSupplierId
    ? getProviderSuppliers(cfg, providerId).find(item => item.id === requestedSupplierId)
    : getActiveProviderSupplier(cfg, providerId);
  if (requestedSupplierId && !activeSupplier) return { error: '供应商不存在' };
  if (activeSupplier) {
    const clearedSupplierId = activeSupplier.id;
    activeSupplier.apiKey = '';
    activeSupplier.models = [];
    activeSupplier.imageGenerationUrl = '';
    activeSupplier.imageEditUrl = '';
    activeSupplier.videoGenerationUrl = '';
    syncActiveProviderSupplier(cfg, providerId, activeSupplier);
    rebindRolesAfterSupplierRemoval(cfg, providerId, clearedSupplierId);
    if (provider.custom && cfg.customModel) {
      cfg.customModel.apiKey = '';
      cfg.customModel.baseUrl = '';
      cfg.customModel.modelId = '';
      cfg.customModel.modelName = '';
      cfg.customModel.models = [];
      cfg.customProviders = [cfg.customModel];
    }
  } else {
    cfg.api.providerConfigs[providerId] = normalizeProviderConfig({}, provider);
    cfg.api.apiKeys[providerId] = '';
  }
  if (!cfg.providerModels) cfg.providerModels = {};
  if (provider.dynamicModels) cfg.providerModels[providerId] = [];
  if (cfg.agentModel?.providerId && cfg.agentModel?.modelId) {
    const agentConnection = getProviderConnectionForSupplier(
      cfg,
      cfg.agentModel.providerId,
      cfg.agentModel.supplierId
    );
    cfg.api.provider = cfg.agentModel.providerId;
    cfg.api.baseUrl = agentConnection.baseUrl;
    cfg.api.apiKey = agentConnection.apiKey;
    cfg.api.model = cfg.agentModel.modelId;
    cfg.models = getProviderModels(cfg, cfg.agentModel.providerId, cfg.agentModel.supplierId);
  } else {
    cfg.api.model = '';
    cfg.models = [];
  }

  updateImageGenerationConfig(cfg);
  saveConfig(cfg);
  publishModelState(cfg);
  return { ok: true, config: publicConfig(cfg) };
});

// ---------------------------------------------------------------------------
// IPC: user-defined connections (the flat API configuration surface)
// ---------------------------------------------------------------------------
function connectionSummary(cfg, connection) {
  const supplier = getProviderSupplier(cfg, connection.providerId, connection.supplierId);
  if (!supplier) return null;
  const name = String(supplier.name || '连接').trim() || '连接';
  const preset = connection.providerId.startsWith('conn-')
    ? resolveConnectionPreset(connection, name, supplier.baseUrl)
    : connection.providerId;
  const provider = MODEL_PROVIDERS[connection.providerId];
  const catalog = summarizeModelCatalog(
    getProviderSupplierApiCatalog(connection.providerId, supplier),
    STATIC_PROVIDER_SUPPLEMENTAL_MODELS[providerMediaPresetId(provider)] || []
  );
  return {
    id: connection.id,
    providerId: connection.providerId,
    supplierId: supplier.id,
    name,
    baseUrl: supplier.baseUrl || '',
    apiKeyConfigured: !!String(supplier.apiKey || '').trim(),
    imageGenerationUrl: supplier.imageGenerationUrl || '',
    imageEditUrl: supplier.imageEditUrl || '',
    videoGenerationUrl: supplier.videoGenerationUrl || '',
    preset,
    presetManual: connection.preset && connection.preset !== 'auto',
    apiFormat: resolveConnectionApiFormat(connection, name, supplier.baseUrl),
    streamEnabled: connection.streamEnabled !== false,
    manualModelId: String(connection.manualModelId || '').trim(),
    modelCount: catalog.modelCount,
    supplementalModelCount: catalog.supplementalModelCount,
    supplementalModelLabel: preset === 'glm' ? 'GLM 官方补充' : '官方补充',
    totalModelCount: catalog.totalModelCount,
    models: catalog.apiModels.map(model => ({
      id: model.id,
      name: model.name || model.id,
      modelType: getModelType(connection.providerId, model)
    })),
    isCurrentText: cfg.agentModel?.providerId === connection.providerId
      && cfg.agentModel?.supplierId === supplier.id,
    isEnabled: !!String(supplier.apiKey || '').trim()
      && cfg.api?.provider === connection.providerId
      && cfg.api?.providerActiveSupplierIds?.[connection.providerId] === supplier.id,
    logoProviderId: connection.providerId.startsWith('conn-') ? '' : connection.providerId,
    createdAt: Number(connection.createdAt) || 0
  };
}

ipcMain.handle('connections:list', () => {
  const cfg = loadConfig();
  return (cfg.api.connections || [])
    .map(connection => connectionSummary(cfg, connection))
    .filter(Boolean)
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
});

ipcMain.handle('connections:test', async (_e, { baseUrl, apiKey, preset, apiFormat: requestedFormat } = {}) => {
  const url = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Base URL 必须以 http:// 或 https:// 开头' };
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: '请填写 API Key 后再测试' };
  const requestedPreset = String(preset || 'auto').trim().toLowerCase();
  const capabilityPreset = requestedPreset === 'auto'
    ? inferConnectionPreset('', url)
    : (CONNECTION_PRESETS.includes(requestedPreset) ? requestedPreset : 'openai');
  const explicitFormat = normalizeApiFormat(requestedFormat);
  const apiFormat = resolveConnectionApiFormat({ preset: capabilityPreset, apiFormat: explicitFormat }, '', url);
  const catalogApiFormat = apiFormat === 'anthropic' ? 'anthropic' : 'openai';
  try {
    const catalog = await fetchRemoteModelCatalog({ baseUrl: url, apiKey: key, apiFormat: catalogApiFormat });
    const models = normalizeRemoteModels(catalog);
    return {
      ok: true,
      modelCount: models.length,
      models: models.map(model => ({
        id: model.id,
        name: model.name || model.id,
        modelType: getModelType(capabilityPreset, model)
      }))
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('connections:save', async (_e, payload = {}) => {
  const name = String(payload.name || '').trim() || '新连接';
  const preset = CONNECTION_PRESETS.includes(String(payload.preset || 'auto'))
    ? String(payload.preset)
    : 'auto';
  const manualModelId = String(payload.manualModelId || '').trim();
  const apiFormat = normalizeApiFormat(payload.apiFormat);
  const existingId = String(payload.id || '').trim();
  let cfg = loadConfig();
  if (!Array.isArray(cfg.api.connections)) cfg.api.connections = [];
  let connection = findConnection(cfg, existingId);
  let created = false;
  if (!connection) {
    const providerId = newConnectionId();
    connection = {
      id: providerId,
      providerId,
      supplierId: 'official',
      preset,
      apiFormat,
      streamEnabled: payload.streamEnabled !== false,
      manualModelId,
      createdAt: Date.now()
    };
    cfg.api.connections.push(connection);
    cfg.api.providerSuppliers[providerId] = [{
      id: 'official',
      name,
      kind: 'official',
      baseUrl: '',
      apiKey: '',
      imageGenerationUrl: '',
      imageEditUrl: '',
      videoGenerationUrl: '',
      workspaceId: '',
      models: []
    }];
    cfg.api.providerActiveSupplierIds[providerId] = 'official';
    created = true;
  }
  connection.preset = preset;
  connection.apiFormat = apiFormat;
  connection.streamEnabled = payload.streamEnabled !== false;
  connection.manualModelId = manualModelId;
  const supplier = cfg.api.providerSuppliers[connection.providerId]?.find(item => item.id === connection.supplierId);
  if (supplier) supplier.name = name;
  syncConnectionProviders(cfg);
  saveConfig(cfg);

  // Retain ownership through the caller's await and rollback as well as the
  // catalog request itself; another save can start in that microtask gap.
  const saveKey = JSON.stringify([connection.providerId, connection.supplierId]);
  const saveToken = Symbol('connection-save');
  ensureProviderConfigs(cfg);
  const createdSnapshot = providerConfigurationSnapshot(cfg, connection.providerId, connection.supplierId);
  pendingConnectionSaves.set(saveKey, saveToken);
  try {
    const result = await applyProviderConfiguration({
      providerId: connection.providerId,
      supplierId: connection.supplierId,
      supplierName: name,
      apiKey: payload.apiKey,
      baseUrl: payload.baseUrl,
      imageGenerationUrl: payload.imageGenerationUrl,
      imageEditUrl: payload.imageEditUrl,
      videoGenerationUrl: payload.videoGenerationUrl,
      providerName: name,
      modelId: manualModelId || undefined,
      modelName: manualModelId || undefined,
      apiFormat: resolveConnectionApiFormat(connection, name, String(payload.baseUrl || ''))
    });
    if (!result?.ok && created && result?.code !== 'PROVIDER_CONFIG_CHANGED') {
      // A brand-new connection that cannot be validated is rolled back so the
      // list never shows a half-configured ghost entry. An obsolete request
      // cannot roll back a connection that another save has since edited.
      const rollback = loadConfig();
      ensureProviderConfigs(rollback);
      if (pendingConnectionSaves.get(saveKey) !== saveToken
          || pendingProviderConfigurations.has(saveKey)
          || providerConfigurationSnapshot(rollback, connection.providerId, connection.supplierId) !== createdSnapshot) {
        return { error: '连接在保存期间已更改，请重新打开后重试。', code: 'PROVIDER_CONFIG_CHANGED' };
      }
      rollback.api.connections = (rollback.api.connections || []).filter(item => item.id !== connection.id);
      delete rollback.api.providerSuppliers[connection.providerId];
      delete rollback.api.providerActiveSupplierIds?.[connection.providerId];
      delete rollback.api.providerConfigs?.[connection.providerId];
      delete rollback.api.apiKeys?.[connection.providerId];
      delete rollback.providerModels?.[connection.providerId];
      delete MODEL_PROVIDERS[connection.providerId];
      saveConfig(rollback);
      return result;
    }
    if (!result?.ok) return result;
    const finalConfig = result.config;
    const summary = connectionSummary(finalConfig, connection);
    return {
      ok: true,
      modelCount: summary?.modelCount || 0,
      supplementalModelCount: summary?.supplementalModelCount || 0,
      totalModelCount: summary?.totalModelCount || 0,
      connection: summary
    };
  } finally {
    if (pendingConnectionSaves.get(saveKey) === saveToken) pendingConnectionSaves.delete(saveKey);
  }
});

ipcMain.handle('connections:delete', (_e, { id } = {}) => {
  const cfg = loadConfig();
  const connection = findConnection(cfg, id);
  if (!connection) return { error: '连接不存在' };
  const { providerId, supplierId } = connection;
  cfg.api.connections = cfg.api.connections.filter(item => item.id !== connection.id);
  if (providerId.startsWith('conn-')) {
    delete cfg.api.providerSuppliers[providerId];
    delete cfg.api.providerActiveSupplierIds?.[providerId];
    delete cfg.api.providerConfigs?.[providerId];
    delete cfg.api.apiKeys?.[providerId];
    delete cfg.providerModels?.[providerId];
    delete MODEL_PROVIDERS[providerId];
    if (cfg.agentModel?.providerId === providerId) {
      cfg.agentModel = { ...cfg.agentModel, providerId: '', supplierId: '', modelId: '', name: '' };
    }
    for (const role of ['image', 'video']) {
      if (cfg.media?.[`${role}Provider`] === providerId) {
        cfg.media[`${role}Provider`] = '';
        cfg.media[`${role}SupplierId`] = '';
        cfg.media[`${role}Model`] = '';
        cfg.media[`${role}Name`] = '';
      }
    }
  } else if (supplierId === 'official') {
    const supplier = getProviderSupplier(cfg, providerId, supplierId);
    if (supplier) {
      supplier.apiKey = '';
      supplier.models = [];
      supplier.imageGenerationUrl = '';
      supplier.imageEditUrl = '';
      supplier.videoGenerationUrl = '';
      syncActiveProviderSupplier(cfg, providerId, supplier);
      rebindRolesAfterSupplierRemoval(cfg, providerId, supplierId);
    }
  } else {
    cfg.api.providerSuppliers[providerId] = (cfg.api.providerSuppliers[providerId] || [])
      .filter(item => item.id !== supplierId);
    if (cfg.api.providerActiveSupplierIds?.[providerId] === supplierId) {
      cfg.api.providerActiveSupplierIds[providerId] = 'official';
    }
    rebindRolesAfterSupplierRemoval(cfg, providerId, supplierId);
  }
  if (cfg.agentModel?.providerId && cfg.agentModel?.modelId) {
    const agentConnection = getProviderConnectionForSupplier(cfg, cfg.agentModel.providerId, cfg.agentModel.supplierId);
    cfg.api.provider = cfg.agentModel.providerId;
    cfg.api.baseUrl = agentConnection.baseUrl;
    cfg.api.apiKey = agentConnection.apiKey;
    cfg.api.model = cfg.agentModel.modelId;
    cfg.models = getProviderModels(cfg, cfg.agentModel.providerId, cfg.agentModel.supplierId);
  }
  normalizeAgentModelSelection(cfg);
  updateImageGenerationConfig(cfg);
  saveConfig(cfg);
  publishModelState(cfg);
  return { ok: true };
});

// All configured connections are available outside settings. Only public
// model metadata crosses this endpoint, never API keys or gateway URLs.
function composerConnections(cfg) {
  return Object.values(MODEL_PROVIDERS).flatMap(provider => getProviderSuppliers(cfg, provider.id).flatMap(supplier => {
    if (!isConfiguredSupplier(cfg, provider.id, supplier)) return [];
    const models = getProviderSupplierCatalog(provider.id, supplier)
      .filter(model => getModelType(provider.id, model) === 'text')
      .map(model => ({ id: model.id, name: model.name || model.id, capabilities: model.capabilities || {} }));
    if (!models.length) return [];
    return [{ providerId: provider.id, supplierId: supplier.id,
      name: supplier.id === 'official' ? provider.name : `${provider.name} · ${supplier.name}`, models }];
  }));
}

function observerConnectionForRun(cfg) {
  const observer = normalizeObserverSettings(cfg.observer);
  const selection = observer.model;
  if (!selection) return null;
  const entry = composerConnections(cfg).find(item => item.providerId === selection.providerId && item.supplierId === selection.supplierId);
  if (!entry?.models.some(model => model.id === selection.modelId)) {
    return { ...selection, reasoningEffort: observer.reasoningEffort, unavailable: true };
  }
  const connection = getProviderConnectionForSupplier(cfg, selection.providerId, selection.supplierId);
  const model = getProviderModels(cfg, selection.providerId, selection.supplierId).find(item => item.id === selection.modelId);
  return { ...selection, ...connection, reasoningEffort: observer.reasoningEffort,
    maxOutputTokens: observer.maxOutputTokens,
    capabilities: model?.capabilities || {}, apiFormat: MODEL_PROVIDERS[selection.providerId]?.apiFormat || 'openai' };
}

ipcMain.handle('models:connections', () => {
  const cfg = loadConfig();
  return { connections: composerConnections(cfg), observer: normalizeObserverSettings(cfg.observer) };
});
ipcMain.handle('observer:configure', (_event, payload = {}) => {
  const cfg = loadConfig();
  const every = Number(payload.judgeEvery);
  if (!Number.isInteger(every) || every < 1 || every > 100) return { error: '检查间隔须为 1 到 100 个工具动作' };
  if (payload.model !== null) {
    const model = payload.model || {};
    const entry = composerConnections(cfg).find(item => item.providerId === model.providerId && item.supplierId === model.supplierId);
    const selected = entry?.models.find(item => item.id === model.modelId);
    if (!selected) return { error: '请选择已启用 API 中的文本模型' };
    if (Object.hasOwn(payload, 'maxOutputTokens')) {
      const error = validateOutputTokens(payload.maxOutputTokens, { modelId: selected.id, capabilities: selected.capabilities });
      if (error) return { error };
    }
    const previous = cfg.observer?.model;
    if (!Object.hasOwn(payload, 'maxOutputTokens') && (previous?.providerId !== model.providerId
      || previous?.supplierId !== model.supplierId || previous?.modelId !== model.modelId)) {
      payload = { ...payload, maxOutputTokens: 0 };
    }
    payload = { ...payload, model: { providerId: entry.providerId, supplierId: entry.supplierId, modelId: selected.id, name: selected.name } };
  }
  cfg.observer = normalizeObserverSettings({ ...cfg.observer, ...payload });
  saveConfig(cfg);
  publishModelState(cfg);
  return { observer: cfg.observer };
});

// End-of-turn goal check by the observer model. One review per conversation; a
// newer request or a cancel aborts the older one. Only goal/result summaries are
// sent, never API keys; the renderer decides what to do with the verdict.
const completionReviews = new Map();
ipcMain.handle('observer:review-completion', async (_event, payload = {}) => {
  const sessionId = String(payload.sessionId || '');
  if (!sessionId) return { skipped: 'no-session' };
  const cfg = loadConfig();
  const settings = completionSettings(normalizeObserverSettings(cfg.observer).completion);
  if (!settings.enabled) return { skipped: 'disabled' };
  const connection = observerConnectionForRun(cfg);
  if (!connection) return { skipped: 'rules-only' };
  if (connection.unavailable) return { error: '所选观察者 API 已停用，请在观察者设置里重新选择', maxWakes: settings.maxWakes };
  completionReviews.get(sessionId)?.abort();
  const controller = new AbortController();
  completionReviews.set(sessionId, controller);
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const verdict = await reviewCompletion(connection, completionInput(payload), { signal: controller.signal });
    return { verdict, maxWakes: settings.maxWakes, model: connection.name || connection.modelId };
  } catch (error) {
    if (controller.signal.aborted) return { cancelled: true };
    const message = String(error?.message || '');
    return { error: message.startsWith('观察者模型') ? message.slice(0, 160) : '观察者模型暂时不可用，本轮未核验', maxWakes: settings.maxWakes };
  } finally {
    clearTimeout(timer);
    if (completionReviews.get(sessionId) === controller) completionReviews.delete(sessionId);
  }
});
ipcMain.handle('observer:cancel-completion', (_event, sessionId) => {
  completionReviews.get(String(sessionId || ''))?.abort();
  return { ok: true };
});

// Pending/scheduled observer wakes, indexed so startup can find them without
// opening every conversation. The full record also lives on the session.
const observerWakeIndexPath = () => path.join(dataDir, 'observer-wakes.json');
function readObserverWakes() {
  try { const value = JSON.parse(fs.readFileSync(observerWakeIndexPath(), 'utf8')); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
}
let observerWakeWrite = Promise.resolve();
ipcMain.handle('observer:list-wakes', () => Object.entries(readObserverWakes()).map(([sessionId, record]) => ({ ...record, sessionId })));
ipcMain.handle('observer:set-completion', async (_event, sessionId, record) => {
  const id = String(sessionId || '');
  if (!isSafeSessionId(id) || !record || typeof record !== 'object' || JSON.stringify(record).length > 32_000) return { ok: false };
  const wake = ['pending', 'scheduled'].includes(record.status);
  // Only this field changes: no updatedAt bump, so the conversation keeps its place in the list.
  const saved = await withSessionWrite(id, async () => {
    const p = sessionPath(id);
    const data = p && fs.existsSync(p) ? await readSessionRecord(id, { sessionLocked: true }) : null;
    if (!data) return false;
    data.observerCompletion = record;
    await writeSessionFileAtomic(p, JSON.stringify(data, null, 2));
    return true;
  });
  observerWakeWrite = observerWakeWrite.then(async () => {
    const index = readObserverWakes();
    if (wake && saved) index[id] = record; else delete index[id];
    await writeAtomic(observerWakeIndexPath(), index);
  }).catch(error => console.warn('[observer] wake index write failed:', error?.message || error));
  await observerWakeWrite;
  return { ok: saved };
});

ipcMain.handle('models:quick-list', () => {
  const cfg = loadConfig();
  const activeSelection = normalizeAgentModelSelection(cfg);
  const pickerProviderId = String(cfg.api.provider || activeSelection.providerId || '');
  const activeSupplierId = String(cfg.api.providerActiveSupplierIds?.[pickerProviderId] || activeSelection.supplierId || '');
  const activeSupplier = pickerProviderId && activeSupplierId
    ? getProviderSuppliers(cfg, pickerProviderId).find(item => item.id === activeSupplierId)
    : null;
  const activeConfigured = isConfiguredSupplier(cfg, pickerProviderId, activeSupplier);
  const activeModels = activeConfigured
    ? configuredSupplierModels(getProviderSupplierCatalog(pickerProviderId, activeSupplier), true)
        .map(model => ({
          ...model,
          providerId: pickerProviderId,
          providerName: MODEL_PROVIDERS[pickerProviderId]?.name || pickerProviderId,
          supplierId: activeSupplier.id,
          supplierName: activeSupplier.name || activeSupplier.id,
          // The renderer groups quick-picker entries by the public top-level
          // modelType. Dynamic connection catalogs also keep the richer
          // capability object, but must expose this field explicitly.
          modelType: getModelType(pickerProviderId, model)
        }))
    : [];
  const providers = activeConfigured
    ? [{
        providerId: pickerProviderId,
        providerName: MODEL_PROVIDERS[pickerProviderId]?.name || pickerProviderId,
        suppliers: [{
          supplierId: activeSupplier.id,
          supplierName: activeSupplier.name || activeSupplier.id,
          configured: true,
          active: true,
          selected: true,
          models: activeModels
        }]
      }]
    : [];
  const models = activeModels.slice();
  // Keep role-specific media selections visible even when their supplier is
  // different from the text-model browsing cursor. This prevents the image
  // and video sections in settings from appearing to lose a configured model.
  for (const role of ['image', 'video']) {
    const providerId = String(cfg.media?.[`${role}Provider`] || '');
    const supplierId = String(cfg.media?.[`${role}SupplierId`] || '');
    if (!providerId || !supplierId) continue;
    const provider = providers.find(item => item.providerId === providerId);
    const supplier = provider?.suppliers?.find(item => item.supplierId === supplierId);
    for (const model of supplier?.models || []) {
      if (model.modelType !== role) continue;
      if (!models.some(item => item.providerId === model.providerId && item.supplierId === model.supplierId && item.id === model.id)) {
        models.push(model);
      }
    }
  }
  const providerCount = new Set(models.map(model => model.providerId)).size;
  const hasTextModel = models.some(model => model.modelType === 'text');
  return {
    models,
    providers,
    activeProviderId: pickerProviderId,
    activeSupplierId,
    providerCount,
    providerName: hasTextModel ? `已启用 ${providers.length} 家厂商` : '尚未启用文本模型',
    notice: hasTextModel ? '' : '请先在设置 → API 中启用一个包含文本模型的连接。'
  };
});
ipcMain.handle('models:media-list', () => {
  const cfg = loadConfig();
  const providers = Object.values(MODEL_PROVIDERS).flatMap(provider => {
    const adapter = PROVIDER_MEDIA_ADAPTERS[providerMediaPresetId(provider)] || EMPTY_MEDIA_CAPABILITIES;
    if (!Object.values(adapter).some(Boolean)) return [];
    return getProviderSuppliers(cfg, provider.id).flatMap(supplier => {
      if (!isConfiguredSupplier(cfg, provider.id, supplier)) return [];
      return [{
        providerId: provider.id,
        providerName: provider.name,
        supplierId: supplier.id,
        supplierName: supplier.name,
        models: getProviderSupplierCatalog(provider.id, supplier),
        configured: true
      }];
    });
  });
  const models = buildMediaModelList({
      providers,
      media: cfg.media
    });
  // Clear media selections that no longer belong to any configured supplier.
  // This prevents a deleted connection from remaining active in z-media or
  // being shown by a renderer that was already open when the deletion happened.
  let mediaChanged = false;
  for (const role of ['image', 'video']) {
    const providerId = String(cfg.media?.[`${role}Provider`] || '');
    const supplierId = String(cfg.media?.[`${role}SupplierId`] || '');
    const modelId = String(cfg.media?.[`${role}Model`] || '');
    if (!providerId || !modelId) continue;
    const stillAvailable = models.some(model => model.modelType === role
      && model.providerId === providerId
      && model.id === modelId
      && (!supplierId || String(model.supplierId || '') === supplierId));
    if (stillAvailable) continue;
    cfg.media[`${role}Provider`] = '';
    cfg.media[`${role}SupplierId`] = '';
    cfg.media[`${role}Model`] = '';
    cfg.media[`${role}Name`] = '';
    mediaChanged = true;
  }
  if (mediaChanged) {
    updateImageGenerationConfig(cfg);
    saveConfig(cfg);
  }
  return {
    models,
    notice: providers.length ? '' : '请先配置至少一家已适配媒体能力的厂商 API。'
  };
});
ipcMain.handle('model:role-set', (_e, payload = {}) => (
  setActiveModelRole(payload.providerId, payload.modelId, payload.modelType, payload.supplierId)
));

ipcMain.handle('skills:list', () => getMergedSkills(loadConfig()));
ipcMain.handle('skills:catalog', () => skillRegistry.getAllSkillsForCatalog(loadConfig(), appRoot, dataDir));
ipcMain.handle('skills:open-directory', async (_e, skillId) => {
  const id = String(skillId || '').trim().toLowerCase();
  if (!id) return { ok: false, error: 'Skill ID 为空。' };
  const skill = skillRegistry.getInstalledSkills(loadConfig(), appRoot, dataDir)
    .find(item => String(item?.id || '').trim().toLowerCase() === id);
  if (!skill?.runtimeDirectory) return { ok: false, error: '这个 Skill 没有可打开的用户目录。' };
  if (['builtin', 'bundled', 'Z Agent'].includes(skillRegistry.normalizeSkillSource(skill.source))) {
    return { ok: false, error: '内置 Skill 不提供用户资源目录。' };
  }
  const directory = path.resolve(String(skill.runtimeDirectory));
  try {
    const stat = await fsp.stat(directory);
    if (!stat.isDirectory()) return { ok: false, error: 'Skill 目录不可用。' };
    const error = await shell.openPath(directory);
    return error ? { ok: false, error } : { ok: true, path: directory };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

function upsertCustomSkill(skill = {}) {
  const cfg = loadConfig();
  if (!cfg.customSkills) cfg.customSkills = [];
  const idx = cfg.customSkills.findIndex(s => s.id === String(skill.id || '').trim());
  const previous = idx >= 0 ? cfg.customSkills[idx] : null;
  const item = {
    id: String(skill.id || '').trim(),
    name: String(skill.name || skill.id || 'Custom Skill').trim(),
    desc: String(skill.desc || '').trim(),
    prompt: String(skill.prompt || '').trim(),
    source: skill.source || 'custom',
    repo: String(skill.repo || '').trim() || undefined,
    stars: String(skill.stars || '').trim() || undefined,
    aliases: Array.isArray(skill.aliases) ? skill.aliases.map(alias => String(alias || '').trim()).filter(Boolean) : [],
    tags: Array.isArray(skill.tags) ? skill.tags.map(tag => String(tag || '').trim()).filter(Boolean) : [],
    triggers: Array.isArray(skill.triggers) ? skill.triggers.map(trigger => String(trigger || '').trim()).filter(Boolean) : [],
    requires: Array.isArray(skill.requires) ? skill.requires : [],
    version: Number.isFinite(Number(skill.version)) ? Number(skill.version) : 1,
    logo: skillRegistry.resolveSkillLogo(skill),
    createdBy: String(skill.createdBy || previous?.createdBy || '').trim() || undefined,
    evidenceCount: Number.isFinite(Number(skill.evidenceCount)) ? Number(skill.evidenceCount) : previous?.evidenceCount,
    installedAt: previous?.installedAt || Date.now(),
    updatedAt: Number.isFinite(Number(skill.updatedAt)) ? Number(skill.updatedAt) : Date.now()
  };
  if (!item.id || !item.prompt) return { error: 'id 和 prompt 为必填项' };
  if (DEFAULT_SKILLS.find(s => s.id === item.id)) return { error: '与内置 Skill 冲突' };
  const installResult = skillRegistry.installZUserSkill(dataDir, item);
  if (!installResult.ok) return { error: installResult.error };
  const storedItem = skillConfigMetadata(item);
  if (idx >= 0) cfg.customSkills[idx] = storedItem;
  else cfg.customSkills.push(storedItem);
  saveConfig(cfg);
  const storeResult = refreshZSkillRegistry({ reason: 'install', id: item.id });
  if (!storeResult.ok) return { error: storeResult.error };
  return { ...storedItem, runtimeDirectory: installResult.directory };
}

ipcMain.handle('skills:add-custom', (_e, skill) => upsertCustomSkill(skill));

ipcMain.handle('skills:remove-custom', (_e, id) => {
  const cfg = loadConfig();
  const removeResult = skillRegistry.removeZUserSkill(dataDir, id);
  if (!removeResult.ok) return { error: removeResult.error };
  cfg.customSkills = (cfg.customSkills || []).filter(s => s.id !== id);
  saveConfig(cfg);
  const storeResult = refreshZSkillRegistry({ reason: 'remove', id });
  if (!storeResult.ok) return { error: storeResult.error };
  return true;
});

async function recordLearningReview(payload = {}) {
  if (!payload.skillCandidate) return { ok: true, candidate: null, promotedSkill: null };
  const recorded = skillEvolution.record(payload.skillCandidate, {
    verified: !!payload.verified,
    toolCallCount: payload.toolCallCount,
    runId: payload.runId,
    sessionId: payload.sessionId,
    workspace: payload.workspace
  });
  if (!recorded.ok) return { ...recorded, promotedSkill: null };

  const candidate = recorded.candidate;
  const learnedId = `z-learned-${candidate.id.replace(/^z-(?:learned-)?/, '')}`;
  const scope = payload.workspace ? 'workspace' : 'global';
  const state = continualHarness.load({ scope, workspace: payload.workspace });
  const existingHarnessSkill = state.entries.skill[learnedId];
  const harnessEdit = {
    action: existingHarnessSkill ? 'update' : 'create',
    kind: 'skill',
    id: learnedId,
    title: candidate.name,
    content: candidate.prompt,
    path: 'learned',
    scope,
    metadata: {
      status: recorded.ready ? 'active' : 'observing',
      description: candidate.description,
      triggers: candidate.triggers || [],
      successfulRuns: candidate.successfulRuns,
      evidenceCount: candidate.successfulRuns.length
    },
    reason: candidate.evidence
  };
  const harnessResult = await continualHarness.apply({
    trigger: `Learn reusable Skill ${candidate.name}`,
    evidence: candidate.evidence,
    expectedOutcome: recorded.ready
      ? 'Make the repeatedly verified procedure available as a Z Skill.'
      : 'Observe the same procedure in another independent verified run before activation.',
    edits: [harnessEdit]
  }, {
    scope,
    workspace: payload.workspace,
    expectedRevision: payload.harnessBaseline?.revision,
    baselineState: payload.harnessBaseline,
    runId: payload.runId,
    sessionId: payload.sessionId,
    source: 'background_review'
  });
  if (!harnessResult.ok || !harnessResult.refinement?.appliedEdits?.some(edit => edit.applied)) {
    return { ...recorded, harnessResult, promotedSkill: null };
  }
  if (!recorded.ready) {
    await continualHarness.recordOutcome(harnessResult.refinement.id, {
      status: 'partial',
      evidence: 'Candidate retained in observing state pending independent reinforcement.'
    }, { scope, workspace: payload.workspace });
    return { ...recorded, harnessResult, promotedSkill: null };
  }

  // P0-1 promotion gate: workflow-mined candidates (and everything under the
  // strict env flag) must carry a passing Z Eval validation before the
  // candidate may be projected into a real Skill. The validation is now real:
  // static checks plus one headless judge session, whose evidence record is
  // attached to the candidate and persisted for the topology gate.
  const requiresValidation = Boolean(candidate.verification?.postconditions?.length)
    || process.env.Z_AGI_STRICT_SKILL_PROMOTION === '1';
  if (requiresValidation && !candidate.validation) {
    const evidence = await validateSkillCandidate(candidate, payload.sidecar || null);
    if (evidence.ok) {
      const attached = skillEvolution.attachValidation(candidate.id, evidence);
      if (attached.ok) candidate.validation = attached.validation;
    } else {
      console.warn(`[agi] skill candidate ${candidate.id} failed validation: ${evidence.failed}/${evidence.passed + evidence.failed} checks passed`);
    }
  }
  const promotionGate = skillEvolution.canPromote(candidate.id, { requireValidation: requiresValidation });
  if (!promotionGate.ok) {
    await continualHarness.rollback(harnessResult.refinement.id, {
      scope,
      workspace: payload.workspace,
      source: 'validation_gate',
      evidence: promotionGate.reason
    });
    return { ...recorded, harnessResult, error: promotionGate.reason, promotedSkill: null };
  }
  // P1-5 guard visibility: consistency issues never block a legacy promotion
  // path, but they must surface instead of disappearing into the projection.
  try {
    const consistency = checkConsistency({
      name: candidate.name,
      description: candidate.description,
      prompt: candidate.prompt
    });
    if (!consistency.ok) {
      console.warn(`[agi] skill candidate ${candidate.id} consistency issues: ${consistency.issues.map(issue => issue.code).join(', ')}`);
    }
  } catch {}

  const existingSkill = (loadConfig().customSkills || []).find(skill => skill.id === learnedId);
  if (existingSkill && !skillRegistry.isGeneratedSkill(existingSkill)) {
    await continualHarness.rollback(harnessResult.refinement.id, {
      scope,
      workspace: payload.workspace,
      source: 'projection_failed',
      evidence: `A user or external Skill already owns ${learnedId}.`
    });
    return {
      ...recorded,
      error: `同名 Skill「${learnedId}」已由用户或外部来源安装，Z 不会覆盖它。`,
      promotedSkill: null
    };
  }
  const promotedSkill = upsertCustomSkill({
    id: learnedId,
    name: candidate.name,
    desc: candidate.description,
    prompt: candidate.prompt,
    source: 'z-self-evolution',
    aliases: [],
    tags: ['learned'],
    triggers: candidate.triggers || [],
    requires: [],
    version: 1,
    createdBy: 'z-skill-creator',
    evidenceCount: candidate.successfulRuns.length,
    updatedAt: Date.now()
  });
  if (promotedSkill?.error) {
    await continualHarness.rollback(harnessResult.refinement.id, {
      scope,
      workspace: payload.workspace,
      source: 'projection_failed',
      evidence: promotedSkill.error
    });
    return { ...recorded, error: promotedSkill.error, harnessResult, promotedSkill: null };
  }
  skillEvolution.markPromoted(candidate.id, promotedSkill.id, { refinementId: harnessResult.refinement.id });
  await continualHarness.recordOutcome(harnessResult.refinement.id, {
    status: 'verified',
    evidence: `${candidate.successfulRuns.length} distinct verified runs reinforced this procedure and the Skill projection succeeded.`
  }, { scope, workspace: payload.workspace });
  return { ...recorded, harnessResult, promotedSkill };
}

ipcMain.handle('skills:market', () => skillRegistry.getMarketSkills(appRoot, dataDir));

ipcMain.handle('skills:read', (_e, payload) => {
  const { id, taskContext } = payload || {};
  const cfg = loadConfig();
  return skillRegistry.readSkillWithRetry(id, taskContext, cfg, appRoot, dataDir, saveConfig, {
    allowUserOnly: true,
    maxAttempts: 3
  });
});

// ---------------------------------------------------------------------------
// IPC: Workspace
// ---------------------------------------------------------------------------
let workspaceWatcher = null;
let workspaceNotifyTimer = null;
const pendingWorkspaceChanges = new Map();

const WORKSPACE_WATCH_IGNORED_ROOTS = new Set([
  ZAGENT_DIR,
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  '.turbo'
]);

function shouldIgnoreWorkspaceWatch(filename) {
  if (!filename) return false;
  const norm = String(filename).replace(/\\/g, '/');
  return norm.split('/').some(segment => WORKSPACE_WATCH_IGNORED_ROOTS.has(segment));
}

// Per-workspace repo map cache. Built once, refreshed on workspace file
// changes (watcher) or after a TTL, and frozen into each run's request so the
// kernel's cached system prefix stays stable for the whole run.
const REPO_MAP_TTL_MS = 5 * 60_000;
const REPO_MAP_BUDGET_TOKENS = 1200;
const repoMapCache = new Map();
const repoMapInflight = new Map();

function invalidateRepoMap(workspace) {
  const key = String(workspace || '').trim();
  if (!key) return;
  repoMapCache.delete(path.resolve(key).toLowerCase());
  repoMapInflight.get(path.resolve(key).toLowerCase())?.cancel?.();
  repoMapInflight.delete(path.resolve(key).toLowerCase());
}

async function getCachedRepoMap(workspace) {
  const normalized = workspaceSandbox.normalizeWorkspace(workspace);
  if (!normalized) return '';
  const key = normalized.toLowerCase();
  const cached = repoMapCache.get(key);
  if (cached && Date.now() - cached.builtAt < REPO_MAP_TTL_MS) return cached.text;
  const inflight = repoMapInflight.get(key);
  if (inflight) return inflight;
  const controller = new AbortController();
  const building = (async () => {
    try {
      const text = await buildRepoMapBackground(normalized, { budgetTokens: REPO_MAP_BUDGET_TOKENS, signal: controller.signal });
      if (repoMapInflight.get(key) === building) repoMapCache.set(key, { text, builtAt: Date.now() });
      return text;
    } catch {
      return '';
    } finally {
      if (repoMapInflight.get(key) === building) repoMapInflight.delete(key);
    }
  })();
  building.cancel = () => controller.abort();
  repoMapInflight.set(key, building);
  return building;
}

function notifyWorkspaceChanged(detail = {}) {
  if (detail.workspace) invalidateRepoMap(detail.workspace);
  if (detail.path) {
    pendingWorkspaceChanges.set(detail.path, {
      path: detail.path,
      eventType: detail.eventType || 'change'
    });
  }
  if (workspaceNotifyTimer) clearTimeout(workspaceNotifyTimer);
  workspaceNotifyTimer = setTimeout(() => {
    workspaceNotifyTimer = null;
    const payload = {
      workspace: detail.workspace || loadConfig().workspace,
      changes: [...pendingWorkspaceChanges.values()].slice(0, 100),
      timestamp: Date.now()
    };
    pendingWorkspaceChanges.clear();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workspace:changed', payload);
    }
  }, 300);
}

function stopWorkspaceWatcher() {
  if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = null;
  }
  pendingWorkspaceChanges.clear();
}

function startWorkspaceWatcher(workspace) {
  stopWorkspaceWatcher();
  if (!workspace || !fs.existsSync(workspace)) return;
  try {
    workspaceWatcher = fs.watch(workspace, { recursive: true }, (eventType, filename) => {
      if (shouldIgnoreWorkspaceWatch(filename)) return;
      const relPath = String(filename || '').replace(/\\/g, '/');
      notifyWorkspaceChanged({
        workspace,
        eventType,
        path: relPath ? path.join(workspace, relPath) : workspace
      });
    });
    workspaceWatcher.on('error', () => stopWorkspaceWatcher());
  } catch {
    stopWorkspaceWatcher();
  }
}

let pendingFocusMain = process.argv.includes('--show-main');

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingFocusMain = true;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

ipcMain.handle('workspace:get', () => loadConfig().workspace);
function activateWorkspace(workspace) {
  const ws = workspace || '';
  const cfg = loadConfig();
  cfg.workspace = ws;
  saveConfig(cfg);
  if (ws) {
    migrateMemoryToWorkspace(ws);
    ensureZagent(ws);
  }
  startWorkspaceWatcher(ws);
  return cfg;
}
ipcMain.handle('workspace:activate', (_e, workspace) => activateWorkspace(workspace));
async function pickWorkspaceDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return !result.canceled && result.filePaths.length ? result.filePaths[0] : null;
}
ipcMain.handle('workspace:pick', pickWorkspaceDirectory);
ipcMain.handle('workspace:choose', async () => {
  const workspace = await pickWorkspaceDirectory();
  if (workspace) {
    const cfg = loadConfig();
    cfg.workspace = workspace;
    saveConfig(cfg);
    startWorkspaceWatcher(cfg.workspace);
    return workspace;
  }
  return null;
});

ipcMain.handle('workspace:open-explorer', async (_e, workspace) => {
  const normalized = workspaceSandbox.normalizeWorkspace(workspace);
  if (!normalized) return { ok: false, error: '工作区路径为空。' };
  try {
    const stat = await fsp.stat(normalized);
    if (!stat.isDirectory()) return { ok: false, error: '工作区不是文件夹。' };
    const error = await shell.openPath(normalized);
    return error ? { ok: false, error } : { ok: true, path: normalized };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

// ---------------------------------------------------------------------------
// IPC: Git
// ---------------------------------------------------------------------------
async function gitIpc(action) {
  try {
    const result = await action();
    if (result && typeof result === 'object' && !Array.isArray(result)) return { ok: true, ...result };
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      code: error?.code || 'GIT_ERROR'
    };
  }
}

ipcMain.handle('git:status', (_e, { workspace = '' } = {}) => gitIpc(async () => ({
  status: await gitService.repositoryStatus(workspace)
})));
ipcMain.handle('git:init', (_e, { workspace = '', initialBranch = 'main' } = {}) => gitIpc(async () => ({
  status: await gitService.initRepository(workspace, initialBranch)
})));
ipcMain.handle('git:stage', (_e, { workspace = '', paths = [], all = false } = {}) => gitIpc(async () => ({
  status: await gitService.stageFiles(workspace, paths, all)
})));
ipcMain.handle('git:unstage', (_e, { workspace = '', paths = [], all = false } = {}) => gitIpc(async () => ({
  status: await gitService.unstageFiles(workspace, paths, all)
})));
ipcMain.handle('git:discard', (_e, { workspace = '', paths = [] } = {}) => gitIpc(async () => ({
  status: await gitService.discardFiles(workspace, paths)
})));
ipcMain.handle('git:commit', (_e, { workspace = '', message = '', amend = false } = {}) => gitIpc(() => (
  gitService.commit(workspace, message, { amend })
)));
ipcMain.handle('git:branch-create', (_e, { workspace = '', name = '', checkout = true } = {}) => gitIpc(async () => ({
  status: await gitService.createBranch(workspace, name, { checkout })
})));
ipcMain.handle('git:branch-switch', (_e, { workspace = '', name = '', remoteBranch = '' } = {}) => gitIpc(async () => ({
  status: await gitService.switchBranch(workspace, name, remoteBranch)
})));
ipcMain.handle('git:fetch', (_e, { workspace = '', remoteName = '' } = {}) => gitIpc(async () => ({
  status: await gitService.fetchRemote(workspace, remoteName)
})));
ipcMain.handle('git:pull', (_e, { workspace = '' } = {}) => gitIpc(async () => ({
  status: await gitService.pull(workspace)
})));
ipcMain.handle('git:push', (_e, { workspace = '', remoteName = '' } = {}) => gitIpc(async () => ({
  status: await gitService.push(workspace, remoteName)
})));
ipcMain.handle('git:remote-add', (_e, { workspace = '', name = '', url = '' } = {}) => gitIpc(async () => ({
  status: await gitService.addRemote(workspace, name, url)
})));
ipcMain.handle('git:remote-set-url', (_e, { workspace = '', name = '', url = '' } = {}) => gitIpc(async () => ({
  status: await gitService.setRemoteUrl(workspace, name, url)
})));
ipcMain.handle('git:remote-remove', (_e, { workspace = '', name = '' } = {}) => gitIpc(async () => ({
  status: await gitService.removeRemote(workspace, name)
})));
ipcMain.handle('git:identity-set', (_e, { workspace = '', name = '', email = '' } = {}) => gitIpc(async () => ({
  status: await gitService.setIdentity(workspace, name, email)
})));
ipcMain.handle('git:history', (_e, { workspace = '', limit = 40 } = {}) => gitIpc(async () => ({
  commits: await gitService.history(workspace, limit)
})));
ipcMain.handle('git:diff', (_e, { workspace = '', path: filePath = '', staged = false } = {}) => gitIpc(async () => ({
  diff: await gitService.diff(workspace, filePath, staged)
})));
ipcMain.handle('git:review', (_e, { workspace = '', options = {} } = {}) => gitIpc(async () => ({
  review: await runReviewTask('gitReview', workspace, options)
})));
ipcMain.handle('git:review-document', (_e, { workspace = '', path: filePath = '', options = {} } = {}) => gitIpc(async () => ({
  document: await gitService.reviewDocument(workspace, filePath, options)
})));
ipcMain.handle('git:pick-clone-destination', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择空文件夹作为克隆目标',
    buttonLabel: '选择文件夹',
    properties: ['openDirectory', 'createDirectory']
  });
  return !result.canceled && result.filePaths.length ? result.filePaths[0] : '';
});
ipcMain.handle('git:clone', (_e, { remoteUrl = '', destination = '' } = {}) => gitIpc(() => (
  gitService.cloneRepository(remoteUrl, destination)
)));
ipcMain.handle('git:open-remote', (_e, { remoteUrl = '' } = {}) => gitIpc(async () => {
  const url = gitService.remoteWebUrl(remoteUrl);
  if (!url) {
    const error = new Error('该远程地址没有可打开的网页。');
    error.code = 'REMOTE_WEB_URL_UNAVAILABLE';
    throw error;
  }
  await shell.openExternal(url);
  return { url };
}));

// Task-scoped git worktrees (parallel builder isolation) and GitHub PR flows.
// The agent reaches the same operations through z_workspace MCP tools; the
// channels exist so the Git panel and scripts can drive them too.
ipcMain.handle('git:worktree-create', (_e, { workspace = '', taskId = '', base = '' } = {}) => gitIpc(async () => ({
  worktree: await worktreeService.createTaskWorktree(workspace, { taskId, base })
})));
ipcMain.handle('git:worktree-list', (_e, { workspace = '' } = {}) => gitIpc(async () => ({
  worktrees: await worktreeService.listTaskWorktrees(workspace)
})));
ipcMain.handle('git:worktree-status', (_e, { workspace = '', taskId = '' } = {}) => gitIpc(async () => ({
  status: await worktreeService.taskWorktreeStatus(workspace, { taskId })
})));
ipcMain.handle('git:worktree-merge', (_e, { workspace = '', taskId = '', message = '', squash = false } = {}) => gitIpc(async () => (
  worktreeService.mergeTaskWorktree(workspace, { taskId, message, squash })
)));
ipcMain.handle('git:worktree-remove', (_e, { workspace = '', taskId = '', force = false } = {}) => gitIpc(async () => (
  worktreeService.removeTaskWorktree(workspace, { taskId, force })
)));
ipcMain.handle('gh:detect', () => gitIpc(async () => ({
  ghPath: await ghService.detectGh()
})));
ipcMain.handle('gh:pr-list', (_e, { workspace = '', limit = 20, state = 'open', base = '' } = {}) => gitIpc(async () => ({
  prs: await ghService.prList({ cwd: workspace, limit, state, base })
})));
ipcMain.handle('gh:pr-diff', (_e, { workspace = '', number = 0 } = {}) => gitIpc(async () => ({
  diff: await ghService.prDiff({ cwd: workspace, number })
})));
ipcMain.handle('gh:pr-view', (_e, { workspace = '', number = 0 } = {}) => gitIpc(async () => ({
  pr: await ghService.prView({ cwd: workspace, number })
})));
ipcMain.handle('gh:pr-create', (_e, { workspace = '', title = '', body = '', base = '', draft = false } = {}) => gitIpc(async () => (
  ghService.prCreate({ cwd: workspace, title, body, base, draft })
)));

// ---------------------------------------------------------------------------
// IPC: Sessions (CRUD)
// ---------------------------------------------------------------------------
function isSafeSessionId(value) {
  const id = String(value || '').trim();
  return /^sess_[A-Za-z0-9_-]{4,160}$/.test(id);
}

function sessionPath(id) {
  const normalized = String(id || '').trim();
  return isSafeSessionId(normalized) ? path.join(sessionsDir, `${normalized}.json`) : null;
}

function sanitizeSessionReviewSummaries(session) {
  if (!session || typeof session !== 'object') return session;
  const workspace = String(session.workspace || '');
  for (const message of Array.isArray(session.messages) ? session.messages : []) {
    const run = message?.agentRun;
    if (!run?.changeSummary) continue;
    const summary = filterReviewSummary(workspace, run.changeSummary);
    run.changeCount = summary.count;
    if (summary.count > 0) run.changeSummary = summary;
    else delete run.changeSummary;
  }
  return session;
}

// Subagent records keep live de-duplication bookkeeping: every observed event
// id, milestone copies of tool output, and streaming buffers. Once a record is
// terminal none of it is read again, but serializing it on every save made
// long tasks with many subagents produce tens of megabytes of session JSON,
// which then stalled the main process on every read, save and list refresh.
const TERMINAL_SUBAGENT_STATUSES = new Set(['completed', 'error', 'interrupted', 'incomplete']);
const SUBAGENT_RUNTIME_BOOKKEEPING_FIELDS = ['seenEvents', 'milestones', 'pendingDeltas', 'nextStreams', 'partKinds', 'messages'];

// Long tasks often hold a few multi-megabyte messages (subagent records with
// full tool output). Count-based paging alone still ships those whole, so IPC
// payloads are bounded by accumulated character size as well.
const MESSAGE_TAIL_COUNT = 40;
const MESSAGE_TAIL_CHAR_BUDGET = 3_000_000;
const MESSAGE_PAGE_CHAR_BUDGET = 6_000_000;
const messageSizeEstimateCache = new WeakMap();

function estimateMessageSize(value, depth = 0) {
  if (value == null) return 0;
  const type = typeof value;
  if (type === 'string') return value.length;
  if (type !== 'object') return 8;
  if (depth > 8) return 8;
  if (depth === 0) {
    const cached = messageSizeEstimateCache.get(value);
    if (cached !== undefined) return cached;
    let total = 0;
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        total += key.length + 2 + estimateMessageSize(value[key], depth + 1);
      }
      if (total > 64_000_000) break;
    }
    messageSizeEstimateCache.set(value, total);
    return total;
  }
  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += estimateMessageSize(item, depth + 1);
    return total;
  }
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      total += key.length + 2 + estimateMessageSize(value[key], depth + 1);
    }
    if (total > 64_000_000) break;
  }
  return total;
}

function selectTailMessages(messages, countLimit = MESSAGE_TAIL_COUNT, sizeBudget = MESSAGE_TAIL_CHAR_BUDGET) {
  let start = messages.length;
  let count = 0;
  let size = 0;
  while (start > 0) {
    const estimated = estimateMessageSize(messages[start - 1]);
    // Always keep at least the newest message so a single oversized message
    // cannot produce an empty conversation.
    if (start < messages.length && (count >= countLimit || size + estimated > sizeBudget)) break;
    start -= 1;
    count += 1;
    size += estimated;
  }
  return { tail: messages.slice(start), messagesStart: start };
}

function pruneSessionRuntimeBookkeeping(session) {
  if (!session || typeof session !== 'object') return session;
  for (const message of Array.isArray(session.messages) ? session.messages : []) {
    const run = message?.agentRun;
    if (!run || typeof run !== 'object' || !Array.isArray(run.subagents)) continue;
    for (const record of run.subagents) {
      if (!record || typeof record !== 'object' || !TERMINAL_SUBAGENT_STATUSES.has(record.status)) continue;
      for (const field of SUBAGENT_RUNTIME_BOOKKEEPING_FIELDS) {
        if (record[field] !== undefined) delete record[field];
      }
    }
  }
  return session;
}

// session:get fires on every task switch, and re-reading plus re-parsing a
// multi-megabyte session file each time stalled the main process for hundreds
// of milliseconds while the window sat on the loading spinner. Cache parsed
// records keyed by file mtime+size, exactly like the summary cache below.
const sessionRecordCache = new Map();
const SESSION_RECORD_CACHE_MAX = 6;

function touchSessionRecordCache(id, session, stat) {
  const key = String(id || '');
  if (!key || !session || !stat) return;
  sessionRecordCache.delete(key);
  sessionRecordCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, session });
  while (sessionRecordCache.size > SESSION_RECORD_CACHE_MAX) {
    sessionRecordCache.delete(sessionRecordCache.keys().next().value);
  }
}

function invalidateSessionRecordCache(id) {
  sessionRecordCache.delete(String(id || ''));
}

const sessionWorkspaceAssignments = new Map();
const withSessionWrite = createSessionWriteQueue();

function initialSessionModelSelection(session) {
  const cfg = loadConfig();
  const candidates = composerConnections(cfg).flatMap(connection => connection.models.map(model => ({
    providerId: connection.providerId, supplierId: connection.supplierId, modelId: model.id
  })));
  return inferSessionModelSelection(session, { ...cfg.agentModel,
    reasoningSpeed: cfg.api?.reasoningSpeed, thinking: cfg.api?.thinking,
    compactionThreshold: normalizeContextSettings(cfg.context).compactionThreshold }, candidates);
}

function resolveSessionModelSelection(cfg, requested) {
  const selection = sessionModelSnapshot({ ...requested,
    reasoningSpeed: requested?.reasoningSpeed ?? cfg.api?.reasoningSpeed, thinking: cfg.api?.thinking,
    compactionThreshold: requested?.compactionThreshold ?? normalizeContextSettings(cfg.context).compactionThreshold });
  const fail = () => {
    const error = new Error(`此对话的模型“${selection?.name || selection?.modelId || '未选择'}”或供应商已不可用，请为此对话重新选择模型。`);
    error.code = 'SESSION_MODEL_UNAVAILABLE';
    throw error;
  };
  if (!selection?.providerId || !selection.supplierId || !selection.modelId) return fail();
  const supplier = cfg.api?.providerSuppliers?.[selection.providerId]?.find(item => item.id === selection.supplierId);
  if (!MODEL_PROVIDERS[selection.providerId] || !supplier || !isConfiguredSupplier(cfg, selection.providerId, supplier)) return fail();
  const model = getProviderModels(cfg, selection.providerId, selection.supplierId)
    .find(item => item.id === selection.modelId && getModelType(selection.providerId, item) === 'text');
  if (!model) return fail();
  if (Object.hasOwn(requested, 'maxOutputTokens')) {
    const message = validateOutputTokens(requested.maxOutputTokens, { modelId: model.id,
      capabilities: model.capabilities, contextWindow: cfg.context?.maxTokens });
    if (message) {
      const error = new Error(message);
      error.code = 'MODEL_OUTPUT_LIMIT_INVALID';
      throw error;
    }
  }
  return sessionModelSnapshot({ ...selection, name: model.name || model.id, capabilities: model.capabilities || {} });
}

function applySessionModelToRunConfig(cfg, requested) {
  const selection = resolveSessionModelSelection(cfg, requested);
  const connection = getProviderConnectionForSupplier(cfg, selection.providerId, selection.supplierId);
  // Old frozen turns can outlive a later window-size change. Resolve their
  // effective boundary only for this run without rewriting conversation history.
  cfg.context = { ...cfg.context, ...normalizeContextSettings({ ...cfg.context,
    compactionThreshold: selection.compactionThreshold }) };
  selection.compactionThreshold = cfg.context.compactionThreshold;
  cfg.agentModel = selection;
  cfg.api = { ...cfg.api, provider: selection.providerId, model: selection.modelId,
    reasoningSpeed: selection.reasoningSpeed, thinking: reasoningSpeedEnablesThinking(selection.reasoningSpeed),
    baseUrl: connection.baseUrl, apiKey: connection.apiKey,
    providerActiveSupplierIds: { ...cfg.api.providerActiveSupplierIds, [selection.providerId]: selection.supplierId } };
  cfg.models = getProviderModels(cfg, selection.providerId, selection.supplierId);
  return selection;
}

async function ensureStoredSessionWorkspace(session) {
  if (!session || !isSafeSessionId(session.id)) return session;
  if (String(session.workspace || '').trim() && ['default', 'selected'].includes(session.workspaceKind)) return session;
  if (sessionWorkspaceAssignments.has(session.id)) return sessionWorkspaceAssignments.get(session.id);
  const operation = (async () => {
    const workspace = await ensureTaskWorkspace(session, { root: defaultTasksRoot, dataDirectory: dataDir });
    Object.assign(session, workspace);
    // Assigning a task folder must not reorder old conversations or touch any
    // historical files in their former private runtime folder.
    await writeSessionFileAtomic(sessionPath(session.id), JSON.stringify(session, null, 2));
    await refreshSessionSummaryCache(session.id, session);
    return session;
  })();
  sessionWorkspaceAssignments.set(session.id, operation);
  try { return await operation; }
  finally {
    if (sessionWorkspaceAssignments.get(session.id) === operation) sessionWorkspaceAssignments.delete(session.id);
  }
}

async function readSessionRecord(id, options = {}) {
  if (!options.sessionLocked) return withSessionWrite(id, () => readSessionRecord(id, { ...options, sessionLocked: true }));
  const key = String(id || '');
  const file = sessionPath(key);
  if (!file || !fs.existsSync(file)) return null;
  let stat = await fsp.stat(file);
  const cached = sessionRecordCache.get(key);
  let data;
  let needsSanitizing = false;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    data = cached.session;
  } else {
    data = JSON.parse(await fsp.readFile(file, 'utf8'));
    needsSanitizing = true;
  }
  if (!String(data.workspace || '').trim() || !['default', 'selected'].includes(data.workspaceKind)) {
    data = await ensureStoredSessionWorkspace(data);
    stat = await fsp.stat(file);
    needsSanitizing = true;
  }
  if (!sessionModelSnapshot(data.modelSelection) || !Object.hasOwn(data.modelSelection, 'reasoningSpeed')
      || !Number.isSafeInteger(data.modelSelection?.compactionThreshold) || data.modelSelection.compactionThreshold <= 0) {
    data = { ...data, modelSelection: initialSessionModelSelection(data) };
    await writeSessionFileAtomic(file, JSON.stringify(data, null, 2));
    await refreshSessionSummaryCache(key, data);
    stat = await fsp.stat(file);
    needsSanitizing = true;
  }
  if (needsSanitizing) pruneSessionRuntimeBookkeeping(sanitizeSessionReviewSummaries(data));
  touchSessionRecordCache(key, data, stat);
  // Task switching only needs the newest messages to paint the conversation;
  // the full history stays cached here and is served page by page through
  // session:messages, so a multi-megabyte session no longer crosses IPC whole.
  const messageLimit = Number(options.messageLimit) || 0;
  if (messageLimit > 0 && Array.isArray(data.messages) && data.messages.length > 1) {
    const { tail, messagesStart } = selectTailMessages(data.messages, messageLimit);
    if (messagesStart > 0) {
      return {
        ...data,
        messages: tail,
        totalMessages: data.messages.length,
        messagesStart,
        messagesTruncated: true
      };
    }
  }
  return data;
}

// session:list fires after every run completion and session save. Parsing
// every session file (with full message history) each time made the app
// progressively slower as usage accumulated. Summaries are tiny immutable
// objects, so cache them keyed by file mtime+size and re-parse only files
// that actually changed.
const sessionSummaryCache = new Map();

async function listSessionSummaries({ includeRewindBackups = false } = {}) {
  ensureDirs();
  const files = await fsp.readdir(sessionsDir);
  const summaries = [];
  // Disk state can change while the app runs, so workspace existence is
  // re-checked (one stat per unique workspace) on every list call.
  const workspaceExists = new Map();
  const workspaceMissing = workspace => {
    const value = String(workspace || '').trim();
    if (!value) return false;
    if (!workspaceExists.has(value)) {
      try { workspaceExists.set(value, fs.existsSync(value)); }
      catch { workspaceExists.set(value, false); }
    }
    return !workspaceExists.get(value);
  };
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(sessionsDir, file);
    try {
      const stat = await fsp.stat(filePath);
      const cached = sessionSummaryCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        summaries.push({ ...cached.summary, workspaceMissing: workspaceMissing(cached.summary.workspace) });
        continue;
      }
      // session:save refreshes the parsed-record cache; reuse it so a large
      // session changed by a running task is not parsed a second time here.
      const key = file.slice(0, -'.json'.length);
      const cachedRecord = sessionRecordCache.get(key);
      let data = null;
      if (cachedRecord && cachedRecord.mtimeMs === stat.mtimeMs && cachedRecord.size === stat.size) {
        data = cachedRecord.session;
      } else {
        data = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      }
      if (!isSafeSessionId(data?.id)) continue;
      sanitizeSessionReviewSummaries(data);
      const summary = toSessionSummary(data);
      sessionSummaryCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      summaries.push({ ...summary, workspaceMissing: workspaceMissing(summary.workspace) });
    } catch { /* skip invalid session files */ }
  }
  const ids = new Set(summaries.map(summary => summary.id));
  return summaries.filter(summary => includeRewindBackups || !summary.isRewindBackup
    || !ids.has(summary.rewindBackupOf?.sessionId)).sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function toSessionSummary(data) {
  const backup = data.rewindBackupOf;
  const backupSourceId = isSafeSessionId(backup?.sessionId) ? backup.sessionId : '';
  return {
    id: data.id,
    title: data.title,
    workspace: data.workspace || '',
    workspaceKind: data.workspaceKind || (data.workspace ? 'selected' : 'default'),
    parentSessionId: data.parentSessionId || '',
    hasHandoff: !!data.handoff,
    ...(data.forkedFrom ? { forkedFrom: data.forkedFrom } : {}),
    ...(data.rewindState ? { rewindState: data.rewindState } : {}),
    ...(backupSourceId ? { rewindBackupOf: { sessionId: backupSourceId,
      createdAt: Number(backup.createdAt) || Number(data.createdAt) || 0,
      messageCount: Number(backup.messageCount) || 0 },
      isRewindBackup: data.contextReset?.kind === 'rewind-backup'
        && data.contextReset.sourceSessionId === backupSourceId
        && Array.isArray(data.messages) && data.messages.length === backup.messageCount } : {}),
    conversationRevision: sessionConversationRevision(data),
    pinned: !!data.pinned,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: (data.messages || []).length,
    browserTabCount: Array.isArray(data.browserState?.tabs) ? data.browserState.tabs.length : 0
  };
}

function notifyDesktopSessionUpdate(detail) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('session:changed', detail || {});
}

let createSessionPromise = null;
let sessionDeleteQueue = Promise.resolve();

function isSessionRunActive(sessionId) {
  const target = String(sessionId || '');
  if (!target) return false;
  if ([...openCodeActiveRuns.values()].some(run => String(run?.zSessionId || '') === target)) return true;
  return [...openCodeRunAdmissions.values()].some(admittedSessionId => String(admittedSessionId || '') === target);
}

async function createFreshSessionRecord(options = {}) {
  ensureDirs();
  const id = 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const session = {
    id,
    title: String(options.title || '新对话').slice(0, 80),
    messages: [],
    pinned: false,
    workspace: normalizeWorkspacePath(options.workspace),
    createdAt: Date.now(), updatedAt: Date.now()
  };
  session.modelSelection = initialSessionModelSelection(session);
  if (options.parentSessionId) session.parentSessionId = String(options.parentSessionId);
  if (options.handoff) session.handoff = options.handoff;
  Object.assign(session, await ensureTaskWorkspace(session, { root: defaultTasksRoot }));
  await fsp.writeFile(sessionPath(id), JSON.stringify(session, null, 2));
  return session;
}

async function forkSessionRecord(boundary = {}) {
  const sourceId = String(boundary.sessionId || '');
  if (!isSafeSessionId(sourceId)) throw Object.assign(new Error('来源对话 ID 无效。'), { code: 'SESSION_FORK_SOURCE_NOT_FOUND' });
  return withSessionWrite(sourceId, async () => {
    ensureDirs();
    // Read the durable record directly: legacy read migrations must not edit
    // the source conversation as a side effect of creating its branch.
    const text = await fsp.readFile(sessionPath(sourceId), 'utf8').catch(error => {
      if (error.code === 'ENOENT') throw Object.assign(new Error('来源对话不存在。'), { code: 'SESSION_FORK_SOURCE_NOT_FOUND' });
      throw error;
    });
    const source = JSON.parse(text);
    forkBoundary(source, boundary);
    const resolved = await ensureTaskWorkspace(source, { root: defaultTasksRoot, dataDirectory: dataDir });
    const workspaceStat = await fsp.stat(resolved.workspace).catch(() => null);
    if (!workspaceStat?.isDirectory()) throw Object.assign(new Error('来源任务文件夹不存在，无法共享文件创建分支。'), { code: 'SESSION_FORK_WORKSPACE_UNAVAILABLE' });
    const cfg = loadConfig();
    const candidates = composerConnections(cfg).flatMap(connection => connection.models.map(model => ({
      providerId: connection.providerId, supplierId: connection.supplierId, modelId: model.id
    })));
    const id = `sess_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
    const session = createSessionForkRecord(source, boundary, { id, workspace: resolved.workspace,
      defaultSelection: cfg.agentModel, candidates });
    await writeSessionFileAtomic(sessionPath(id), JSON.stringify(session, null, 2));
    await refreshSessionSummaryCache(id, session);
    notifyDesktopSessionUpdate({ id, reason: 'fork-created', sourceSessionId: sourceId });
    const { tail, messagesStart } = selectTailMessages(session.messages, 40);
    return { ok: true, session: messagesStart > 0 ? { ...session, messages: tail,
      totalMessages: session.messages.length, messagesStart, messagesTruncated: true } : session };
  });
}

async function persistForkKernelBinding(sessionId, openCodeSessionId, conversationRevision = 0) {
  if (!isSafeSessionId(sessionId) || !String(openCodeSessionId || '').trim()) return;
  return withSessionWrite(sessionId, async () => {
    const stored = await readSessionRecord(sessionId, { sessionLocked: true });
    assertConversationRevision(stored, conversationRevision);
    if (!isAuthoritativeHistorySession(stored) || stored.openCodeSessionId === openCodeSessionId) return;
    const updated = { ...stored, openCodeSessionId: String(openCodeSessionId) };
    await writeSessionFileAtomic(sessionPath(sessionId), JSON.stringify(updated, null, 2));
    await refreshSessionSummaryCache(sessionId, updated);
  });
}

const sessionRewindOperations = new Set();

function assertSessionRewindIdle(sessionId) {
  const pending = Object.values(zCore?.state?.intents || {}).some(intent =>
    intent?.threadId === sessionId && ['queued', 'consumed'].includes(intent.status));
  if (isSessionRunActive(sessionId) || pending || manualContextCompressions.has(sessionId)) {
    throw Object.assign(new Error('当前对话仍在运行或排队，请结束后再回退。'), { code: 'SESSION_REWIND_BUSY' });
  }
}

async function rewindSessionRecord(request = {}, { restore = false } = {}) {
  const id = String(request.sessionId || '');
  if (!isSafeSessionId(id)) throw Object.assign(new Error('对话不存在。'), { code: 'SESSION_REWIND_SOURCE_NOT_FOUND' });
  return withSessionWrite(id, async () => {
    sessionRewindOperations.add(id);
    try {
      assertSessionRewindIdle(id);
      ensureDirs();
      // Read the durable full record without migrations or cache mutation. A
      // failed backup/write must leave the previous conversation untouched.
      const text = await fsp.readFile(sessionPath(id), 'utf8').catch(error => {
        if (error.code === 'ENOENT') throw Object.assign(new Error('对话不存在。'), { code: 'SESSION_REWIND_SOURCE_NOT_FOUND' });
        throw error;
      });
      const source = JSON.parse(text);
      if (source?.id !== id) throw Object.assign(new Error('对话记录 ID 不一致。'), { code: 'SESSION_REWIND_SOURCE_NOT_FOUND' });
      assertConversationRevision(source, request.conversationRevision);
      let messages;
      let modelSelection;
      if (restore) {
        const backupId = source.rewindState?.backupSessionId;
        if (!isSafeSessionId(backupId)) throw Object.assign(new Error('找不到回退前的备份对话。'), { code: 'SESSION_REWIND_BACKUP_NOT_FOUND' });
        const backupText = await fsp.readFile(sessionPath(backupId), 'utf8').catch(error => {
          if (error.code === 'ENOENT') throw Object.assign(new Error('回退前的备份对话已经不存在。'), { code: 'SESSION_REWIND_BACKUP_NOT_FOUND' });
          throw error;
        });
        ({ messages, modelSelection } = restoreRewindSnapshot(source, JSON.parse(backupText)));
      } else messages = rewindBoundary(source, request);
      Object.assign(source, await ensureTaskWorkspace(source, { root: defaultTasksRoot, dataDirectory: dataDir }));
      const cfg = loadConfig();
      const candidates = composerConnections(cfg).flatMap(connection => connection.models.map(model => ({
        providerId: connection.providerId, supplierId: connection.supplierId, modelId: model.id
      })));
      const now = Date.now();
      const backupSessionId = `sess_${now.toString(36)}${crypto.randomBytes(6).toString('hex')}`;
      const backup = createRewindBackup(source, { id: backupSessionId, now });
      const session = createRewoundSession(source, messages, { backupSessionId, now,
        action: restore ? 'restore' : 'rewind', modelSelection, candidates, defaultSelection: cfg.agentModel });
      // Commit a separate, independently resumable backup FIRST. Even if the
      // second atomic rename fails, both the old original and its backup survive.
      await writeSessionFileAtomic(sessionPath(backupSessionId), JSON.stringify(backup, null, 2));
      await refreshSessionSummaryCache(backupSessionId, backup);
      notifyDesktopSessionUpdate({ id: backupSessionId, reason: 'rewind-backup-created', sourceSessionId: id });
      // Admissions reserve their target before waiting on this same write lock.
      // Catch any task that arrived while the backup was being written.
      assertSessionRewindIdle(id);
      await writeSessionFileAtomic(sessionPath(id), JSON.stringify(session, null, 2));
      await refreshSessionSummaryCache(id, session);
      notifyDesktopSessionUpdate({ id, reason: restore ? 'rewind-restored' : 'rewound',
        backupSessionId, conversationRevision: session.conversationRevision });
      const { tail, messagesStart } = selectTailMessages(session.messages, 40);
      return { ok: true, backupSessionId, conversationRevision: session.conversationRevision,
        session: messagesStart > 0 ? { ...session, messages: tail, totalMessages: session.messages.length,
          messagesStart, messagesTruncated: true } : session };
    } finally { sessionRewindOperations.delete(id); }
  });
}

async function validateHandoffTarget(sourceWorkspace, targetWorkspace) {
  const source = normalizeWorkspacePath(sourceWorkspace);
  const target = normalizeWorkspacePath(targetWorkspace);
  if (!source) return { ok: false, error: '来源任务当前没有工作区。', code: 'WORKSPACE_SOURCE_REQUIRED' };
  if (!target) return { ok: false, error: '目标工作区路径为空。', code: 'WORKSPACE_TARGET_REQUIRED' };
  if (sameWorkspace(source, target)) {
    return { ok: false, error: '目标工作区必须不同于当前任务工作区。', code: 'WORKSPACE_TARGET_SAME' };
  }
  try {
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      return { ok: false, error: `目标不是文件夹：${target}`, code: 'WORKSPACE_TARGET_NOT_DIRECTORY' };
    }
  } catch (error) {
    return {
      ok: false,
      error: `目标工作区不存在或无法访问：${target}`,
      code: error?.code || 'WORKSPACE_TARGET_NOT_FOUND'
    };
  }
  return { ok: true, source, target };
}

async function resolveWorkspaceSessionForHandoff(sourceSessionId, targetWorkspace) {
  const source = await readSessionRecord(sourceSessionId);
  if (!source) return { ok: false, error: '来源任务不存在。', code: 'SESSION_SOURCE_NOT_FOUND' };
  const validation = await validateHandoffTarget(source.workspace, targetWorkspace);
  if (!validation.ok) return validation;
  // 只用摘要定位目标会话,命中后再读完整记录,避免把所有会话全文解析一遍
  const summary = findLatestWorkspaceSession(await listSessionSummaries(), validation.target, {
    excludeSessionIds: [source.id]
  });
  if (summary) {
    const existing = await readSessionRecord(summary.id);
    if (existing) return { ok: true, session: existing, handoffId: '', reused: true };
  }
  const handoffId = `handoff_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const handoff = createHandoffPackage(source, validation.target, { id: handoffId });
  const suffix = ' · 继续';
  const sourceTitle = String(source.title || '任务');
  const baseTitle = sourceTitle.endsWith(suffix) ? sourceTitle.slice(0, -suffix.length) : sourceTitle;
  const session = await createFreshSessionRecord({
    title: `${baseTitle}${suffix}`,
    workspace: validation.target,
    parentSessionId: source.id,
    handoff
  });
  migrateMemoryToWorkspace(session.workspace);
  ensureZagent(session.workspace);
  return { ok: true, session, handoffId, reused: false };
}

async function readBoundSourceContext(sessionId, startValue, limitValue) {
  const child = await readSessionRecord(sessionId);
  if (!child?.parentSessionId || child.handoff?.sourceSessionId !== child.parentSessionId) {
    return { ok: false, error: '当前任务没有绑定的来源任务。', code: 'SESSION_HANDOFF_REQUIRED' };
  }
  const source = await readSessionRecord(child.parentSessionId);
  if (!source) return { ok: false, error: '来源任务已经不存在。', code: 'SESSION_SOURCE_NOT_FOUND' };
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const limit = Math.max(1, Math.min(20, Number(limitValue) || 10));
  const start = Math.max(0, Math.min(messages.length, Number(startValue) || 0));
  const items = [];
  let remaining = 6000;
  for (const message of messages.slice(start, start + limit)) {
    if (remaining <= 0) break;
    const content = contentToText(message?.content).slice(0, Math.min(3000, remaining));
    remaining -= content.length;
    items.push({
      role: String(message?.role || ''),
      content,
      ts: Number(message?.ts) || 0,
      attachments: (message?.attachments || []).map(item => ({ name: String(item?.name || '') })).filter(item => item.name)
    });
  }
  return {
    ok: true,
    sourceSessionId: source.id,
    sourceTitle: source.title,
    start,
    nextStart: start + items.length < messages.length ? start + items.length : null,
    total: messages.length,
    messages: items
  };
}

async function createOrReuseSessionRecord() {
  if (createSessionPromise) return createSessionPromise;
  createSessionPromise = (async () => {
    // 找可复用空会话只需要标题/条数/工作区,用摘要缓存即可,
    // 不必把磁盘上每个会话(可达 45MB)全部解析一遍
    const summaries = await listSessionSummaries();
    const reusable = findReusableBlankSession(summaries);
    if (reusable) {
      const existing = await readSessionRecord(reusable.id);
      if (existing && isBlankUnassignedNewChat(existing)) return { session: existing, reused: true };
    }
    return { session: await createFreshSessionRecord(), reused: false };
  })();
  try {
    return await createSessionPromise;
  } finally {
    createSessionPromise = null;
  }
}

async function renameSessionRecord(id, title, options = {}) {
  return withSessionWrite(id, async () => {
    const p = sessionPath(id);
    if (!p || !fs.existsSync(p)) return null;
    // 走带缓存读取,命中时免去一次整会话 JSON.parse
    const data = await readSessionRecord(id, { sessionLocked: true });
    if (!data) return null;
    // A first-turn save may have captured the placeholder before the user
    // renamed this task. Decide under the write lock, using the current title.
    if (options.automatic === true && !isDefaultSessionTitle(data.title)) return data;
    const nextTitle = String(title || '').trim().slice(0, 80);
    if (!nextTitle) return null;
    data.title = nextTitle;
    data.updatedAt = Date.now();
    await writeSessionFileAtomic(p, JSON.stringify(data, null, 2));
    await refreshSessionSummaryCache(id, data);
    return data;
  });
}

async function setSessionPinnedRecord(id, pinned) {
  return withSessionWrite(id, async () => {
    const p = sessionPath(id);
    if (!p || !fs.existsSync(p)) return null;
    const data = await readSessionRecord(id, { sessionLocked: true });
    if (!data) return null;
    data.pinned = !!pinned;
    data.updatedAt = Date.now();
    await writeSessionFileAtomic(p, JSON.stringify(data, null, 2));
    await refreshSessionSummaryCache(id, data);
    return data;
  });
}

function deleteSessionRecord(id, options = {}) {
  const operation = sessionDeleteQueue.then(() => withSessionWrite(id, async () => {
    if (!isSafeSessionId(id)) return { ok: false, code: 'invalid-session-id', error: '会话 ID 无效' };
    // 删除判定只需要标题与消息条数,读摘要即可,避免全量解析所有会话文件
    const sessions = await listSessionSummaries();
    const session = sessions.find(item => item.id === id);
    const running = isSessionRunActive(id);
    const decision = evaluateSessionDeletion(session, sessions.length, { ...options, running });
    if (!decision.ok) return decision;
    const replacedLast = sessions.length <= 1;
    const replacementSession = replacedLast ? await createFreshSessionRecord() : null;
    // The replacement write above yields to the event loop. Re-check before
    // unlinking so a run that started during that window cannot resurrect the
    // session through its completion save.
    const becameRunning = isSessionRunActive(id);
    if (becameRunning) {
      if (replacementSession) await fsp.unlink(sessionPath(replacementSession.id)).catch(() => {});
      return { ok: false, code: 'running', error: '任务运行中，无法删除' };
    }
    try {
      // Keep the final existence check and unlink in one synchronous turn of
      // the main process. An async unlink would yield between the check and
      // deletion, allowing a newly-started run to save the session again.
      fs.unlinkSync(sessionPath(id));
      invalidateSessionRecordCache(id);
    } catch (error) {
      if (replacementSession) {
        await fsp.unlink(sessionPath(replacementSession.id)).catch(() => {});
      }
      throw error;
    }
    try {
      const coreDeletion = zCore?.deleteThread(id);
      if (coreDeletion && coreDeletion.ok === false && coreDeletion.code !== 'Z_THREAD_NOT_FOUND') {
        console.warn('[z-core] session deleted but Core Thread cleanup was rejected:', coreDeletion.error || coreDeletion.code);
      }
    } catch (error) {
      console.warn('[z-core] session deleted but Core Thread cleanup failed:', error?.message || error);
    }
    return { ok: true, id, replacedLast, replacementSession };
  }));
  sessionDeleteQueue = operation.catch(() => {});
  return operation;
}

ipcMain.handle('session:list', () => listSessionSummaries({ includeRewindBackups: true }));

ipcMain.handle('session:get', async (_e, id, options = {}) => {
  return readSessionRecord(id, { messageLimit: options?.messageLimit });
});

async function getSessionBrowserStateRecord(id) {
  if (typeof id !== 'string' || id !== id.trim() || !isSafeSessionId(id)) {
    return { ok: false, error: '会话 ID 无效', code: 'invalid-session-id' };
  }
  return withSessionWrite(id, async () => {
    const stored = await readSessionRecord(id, { sessionLocked: true });
    if (!stored) return { ok: false, error: '会话不存在', code: 'session-not-found' };
    return { ok: true, id, browserState: normalizeBrowserSessionState(stored.browserState) };
  });
}

async function setSessionBrowserStateRecord(id, requested) {
  if (typeof id !== 'string' || id !== id.trim() || !isSafeSessionId(id)) {
    return { ok: false, error: '会话 ID 无效', code: 'invalid-session-id' };
  }
  const browserState = normalizeBrowserSessionState(requested);
  if (!browserState) return { ok: false, error: '浏览器状态无效', code: 'invalid-browser-state' };
  return withSessionWrite(id, async () => {
    const stored = await readSessionRecord(id, { sessionLocked: true });
    if (!stored) return { ok: false, error: '会话不存在', code: 'session-not-found' };
    // Navigation does not change conversation messages or reorder the sidebar.
    const data = { ...stored, browserState };
    await writeSessionFileAtomic(sessionPath(id), JSON.stringify(data, null, 2));
    await refreshSessionSummaryCache(id, data);
    return { ok: true, id, browserState };
  });
}

ipcMain.handle('session:browser-state-get', async (_e, id) => {
  try { return await getSessionBrowserStateRecord(id); }
  catch (error) { return { ok: false, error: error.message, code: error.code || 'session-browser-state-read-failed' }; }
});

ipcMain.handle('session:browser-state-set', async (_e, { id, browserState } = {}) => {
  try { return await setSessionBrowserStateRecord(id, browserState); }
  catch (error) { return { ok: false, error: error.message, code: error.code || 'session-browser-state-save-failed' }; }
});

async function setSessionModelRecord(id, requested, conversationRevision = 0) {
  if (!isSafeSessionId(id)) return { ok: false, error: '会话 ID 无效', code: 'invalid-session-id' };
  return withSessionWrite(id, async () => {
    const stored = await readSessionRecord(id, { sessionLocked: true });
    if (!stored) return { ok: false, error: '会话不存在', code: 'session-not-found' };
    assertConversationRevision(stored, conversationRevision);
    const cfg = loadConfig();
    if (Object.hasOwn(requested || {}, 'compactionThreshold')) {
      const threshold = requested.compactionThreshold;
      const window = normalizeContextSettings(cfg.context).maxTokens;
      if (!Number.isSafeInteger(threshold) || threshold <= 0 || threshold >= window) {
        return { ok: false, error: `自动压缩阈值必须是大于 0 且小于 ${window.toLocaleString('en-US')} 的整数。`,
          code: 'SESSION_COMPACTION_THRESHOLD_INVALID' };
      }
    }
    // Each control sends only the fields it changed. Merge inside the session
    // write queue so independent saves retain the latest committed settings.
    const merged = { ...stored.modelSelection, ...requested };
    const modelChanged = ['providerId', 'supplierId', 'modelId'].some(field =>
      String(merged[field] || '').trim() !== String(stored.modelSelection?.[field] || '').trim());
    // Output caps belong to a particular model. Older model pickers omit this
    // field when switching, which has always meant returning to automatic.
    if (modelChanged && !Object.hasOwn(requested || {}, 'maxOutputTokens')) merged.maxOutputTokens = 0;
    const modelSelection = resolveSessionModelSelection(cfg, merged);
    const data = { ...stored, modelSelection, updatedAt: Date.now() };
    await writeSessionFileAtomic(sessionPath(id), JSON.stringify(data, null, 2));
    await refreshSessionSummaryCache(id, data);
    return { ok: true, id, modelSelection, conversationRevision: sessionConversationRevision(stored) };
  });
}

ipcMain.handle('session:model-set', async (_e, { id, modelSelection, conversationRevision } = {}) => {
  try { return await setSessionModelRecord(id, modelSelection, conversationRevision); }
  catch (error) { return { ok: false, error: error.message, code: error.code || 'session-model-save-failed' }; }
});

ipcMain.handle('session:messages', async (_e, { id, offset, limit, fromEnd = false } = {}) => {
  const session = await readSessionRecord(id);
  if (!session) return { ok: false, error: '会话不存在' };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const total = messages.length;
  const requestedStart = Math.max(0, Math.min(total, Number(offset) || 0));
  const requestedCount = Math.max(1, Math.min(200, Number(limit) || 40));
  // Cap each page by accumulated size too, so paging back through a session
  // full of multi-megabyte messages never materializes them all at once.
  // Backward readers need a suffix ending at their existing history cursor;
  // returning a size-limited prefix would leave an unseen gap before it.
  if (fromEnd === true) {
    const requestedEnd = Math.min(total, Math.floor(requestedStart + requestedCount));
    let start = requestedEnd;
    let size = 0;
    while (start > requestedStart) {
      const estimated = estimateMessageSize(messages[start - 1]);
      if (start < requestedEnd && size + estimated > MESSAGE_PAGE_CHAR_BUDGET) break;
      start -= 1;
      size += estimated;
    }
    return { ok: true, messages: messages.slice(start, requestedEnd), total, offset: start };
  }
  let end = requestedStart;
  let size = 0;
  let count = 0;
  while (end < total && count < requestedCount) {
    const estimated = estimateMessageSize(messages[end]);
    if (count > 0 && size + estimated > MESSAGE_PAGE_CHAR_BUDGET) break;
    end += 1;
    count += 1;
    size += estimated;
  }
  return { ok: true, messages: messages.slice(requestedStart, end), total, offset: requestedStart };
});

ipcMain.handle('session:create', async (_e, options = {}) => {
  const workspace = normalizeWorkspacePath(options.workspace);
  const result = (options.forceNew || workspace)
    ? { session: await createFreshSessionRecord({ workspace }), reused: false }
    : await createOrReuseSessionRecord();
  return result.session;
});

ipcMain.handle('session:fork', async (_e, boundary = {}) => {
  try { return await forkSessionRecord(boundary); }
  catch (error) { return { ok: false, error: error.message, code: error.code || 'SESSION_FORK_FAILED' }; }
});

ipcMain.handle('session:rewind', async (_e, request = {}) => {
  try { return await rewindSessionRecord(request); }
  catch (error) { return { ok: false, error: error.message, code: error.code || 'SESSION_REWIND_FAILED' }; }
});

ipcMain.handle('session:rewind-restore', async (_e, request = {}) => {
  try { return await rewindSessionRecord(request, { restore: true }); }
  catch (error) { return { ok: false, error: error.message, code: error.code || 'SESSION_REWIND_FAILED' }; }
});

// Session JSON is the only durable copy of the conversation. Write to a
// temporary file and rename so a crash mid-write cannot truncate it.
// 保存/改名/置顶等写操作后,顺手刷新摘要缓存,
// 下一次 session:list 就不必为这个(可能 45MB 的)文件重新做整包 JSON.parse
async function refreshSessionSummaryCache(id, data) {
  try {
    const file = sessionPath(id);
    const stat = await fsp.stat(file);
    touchSessionRecordCache(id, data, stat);
    sessionSummaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary: toSessionSummary(data) });
  } catch { /* 缓存留在失效状态,下次 list 自动重建 */ }
}

async function writeSessionFileAtomic(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fsp.writeFile(temporary, content, { flag: 'wx' });
    await fsp.rename(temporary, filePath);
  } finally {
    // Never fall back to copying over the sole durable record: a failed copy
    // can truncate it. Failed renames leave the existing destination intact.
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

ipcMain.handle('session:save', async (_e, session) => {
  if (!session || !isSafeSessionId(session.id)) {
    return { ok: false, error: '会话 ID 无效', code: 'invalid-session-id' };
  }
  return withSessionWrite(session.id, async () => {
    ensureDirs();
    const stored = await readSessionRecord(session.id, { sessionLocked: true });
    try { assertConversationRevision(stored, session.conversationRevision); }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
    // The renderer may hold only the newest slice of the conversation (loaded
    // through session:get with a message limit). Re-attach the older messages
    // from the stored record so a tail save can never truncate the history.
    // Titles are changed by session:rename (including the first-turn automatic
    // title). A background run can still hold the old title in its snapshot;
    // saving its new messages must not undo a rename made from the sidebar.
    let persisted = { ...session, title: stored?.title ?? session.title,
      modelSelection: stored?.modelSelection
      || initialSessionModelSelection({ ...session, modelSelection: undefined }) };
    // Only the browser-state IPC may change this field. Message saves often
    // carry stale renderer snapshots, including snapshots from a previous tab.
    if (stored && Object.hasOwn(stored, 'browserState')) persisted.browserState = stored.browserState;
    else delete persisted.browserState;
    if (session.messagesTruncated === true && Number.isInteger(session.messagesStart) && session.messagesStart > 0) {
      if (stored && Array.isArray(stored.messages)) {
        const head = stored.messages.slice(0, session.messagesStart);
        persisted = {
          ...persisted,
          messages: [...head, ...(Array.isArray(session.messages) ? session.messages : [])]
        };
        delete persisted.messagesTruncated;
        delete persisted.messagesStart;
        delete persisted.totalMessages;
      }
    }
    persisted = preserveForkAuthority(stored, persisted);
    persisted.conversationRevision = sessionConversationRevision(stored);
    Object.assign(persisted, await ensureTaskWorkspace(persisted, {
      root: defaultTasksRoot, dataDirectory: dataDir, previousSession: stored
    }));
    sanitizeSessionReviewSummaries(persisted);
    pruneSessionRuntimeBookkeeping(persisted);
    persisted.updatedAt = Date.now();
    const file = sessionPath(persisted.id);
    await writeSessionFileAtomic(file, JSON.stringify(persisted, null, 2));
    try {
      const stat = await fsp.stat(file);
      touchSessionRecordCache(persisted.id, persisted, stat);
      await refreshSessionSummaryCache(persisted.id, persisted);
    } catch { invalidateSessionRecordCache(persisted.id); }
    return persisted;
  });
});

// 会话级工作区：存储在 session 对象中，而非全局 config，实现会话隔离

ipcMain.handle('session:set-workspace', async (_e, { id, workspace, activate = true }) => {
  return withSessionWrite(id, async () => {
    const p = sessionPath(id);
    if (!p || !fs.existsSync(p)) return null;
    // 走缓存读取,避免为改一个字段而整包解析 45MB 会话
    const data = await readSessionRecord(id, { sessionLocked: true });
    if (!data) return null;
    Object.assign(data, await ensureTaskWorkspace({ ...data, workspace: workspace || '' }, {
      root: defaultTasksRoot, dataDirectory: dataDir
    }));
    data.updatedAt = Date.now();
    await writeSessionFileAtomic(p, JSON.stringify(data, null, 2));
    await refreshSessionSummaryCache(id, data);
    if (activate !== false) {
      activateWorkspace(data.workspace);
    } else if (data.workspace) {
      migrateMemoryToWorkspace(data.workspace);
      ensureZagent(data.workspace);
    }
    return data;
  });
});

ipcMain.handle('session:rename', async (_e, { id, title, automatic } = {}) => {
  return renameSessionRecord(id, title, { automatic: automatic === true });
});

ipcMain.handle('session:set-pinned', async (_e, { id, pinned }) => {
  return setSessionPinnedRecord(id, pinned);
});

ipcMain.handle('session:delete', async (_e, payload) => {
  const id = typeof payload === 'string' ? payload : payload?.id;
  const confirmed = typeof payload === 'object' && !!payload?.confirmed;
  const result = await deleteSessionRecord(id, { confirmed });
  return result;
});

// ---------------------------------------------------------------------------
// IPC: Long-term memory (global/machine/workspace, selectively retrieved)
// ---------------------------------------------------------------------------
function addMemoryRecord(record = {}, options = {}) {
  const workspace = String(options.workspace || record.workspace || '').trim();
  const defaultScope = record.scope || (workspace ? 'workspace' : 'global');
  const result = longTermMemory.upsert(record, {
    workspace,
    defaultScope,
    sourceKind: options.sourceKind || record.sourceKind,
    sessionId: options.sessionId || record.sessionId,
    runId: options.runId || record.runId,
    refinementId: options.refinementId || record.refinementId
  });
  // P0-5 simplified forgetting runs at write time (throttled): it only reduces
  // confidence on stale low-frequency entries and never deletes or touches
  // preference/work_state memories.
  if (result?.ok && Date.now() - lastAgiMemoryMaintenanceAt > AGI_MEMORY_MAINTENANCE_INTERVAL_MS) {
    lastAgiMemoryMaintenanceAt = Date.now();
    try {
      maintainMemoryStore({ longTermMemory, memoryPath, workspace });
    } catch (error) {
      console.warn(`[agi] memory maintenance failed: ${error?.message || error}`);
    }
  }
  return result;
}

async function reviewCompletedRunMemory({
  sidecar,
  selection,
  request,
  result,
  prompt,
  workspace,
  zSessionId,
  runId,
  harnessBaselines,
  evolutionMode = false
}) {
  try {
    const refineRequest = evolutionMode ? consumeHarnessRefinementRequest(runId) : null;
    if (refineRequest?.action === 'rollback') {
      const targetState = continualHarness.load({ scope: refineRequest.scope, workspace });
      const target = targetState.refinements.find(item => item.id === refineRequest.rollbackId);
      const rollback = await continualHarness.rollback(refineRequest.rollbackId, {
        scope: refineRequest.scope,
        workspace,
        source: 'explicit_user_rollback',
        evidence: refineRequest.instructions
      });
      if (rollback.ok) rollbackHarnessProjection(target, workspace);
      if (!rollback.ok) console.warn(`[harness] rollback ${refineRequest.rollbackId} failed: ${rollback.error}`);
      return;
    }
    // Persist an explicit user policy before consulting the isolated reviewer.
    // Reviewer output is enrichment only; a provider/schema failure must never
    // be able to erase or postpone a rule the user explicitly requested.
    const explicitPolicy = evolutionMode
      ? (refineRequest?.action === 'refine'
        ? { text: refineRequest.instructions, source: 'scheduled_refinement' }
        : extractExplicitPolicyInstruction({ prompt, history: request.history }))
      : null;
    let directPolicyResult = null;
    if (evolutionMode && explicitPolicy?.text) {
      const policyScope = refineRequest?.scope === 'workspace' && workspace ? 'workspace' : 'global';
      directPolicyResult = await persistExplicitUserPolicy({
        instructions: explicitPolicy.text,
        scope: policyScope,
        workspace,
        runId,
        sessionId: zSessionId,
        source: refineRequest ? 'agent_refine' : 'explicit_user_policy'
      });
      if (!directPolicyResult.ok) {
        console.warn(`[harness] explicit policy was not activated for run ${runId}: ${directPolicyResult.error}`);
      }
    }
    const cfg = loadConfig();
    const review = await sidecar.reviewMemory({
      providerId: selection.providerId,
      modelId: selection.modelId,
      inputTokensPerSecond: Math.max(DEFAULT_INPUT_TOKENS_PER_SECOND, normalizeInputTokensPerSecond(
        cfg.api?.inputTokensPerSecond || cfg.agent?.inputTokensPerSecond
      )),
      workspace,
      sessionId: zSessionId,
      runId,
      prompt,
      history: request.history,
      result,
      refineInstructions: refineRequest?.instructions || '',
      harnessOverview: evolutionMode ? continualHarness.overview({ workspace, query: prompt }) : '',
      userRequestedFinish: result?.userRequestedFinish === true
    });
    // The direct policy above is the authoritative representation of an
    // explicit user instruction. Do not create a second competing candidate
    // from the reviewer for the same request.
    const reviewForHarness = explicitPolicy?.text
      ? { ...review, harnessCandidates: [] }
      : review;
    const harnessResults = evolutionMode
      ? await applyReviewedHarnessState(reviewForHarness, {
        workspace,
        sessionId: zSessionId,
        runId,
        harnessBaselines,
        refineInstructions: refineRequest?.instructions || '',
        verifiedSuccess: result?.status === 'done'
          && (Array.isArray(result?.todos) ? result.todos : []).every(todo => todo?.done === true)
      })
      : [];
    if (evolutionMode) await recordReviewedRefinementOutcomes(review, workspace);
    const memoryResults = evolutionMode
      ? harnessResults.flatMap(item => item.memories.map(({ record }) => addMemoryRecord(record, {
        workspace,
        sourceKind: refineRequest ? 'agent_refine' : 'background_review',
        sessionId: zSessionId,
        runId,
        refinementId: item.result?.refinement?.id
      })))
      : (Array.isArray(review?.memories) ? review.memories.map(memory => addMemoryRecord(memory, {
        workspace,
        sourceKind: 'background_review',
        sessionId: zSessionId,
        runId
      })) : []);
    // Continuity card: one superseding record per workspace so a new task in
    // the same workspace starts from where this run stopped.
    if (review?.workState && workspace) {
      const workStateResult = addMemoryRecord({
        key: 'work.state.current',
        type: 'work_state',
        scope: 'workspace',
        content: review.workState.content,
        confidence: 0.9,
        evidence: review.workState.evidence,
        basis: 'project_artifact',
        verified: true,
        durable: true,
        sensitive: false,
        transient: false
      }, { workspace, sourceKind: 'work_state', sessionId: zSessionId, runId });
      if (!workStateResult?.ok) {
        console.warn(`[memory] work state was not stored for run ${runId}: ${workStateResult?.error || 'unknown error'}`);
      }
    }
    if (evolutionMode && review?.skillCandidate) {
      await recordLearningReview({
        sidecar,
        skillCandidate: review.skillCandidate,
        verified: result?.status === 'done'
          && (Array.isArray(result?.todos) ? result.todos : []).every(todo => todo?.done === true),
        toolCallCount: Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0,
        workspace,
        sessionId: zSessionId,
        runId,
        harnessBaseline: harnessBaselines?.[workspace ? 'workspace' : 'global']
      });
    }
    // Result attribution runs after the reviewer's edits on purpose: usage
    // bookkeeping changes the entry fingerprint, and doing it first would trip
    // the revision-conflict check for any entry the same review is updating.
    // Attribution itself only needs the run's verified outcome, not the
    // reviewer, so its own failure never blocks the rest of the pipeline.
    if (evolutionMode) {
      try {
        await attributeHarnessUsage({ runId, workspace, sessionId: zSessionId, result });
      } catch (error) {
        console.warn(`[harness] usage attribution failed for run ${runId}:`, error?.message || error);
      }
    }
    const stored = memoryResults.filter(item => item?.ok).length;
    if (stored > 0) console.log(`[memory] stored ${stored} durable record(s) from run ${runId}`);
    if (review?.error) console.warn(`[memory] review skipped for run ${runId}: ${review.error}`);
  } catch (error) {
    console.warn(`[memory] non-fatal review failure for run ${runId}:`, error?.message || error);
  }
}

// ---------------------------------------------------------------------------
// IPC: .zagent (snapshots, rollback, logs)
// ---------------------------------------------------------------------------
ipcMain.handle('zagent:ensure', async (_e, workspace) => {
  const ws = workspace || loadConfig().workspace;
  if (!ws) return { ok: false, error: '未设置工作区' };
  const root = ensureZagent(ws);
  return { ok: true, path: root };
});

ipcMain.handle('zagent:run-changes', async (_e, { sessionId, runId, workspace, includeDiff = false, documentPath = '', allRuns = false, paths = null }) => {
  const session = await readSessionRecord(sessionId);
  const ws = workspaceSandbox.normalizeWorkspace(session?.workspace);
  if (!ws || !session || (!allRuns && !isSafePathSegment(runId))) return { count: 0, additions: 0, deletions: 0, files: [] };
  if (allRuns) {
    try {
      const changes = await loadSessionChangeHistory(ws, sessionId);
      return await runReviewTask('legacyChanges', ws, changes, { includeDiff: !!includeDiff, documentPath, paths });
    } catch {
      return { count: 0, additions: 0, deletions: 0, files: [] };
    }
  }
  const snapPath = runSnapshotPath(ws, sessionId, runId);
  if (!fs.existsSync(snapPath)) return { count: 0, additions: 0, deletions: 0, files: [] };
  try {
    const data = JSON.parse(await fsp.readFile(snapPath, 'utf8'));
    return await runReviewTask('legacyChanges', ws, data.changes || [], { includeDiff: !!includeDiff, documentPath, paths });
  } catch {
    return { count: 0, additions: 0, deletions: 0, files: [] };
  }
});

ipcMain.handle('zagent:rollback-run', async (_e, { sessionId, runId, workspace }) => {
  const session = await readSessionRecord(sessionId);
  const ws = workspaceSandbox.normalizeWorkspace(session?.workspace);
  if (!session || !ws || !isSafeSessionId(sessionId) || !isSafePathSegment(runId)) {
    return { ok: false, error: '会话、工作区或 runId 无效' };
  }
  if (workspace && !sameWorkspace(ws, workspace)) return { ok: false, error: '工作区与会话不匹配' };
  const snapPath = runSnapshotPath(ws, sessionId, runId);
  if (!fs.existsSync(snapPath)) return { ok: false, error: '该轮对话没有可撤销的文件改动' };
  let data;
  try {
    data = JSON.parse(await fsp.readFile(snapPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (String(data.sessionId || '') !== String(sessionId) || String(data.runId || '') !== String(runId)) {
    return { ok: false, error: '回滚快照归属不匹配' };
  }
  const changes = data.changes || [];
  const results = await applySnapshotRollback(changes, ws);
  require('./lib/run-snapshot-storage').consumeRunSnapshot(ws, sessionId, runId);
  try { await fsp.unlink(snapPath); } catch {}
  appendZagentLog(ws, `[rollback] run ${runId} (session ${sessionId}): ${results.length} file(s)`);
  return { ok: true, results, count: changes.length, runId };
});

// ---------------------------------------------------------------------------
// IPC: File uploads and generated media
// ---------------------------------------------------------------------------
ipcMain.handle('file:choose-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return !result.canceled && result.filePaths.length ? result.filePaths[0] : null;
});

ipcMain.handle('file:inspect-attachment-path', async (event, filePath) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: '无权检查该附件路径', code: 'UNAUTHORIZED' };
  }
  const rawPath = String(filePath || '').trim();
  if (!rawPath) return { ok: false, error: '附件路径为空', code: 'PATH_EMPTY' };
  if (rawPath.includes('\0')) return { ok: false, error: '附件路径无效', code: 'PATH_INVALID' };

  let resolvedPath;
  try {
    resolvedPath = path.resolve(rawPath);
  } catch (error) {
    return {
      ok: false,
      error: `附件路径无效：${error?.message || String(error || '未知错误')}`,
      code: 'PATH_INVALID'
    };
  }

  try {
    const stat = await fsp.stat(resolvedPath);
    const isDirectory = stat.isDirectory();
    const isFile = stat.isFile();
    if (!isDirectory && !isFile) {
      return { ok: false, error: '暂不支持该附件类型', code: 'ATTACHMENT_TYPE_UNSUPPORTED' };
    }
    return {
      ok: true,
      path: resolvedPath,
      name: path.basename(resolvedPath) || resolvedPath,
      isDirectory,
      isFile,
      size: isFile ? stat.size : 0
    };
  } catch (error) {
    const reason = error?.code === 'ENOENT'
      ? '路径不存在'
      : (error?.code === 'EACCES' || error?.code === 'EPERM')
        ? '没有权限访问该路径'
        : (error?.message || String(error || '未知错误'));
    return {
      ok: false,
      error: `无法读取附件：${reason}`,
      code: error?.code || 'ATTACHMENT_PATH_UNREADABLE'
    };
  }
});

function resolveStoredUploadPath(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const relative = path.relative(path.resolve(filesDir), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function sanitizeUploadName(name) {
  const base = path.basename(String(name || 'attachment'));
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'attachment';
}

// Upload: copy a file into the uploads dir & return metadata
ipcMain.handle('file:upload', async (_e, { name, data: b64, mimeType = '' }) => {
  ensureDirs();
  const safeName = sanitizeUploadName(name);
  const buffer = Buffer.from(String(b64 || ''), 'base64');
  if (buffer.length > 50 * 1024 * 1024) return { error: '附件不能超过 50MB' };
  const target = path.join(filesDir, Date.now() + '_' + safeName);
  await fsp.writeFile(target, buffer);
  const stat = await fsp.stat(target);
  return { path: target, name: safeName, size: stat.size, mimeType: String(mimeType || '') };
});

ipcMain.handle('image:generate', async (_e, payload = {}) => {
  const cfg = loadConfig();
  if (!cfg.permissions.allowNetwork) return { error: '网络访问权限已关闭，无法生成图片' };
  updateImageGenerationConfig(cfg);
  const imageConfig = resolveRequestedGenerationConfig(cfg, 'image', payload.providerId, payload.modelId);
  if (imageConfig?.error) return { error: imageConfig.error };
  if (!imageConfig.available) return { error: '当前模型配置没有可用的图片生成能力' };
  const imageConnection = getProviderConnectionForSupplier(cfg, imageConfig.providerId, imageConfig.supplierId);
  if (!imageConnection.apiKey) {
    return { error: `请先配置 ${MODEL_PROVIDERS[imageConfig.providerId]?.name || imageConfig.providerId} API Key` };
  }
  const prompt = String(payload.prompt || '').trim();
  const requestId = String(payload.requestId || '').trim().slice(0, 160);
  if (!prompt) return { error: '生图提示词不能为空' };
  if (prompt.length > 4000) return { error: '生图提示词不能超过 4000 个字符' };
  if (!requestId) return { error: '生图请求缺少任务标识' };
  if (activeImageGenerations.has(requestId)) return { error: '该生图任务正在执行，请勿重复提交' };
  let sourceImage = null;
  if (payload.sourceImagePath) {
    if (!cfg.permissions.allowFileRead) return { error: '文件读取权限已关闭，无法编辑图片' };
    const sourcePath = resolveStoredUploadPath(payload.sourceImagePath);
    if (!sourcePath) return { error: '只能编辑 Z 保存的图片附件' };
    try {
      const stat = await fsp.stat(sourcePath);
      if (stat.size > 20 * 1024 * 1024) return { error: '输入图片不能超过 20MB' };
      const buffer = await fsp.readFile(sourcePath);
      const type = detectImageType(buffer);
      sourceImage = { buffer, mimeType: type.mimeType, name: path.basename(sourcePath) };
    } catch (error) {
      return { error: `无法读取输入图片：${error.message}` };
    }
  }
  const controller = new AbortController();
  const activeRequest = { controller, ownerId: _e.sender.id };
  activeImageGenerations.set(requestId, activeRequest);
  try {
    const result = await generateImage({
      baseUrl: imageConnection.baseUrl,
      apiKey: imageConnection.apiKey,
      providerId: imageConfig.providerId,
      strategy: imageConfig.strategy,
      model: imageConfig.model,
      imageEndpoints: {
        generations: imageConnection.imageGenerationUrl,
        edits: imageConnection.imageEditUrl
      },
      providerOptions: {
        workspaceId: imageConnection.workspaceId,
        adapterKind: providerAdapterPreset(cfg, imageConfig.providerId)
      },
      prompt,
      aspectRatio: payload.aspectRatio || '1:1',
      signal: controller.signal,
      sourceImage
    });
    const asset = await registerGeneratedImage({
      ...result,
      providerId: imageConfig.providerId,
      model: imageConfig.model
    });
    return {
      ok: true,
      assetId: asset.assetId,
      name: asset.name,
      size: result.buffer.length,
      mimeType: result.mimeType,
      providerId: imageConfig.providerId,
      model: imageConfig.model,
      providerRequestId: result.providerRequestId || '',
      providerUsage: result.providerUsage || null,
      strategy: imageConfig.strategy,
      edited: !!result.edited,
      revisedPrompt: result.revisedPrompt || ''
    };
  } catch (error) {
    return { error: error.message, code: error.code || undefined };
  } finally {
    if (activeImageGenerations.get(requestId) === activeRequest) {
      activeImageGenerations.delete(requestId);
    }
  }
});

ipcMain.handle('image:cancel', (_e, requestId) => {
  const id = String(requestId || '').trim();
  const activeRequest = activeImageGenerations.get(id);
  if (!activeRequest || activeRequest.ownerId !== _e.sender.id) return { ok: false };
  activeRequest.controller.abort();
  return { ok: true };
});

ipcMain.handle('video:generate', async (_e, payload = {}) => {
  const cfg = loadConfig();
  if (!cfg.permissions.allowNetwork) return { error: '网络访问权限已关闭，无法生成视频' };
  updateImageGenerationConfig(cfg);
  const videoConfig = resolveRequestedGenerationConfig(cfg, 'video', payload.providerId, payload.modelId);
  if (videoConfig?.error) return { error: videoConfig.error };
  if (!videoConfig?.available) return { error: '当前模型配置没有可用的视频生成能力' };
  const connection = getProviderConnectionForSupplier(cfg, videoConfig.providerId, videoConfig.supplierId);
  if (!connection.apiKey) {
    return { error: `请先配置 ${MODEL_PROVIDERS[videoConfig.providerId]?.name || videoConfig.providerId} API Key` };
  }
  const prompt = String(payload.prompt || '').trim();
  const requestId = String(payload.requestId || '').trim().slice(0, 160);
  if (!prompt) return { error: '视频提示词不能为空' };
  if (prompt.length > 4000) return { error: '视频提示词不能超过 4000 个字符' };
  if (!requestId) return { error: '视频请求缺少任务标识' };
  if (activeVideoGenerations.has(requestId)) return { error: '该视频任务正在执行，请勿重复提交' };

  const controller = new AbortController();
  const activeRequest = { controller, ownerId: _e.sender.id };
  activeVideoGenerations.set(requestId, activeRequest);
  try {
    const generated = await generateVideo({
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      providerId: videoConfig.providerId,
      providerOptions: {
        workspaceId: connection.workspaceId,
        videoGenerationUrl: connection.videoGenerationUrl,
        adapterKind: providerAdapterPreset(cfg, videoConfig.providerId)
      },
      model: videoConfig.model,
      prompt,
      aspectRatio: payload.aspectRatio || '16:9',
      durationSeconds: payload.durationSeconds,
      resolution: payload.resolution,
      negativePrompt: payload.negativePrompt,
      seed: payload.seed,
      signal: controller.signal
    });
    const result = await cacheAuthorizedGeneratedVideo(generated, controller.signal);
    return { ok: true, ...result };
  } catch (error) {
    return { error: error.message, code: error.code || undefined };
  } finally {
    if (activeVideoGenerations.get(requestId) === activeRequest) activeVideoGenerations.delete(requestId);
  }
});

ipcMain.handle('video:cancel', (_e, requestId) => {
  const id = String(requestId || '').trim();
  const activeRequest = activeVideoGenerations.get(id);
  if (!activeRequest || activeRequest.ownerId !== _e.sender.id) return { ok: false };
  activeRequest.controller.abort();
  return { ok: true };
});

ipcMain.handle('image:generated-read', async (_e, assetId) => {
  const asset = getGeneratedImageAsset(assetId);
  if (!asset) return { error: '会话图片已失效，请重新生成' };
  try {
    const buffer = await fsp.readFile(asset.filePath);
    return {
      assetId: asset.assetId,
      name: asset.name,
      size: asset.size,
      mimeType: asset.mimeType,
      dataUrl: `data:${asset.mimeType};base64,${buffer.toString('base64')}`
    };
  } catch (error) {
    generatedImages.delete(asset.assetId);
    return { error: error.message };
  }
});

ipcMain.handle('image:generated-open', (_e, assetId) => openGeneratedImageViewer(assetId));

ipcMain.handle('image:generated-download', async (_e, assetId) => {
  const asset = getGeneratedImageAsset(assetId);
  if (!asset) return { error: '会话图片已失效，请重新生成' };
  const owner = BrowserWindow.fromWebContents(_e.sender);
  const extension = path.extname(asset.name).slice(1).toLowerCase() || 'png';
  const result = await dialog.showSaveDialog(owner && !owner.isDestroyed() ? owner : mainWindow, {
    title: '下载图片',
    buttonLabel: '下载',
    defaultPath: path.join(app.getPath('downloads'), asset.name),
    filters: [{ name: '图片', extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await fsp.copyFile(asset.filePath, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { error: `下载失败：${error.message}` };
  }
});

ipcMain.handle('image:file-open', (_e, filePath) => openImageFileViewer(filePath));

ipcMain.handle('image:file-read', async (_e, filePath) => {
  const file = await resolveLocalImageFile(filePath);
  if (!file) return { error: '图片不可用或格式不支持预览' };
  try {
    const buffer = await fsp.readFile(file.path);
    let mimeType = file.mimeType;
    try {
      mimeType = detectImageType(buffer, file.mimeType).mimeType || mimeType;
    } catch {}
    return {
      name: file.name,
      size: file.size,
      mimeType,
      dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
    };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('image:file-download', async (_e, filePath) => {
  const file = await resolveLocalImageFile(filePath);
  if (!file) return { error: '图片不可用或格式不支持预览' };
  const owner = BrowserWindow.fromWebContents(_e.sender);
  const extension = path.extname(file.name).slice(1).toLowerCase() || 'png';
  const result = await dialog.showSaveDialog(owner && !owner.isDestroyed() ? owner : mainWindow, {
    title: '下载图片',
    buttonLabel: '下载',
    defaultPath: path.join(app.getPath('downloads'), file.name),
    filters: [{ name: '图片', extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await fsp.copyFile(file.path, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { error: `下载失败：${error.message}` };
  }
});

ipcMain.handle('file:reveal', async (_e, filePath) => {
  const target = String(filePath || '').trim();
  if (!target) return { ok: false, error: '路径为空' };
  try {
    if (!fs.existsSync(target)) return { ok: false, error: '文件不存在' };
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || '无法在访达中显示' };
  }
});

ipcMain.handle('file:preview-local', async (_e, filePath) => {
  const target = path.resolve(String(filePath || '').trim());
  if (!target) return { ok: false, error: '路径为空' };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, error: '文件不存在' };
  }
  const ext = path.extname(target).toLowerCase();
  const lastExt = ext || `.${path.basename(target).split('.').pop() || ''}`.toLowerCase();
  const REVEAL_EXTS = new Set([
    '.dmg', '.pkg', '.app', '.ipa', '.apk', '.aab',
    '.exe', '.msi', '.msix', '.appx', '.appxbundle',
    '.deb', '.rpm', '.snap',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
    '.iso', '.img', '.bin',
    '.dll', '.so', '.dylib',
    '.crx', '.xpi'
  ]);
  const OFFICE_EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf']);
  const IN_APP_PREVIEW_EXTS = new Set([
    '.html', '.htm', '.xhtml', '.shtml',
    '.md', '.markdown', '.mdx', '.rst', '.adoc', '.org',
    '.txt', '.text', '.log', '.out', '.err', '.nfo', '.asc', '.utf8',
    '.csv', '.tsv', '.tab',
    '.json', '.jsonc', '.jsonl', '.ndjson', '.geojson',
    '.xml', '.svg', '.plist',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.cnf', '.properties', '.env', '.editorconfig',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
    '.css', '.scss', '.less', '.sass', '.styl',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.scala', '.groovy',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.m', '.mm', '.cs', '.fs', '.php', '.sql', '.lua', '.r', '.pl', '.pm',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.lock', '.gitignore', '.gitattributes', '.dockerignore', '.npmrc', '.nvmrc',
    '.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp', '.ico', '.icns', '.avif', '.tif', '.tiff', '.heic', '.heif',
    '.pdf',
    '.mp3', '.wav', '.ogg', '.oga', '.flac', '.aac', '.m4a', '.opus',
    '.mp4', '.m4v', '.webm', '.mov', '.ogv',
    '.wasm', '.map', '.graphql', '.gql', '.proto', '.diff', '.patch'
  ]);
  const revealInFinder = () => {
    try {
      shell.showItemInFolder(target);
      return { ok: true, action: 'reveal', path: target };
    } catch (error) {
      return { ok: false, error: error.message || '无法打开路径' };
    }
  };
  // Bundles and installers: always reveal, including .app directories.
  if (REVEAL_EXTS.has(ext) || REVEAL_EXTS.has(lastExt) || target.toLowerCase().endsWith('.app')) {
    return revealInFinder();
  }
  if (stat.isDirectory()) return revealInFinder();
  if (!stat.isFile()) return { ok: false, error: '不是文件' };
  if (IN_APP_PREVIEW_EXTS.has(ext) || (!ext && stat.size <= 2 * 1024 * 1024)) {
    return { ok: true, action: 'browser', url: pathToFileURL(target).href, path: target };
  }
  if (OFFICE_EXTS.has(ext)) {
    const officecli = require('./lib/officecli-runtime');
    try {
      const executable = await officecli.ensureOfficeCli({ appRoot });
      const outDir = path.join(os.tmpdir(), 'z-office-preview');
      fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, `${path.basename(target, ext)}.html`);
      await new Promise((resolve, reject) => {
        const child = spawn(executable, ['view', target, 'html', '-o', outFile], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stderr = '';
        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          reject(new Error('Office 预览超时'));
        }, 25000);
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(outFile)) resolve();
          else reject(new Error(String(stderr || `OfficeCLI 退出 ${code}`).trim()));
        });
      });
      return { ok: true, action: 'browser', url: pathToFileURL(outFile).href, path: target };
    } catch (error) {
      return { ok: false, error: error.message || 'Office 内置预览失败' };
    }
  }
  try {
    shell.showItemInFolder(target);
    return { ok: true, action: 'reveal', path: target };
  } catch (error) {
    return { ok: false, error: error.message || '无法打开路径' };
  }
});

ipcMain.handle('vscode:status', async () => {
  const status = await detectVsCode();
  if (!status.available || !status.executable) return status;
  try {
    const icon = await app.getFileIcon(status.executable, { size: 'normal' });
    return { ...status, iconDataUrl: icon.isEmpty() ? '' : icon.toDataURL() };
  } catch {
    return { ...status, iconDataUrl: '' };
  }
});

ipcMain.handle('vscode:launch', async (_e, { workspace = '' } = {}) => {
  const cfg = loadConfig();
  return launchVsCode(workspace || cfg.workspace);
});

ipcMain.handle('powershell:open-external', async (_e, { workspace = '' } = {}) => {
  const requested = String(workspace || '').trim();
  let cwd = process.env.HOME || process.env.USERPROFILE || os.homedir() || process.cwd();
  try {
    if (requested && fs.statSync(requested).isDirectory()) cwd = path.resolve(requested);
  } catch { /* fall back to the user's home directory */ }
  try {
    const shellInfo = resolveWindowsPowerShell();
    if (process.platform === 'darwin') {
      const child = spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, cwd, shell: 'Terminal', pid: child.pid };
    }
    if (process.platform === 'win32') {
      const command = `Set-Location -LiteralPath ${JSON.stringify(cwd)}`;
      const encoded = Buffer.from(command, 'utf16le').toString('base64');
      const script = [
        '$p = Start-Process',
        '-FilePath $env:Z_EXTERNAL_PS',
        '-WorkingDirectory $env:Z_EXTERNAL_CWD',
        '-ArgumentList @("-NoProfile", "-NoLogo", "-NoExit", "-EncodedCommand", $env:Z_EXTERNAL_COMMAND)',
        '-PassThru',
        '-ErrorAction Stop;',
        '[Console]::Out.Write($p.Id)'
      ].join(' ');
      const scriptEncoded = Buffer.from(script, 'utf16le').toString('base64');
      const childResult = await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', scriptEncoded], {
          cwd,
          windowsHide: true,
          // 无超时的话,PowerShell 首次加载 .NET 程序集被杀软/OneDrive 卡住时,这个 IPC 永远不返回
          timeout: 15000,
          killSignal: 'SIGKILL',
          env: { ...process.env, Z_EXTERNAL_PS: shellInfo.command, Z_EXTERNAL_CWD: cwd, Z_EXTERNAL_COMMAND: encoded }
        }, (error, stdout, stderr) => {
          if (error) resolve({ error: String(stderr || error.message || '打开 PowerShell 失败').trim() });
          else resolve({ pid: Number.parseInt(String(stdout).trim(), 10) || null });
        });
      });
      if (childResult.error) return { ok: false, error: childResult.error };
      return { ok: true, cwd, shell: shellInfo.label, pid: childResult.pid };
    }
    const child = spawn(shellInfo.command, shellInfo.args || [], { cwd, detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, cwd, shell: shellInfo.label, pid: child.pid };
  } catch (error) {
    return { ok: false, error: error?.message || '打开 PowerShell 失败' };
  }
});

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — manage external tool servers via stdio
// ---------------------------------------------------------------------------
const mcpServers = new Map(); // id -> { process, tools, pending, buffer, nextId }

function mcpSend(proc, msg) {
  // 子进程崩溃后 stdin 在 close 之前写入会触发 EPIPE;这里守卫 + 静默失败,
  // 由 mcpStart 里挂的 stdin error 监听兜底,绝不能让主进程因未捕获异常退出
  const stdin = proc && proc.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) return false;
  try {
    stdin.write(JSON.stringify(msg) + '\n');
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(proc) {
  // Windows 上 cmd /c 包装的子进程必须杀整棵树,只 kill 直接子进程会留下孤儿
  if (!proc || typeof proc.pid !== 'number') return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {}
}

function mcpRequest(server, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = server.nextId++;
    const timer = setTimeout(() => {
      if (server.pending.has(id)) {
        server.pending.delete(id);
        reject(new Error('MCP 请求超时: ' + method));
      }
    }, server.requestTimeoutMs || 30000);
    server.pending.set(id, { resolve, reject, timer });
    if (!mcpSend(server.process, { jsonrpc: '2.0', id, method, params })) {
      server.pending.delete(id);
      clearTimeout(timer);
      reject(new Error('MCP 服务器进程不可用: ' + method));
    }
  });
}

function rollbackHarnessProjection(target, workspace) {
  if (!target) return { removedMemories: 0, removedSkills: [] };
  const memoryRemoval = longTermMemory.removeBySource({
    refinementId: target.id,
    workspace
  });
  const removedSkills = [];
  for (const edit of Array.isArray(target.appliedEdits) ? target.appliedEdits : []) {
    if (!edit.applied || edit.kind !== 'skill' || edit.after?.metadata?.status !== 'active') continue;
    const cfg = loadConfig();
    const skill = (cfg.customSkills || []).find(item => item.id === edit.id);
    if (!skill || !skillRegistry.isGeneratedSkill(skill)) continue;
    const removal = skillRegistry.removeZUserSkill(dataDir, skill.id);
    if (!removal.ok) continue;
    cfg.customSkills = (cfg.customSkills || []).filter(item => item.id !== skill.id);
    saveConfig(cfg);
    refreshZSkillRegistry({ reason: 'harness-rollback', id: skill.id });
    skillEvolution.markRolledBack(skill.id, target.id);
    removedSkills.push(skill.id);
  }
  return { removedMemories: memoryRemoval.removed, removedSkills };
}

function harnessRunContextPath(runId) {
  const key = crypto.createHash('sha256').update(String(runId || '')).digest('hex');
  return path.join(dataDir, 'harness', 'runtime', `${key}.json`);
}

function registerHarnessRunContext({ runId, sessionId = '', workspace = '', allowFileRead = true, allowNetwork = true, allowFileWrite = true } = {}) {
  const id = String(runId || '').trim();
  if (!id) return '';
  const contextPath = harnessRunContextPath(id);
  const normalizedWorkspace = workspaceSandbox.normalizeWorkspace(workspace);
  const context = {
    schema: 1,
    runId: id,
    sessionId: String(sessionId || ''),
    workspace: normalizedWorkspace || '',
    allowFileRead,
    allowNetwork,
    allowFileWrite,
    requestPath: pendingHarnessRequestPath(id),
    workspaceStatePath: normalizedWorkspace
      ? continualHarness.statePath({ scope: 'workspace', workspace: normalizedWorkspace })
      : '',
    createdAt: Date.now()
  };
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  const temporary = `${contextPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(context)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, contextPath);
  return contextPath;
}

function removeHarnessRunContext(runId) {
  try { fs.rmSync(harnessRunContextPath(runId), { force: true }); } catch {}
}

function pendingHarnessRequestPath(runId) {
  const key = crypto.createHash('sha256').update(String(runId || '')).digest('hex');
  return path.join(dataDir, 'harness', 'pending', `${key}.json`);
}

function consumeHarnessRefinementRequest(runId) {
  const filePath = pendingHarnessRequestPath(runId);
  try {
    if (!fs.existsSync(filePath)) return null;
    const request = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    fs.rmSync(filePath, { force: true });
    if (!request || typeof request !== 'object' || String(request.runId || '') !== String(runId || '')) return null;
    return request;
  } catch {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    return null;
  }
}

// Result attribution bookkeeping: remember which harness entries this run
// actually injected, so the post-turn review can credit or blame them with
// the run's verified outcome. The review runs outside the Harness MCP context
// lifecycle, so this state lives in its own file and is consumed exactly once.
function harnessUsagePath(runId) {
  const key = crypto.createHash('sha256').update(String(runId || '')).digest('hex');
  return path.join(dataDir, 'harness', 'usage', `${key}.json`);
}

function pruneHarnessUsageFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    const dir = path.dirname(harnessUsagePath('probe'));
    const cutoff = Date.now() - Math.max(60_000, Number(maxAgeMs) || 0);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {}
    }
  } catch {}
}

function registerHarnessUsage({ runId, workspace = '', sessionId = '', entries = [] } = {}) {
  const id = String(runId || '').trim();
  const items = (Array.isArray(entries) ? entries : []).map(entry => ({
    kind: String(entry?.kind || '').trim(),
    id: String(entry?.id || '').trim(),
    scope: entry?.scope === 'workspace' ? 'workspace' : 'global'
  })).filter(item => item.kind && item.id).slice(0, 32);
  if (!id || !items.length) return '';
  pruneHarnessUsageFiles();
  const filePath = harnessUsagePath(id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    schema: 1,
    runId: id,
    workspace: String(workspace || ''),
    sessionId: String(sessionId || ''),
    injectedAt: Date.now(),
    entries: items
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return filePath;
}

function consumeHarnessUsage(runId) {
  const filePath = harnessUsagePath(runId);
  try {
    if (!fs.existsSync(filePath)) return null;
    const usage = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    fs.rmSync(filePath, { force: true });
    if (!usage || String(usage.runId || '') !== String(runId || '')) return null;
    return usage;
  } catch {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    return null;
  }
}

// Only outcomes the run itself can prove count: a completed run with every
// todo done is a success, a provider-level error is a failure. Runs that
// stopped early (cancelled, user-requested finish, open todos) stay neutral
// so attribution never guesses.
function harnessRunOutcome(result) {
  if (result?.status === 'error') return 'failure';
  const todos = Array.isArray(result?.todos) ? result.todos : [];
  if (result?.status === 'done' && todos.every(todo => todo?.done === true)) return 'success';
  return '';
}

async function attributeHarnessUsage({ runId, workspace = '', sessionId = '', result } = {}) {
  const usage = consumeHarnessUsage(runId);
  if (!usage?.entries?.length) return null;
  const outcome = harnessRunOutcome(result);
  if (!outcome) return null;
  const attribution = await continualHarness.recordUsage({
    entries: usage.entries,
    outcome,
    runId,
    sessionId,
    injectedAt: usage.injectedAt
  }, { workspace });
  if (attribution?.demoted?.length) {
    console.warn(`[harness] usage attribution returned ${attribution.demoted.length} repeated-failure entr(ies) to observing for run ${runId}`);
  } else if (attribution && attribution.ok === false) {
    console.warn(`[harness] usage attribution failed for run ${runId}: ${attribution.error || 'unknown error'}`);
  }
  // P0-2: additive utility ledger keyed by entry, fed by the delivery verdict.
  // The existing recordUsage demotion above stays the only state change.
  const verificationVerdict = result?.delivery?.review?.verdict
    || (result?.delivery?.verified === true ? 'pass' : '');
  try {
    agiUtilityLedger.attribute({
      runId,
      entries: usage.entries,
      outcome,
      verification: verificationVerdict ? { verdict: verificationVerdict } : null
    });
  } catch (error) {
    console.warn(`[agi] utility attribution failed for run ${runId}:`, error?.message || error);
  }
  return attribution;
}

// P2-3: bounded, redacted trajectory accumulation for every finished run.
function recordAgiTrajectory({ runId, workspace = '', result } = {}) {
  if (!runId || !result) return null;
  const verdict = result?.delivery?.review?.verdict
    || (result?.delivery?.verified === true ? 'pass' : '');
  const outcome = result?.status === 'error'
    ? 'failure'
    : result?.status === 'done' ? 'success' : '';
  return agiTrajectoryStore.record({
    runId,
    workspace,
    outcome,
    verification: verdict ? { verdict } : null,
    steps: (Array.isArray(result?.toolCalls) ? result.toolCalls : []).slice(-60).map(call => ({
      tool: String(call?.tool || call?.name || ''),
      ok: call?.ok === true || call?.status === 'completed',
      target: String(call?.file || call?.path || call?.target || '')
    })),
    summary: String(result?.text || '').slice(0, 200)
  });
}

// Only verified outcomes may become experience: a run that merely finished
// (no review) distills nothing — the pelican audit showed self-claimed passes
// without a surviving review record cannot be trusted as experience.
function runAgiOutcome(result) {
  const verdict = result?.delivery?.review?.verdict;
  if (result?.status === 'error' || verdict === 'fail') return 'failure';
  if (verdict === 'pass' || result?.delivery?.verified === true) return 'success';
  return '';
}

function failureTextFromResult(result) {
  const criteria = result?.delivery?.review?.criteria;
  const failed = criteria
    ? Object.values(criteria).filter(item => item?.status === 'fail').map(item => String(item?.evidence || '')).filter(Boolean)
    : [];
  const text = failed.join('；')
    || String(result?.goal?.failure || '')
    || String(result?.delivery?.failure || '')
    || String(result?.text || '');
  return text.slice(0, 300);
}

// P0-5 distillation: after a finished run in evolution/AGI mode, persist a
// rule (success) or failure_solution (failure) into long-term memory, and
// record a failure→repair edge in the experience graph for later retrieval.
function distillRunMemory({ runId, workspace = '', result } = {}) {
  if (!result || !workspace || !runId) return null;
  const outcome = runAgiOutcome(result);
  if (!outcome) return null;
  const summary = String(result?.text || '').slice(0, 300).trim();
  if (!summary) return null;
  const failure = outcome === 'failure' ? failureTextFromResult(result) : '';
  const distilled = distillOutcome({
    outcome,
    summary,
    failure,
    workspace,
    runId,
    scope: 'workspace'
  });
  if (!distilled.ok) return null;
  if (outcome === 'failure') {
    agiExperienceGraph.record({
      runId,
      action: summary,
      failure: failure || summary
    });
  }
  return addMemoryRecord({ ...distilled.record, runId }, { workspace, runId, sourceKind: 'agi_memory_consolidation' });
}

function persistAgiEvalEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return;
  try {
    fs.mkdirSync(path.dirname(AGI_EVAL_EVIDENCE_PATH), { recursive: true });
    fs.writeFileSync(AGI_EVAL_EVIDENCE_PATH, `${JSON.stringify({ version: 1, latest: evidence }, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[agi] eval evidence persist failed: ${error?.message || error}`);
  }
}

// Real promotion validation for skill candidates: deterministic static checks
// plus one headless judge session. The evidence record this returns is what
// attachValidation stores, so the promotion gate finally consumes something
// that was actually produced — not a hand-written placeholder.
async function validateSkillCandidate(candidate, sidecar = null) {
  if (!candidate?.id || !candidate?.prompt) {
    return { ok: false, failed: 1, passed: 0, suiteId: SKILL_VALIDATION_SUITE_ID, rubricVersion: 1, taskIds: [], digest: '', error: '候选不完整，无法验证' };
  }
  let judge = null;
  if (sidecar) {
    try {
      const cfg = loadConfig();
      const selection = normalizeAgentModelSelection(cfg);
      const judged = await sidecar.judgeSkillCandidate({
        providerId: selection.providerId,
        modelId: selection.modelId,
        candidate
      });
      if (judged.ok) judge = judged.judge;
      else console.warn(`[agi] skill judge unavailable: ${judged.error}`);
    } catch (error) {
      console.warn(`[agi] skill judge failed: ${error?.message || error}`);
    }
  }
  const evidence = evaluateSkillCandidate({ candidate, judge });
  persistAgiEvalEvidence(evidence);
  return evidence;
}

// P1-1: turn recurring tool sequences of verified runs into structured Skill
// candidates. Drafts stay unvalidated until Z Eval evidence is attached, so
// nothing reaches promotion through mining alone.
function mineAndRecordWorkflowCandidates({ runId, workspace = '', result } = {}) {
  if (!workspace || !runId) return null;
  if (result?.status !== 'done' || result?.delivery?.review?.verdict === 'fail') return null;
  // "已验证运行" now means what it says: only runs whose delivery review
  // passed enter the mining corpus. A run that merely finished (no review, or
  // a review the runtime dropped) used to be counted as verified here.
  const runs = verifiedRunsFromTrajectories(agiTrajectoryStore.list({ limit: 200 }), workspace);
  if (runs.length < 2) return null;
  const proposals = collectWorkflowProposals({ runs });
  if (!proposals.length) return null;
  const known = new Set(skillEvolution.list().map(item => item.id));
  const recorded = [];
  const toolCallCount = Math.max(4, Array.isArray(result?.toolCalls) ? result.toolCalls.length : 4);
  for (const candidate of proposals) {
    if (known.has(candidate.id)) continue;
    const stored = skillEvolution.record(candidate, {
      verified: true,
      toolCallCount,
      runId,
      workspace
    });
    if (stored.ok) recorded.push(candidate.id);
  }
  if (recorded.length) {
    console.log(`[agi] mined ${recorded.length} workflow candidate(s) from run ${runId}`);
  }
  return recorded;
}

// P0-3: inject the workspace's active long-horizon protocol into the turn
// context so a new session restores state before the first business action.
function readLongHorizonContext(workspace) {
  try {
    const latest = loadProtocol({ workspace });
    if (!latest?.protocol?.taskId) return '';
    const full = readProtocol({ workspace, taskId: latest.protocol.taskId });
    if (!full?.ok) return '';
    return renderProtocolPrompt(full);
  } catch {
    return '';
  }
}

function harnessEntryId(prefix, value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 90);
  if (normalized) return `${prefix}-${normalized}`.slice(0, 100);
  return `${prefix}-${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16)}`;
}

async function persistExplicitUserPolicy({ instructions, scope = 'global', workspace = '', runId = '', sessionId = '', source = 'agent_refine', recoveredFrom = '' } = {}) {
  const content = String(instructions || '').replace(/\r\n?/g, '\n').trim().slice(0, 6_000);
  if (!content) return { ok: false, error: 'Explicit policy is empty.' };
  const normalizedScope = scope === 'workspace' && workspace ? 'workspace' : 'global';
  const state = continualHarness.load({ scope: normalizedScope, workspace });
  const id = harnessEntryId('prompt', policyId(content).replace(/^user-policy-/u, ''));
  const existing = state.entries.prompt[id];
  if (existing?.metadata?.status === 'active' && existing.content === content) {
    return { ok: true, skipped: true, refinement: null, revision: state.revision };
  }
  const result = await continualHarness.apply({
    id: `policy-${crypto.createHash('sha256').update(`${normalizedScope}:${content}`).digest('hex').slice(0, 16)}`,
    trigger: `Explicit user policy: ${content}`,
    evidence: 'The user explicitly requested this durable behavior policy.',
    expectedOutcome: 'Make the explicit user policy active for every relevant future task.',
    edits: [{
      action: existing ? 'update' : 'create',
      kind: 'prompt',
      id,
      title: 'Explicit user policy',
      content,
      path: 'user-policy',
      scope: normalizedScope,
      metadata: {
        status: 'active',
        enforcement: 'mandatory',
        basis: 'explicit_user_statement',
        controls: derivePolicyControls(content),
        ...(recoveredFrom ? { recoveredFrom } : {})
      },
      reason: 'Explicit user instruction is the evidence for this active policy.'
    }]
  }, {
    scope: normalizedScope,
    workspace,
    expectedRevision: state.revision,
    baselineState: state,
    runId,
    sessionId,
    source
  });
  const applied = result.ok && (result.refinement?.appliedEdits || [])
    .some(edit => edit.applied === true && edit.kind === 'prompt' && edit.id === id);
  if (applied) {
    await continualHarness.recordOutcome(result.refinement.id, {
      status: 'partial',
      evidence: 'The explicit user policy was persisted and activated before reviewer output was considered.'
    }, { scope: normalizedScope, workspace });
  }
  if (applied) return result;
  // Another task or the stable Harness MCP may have activated the same rule
  // while this task waited for the state lock. Treat the durable end state as
  // success instead of reporting a stale-revision failure.
  const concurrent = continualHarness.get('prompt', id, { scope: normalizedScope, workspace });
  if (concurrent?.metadata?.status === 'active' && concurrent.content === content) {
    return { ok: true, skipped: true, concurrent: true, refinement: null, revision: result.revision };
  }
  return { ...result, ok: false, error: result.error || 'Explicit policy failed the Harness safety validation.' };
}

function harnessCandidateSimilarity(left, right) {
  const leftTokens = new Set(tokenizeMemoryText(left));
  const rightTokens = new Set(tokenizeMemoryText(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

async function applyReviewedHarnessState(review, payload = {}) {
  const byScope = new Map();
  const add = (scope, item) => {
    const normalizedScope = scope === 'workspace' && payload.workspace ? 'workspace' : 'global';
    if (!byScope.has(normalizedScope)) byScope.set(normalizedScope, { edits: [], memories: [], observing: false });
    const group = byScope.get(normalizedScope);
    group.edits.push(item.edit);
    if (item.memory) group.memories.push({ id: item.edit.id, record: item.memory });
    if (item.observing) group.observing = true;
  };

  for (const memory of Array.isArray(review?.memories) ? review.memories : []) {
    const scope = memory.scope === 'workspace' && payload.workspace ? 'workspace' : 'global';
    const state = continualHarness.load({ scope, workspace: payload.workspace });
    const id = harnessEntryId('memory', memory.key || memory.content);
    add(scope, {
      memory,
      edit: {
        action: state.entries.memory[id] ? 'update' : 'create',
        kind: 'memory',
        id,
        title: String(memory.key || memory.type || 'Durable memory'),
        content: memory.content,
        path: memory.type || 'general',
        scope,
        metadata: {
          status: 'active',
          key: memory.key,
          type: memory.type,
          confidence: memory.confidence,
          basis: memory.basis,
          verified: memory.verified === true,
          ...(memory.type === 'preference' && memory.basis === 'explicit_user_statement'
            ? { enforcement: 'mandatory', controls: derivePolicyControls(memory.content) }
            : {})
        },
        reason: memory.evidence
      }
    });
  }

  for (const candidate of Array.isArray(review?.harnessCandidates) ? review.harnessCandidates : []) {
    const scope = candidate.scope === 'workspace' && payload.workspace ? 'workspace' : 'global';
    const state = continualHarness.load({ scope, workspace: payload.workspace });
    const id = harnessEntryId(candidate.kind, candidate.id || candidate.title);
    const existing = state.entries[candidate.kind]?.[id];
    const compatible = !existing || harnessCandidateSimilarity(existing.content, candidate.content) >= 0.55;
    if (existing?.metadata?.status === 'active' && !compatible) continue;
    // Agent-requested refinements (the model relaying an explicit user
    // instruction such as "prefer AnySearch from now on") activate
    // immediately: the user is the evidence. Background-mined candidates
    // keep the two-independent-verified-runs gate, which would otherwise
    // deadlock - an observing entry is invisible to promptContext, so it can
    // never gather the second run's evidence on its own.
    const agentRequested = !!payload.refineInstructions;
    const evidenceRuns = [...new Set([
      ...(compatible && Array.isArray(existing?.metadata?.evidenceRuns) ? existing.metadata.evidenceRuns : []),
      String(payload.runId || '')
    ].filter(Boolean))].slice(-20);
    const successfulRuns = [...new Set([
      ...(compatible && Array.isArray(existing?.metadata?.successfulRuns) ? existing.metadata.successfulRuns : []),
      ...(payload.verifiedSuccess ? [String(payload.runId || '')] : [])
    ].filter(Boolean))].slice(-20);
    const active = agentRequested || successfulRuns.length >= 2;
    add(scope, {
      observing: !active,
      edit: {
        action: existing ? 'update' : 'create',
        kind: candidate.kind,
        id,
        title: candidate.title,
        content: candidate.content,
        path: candidate.path || 'general',
        scope,
        metadata: {
          status: active ? 'active' : 'observing',
          enforcement: agentRequested ? 'mandatory' : 'advisory',
          controls: derivePolicyControls(candidate.content),
          evidenceRuns,
          successfulRuns,
          evidenceCount: evidenceRuns.length,
          successCount: successfulRuns.length
        },
        reason: candidate.evidence
      }
    });
  }

  const results = [];
  for (const [scope, group] of byScope) {
    if (!group.edits.length) continue;
    const baselineState = payload.harnessBaselines?.[scope];
    const result = await continualHarness.apply({
      trigger: payload.refineInstructions
        ? `Agent-requested refinement: ${payload.refineInstructions}`
        : 'Background review found durable reusable evidence.',
      evidence: group.edits.map(edit => edit.reason).filter(Boolean).join('\n').slice(0, 2_000),
      expectedOutcome: group.observing
        ? 'Retain first observations without activating them until an independent successful run reinforces the same entry.'
        : 'Make verified durable evidence available to relevant future tasks.',
      edits: group.edits
    }, {
      scope,
      workspace: payload.workspace,
      expectedRevision: baselineState?.revision,
      baselineState,
      runId: payload.runId,
      sessionId: payload.sessionId,
      source: payload.refineInstructions ? 'agent_refine' : 'background_review'
    });
    if (result.ok) {
      await continualHarness.recordOutcome(result.refinement.id, {
        status: 'partial',
        evidence: group.observing
          ? 'Candidate is isolated in observing state pending a second distinct evidence run.'
          : 'Evidence passed the storage gate; behavioral improvement remains pending a later task outcome.'
      }, { scope, workspace: payload.workspace });
    }
    const appliedIds = new Set((result.refinement?.appliedEdits || [])
      .filter(edit => edit.applied)
      .map(edit => edit.id));
    results.push({
      scope,
      result,
      memories: result.ok
        ? group.memories.filter(item => appliedIds.has(item.id)).map(item => item.record)
        : []
    });
  }
  return results;
}

async function recordReviewedRefinementOutcomes(review, workspace) {
  const outcomes = [];
  for (const outcome of Array.isArray(review?.refinementOutcomes) ? review.refinementOutcomes : []) {
    const scopes = workspace ? ['workspace', 'global'] : ['global'];
    for (const scope of scopes) {
      const state = continualHarness.load({ scope, workspace });
      if (!state.refinements.some(item => item.id === outcome.refinementId)) continue;
      outcomes.push(await continualHarness.recordOutcome(outcome.refinementId, outcome, { scope, workspace }));
      break;
    }
  }
  return outcomes;
}

async function mcpStart(serverCfg) {
  const { id, command, args = [] } = serverCfg;
  if (mcpServers.has(id)) return { error: '已在运行' };

  // Windows 上 npx/node 需要通过 cmd /c 调用，且不能用 shell:true
  // 否则 shell 的额外输出会污染 JSON-RPC stdio 流
  // 对含空格的参数加双引号保护，避免 cmd 再次拆分
  let finalCommand = command;
  let finalArgs = args;
  let finalEnv = { ...process.env, ...(serverCfg.env || {}) };
  let finalCwd;
  if (serverCfg.runtime === 'codegraph') {
    const runtime = codeGraphRuntime.resolveRuntime(appRoot);
    if (!runtime.ok) return { error: runtime.error };
    finalCommand = runtime.command;
    const alreadyResolved = runtime.args.every((value, index) => args[index] === value);
    finalArgs = alreadyResolved ? args : [...runtime.args, ...args];
    finalEnv = { ...finalEnv, ...runtime.env };
    finalCwd = app.getPath('home');
  }
  if (process.platform === 'win32' && (command === 'npx' || command === 'node' || command === 'uvx' || command === 'uv')) {
    finalCommand = process.env.ComSpec || 'cmd.exe';
    // 仅对含空格的参数加双引号，防止 cmd.exe 按空格拆分
    // 不含空格的参数不加引号，否则 npm/npx 会把引号当作包名的一部分
    const quotedArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
    finalArgs = ['/c', command, ...quotedArgs];
  }

  try {
    const proc = spawn(finalCommand, finalArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: finalEnv,
      cwd: finalCwd,
      shell: false
    });

    // spawn 错误（如命令不存在）通过 error 事件触发，不是 try/catch
    // 使用可移除的监听器避免 Promise 泄漏
    let errHandler;
    const spawnError = new Promise((_, reject) => {
      errHandler = (err) => reject(err);
      proc.on('error', errHandler);
    });

    // stdin 的 EPIPE 等 IO 错误只会在 socket 上发 error 事件,没有监听器会直接抛
    // 未捕获异常击穿主进程,这里挂常驻兜底
    proc.stdin.on('error', (err) => {
      console.error(`[MCP ${id}] stdin 错误:`, err.message);
    });

    const server = {
      process: proc,
      stopping: false,
      tools: [],
      pending: new Map(),
      buffer: '',
      nextId: 1,
      decoder: new TextDecoder('utf-8'),
      requestTimeoutMs: (serverCfg.runtime === 'codegraph' || serverCfg.runtime === 'serena') ? 240000 : 30000
    };
    mcpServers.set(id, server);

    proc.stdout.on('data', (data) => {
      // 使用 TextDecoder 流式解码，避免多字节 UTF-8 字符在 data 边界被截断
      server.buffer += server.decoder.decode(data, { stream: true });
      // 防御无换行的超大输出:残留缓冲超过 32MB 时截断,避免字符串无上限增长拖垮主进程
      if (server.buffer.length > 32 * 1024 * 1024) {
        console.warn(`[MCP ${id}] stdout 缓冲超过 32MB,已截断`);
        server.buffer = server.buffer.slice(-1024 * 1024);
      }
      let idx;
      while ((idx = server.buffer.indexOf('\n')) >= 0) {
        const line = server.buffer.slice(0, idx).trim();
        server.buffer = server.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && server.pending.has(msg.id)) {
            const { resolve, reject, timer } = server.pending.get(msg.id);
            server.pending.delete(msg.id);
            if (timer) clearTimeout(timer);
            if (msg.error) reject(new Error(msg.error.message || 'MCP 错误'));
            else resolve(msg.result);
          } else if (msg.method) {
            // 处理通知消息（无 id），至少记录日志
            console.log(`[MCP ${id}] 通知:`, msg.method);
          }
        } catch (e) {
          console.log(`[MCP ${id}] 非 JSON 行:`, line.slice(0, 200));
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (!message) return;
      console.log(`[MCP ${id}] stderr:`, message);
    });

    proc.on('exit', (code) => {
      console.log(`[MCP ${id}] 进程退出，代码 ${code}`);
      // 通知渲染进程服务器已崩溃
      if (!server.stopping && mcpServers.get(id) === server && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mcp:status', { id, status: 'crashed', code });
      }
      // 拒绝所有 pending 请求
      for (const [pid, { reject, timer }] of server.pending) {
        if (timer) clearTimeout(timer);
        reject(new Error(`进程退出 (code ${code})`));
      }
      server.pending.clear();
      if (mcpServers.get(id) === server) mcpServers.delete(id);
    });

    // 初始化握手（与 spawn 错误竞争，先到先处理）
    const initPromise = mcpRequest(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Z', version: app.getVersion() }
    });

    await Promise.race([initPromise, spawnError]);
    // race 结束后把一次性 spawn 监听器换成常驻兜底监听器:
    // 直接 off 会让后续 error 事件无监听器而抛异常;保留 errHandler 又会让
    // spawnError 在 race 之后 reject 形成未处理 rejection,两种都会击穿主进程
    proc.off('error', errHandler);
    proc.on('error', (err) => {
      console.error(`[MCP ${id}] 进程错误:`, err.message);
    });

    // 发送 initialized 通知
    mcpSend(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // 列出工具
    const toolsResult = await mcpRequest(server, 'tools/list', {});
    server.tools = toolsResult.tools || [];

    return { ok: true, tools: server.tools };
  } catch (e) {
    // 握手/列工具失败时子进程可能仍在运行,必须杀掉整棵树,否则每次重试都泄漏一个孤儿
    const failed = mcpServers.get(id);
    mcpServers.delete(id);
    killProcessTree(failed && failed.process);
    return { error: e.message };
  }
}

function mcpStop(id) {
  const server = mcpServers.get(id);
  if (!server) return;
  server.stopping = true;
  killProcessTree(server.process);
  // 拒绝所有 pending 请求，清理 timer
  for (const [pid, { reject, timer }] of server.pending) {
    if (timer) clearTimeout(timer);
    reject(new Error('服务器已停止'));
  }
  server.pending.clear();
  mcpServers.delete(id);
}

// MCP 配置管理
// DSH code-review 审阅页宿主：把上游生成的自包含审阅页写入轮换的临时
// 文件并返回 file: URL。应用 CSP 禁止 blob:/srcdoc 的内联脚本，而审阅页
// 的行内评论与复制按钮都依赖内联脚本，因此 iframe 必须加载真实文档。
let dshReviewWriteSequence = 0;
const dshReviewDocuments = new Map();
ipcMain.handle('dsh-review:write-html', async (_event, html) => {
  if (typeof html !== 'string' || html.length === 0 || html.length > 32 * 1024 * 1024) {
    return { ok: false, error: '无效的审阅页面内容' };
  }
  try {
    const dir = path.join(app.getPath('temp'), 'z-dsh-code-review', String(process.pid));
    await fs.promises.mkdir(dir, { recursive: true });
    const owner = _event.sender.id;
    const file = path.join(dir, `review-${owner}-${++dshReviewWriteSequence}.html`);
    await fs.promises.writeFile(file, html, 'utf8');
    let documents = dshReviewDocuments.get(owner);
    if (!documents) {
      documents = [];
      dshReviewDocuments.set(owner, documents);
      _event.sender.once('destroyed', () => {
        dshReviewDocuments.delete(owner);
        for (const document of documents.splice(0)) void fs.promises.unlink(document).catch(() => {});
      });
    }
    documents.push(file);
    for (const obsolete of documents.splice(0, Math.max(0, documents.length - 8))) {
      void fs.promises.unlink(obsolete).catch(() => {});
    }
    return { ok: true, url: require('url').pathToFileURL(file).href };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('mcp:list', () => getMcpManagementServers(loadConfig()));
ipcMain.handle('understand-anything:open', async (_e, workspace) => {
  const normalized = workspaceSandbox.normalizeWorkspace(workspace);
  if (!normalized) return { ok: false, error: '项目地图需要当前任务工作区。' };
  return understandAnythingRuntime.openUnderstandAnything(appRoot, normalized, {
    viewerCommand: process.execPath,
    useElectron: true
  });
});
ipcMain.handle('understand-anything:refresh', async (_e, workspace) => {
  const normalized = workspaceSandbox.normalizeWorkspace(workspace);
  if (!normalized) return { ok: false, error: '项目地图需要当前任务工作区。' };
  understandAnythingRuntime.stopUnderstandAnything(normalized);
  return understandAnythingRuntime.openUnderstandAnything(appRoot, normalized, {
    viewerCommand: process.execPath,
    useElectron: true
  });
});
function buildUserMcpServer(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) return { error: '请输入 MCP 名称。' };
  if (String(input.type || '').trim().toLowerCase() === 'remote') {
    const url = String(input.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { error: '远程 MCP 地址必须以 http:// 或 https:// 开头。' };
    const headers = normalizeRemoteHeaders(input.headers);
    return {
      id: 'mcp_' + Date.now(),
      name,
      type: 'remote',
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      enabled: true
    };
  }
  const command = String(input.command || '').trim();
  if (!command) return { error: '请输入启动命令。' };
  return {
    id: 'mcp_' + Date.now(),
    name,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    enabled: true
  };
}

ipcMain.handle('mcp:add', (_e, input = {}) => {
  const cfg = loadConfig();
  if (!cfg.mcpServers) cfg.mcpServers = [];
  const server = buildUserMcpServer(input);
  if (server.error) return { error: server.error };
  cfg.mcpServers.push(server);
  saveConfig(cfg);
  return server;
});
ipcMain.handle('mcp:remove', (_e, id) => {
  const cfg = loadConfig();
  const target = (cfg.mcpServers || []).find(s => s.id === id);
  if (target?.builtin) return { error: '预装 MCP 服务器不可删除' };
  mcpStop(id);
  cfg.mcpServers = (cfg.mcpServers || []).filter(s => s.id !== id);
  saveConfig(cfg);
  return true;
});
ipcMain.handle('mcp:update', (_e, { id, ...changes }) => {
  const cfg = loadConfig();
  const servers = cfg.mcpServers || [];
  const idx = servers.findIndex(s => s.id === id);
  if (idx >= 0) {
    servers[idx] = { ...servers[idx], ...changes };
    saveConfig(cfg);
    return servers[idx];
  }
  return null;
});

ipcMain.handle('mcp:test', async (_e, form = {}) => {
  if (isRemoteMcpServer(form)) {
    return probeRemoteServer(form, { clientVersion: app.getVersion() });
  }
  const id = `mcp_test_${crypto.randomUUID()}`;
  try {
    return await mcpStart({
      id,
      name: String(form?.name || ''),
      command: String(form?.command || ''),
      args: Array.isArray(form?.args) ? form.args : [],
      enabled: true
    });
  } finally {
    mcpStop(id);
  }
});

// MCP 运行时
ipcMain.handle('mcp:start', async (_e, id) => {
  const cfg = loadConfig();
  const serverCfg = getMcpServerConfig(cfg, id);
  if (!serverCfg) return { error: '未找到服务器配置' };
  if (isRemoteMcpServer(serverCfg)) {
    return probeRemoteServer(serverCfg, { clientVersion: app.getVersion() });
  }
  return mcpStart(serverCfg);
});
ipcMain.handle('mcp:tools', async (_e, id) => {
  const running = mcpServers.get(id);
  if (running) return { ok: true, tools: running.tools || [] };
  const cfg = loadConfig();
  const serverCfg = getMcpServerConfig(cfg, id);
  if (!serverCfg) return { error: '未找到服务器配置' };
  if (isRemoteMcpServer(serverCfg)) {
    return probeRemoteServer(serverCfg, { clientVersion: app.getVersion() });
  }
  return mcpStart(serverCfg);
});
ipcMain.handle('mcp:stop', (_e, id) => {
  mcpStop(id);
  return { ok: true };
});
// ---------------------------------------------------------------------------
ipcMain.handle('permissions:get', () => loadConfig().permissions);
ipcMain.handle('permissions:set', (_e, perms) => {
  const cfg = loadConfig();
  cfg.permissions = { ...cfg.permissions, ...perms };
  saveConfig(cfg);
  return cfg.permissions;
});

// ---------------------------------------------------------------------------
// IPC: Window controls (custom title bar)
// ---------------------------------------------------------------------------
ipcMain.on('pet:update', (event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return;
  petState = normalizePetState(payload);
  sendPetState();
});

ipcMain.on('pet:ready', (event) => {
  if (!petWindow || petWindow.isDestroyed() || event.sender.id !== petWindow.webContents.id) return;
  sendPetConfig();
  sendPetState();
});

ipcMain.handle('pet:get-visible', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return false;
  return !!(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());
});

ipcMain.handle('pet:toggle-window', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return false;
  return togglePetWindow();
});

ipcMain.on('pet:drag-start', (event) => {
  if (!petWindow || petWindow.isDestroyed() || event.sender.id !== petWindow.webContents.id) return;
  startPetDrag();
});

ipcMain.on('pet:drag-end', (event) => {
  if (!petWindow || petWindow.isDestroyed() || event.sender.id !== petWindow.webContents.id) return;
  updatePetDrag();
  stopPetDrag();
});

ipcMain.on('pet:open-task', (event, sessionId) => {
  if (!petWindow || petWindow.isDestroyed() || event.sender.id !== petWindow.webContents.id) return;
  if (activePetId !== 'orb') return;
  showMainWindowForPet(sessionId);
});

ipcMain.on('pet:stop-task', (event, sessionId) => {
  if (!petWindow || petWindow.isDestroyed() || event.sender.id !== petWindow.webContents.id) return;
  if (!mainWindow || mainWindow.isDestroyed() || !sessionId) return;
  mainWindow.webContents.send('pet:action', { type: 'stop-task', sessionId: String(sessionId) });
});

ipcMain.on('pet:close', (event) => {
  if (!petWindow || petWindow.isDestroyed() || event.sender.id !== petWindow.webContents.id) return;
  destroyPetWindow();
});

ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win:close', () => {
  // 点击标题栏关闭按钮时，最小化到托盘而非退出
  if (mainWindow) mainWindow.hide();
});
ipcMain.handle('win:is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));
ipcMain.on('quick-input:submit', (event, text) => {
  if (!quickInputWindow || quickInputWindow.isDestroyed() || event.sender.id !== quickInputWindow.webContents.id) return;
  const prompt = String(text || '').trim();
  if (!prompt) return;
  destroyQuickInputWindows();
  sendQuickInputPromptToMain(prompt);
});
ipcMain.on('quick-input:close', (event) => {
  if (!quickInputWindow || quickInputWindow.isDestroyed() || event.sender.id !== quickInputWindow.webContents.id) return;
  destroyQuickInputWindows();
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function deepMerge(target, source) {
  if (typeof source !== 'object' || source === null) return source;
  if (typeof target !== 'object' || target === null) return source;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bundled agent skills (OfficeCLI and Z-local integrations)
// ---------------------------------------------------------------------------
let bundledAgentSkillsReady = false;

function ensureBundledAgentSkills(cfg) {
  if (bundledAgentSkillsReady) return false;
  const bundledDir = path.join(appRoot, 'lib', 'skills', 'bundled');
  if (!fs.existsSync(bundledDir)) return false;
  if (!cfg.customSkills) cfg.customSkills = [];
  const files = fs.readdirSync(bundledDir).filter(f => f.endsWith('.json'));
  const manifests = files.flatMap(file => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(bundledDir, file), 'utf8'))];
    } catch {
      return [];
    }
  });
  const availableAppManagedIds = new Set(manifests.map(meta => String(meta?.id || '')).filter(Boolean));
  const migratedShadows = skillRegistry.migrateBundledSkillShadows(dataDir, appRoot, availableAppManagedIds);
  const retiredSkillIds = skillRegistry.getRetiredSkillIds(appRoot);
  const retiredResult = skillRegistry.pruneRetiredSkills(cfg, appRoot, dataDir);
  const beforePrune = cfg.customSkills.length;
  cfg.customSkills = cfg.customSkills.filter(skill => (
    !retiredSkillIds.has(String(skill?.id || '').trim().toLowerCase())
    && (!['Z Agent', 'bundled'].includes(skillRegistry.normalizeSkillSource(skill?.source)) || availableAppManagedIds.has(skillRegistry.normalizeSkillId(skill.id)))
  ));
  let changed = migratedShadows.changed || retiredResult.changed || cfg.customSkills.length !== beforePrune;
  for (const meta of manifests) {
    if (!meta?.id) continue;
    let prompt = String(meta.prompt || '').trim();
    if (meta.promptFile) {
      const promptPath = path.join(bundledDir, meta.promptFile);
      if (fs.existsSync(promptPath)) {
        prompt = fs.readFileSync(promptPath, 'utf8');
      }
    }
    if (!prompt) continue;
    const existing = cfg.customSkills.find(skill => skill.id === meta.id);
    const installedAt = Number(existing?.installedAt || meta.installedAt) || Date.now();
    const item = {
      id: meta.id,
      name: meta.name || meta.id,
      desc: meta.desc || '',
      version: Number(meta.version || 1),
      prompt,
      aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
      tags: meta.tags || [],
      triggers: meta.triggers || [],
      requires: Array.isArray(meta.requires) ? meta.requires : [],
      source: meta.source || 'bundled',
      repo: meta.repo || '',
      hidden: meta.hidden === true,
      userOnly: meta.userOnly === true,
      parentSkillId: meta.parentSkillId || '',
      logo: skillRegistry.resolveSkillLogo(meta),
      installedAt,
      updatedAt: Number(meta.updatedAt || existing?.updatedAt) || installedAt
    };
    if (!skillRegistry.resolveBundledSkillPackage(appRoot, item.id)) {
      const installResult = skillRegistry.installZUserSkill(dataDir, item);
      if (!installResult.ok) console.warn(`[skills] bundled prompt install failed (${item.id}): ${installResult.error}`);
    }
    const idx = cfg.customSkills.findIndex(s => s.id === item.id);
    const metadata = skillConfigMetadata(item);
    if (idx < 0) {
      cfg.customSkills.push(metadata);
      changed = true;
    } else {
      const next = { ...cfg.customSkills[idx], ...metadata, installedAt };
      delete next.prompt;
      if (JSON.stringify(next) !== JSON.stringify(cfg.customSkills[idx])) {
        cfg.customSkills[idx] = next;
        changed = true;
      }
    }
  }
  const compact = skillConfigMetadataList(cfg.customSkills);
  if (JSON.stringify(compact) !== JSON.stringify(cfg.customSkills)) {
    cfg.customSkills = compact;
    changed = true;
  }
  bundledAgentSkillsReady = true;
  if (changed) {
    skillRegistry.invalidateInstalledSkillsCache(dataDir);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// IPC: OpenCode runtime (the only Agent execution authority)
// ---------------------------------------------------------------------------
function getNoWorkspaceAgentDirectory(sessionId) {
  return legacyRuntimeWorkspace(dataDir, sessionId);
}

async function selectedRunSkills(requestedSkills, cfg, { workspace, workMode } = {}) {
  const requested = Array.isArray(requestedSkills) ? [...requestedSkills] : [];
  const requestedIds = selectedSkillIds(requested);
  if (requestedIds.has('z-serena') && !workspace) {
    return {
      error: 'Serena 需要当前任务工作区。请先选择工作区后，再使用 Serena 进行代码定位或符号级修改。'
    };
  }
  const skills = [];
  const skippedSkills = [];
  for (const requestedSkill of requested) {
    const id = String(requestedSkill?.id || requestedSkill || '').trim();
    if (!id) continue;
    const loaded = await skillRegistry.readSkillWithRetry(
      id, '', cfg, appRoot, dataDir, saveConfig, { allowUserOnly: true, maxAttempts: 3 }
    );
    if (!loaded?.ok) {
      skippedSkills.push({
        id: String(loaded?.id || id),
        name: String(loaded?.name || requestedSkill?.name || id),
        attempts: Number(loaded?.attempts) || 1,
        error: String(loaded?.error || 'Skill 无法加载。'),
        skipNotice: String(loaded?.skipNotice || `Skill「${id}」本轮已跳过。`)
      });
      continue;
    }
    skills.push({
      ...(typeof requestedSkill === 'object' ? requestedSkill : {}),
      id: String(loaded.id || id),
      name: String(loaded.name || requestedSkill?.name || id),
      desc: String(loaded.desc || requestedSkill?.desc || ''),
      aliases: Array.isArray(loaded.aliases) ? loaded.aliases : (requestedSkill?.aliases || []),
      prompt: String(loaded.prompt || ''),
      requires: Array.isArray(loaded.requires) ? loaded.requires : (requestedSkill?.requires || []),
      runtimeDirectory: String(loaded.runtimeDirectory || requestedSkill?.runtimeDirectory || '')
    });
  }
  const userSelectedSerena = selectedSkillIds(skills).has('z-serena');
  if (workMode !== 'goal' || !workspace || userSelectedSerena) return { skills, skippedSkills };

  const serena = await skillRegistry.readSkillWithRetry('z-serena', '', cfg, appRoot, dataDir, saveConfig, { maxAttempts: 3 });
  if (!serena?.ok) {
    skippedSkills.push({
      id: 'z-serena', name: 'Serena', attempts: Number(serena?.attempts) || 1,
      error: String(serena?.error || '内置 Skill 不可用'),
      skipNotice: String(serena?.skipNotice || 'Serena 本轮已跳过。')
    });
    return { skills, skippedSkills };
  }
  skills.push({
    id: String(serena.id || 'z-serena'),
    name: String(serena.name || 'Serena'),
    desc: String(serena.desc || ''),
    aliases: Array.isArray(serena.aliases) ? serena.aliases : [],
    prompt: String(serena.prompt || ''),
    requires: Array.isArray(serena.requires) ? serena.requires : []
  });
  return { skills, skippedSkills };
}

ipcMain.handle('opencode:prewarm', async () => {
  try {
    return await prewarmOpenCodeSidecar();
  } catch (error) {
    console.warn('[opencode] prewarm failed:', error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
});

const manualContextCompressions = new Set();
ipcMain.handle('opencode:compress-session', async (_e, { zSessionId } = {}) => {
  const id = String(zSessionId || '');
  if (!isSafeSessionId(id)) return { ok: false, error: '会话 ID 无效' };
  if (isSessionRunActive(id) || manualContextCompressions.has(id)) {
    return { ok: false, error: '任务工作中或正在压缩，请稍后再试' };
  }
  // Reserve before the first await; start-run checks the same reservation.
  manualContextCompressions.add(id);
  console.info('[context] manual compression started:', id);
  try {
    return await withOpenCodeBackgroundLease(async () => {
      const session = await readSessionRecord(id);
      if (!session?.openCodeSessionId) return { ok: false, error: '还没有可压缩的上下文' };
      const cfg = loadConfig();
      const selection = applySessionModelToRunConfig(cfg, session.modelSelection);
      if (selection.modelType !== 'text') return { ok: false, error: '请选择文本模型进行压缩' };
      const workspace = workspaceSandbox.normalizeWorkspace(session.workspace) || getNoWorkspaceAgentDirectory(id);
      const sidecar = await ensureOpenCodeSidecar(getOpenCodeRuntimeConfig(cfg));
      const result = await sidecar.compressSession({
        openCodeSessionId: session.openCodeSessionId, workspace,
        providerId: selection.providerId, modelId: selection.modelId,
        openCodeConfig: getOpenCodeRuntimeConfig(cfg)
      });
      if (result.compacted) {
        console.info('[context] manual compression completed:', id, result.beforeTokens, '->', result.afterTokens);
      } else {
        console.warn('[context] manual compression failed:', id, result.error || '内核未完成压缩');
      }
      return { ...result, ok: result.compacted === true, completedAt: Date.now() };
    });
  } catch (error) {
    console.error('[context] manual compression failed:', id, error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  } finally {
    manualContextCompressions.delete(id);
  }
});

ipcMain.handle('opencode:start-run', async (_e, request = {}) => {
  const admittedRunId = String(request.runId || crypto.randomUUID());
  let admissionPending = false;
  let coreTurnStarted = false;
  let coreTurn = null;
  try {
    if (manualContextCompressions.has(String(request.zSessionId || ''))) {
      return { ok: false, error: '上下文正在压缩，请完成后再开始工作' };
    }
    if (openCodeActiveRuns.size + openCodeRunAdmissions.size >= MAX_CONCURRENT_AGENT_RUNS) {
      return { ok: false, error: `并发任务已达上限（${MAX_CONCURRENT_AGENT_RUNS}个），请稍后再试。` };
    }
    request = { ...request, runId: admittedRunId };
    openCodeRunAdmissions.set(admittedRunId, String(request.zSessionId || ''));
    admissionPending = true;
    const authoritativeSession = request.zSessionId ? await readSessionRecord(request.zSessionId) : null;
    if (request.zSessionId && !authoritativeSession && request.utility !== true) {
      throw Object.assign(new Error('会话不存在，请重新打开对话。'), { code: 'session-not-found' });
    }
    assertConversationRevision(authoritativeSession, request.conversationRevision);
    request.conversationRevision = sessionConversationRevision(authoritativeSession);
    delete request.forkHistory;
    const forkContext = forkRunContext(authoritativeSession, request);
    if (forkContext) Object.assign(request, forkContext);
    const cfg = loadConfig();
    const requestedModel = Object.prototype.hasOwnProperty.call(request, 'modelSelection')
      ? request.modelSelection : (authoritativeSession?.modelSelection || (request.utility === true ? null : cfg.agentModel));
    const selection = applySessionModelToRunConfig(cfg, requestedModel ? { ...requestedModel,
      reasoningSpeed: requestedModel.reasoningSpeed ?? authoritativeSession?.modelSelection?.reasoningSpeed,
      compactionThreshold: requestedModel.compactionThreshold ?? authoritativeSession?.modelSelection?.compactionThreshold } : requestedModel);
    request.modelSelection = selection;
    // The persisted conversation owns its directory. A stale renderer must
    // not erase it, borrow another task's folder, or fall back to private storage.
    const runWorkspaceSession = authoritativeSession || {
      id: isSafeSessionId(request.zSessionId) ? String(request.zSessionId)
        : `sess_run_${crypto.createHash('sha256').update(admittedRunId).digest('hex')}`,
      workspace: Object.prototype.hasOwnProperty.call(request, 'workspace') ? request.workspace : cfg.workspace
    };
    const runWorkspace = await ensureTaskWorkspace(runWorkspaceSession, {
      root: defaultTasksRoot, dataDirectory: dataDir, previousSession: authoritativeSession
    });
    const workspace = runWorkspace.workspace;
    const workspaceKind = runWorkspace.workspaceKind;
    const executionDirectory = workspace;
    await fsp.mkdir(executionDirectory, { recursive: true });
    if (authoritativeSession && !sameWorkspace(request.workspace, workspace)) {
      notifyDesktopSessionUpdate({ id: authoritativeSession.id, reason: 'workspace-assigned', workspace, workspaceKind });
    }
    const prompt = String(request.prompt || '').trim()
      || (Array.isArray(request.selectedSkills) && request.selectedSkills.length
        ? 'Apply the explicitly selected Skills to the current task.'
        : 'Continue the current task.');
    // Activate an explicit durable user rule before this run snapshots
    // Harness state. This removes the A->B race where background memory
    // review had not finished by the time the next task was constructed.
    if (!request.utility) {
      const startingPolicy = extractExplicitPolicyInstruction({ prompt, history: request.history });
      if (startingPolicy?.text) {
        const persisted = await persistExplicitUserPolicy({
          instructions: startingPolicy.text,
          scope: 'global',
          workspace,
          runId: admittedRunId,
          sessionId: String(request.zSessionId || ''),
          source: 'explicit_user_policy_start'
        });
        if (!persisted.ok) {
          console.warn(`[harness] start-of-run policy activation failed for ${admittedRunId}: ${persisted.error}`);
        }
      }
    }
    const memoryQuery = [
      prompt,
      ...(Array.isArray(request.history) ? request.history : [])
        .slice(-8)
        .filter(message => message?.role === 'user')
        .map(message => String(message?.content || '').slice(0, 1_500))
    ].filter(Boolean).join('\n').slice(0, 10_000);
    const runWorkMode = ['normal', 'plan', 'goal', 'evolution', 'agi'].includes(String(request.workMode || ''))
      ? String(request.workMode)
      : (cfg.agent?.workMode || 'normal');
    request.workMode = runWorkMode;
    const isolated = isolateWorkMode(request);
    for (const key of Object.keys(request)) if (!(key in isolated)) delete request[key];
    Object.assign(request, isolated);
    const agiMode = agiEnabled(request);
    const retrievedMemory = request.utility || forkContext
      ? { context: '' }
      : longTermMemory.query({
        query: memoryQuery,
        workspace,
        maxChars: 3_600,
        limit: 12,
        boostRunIds: agiMode ? agiVerifiedRunIndex.ids() : null,
        excludeSourceKinds: agiMode ? [] : ['agi_memory_consolidation']
      });
    const runId = admittedRunId;
    const zSessionId = String(request.zSessionId || '');
    const runStartedAt = Date.now();
    // Self-evolution runs on its own mode and inside AGI mode (the dual chain
    // the user selected): only these modes create and promote new experience.
    const evolutionMode = evolutionEnabled(request);
    // P0-4: consume the one-shot escalation hint here (not at runtime-config
    // build) so it can raise the side-path ceiling of THIS run — best-of-N now
    // maps to real extra compute instead of being written and dropped.
    const escalationHint = !agiMode
      ? null
      : agiEscalationMemo.consume({ workspace });
    if (escalationHint) {
      console.log(`[agi] escalation active for run ${runId}: effort +${escalationHint.steps}, best-of-${escalationHint.bestOfN} ceiling (${escalationHint.reason})`);
      request.escalation = {
        steps: escalationHint.steps,
        bestOfN: escalationHint.bestOfN,
        reason: escalationHint.reason
      };
    }
    // P1-2 topology evolution: only evolution/AGI runs participate. Selection
    // requires a passing eval evidence record plus paired history; roles are
    // advisory preferences merged into the subagent system prompt.
    if (agiMode) {
      try {
        const topology = selectTopologyForRun({
          historyFile: AGI_TOPOLOGY_HISTORY_PATH,
          evidenceFile: AGI_EVAL_EVIDENCE_PATH
        });
        if (topology?.active && Array.isArray(topology.roles) && topology.roles.length) {
          if (!Array.isArray(request.subagentRoles) || request.subagentRoles.length === 0) {
            request.subagentRoles = topology.roles;
          }
          request.topologyVariantId = topology.variantId;
          console.log(`[agi] topology ${topology.variantId} selected for run ${runId}: ${topology.reason}`);
        }
      } catch (error) {
        console.warn(`[agi] topology selection failed for run ${runId}:`, error?.message || error);
      }
    }
    // The experimental reasoning gate belongs exclusively to AGI mode.
    if (agiMode && !request.reasoningSidepath) {
      request.reasoningSidepath = {
        required: true,
        followupRound: Array.isArray(request.history)
          && request.history.some(message => message?.role === 'assistant'),
        ceiling: sidepathCeiling({ workMode: runWorkMode, escalated: Boolean(escalationHint) })
      };
    }
    try { fs.rmSync(pendingHarnessRequestPath(runId), { force: true }); } catch {}
    if (evolutionMode && workspace) {
      try { await continualHarness.recoverRejectedAgentRefinements({ scope: 'workspace', workspace }); } catch (error) {
        console.warn(`[harness] workspace policy recovery failed for ${workspace}:`, error?.message || error);
      }
    }
    // Every workspace run gets a per-run context file: it authorizes the
    // z_workspace (worktree/impact) and z_analysis tools per call. The
    // Harness refinement tools stay separately task-gated to evolution mode,
    // so registering the file here exposes nothing extra.
    if (evolutionMode || (workspace && !request.utility)) {
      registerHarnessRunContext({
        runId,
        sessionId: zSessionId,
        workspace,
        allowFileRead: cfg.permissions?.allowFileRead !== false,
        allowNetwork: cfg.permissions?.allowNetwork !== false,
        allowFileWrite: cfg.permissions?.allowFileWrite !== false
      });
    }
    const harnessBaselines = evolutionMode ? {
      global: continualHarness.load({ scope: 'global' }),
      ...(workspace ? { workspace: continualHarness.load({ scope: 'workspace', workspace }) } : {})
    } : {};
    const evolutionSelection = evolutionMode
      ? continualHarness.evolutionContext({ workspace, query: memoryQuery, maxChars: 6_000, maxEntries: 6 })
      : { entries: [], policies: [], text: '' };
    const behaviorPolicies = evolutionSelection.policies;
    const harnessContext = evolutionSelection.text;
    if (evolutionMode) {
      registerHarnessUsage({
        runId,
        workspace,
        sessionId: zSessionId,
        entries: evolutionSelection.entries || []
      });
    }
    const visionAbortController = new AbortController();
    openCodeActiveRuns.set(runId, {
      task: null,
      startedAt: runStartedAt,
      zSessionId,
      workspace,
      executionDirectory,
      visionAbortController,
      selection,
      prompt
    });
    openCodeRunAdmissions.delete(runId);
    admissionPending = false;
    refreshAgentRuntimeActivity();
    ensureOpenCodeReconcileRun(runId, { zSessionId, workspace, startedAt: runStartedAt });
    registerMediaWorkspace(runId, workspace);
    // Repo map is frozen into this run's request: the sidecar embeds it in
    // the system prompt, which must stay stable for kernel prompt caching.
    if (workspace && !request.utility && !request.skillOnly) {
      request.repoMap = await getCachedRepoMap(workspace);
    }
    if (workspace && agiMode) {
      request.longHorizonContext = readLongHorizonContext(workspace);
      // P2-2 experience graph: matched failure→repair edges for this prompt,
      // rendered as bounded data-only context.
      try {
        request.experienceEdgeContext = collectExperienceEdgeContext(agiExperienceGraph, request.prompt);
      } catch (error) {
        console.warn(`[agi] experience edge context failed:`, error?.message || error);
      }
    }
    const requestedWorkMode = runWorkMode;
    const workMode = request.utility ? 'normal' : requestedWorkMode;
    try {
      coreTurn = zCore.startTurn({
        threadId: zSessionId || `thread_${runId}`,
        turnId: runId,
        workspace,
        title: authoritativeSession?.title || '',
        configSnapshot: {
          providerId: selection.providerId,
          supplierId: selection.supplierId,
          modelId: selection.modelId,
          modelType: selection.modelType,
          workMode,
          accessMode: cfg.agent?.accessMode || 'request',
          inputTokensPerSecond: Math.max(DEFAULT_INPUT_TOKENS_PER_SECOND, normalizeInputTokensPerSecond(
            cfg.api?.inputTokensPerSecond || cfg.agent?.inputTokensPerSecond
          )),
          visionRelayEnabled: cfg.api?.visionRelayEnabled !== false,
          enableSubagents: true,
        },
        intent: {
          prompt,
          attachments: request.attachments,
          selectedSkills: request.selectedSkills,
          subagentRoles: Array.isArray(request.subagentRoles) ? request.subagentRoles : [],
          workMode,
        }
      });
      coreTurnStarted = true;
    } catch (error) {
      const detail = error?.message || String(error);
      console.error('[z-core] failed to start Turn; refusing to start an untracked provider run:', detail);
      try { fs.rmSync(pendingHarnessRequestPath(runId), { force: true }); } catch {}
      removeHarnessRunContext(runId);
      releaseMediaWorkspace(runId);
      openCodeActiveRuns.delete(runId);
      openCodeRunReconcile.delete(runId);
      refreshAgentRuntimeActivity();
      return { ok: false, code: error?.code || 'Z_CORE_START_FAILED', error: `Z 无法启动本轮任务：${detail}` };
    }
    const resolvedSkills = await selectedRunSkills(request.selectedSkills, cfg, { workspace, workMode });
    if (resolvedSkills.error) {
      if (coreTurnStarted) zCore.completeTurn(runId, { status: 'error', error: resolvedSkills.error });
      removeHarnessRunContext(runId);
      releaseMediaWorkspace(runId);
      openCodeActiveRuns.delete(runId);
      refreshAgentRuntimeActivity();
      openCodeRunReconcile.delete(runId);
      return { ok: false, error: resolvedSkills.error };
    }
    const runSelectedSkills = resolvedSkills.skills;
    const skippedSkills = resolvedSkills.skippedSkills || [];
    const desktopTask = isDesktopTaskRequest({ prompt, selectedSkills: runSelectedSkills });
    const skillOnly = isSelectedSkillReadOnlyRequest({
      prompt,
      selectedSkills: runSelectedSkills
    });
    const emitVisionEvent = (type, data = {}) => {
      sendOpenCodeRendererEvent(runId, { type, data });
    };
    const relayed = await relayImagesForTextModel(
      cfg,
      selection,
      { ...request, prompt },
      runId,
      emitVisionEvent,
      visionAbortController.signal
    );
    if (visionAbortController.signal.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      throw error;
    }
    const sidecar = getOpenCodeSidecar();
    const providerAdapter = getOpenCodeProviderAdapter(sidecar);
    const mediaModels = getConfiguredMediaModels(cfg);
    const openCodeMcpServers = getOpenCodeMcpServers(cfg, {
      workspace,
      workMode,
      evolutionMode,
      prompt,
      attachments: request.attachments,
      selectedSkills: runSelectedSkills,
      desktopTask,
      runId,
      zSessionId,
      skillOnly
    });
    const capabilityContext = getOpenCodeCapabilityContext(cfg, openCodeMcpServers, { skippedSkills });
    // P0-4: a run that showed uncertainty raises the effort of exactly the next
    // run in this workspace, then the one-shot hint is cleared. escalationHint
    // was consumed at request-build time so it could raise the side-path
    // ceiling of this run as well.
    const openCodeConfig = getOpenCodeRuntimeConfig(cfg, {
      mcpServers: openCodeMcpServers,
      taskId: runId,
      skillOnly,
      ...(escalationHint
        ? { reasoningSpeed: raiseReasoningSpeed(cfg.api?.reasoningSpeed, escalationHint.steps) }
        : {})
    });
    let forkBindingWrite = Promise.resolve();
    const recordForkBinding = nativeId => {
      if (!forkContext || !nativeId) return forkBindingWrite;
      forkBindingWrite = forkBindingWrite.then(() => persistForkKernelBinding(zSessionId, nativeId, request.conversationRevision))
        .catch(error => console.warn('[session-fork] Kernel binding could not be saved:', error?.message || error));
      return forkBindingWrite;
    };
    const emitOpenCodeEvent = event => {
      if (event?.type === 'z.opencode.started') void recordForkBinding(event.data?.sessionID);
      if (event?.type === 'z.delivery.contract.updated') {
        const activeRun = openCodeActiveRuns.get(runId);
        if (activeRun) activeRun.deliveryContract = event.data?.contract || null;
      }
      trackBrowserAgentToolClaim(runId, event);
      trackSessionAgentToolClaim(runId, event);
      sendOpenCodeRendererEvent(runId, event);
      const eventData = event?.data || event?.properties || {};
      if (event?.type === 'session.diff' && Array.isArray(eventData.diff)) {
        sendOpenCodeRendererEvent(runId, {
          type: 'z.review.updated',
          data: summarizeOpenCodeDiffs(workspace, eventData.diff, {
            includeDiff: true,
            startTime: openCodeActiveRuns.get(runId)?.startedAt || runStartedAt
          })
        });
      } else if (event?.type === 'file.edited') {
        sendOpenCodeRendererEvent(runId, {
          type: 'z.review.invalidated',
          data: { file: String(eventData.file || '') }
        });
      }
    };
    const task = providerAdapter.startTurn({
      ...request,
      runId,
      zConfigSnapshotId: coreTurn?.configSnapshotId || '',
      language: cfg.language,
      prompt: relayed.prompt || prompt,
      attachments: relayed.attachments,
      workspace: executionDirectory,
      userWorkspace: workspace,
      hasUserWorkspace: !!workspace,
      workspaceKind,
      legacyRuntimeWorkspace: runWorkspace.legacyRuntimeWorkspace || '',
      providerId: selection.providerId,
      modelId: selection.modelId,
      observerConnection: observerConnectionForRun(cfg),
      observerJudgeEvery: normalizeObserverSettings(cfg.observer).judgeEvery,
      inputTokensPerSecond: Math.max(DEFAULT_INPUT_TOKENS_PER_SECOND, normalizeInputTokensPerSecond(
        cfg.api?.inputTokensPerSecond || cfg.agent?.inputTokensPerSecond
      )),
      workMode,
      measuredInputTokensPerSecond: Number(
        cfg.api?.inputThroughput?.[measurementKey(selection.providerId, selection.modelId)]?.tokensPerSecond
      ) || 0,
      accessMode: cfg.agent?.accessMode || 'request',
      desktopTask,
      permissions: cfg.permissions,
      enableSubagents: true,
      subagentRoles: Array.isArray(request.subagentRoles) ? request.subagentRoles : [],
      subagentMaxChildren: cfg.agent?.subagentMaxChildren,
      mediaModels,
      zSkillDirectory: skillsDir,
      mcpServers: openCodeMcpServers,
      skillOnly,
      selectedSkills: runSelectedSkills,
      skippedSkills,
      availableSkills: capabilityContext.skills,
      availableMcpServers: capabilityContext.mcpServers,
      zBrowserAvailable: capabilityContext.zBrowserAvailable,
      openCodeConfig,
      behaviorPolicies,
      visionRelay: relayed.relay,
      visionRelayEnabled: cfg.api?.visionRelayEnabled !== false,
      handoff: forkContext ? null : authoritativeSession?.handoff || null,
      memoryContext: retrievedMemory.context || '',
      harnessContext: forkContext ? '' : harnessContext
    }, emitOpenCodeEvent);
    openCodeActiveRuns.set(runId, {
      ...openCodeActiveRuns.get(runId),
      task,
      startedAt: runStartedAt,
      zSessionId,
      workspace,
      executionDirectory,
      visionAbortController,
      selection,
      prompt: relayed.prompt || prompt
    });
    task.then(async result => {
      await recordForkBinding(result?.openCodeSessionId);
      if (coreTurnStarted) zCore.completeTurn(runId, result);
      try {
        if (evolutionMode) recordAgiTrajectory({ runId, workspace, result });
      } catch (error) {
        console.warn(`[agi] trajectory record failed for run ${runId}:`, error?.message || error);
      }
      if (agiMode) {
        try {
          const distilled = distillRunMemory({ runId, workspace, result });
          if (distilled?.ok) console.log(`[agi] distilled ${distilled.record?.type || 'memory'} from run ${runId}`);
        } catch (error) {
          console.warn(`[agi] memory distillation failed for run ${runId}:`, error?.message || error);
        }
        try {
          recordTopologyOutcome({
            historyFile: AGI_TOPOLOGY_HISTORY_PATH,
            variantId: request.topologyVariantId,
            runId,
            ok: runAgiOutcome(result) === 'success',
            cost: 1
          });
        } catch (error) {
          console.warn(`[agi] topology record failed for run ${runId}:`, error?.message || error);
        }
      }
      try {
        const escalation = agiMode ? agiEscalationMemo.noteRun({ workspace, result }) : null;
        if (escalation?.escalated) {
          console.warn(`[agi] escalation scheduled for the next run (${escalation.steps} step(s)): ${escalation.reason}`);
        }
      } catch (error) {
        console.warn(`[agi] escalation memo failed for run ${runId}:`, error?.message || error);
      }
      try {
        if (evolutionMode) mineAndRecordWorkflowCandidates({ runId, workspace, result });
      } catch (error) {
        console.warn(`[agi] workflow mining failed for run ${runId}:`, error?.message || error);
      }
      try {
        const sidepathSummary = summarizeSidepath(result?.sidepath);
        if (sidepathSummary) console.log(`[agi] reasoning side-path run=${runId} ${sidepathSummary}`);
      } catch {}
      const performance = result?.performance;
      if (performance) {
        const outputTps = performance.outputTokensPerSecond
          ?? performance.visibleOutputTokensPerSecond
          ?? performance.providerOutputTokensPerSecond;
        const visibleOutputTps = performance.visibleOutputTokensPerSecond;
        const providerOutputTps = performance.providerOutputTokensPerSecond;
        const inputTps = performance.effectiveInputTokensPerSecond;
        const inputP50 = performance.medianInputTokensPerSecond;
        const inputP10 = performance.p10InputTokensPerSecond;
        const cacheHit = performance.cacheHitRate;
        console.log([
          `[opencode perf] run=${runId}`,
          `ttft=${performance.firstTtftMs ?? 'n/a'}ms`,
          `input_tps=${Number.isFinite(inputTps) ? inputTps.toFixed(1) : 'n/a'}`,
          `input_p50=${Number.isFinite(inputP50) ? inputP50.toFixed(1) : 'n/a'}`,
          `input_p10=${Number.isFinite(inputP10) ? inputP10.toFixed(1) : 'n/a'}`,
          `slow_steps=${Number(performance.requestsBelow2000TokensPerSecond) || 0}/${Number(performance.requestCount) || 0}`,
          `decode=${performance.decodeMs ?? 'n/a'}ms`,
          `output_tps=${Number.isFinite(outputTps) ? outputTps.toFixed(1) : 'n/a'}`,
          `visible_output_tps=${Number.isFinite(visibleOutputTps) ? visibleOutputTps.toFixed(1) : 'n/a'}`,
          `provider_output_tps=${Number.isFinite(providerOutputTps) ? providerOutputTps.toFixed(1) : 'n/a'}`,
          `cache_hit=${Number.isFinite(cacheHit) ? `${(cacheHit * 100).toFixed(1)}%` : 'n/a'}`,
          `events=${Number(performance.streamEvents) || 0}`,
          `first_desktop_action=${performance.firstDesktopActionMs ?? 'n/a'}ms`,
          `first_desktop_progress=${performance.firstDesktopProgressMs ?? 'n/a'}ms`,
          `desktop_recoveries=${Number(performance.desktopActionRecoveryCount) || 0}`
        ].join(' '));
      }
      // Close the throughput loop: learn the real prefill rate for this
      // (provider, model) pair and feed it to the next run. Works for any
      // vendor — nothing is model-specific here.
      try {
        if (isTrustworthyMeasurement(result?.performance)) {
          const measuredCfg = loadConfig();
          const key = measurementKey(selection?.providerId, selection?.modelId);
          if (key !== ':') {
            const store = measuredCfg.api.inputThroughput || {};
            const previousEntry = store[key] || {};
            const metric = result.performance.inputThroughputMetric;
            const sameMetric = previousEntry.metric === metric;
            store[key] = {
              tokensPerSecond: smoothMeasurement(
                sameMetric ? previousEntry.tokensPerSecond : 0,
                result.performance.effectiveInputTokensPerSecond
              ),
              samples: (sameMetric ? Number(previousEntry.samples) || 0 : 0) + 1,
              updatedAt: Date.now(),
              metric
            };
            measuredCfg.api.inputThroughput = normalizeMeasurementStore(store);
            saveConfig(measuredCfg);
          }
        }
      } catch (measurementError) {
        console.warn('[opencode] Input throughput measurement update failed:', measurementError?.message || measurementError);
      }
      await writeRunRollbackSnapshot({
        workspace,
        sessionId: zSessionId,
        runId,
        rollbackChanges: result?.rollbackChanges
      });
      flushOpenCodeRendererEvents(runId);
      const reviewSummary = summarizeOpenCodeDiffs(workspace, result?.changes, {
        includeDiff: true,
        startTime: runStartedAt
      });
      const { rollbackChanges: _rollbackChanges, ...rendererResult } = result || {};
      const completedResult = { ...rendererResult, reviewSummary };
      if (request.workMode === 'plan' && result?.status === 'done' && String(result.text || '').trim()) {
        try {
          const planFile = writePlanDocument({
            dataDir: STABLE_DATA_DIR,
            text: result.text,
            reasoning: result.reasoning
          });
          if (planFile) completedResult.planFile = planFile;
        } catch (planError) {
          console.warn('[plan] Failed to write plan document:', planError?.message || planError);
        }
      }
      completeOpenCodeReconcileRun(runId, completedResult);
      if (mainWindow && !mainWindow.isDestroyed() && mainRendererReady) {
        mainWindow.webContents.send('opencode:completed', { runId, result: completedResult });
      }
      if (!request.utility && ['done', 'error'].includes(result?.status) && result?.userRequestedFinish !== true) {
        void withOpenCodeBackgroundLease(() => reviewCompletedRunMemory({
          sidecar,
          selection,
          request,
          result,
          prompt,
          workspace,
          zSessionId,
          runId,
          harnessBaselines,
          evolutionMode
        }));
      }
    }).catch(error => {
      console.error(`[opencode] Run ${runId} failed:`, error);
      flushOpenCodeRendererEvents(runId);
      const failedResult = {
        openCodeVersion: OPENCODE_VERSION,
        status: 'error',
        text: '',
        reasoning: '',
        toolCalls: [],
        todos: [],
        changes: [],
        usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        contextTokens: 0,
        ...(error?.watchdog ? { watchdog: error.watchdog } : {}),
        error: openCodeErrorDetail(error)
      };
      if (coreTurnStarted) zCore.completeTurn(runId, failedResult);
      completeOpenCodeReconcileRun(runId, failedResult);
      if (mainWindow && !mainWindow.isDestroyed() && mainRendererReady) {
        mainWindow.webContents.send('opencode:completed', {
          runId,
          result: failedResult
        });
      }
    }).finally(() => {
      try { fs.rmSync(pendingHarnessRequestPath(runId), { force: true }); } catch {}
      removeHarnessRunContext(runId);
      releaseMediaWorkspace(runId);
      notifyBrowserAgentRelease(runId);
      clearBrowserAgentToolClaims(runId);
      clearSessionAgentToolClaims(runId);
      openCodeActiveRuns.delete(runId);
      refreshAgentRuntimeActivity();
    });
    return { ok: true, runId, version: OPENCODE_VERSION, workspace, workspaceKind };
  } catch (error) {
    const runId = String(request.runId || '');
    if (coreTurnStarted) zCore.completeTurn(runId, { status: 'error', error: openCodeErrorDetail(error) });
    if (admissionPending) openCodeRunAdmissions.delete(admittedRunId);
    removeHarnessRunContext(runId);
    releaseMediaWorkspace(runId);
    clearSessionAgentToolClaims(runId);
    openCodeActiveRuns.delete(runId);
    refreshAgentRuntimeActivity();
    console.error('[opencode] start-run failed:', error);
    return { ok: false, error: error instanceof Error && error.message ? error.message : openCodeErrorDetail(error), code: error?.code };
  }
});

ipcMain.handle('opencode:sync-active-runs', () => {
  const runs = [];
  for (const [runId, entry] of openCodeRunReconcile) {
    const active = openCodeActiveRuns.get(runId);
    if (!active && !entry.completed) continue; // stale entry without a run
    const replay = watchdogReplay(entry, { runId });
    runs.push({
      runId,
      zSessionId: String(active?.zSessionId || entry.meta.zSessionId || ''),
      workspace: String(active?.workspace || entry.meta.workspace || ''),
      startedAt: Number(active?.startedAt || entry.meta.startedAt) || 0,
      running: !!active,
      events: replay.events,
      completed: replay.completed,
      coreTurn: zCore.getTurn(runId)
    });
  }
  return runs;
});

ipcMain.handle('opencode:recover-runs', (_e, payload = {}) => {
  try {
    return buildRecoveredRunDescriptors(payload?.runIds);
  } catch (error) {
    console.warn('[opencode] recovery descriptor build failed:', error?.message || error);
    return [];
  }
});

// The renderer confirms a recovered run only after its replayed content is
// persisted into the session. Settling the Core Turn afterwards keeps the next
// startup from re-running recovery for the same Turn.
ipcMain.handle('z:core-settle-recovered-run', (_e, payload = {}) => {
  const runId = String(payload?.runId || '');
  if (!runId) return { ok: false, error: '缺少要结算的 Turn。' };
  try {
    if (!zCore) return { ok: false, error: 'Z 任务引擎尚未初始化。' };
    const text = String(payload?.text || '');
    const turn = zCore.completeTurn(runId, {
      status: 'interrupted',
      text,
      emptyFinalText: !text.trim()
    });
    return turn ? { ok: true, turn } : { ok: false, error: '任务回合不存在。' };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('z:core-state', (_e, payload = {}) => {
  try {
    return zCore.getState(payload && typeof payload === 'object' ? payload : {});
  } catch (error) {
    return { version: 1, threads: {}, turns: {}, intents: {}, events: [], error: error?.message || String(error) };
  }
});

ipcMain.handle('z:core-enqueue-intent', async (_e, payload = {}) => {
  const id = String(payload.threadId || '');
  if (sessionRewindOperations.has(id)) {
    return { ok: false, error: '对话正在回退或恢复，请稍后再发送。', code: 'SESSION_REWIND_BUSY' };
  }
  try {
    return await withSessionWrite(id, async () => {
      const stored = isSafeSessionId(id) ? await readSessionRecord(id, { sessionLocked: true }) : null;
      if (isSafeSessionId(id) && !stored) return { ok: false, error: '会话不存在。', code: 'session-not-found' };
      assertConversationRevision(stored, payload.conversationRevision);
      const existing = zCore.state?.intents?.[String(payload.intentId || '')];
      if (existing) {
        if (existing.threadId !== id) return { ok: false, error: '排队请求属于另一对话。', code: 'SESSION_REVISION_CHANGED' };
        assertConversationRevision(stored, existing.intent?.conversationRevision);
      }
      const intent = { ...(payload.intent || {}), conversationRevision: sessionConversationRevision(stored) };
      return { ok: true, intent: zCore.enqueueIntent({ ...payload, intent }) };
    });
  } catch (error) {
    return { ok: false, error: error?.message || String(error), code: error?.code };
  }
});

async function mutateSessionIntent(intentId, method) {
  const id = String(intentId || '');
  const record = zCore.state?.intents?.[id];
  if (!record) return { ok: false, error: '排队请求不存在或已处理。' };
  const threadId = String(record.threadId || '');
  if (sessionRewindOperations.has(threadId)) return { ok: false, error: '对话正在回退或恢复。', code: 'SESSION_REWIND_BUSY' };
  try {
    return await withSessionWrite(threadId, async () => {
      const stored = isSafeSessionId(threadId) ? await readSessionRecord(threadId, { sessionLocked: true }) : null;
      if (isSafeSessionId(threadId) && !stored) return { ok: false, error: '会话不存在。', code: 'session-not-found' };
      assertConversationRevision(stored, record.intent?.conversationRevision);
      const intent = zCore[method](id);
      return intent ? { ok: true, intent } : { ok: false, error: '排队请求不存在或已处理。' };
    });
  } catch (error) {
    return { ok: false, error: error?.message || String(error), code: error?.code };
  }
}

ipcMain.handle('z:core-consume-intent', (_e, intentId) => mutateSessionIntent(intentId, 'consumeIntent'));

ipcMain.handle('z:core-requeue-intent', (_e, intentId) => mutateSessionIntent(intentId, 'requeueIntent'));

ipcMain.handle('z:core-ack-intent', (_e, intentId) => {
  try {
    const intent = zCore.ackIntent(intentId);
    return intent ? { ok: true, intent } : { ok: false, error: '排队请求不存在或无法确认。' };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('z:core-delete-intent', (_e, payload = {}) => {
  try {
    return zCore.deleteIntent(payload?.intentId || payload?.id, payload?.reason);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('opencode:run-changes', async (_e, payload = {}) => {
  const runId = String(payload.runId || '');
  const active = openCodeActiveRuns.get(runId);
  if (!runId || !active || !openCodeSidecar) {
    return { count: 0, additions: 0, deletions: 0, files: [] };
  }
  try {
    const diffs = await openCodeSidecar.runChanges(runId, { includeDiff: payload.includeDiff, paths: payload.paths });
    return await runReviewTask('openCodeDiffs', active.workspace, diffs, {
      includeDiff: payload.includeDiff !== false,
      documentPath: payload.documentPath,
      paths: payload.paths,
      startTime: active.startedAt
    });
  } catch (error) {
    return { count: 0, additions: 0, deletions: 0, files: [], error: error?.message || String(error) };
  }
});

ipcMain.handle('opencode:session-changes', async (_e, payload = {}) => {
  const zSessionId = String(payload.zSessionId || '');
  const runId = String(payload.runId || '');
  if (!zSessionId || !runId) {
    return { count: 0, additions: 0, deletions: 0, files: [] };
  }
  try {
    const session = await readSessionRecord(zSessionId);
    const workspace = workspaceSandbox.normalizeWorkspace(session?.workspace);
    const agentRun = (session?.messages || [])
      .find(message => message?.role === 'assistant' && message?.agentRun?.runId === runId)
      ?.agentRun;
    if (workspace && agentRun && payload.includeDiff === false && !payload.documentPath && payload.fresh !== true) {
      const manifest = projectReviewSummary(agentRun.changeSummary, { paths: payload.paths });
      if (manifest) return manifest;
    }
    if (!workspace || !agentRun?.openCodeSessionId) {
      return { count: 0, additions: 0, deletions: 0, files: [] };
    }
    return await withOpenCodeBackgroundLease(async () => {
      const sidecar = await ensureOpenCodeSidecar(getOpenCodeRuntimeConfig(loadConfig()));
      const diffs = await sidecar.sessionChanges({
        sessionId: agentRun.openCodeSessionId,
        directory: workspace,
        startTime: agentRun.startedAt,
        endTime: agentRun.completedAt || undefined,
        includeDiff: payload.includeDiff,
        paths: payload.paths
      });
      return runReviewTask('openCodeDiffs', workspace, diffs, {
        includeDiff: payload.includeDiff !== false,
        documentPath: payload.documentPath,
        paths: payload.paths,
        startTime: agentRun.startedAt
      });
    });
  } catch (error) {
    return { count: 0, additions: 0, deletions: 0, files: [], error: error?.message || String(error) };
  }
});

async function cancelOpenCodeRun(runId) {
  const key = String(runId || '');
  const coreResult = zCore.requestCancel(key, 'user_cancelled');
  const active = openCodeActiveRuns.get(key);
  const visionCancelled = !!active?.visionAbortController;
  active?.visionAbortController?.abort();
  let sidecarResult = { ok: false, error: '' };
  if (openCodeSidecar) {
    try {
      const result = await getOpenCodeProviderAdapter(openCodeSidecar).cancel(key);
      sidecarResult = {
        ok: result?.ok === true,
        error: result?.error ? String(result.error) : '',
        pending: result?.pending === true
      };
    } catch (error) {
      sidecarResult = { ok: false, error: error?.message || String(error) };
    }
  }
  const cancelRequested = visionCancelled || sidecarResult.ok || coreResult.cancelled === true;
  const sidecarLive = !!openCodeSidecar?.hasRun?.(key)
    || !!openCodeSidecar?.hasPendingRun?.(key);
  const mainRunLive = openCodeActiveRuns.has(key) || openCodeRunAdmissions.has(key);
  const settled = !mainRunLive && !sidecarLive && (
    !active || coreResult.alreadySettled === true || coreResult.cancelled === false
  );
  const cancelled = settled;
  if (cancelRequested) notifyBrowserAgentRelease(key, 'run_cancelled');
  return {
    ok: cancelRequested,
    cancelRequested,
    cancelled,
    settled,
    error: cancelRequested ? '' : (sidecarResult.error || coreResult.error || 'Z 任务不存在'),
    coreTurn: coreResult.turn || zCore.getTurn(key)
  };
}

const openCodeSteeringRequests = new Map();

function steerOpenCodeRun(payload = {}) {
  const runId = String(payload.runId || '').trim();
  const zSessionId = String(payload.zSessionId || '').trim();
  const requestId = String(payload.requestId || '').trim();
  const text = String(payload.text || '').trim();
  const identity = { runId, zSessionId, requestId };
  const failure = (error, code = 'STEERING_UNAVAILABLE') => ({ ...identity, ok: false, delivered: false, error, code });
  if (!runId || !zSessionId || !requestId || !text) {
    return Promise.resolve(failure('缺少任务、会话、消息 ID 或引导内容。', 'INVALID_STEERING_REQUEST'));
  }
  const key = JSON.stringify([runId, zSessionId, requestId]);
  const fingerprint = crypto.createHash('sha256').update(text).digest('hex');
  const previous = openCodeSteeringRequests.get(key);
  if (previous) {
    return previous.fingerprint === fingerprint ? previous.promise
      : Promise.resolve(failure('同一消息 ID 不能发送不同的引导内容。', 'STEERING_REQUEST_CONFLICT'));
  }
  const active = openCodeActiveRuns.get(runId);
  const sidecar = openCodeSidecar;
  if (!active || !sidecar) return Promise.resolve(failure('当前任务已经结束，引导未送达。', 'STEERING_STALE'));
  if (String(active.zSessionId || '') !== zSessionId) {
    return Promise.resolve(failure('该运行不属于当前会话，引导未送达。', 'STEERING_SESSION_MISMATCH'));
  }
  const isLive = () => openCodeActiveRuns.get(runId) === active && openCodeSidecar === sidecar
    && !active.cancelRequested && !active.visionAbortController?.signal?.aborted && sidecar.hasRun(runId);
  // Install the promise before the first delivery, so concurrent retries
  // share a single direct injection instead of calling an auxiliary model.
  const promise = Promise.resolve().then(async () => {
    if (!isLive()) return failure('当前任务已结束或正在停止，引导未送达。', 'STEERING_STALE');
    try {
      const delivery = await sidecar.deliverInterjection(runId, {
        kind: 'guidance', guidance: text, requestId, requestFinish: false, hardCancel: false, source: 'user'
      });
      if (delivery?.ok !== true || delivery.accepted !== true) {
        return failure(delivery?.error || '内核未确认收到引导。', 'STEERING_DELIVERY_FAILED');
      }
      const delivered = delivery.delivered === true && delivery.deliveryEvidence === 'provider-response';
      if (!isLive() && !delivered) return failure('引导发送期间任务已结束或停止，未确认送达。', 'STEERING_STALE');
      return { ...identity, ok: true, accepted: true, delivered,
        deliveredAt: delivery.deliveredAt, deliveryEvidence: delivery.deliveryEvidence,
        version: delivery.version, phase: delivery.phase };
    } catch (error) {
      return failure(error?.message || String(error), 'STEERING_DELIVERY_FAILED');
    }
  });
  openCodeSteeringRequests.set(key, { runId, fingerprint, promise });
  // Retain every live run's receipt. Old completed-run receipts can expire
  // without allowing reinjection, since a completed run fails the live check.
  if (openCodeSteeringRequests.size > 512) {
    for (const [oldKey, entry] of openCodeSteeringRequests) {
      if (openCodeSteeringRequests.size <= 512) break;
      if (!openCodeActiveRuns.has(entry.runId)) openCodeSteeringRequests.delete(oldKey);
    }
  }
  return promise;
}

ipcMain.handle('opencode:steer-run', (_event, payload = {}) => steerOpenCodeRun(payload));

ipcMain.handle('opencode:interject', async (event, payload = {}) => {
  const runId = String(payload.runId || '');
  const requestId = String(payload.requestId || '');
  const text = String(payload.text || '').trim();
  const active = openCodeActiveRuns.get(runId);
  if (!runId || !text) return { ok: false, error: '辅助对话内容不能为空。' };
  if (!active || !openCodeSidecar) return { ok: false, error: '当前任务已经结束。' };
  const emitAuxiliaryEvent = auxiliaryEvent => {
    if (!event.sender || event.sender.isDestroyed()) return;
    event.sender.send('opencode:interjection-event', {
      runId,
      requestId,
      event: auxiliaryEvent
    });
  };
  try {
    const analysis = await openCodeSidecar.analyzeInterjection({
      runId,
      requestId,
      text,
      history: Array.isArray(payload.history) ? payload.history : [],
      snapshot: payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : {}
    }, emitAuxiliaryEvent);
    if (openCodeActiveRuns.get(runId) !== active || !openCodeSidecar.hasRun(runId)) {
      return { ok: false, stale: true, error: '判断完成前任务已经结束，辅助对话消息未送达。' };
    }
    if (analysis.kind === 'check') {
      return { ok: true, ...analysis, delivered: false };
    }
    if (analysis.hardCancel) {
      const cancelled = await cancelOpenCodeRun(runId);
      return {
        ok: cancelled.ok,
        ...analysis,
        delivered: false,
        hardCancelled: cancelled.cancelled,
        error: cancelled.error
      };
    }
    const delivery = await openCodeSidecar.deliverInterjection(runId, analysis);
    return {
      ok: delivery.ok,
      ...analysis,
      ...delivery,
      reply: analysis.reply
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('opencode:cancel-interjection', async (_e, payload = {}) => {
  const runId = String(payload.runId || '');
  const requestId = String(payload.requestId || '');
  if (!runId || !openCodeSidecar) return { ok: false, error: '辅助对话不存在。' };
  try {
    return await openCodeSidecar.cancelInterjection(runId, requestId);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('plan:read-file', async (_e, payload = {}) => {
  try {
    const root = plansRoot(STABLE_DATA_DIR);
    const target = path.resolve(String(payload?.path || ''));
    if (!target.startsWith(root + path.sep)) return { ok: false, error: '计划文件不在 Z 的计划目录内。' };
    const content = fs.readFileSync(target, 'utf8');
    return { ok: true, name: path.basename(target), content };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('plan:download-file', async (_e, payload = {}) => {
  try {
    const root = plansRoot(STABLE_DATA_DIR);
    const target = path.resolve(String(payload?.path || ''));
    if (!target.startsWith(root + path.sep)) return { error: '计划文件不在 Z 的计划目录内。' };
    const stat = await fsp.stat(target);
    if (!stat.isFile() || !stat.size) return { error: '计划文件不存在或为空。' };
    const owner = BrowserWindow.fromWebContents(_e.sender);
    const result = await dialog.showSaveDialog(owner && !owner.isDestroyed() ? owner : mainWindow, {
      title: '下载计划文件',
      buttonLabel: '下载',
      defaultPath: path.join(app.getPath('downloads'), path.basename(target)),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await fsp.copyFile(target, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { error: error?.message || String(error) };
  }
});

ipcMain.handle('opencode:cancel-run', async (_e, runId) => {
  return cancelOpenCodeRun(runId);
});

ipcMain.handle('opencode:permission-reply', async (_e, payload = {}) => {
  if (!openCodeSidecar) return { ok: false, error: 'Z 内核尚未运行' };
  try {
    return await openCodeSidecar.replyPermission(payload);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('opencode:classify-shell-command', (_e, command) => {
  return classifyDelegatedShellCommand(command);
});

ipcMain.handle('opencode:question-reply', async (_e, payload = {}) => {
  if (!openCodeSidecar) return { ok: false, error: 'Z 内核尚未运行' };
  try {
    return await openCodeSidecar.replyQuestion(payload);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = process.env.Z_E2E_MODE === '1'
  ? true
  : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // A normal second launch must always surface the existing app. The
    // process survives window close (tray/pet keep-alive), so the main window
    // may not exist anymore — recreate it instead of only focusing, otherwise
    // the second launch looks exactly like a failed npm start.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    focusMainWindow();
  });
}

app.whenReady().then(async () => {
  if (e2eOrphanShutdownStarted) return;
  app.setAppUserModelId('io.github.zyfyz666.z');
  // The Chromium spellchecker re-segments a contenteditable on every edit and
  // is a constant per-keystroke cost under CJK IME input — the composer's
  // typing lag. The app is Chinese-first; disable it at the session level.
  try { session.defaultSession.setSpellCheckerEnabled(false); } catch {}
  createSplashWindow();
  await migrateLegacyDataDir();
  ensureDirs();
  initializeZCore();
  try {
    const recoveredTurns = zCore.recoverInterruptedTurns();
    if (recoveredTurns.length) {
      console.warn(`[z-core] recovered ${recoveredTurns.length} interrupted Turn(s) from the previous process.`);
    }
  } catch (error) {
    console.warn('[z-core] startup recovery failed:', error?.message || error);
  }
  await refreshBrowserNetworkSession('https://example.com', { resetConnections: false })
    .catch(error => console.warn(`[browser network] setup failed: ${error.message}`));
  loadGeneratedImageStore();
  const cfg = loadConfig();
  skillRegistry.hydrateInstalledSkillMetadata(cfg, appRoot, dataDir);
  skillRegistry.syncZUserSkills(cfg, appRoot, dataDir);
  const skillStoreResult = skillRegistry.syncSkillStore(cfg, appRoot, dataDir);
  if (!skillStoreResult.ok) console.warn(`[SkillStore] ${skillStoreResult.error}`);
  saveConfig(cfg);
  try {
    await startBrowserAgentBridge();
    if (e2eOrphanShutdownStarted) return;
    await startSessionAgentBridge();
    if (e2eOrphanShutdownStarted) return;
  } catch (error) {
    if (e2eOrphanShutdownStarted) return;
    const message = error && error.message ? error.message : String(error);
    destroySplashWindow();
    dialog.showErrorBox('Z 内核启动失败', `Z 内核无法启动。\n\n${message}`);
    app.quit();
    return;
  }
  startZSkillWatcher();
  startWorkspaceWatcher(cfg.workspace);
  createWindow();
  applyLightWindowIcon(mainWindow);
  refreshConfiguredProviderModelCache('agnes')
    .catch(error => console.warn(`[Agnes models] background refresh failed: ${error.message}`));
  if (process.env.Z_E2E_MODE !== '1') {
    activePetId = cfg.pet.selected;
    if (cfg.pet.enabled) createPetWindow();
    createTray();
    const quickLaunchRegistration = registerQuickInputShortcut(cfg.quickLaunch);
    if (!quickLaunchRegistration.ok) {
      console.warn(`[quick-input] startup registration failed: ${quickLaunchRegistration.error}`);
    }
  }
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else focusMainWindow();
  });
});

// 有托盘保活时，所有窗口关闭不退出应用
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// 真正退出时清理托盘和 MCP 服务器
app.on('before-quit', () => {
  isQuiting = true;
  if (e2eParentWatchdog) {
    clearInterval(e2eParentWatchdog);
    e2eParentWatchdog = null;
  }
  openCodeEventBatcher.close();
  // Flush a debounced Core snapshot before the process exits.
  try { zCore?.persist?.(); } catch {}
  // Give a pending event-log compaction a chance to finish during shutdown.
  // Best effort: the process may exit before the promise resolves, in which
  // case the bounded log is simply compacted on the next launch.
  try { zCore?.store?.flushCompaction?.()?.catch?.(() => {}); } catch {}
  if (openCodeIdleReleaseTimer) clearTimeout(openCodeIdleReleaseTimer);
  openCodeIdleReleaseTimer = null;
  destroySplashWindow();
  unregisterQuickInputShortcut();
  destroyQuickInputWindows();
  for (const request of activeImageGenerations.values()) request.controller.abort();
  activeImageGenerations.clear();
  closeGeneratedImageViewers();
  stopWorkspaceWatcher();
  stopZSkillWatcher();
  stopBrowserAgentBridge();
  stopSessionAgentBridge();
  understandAnythingRuntime.stopAllUnderstandAnything();
  openCodeSidecar?.close();
  openCodeSidecar = null;
  openCodeProviderAdapter = null;
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  if (tray) tray.destroy();
  // 停止所有 MCP 服务器
  for (const id of mcpServers.keys()) mcpStop(id);
});

// Test-only exports: loaded under a stubbed Electron (see
// test/opencode-config-signature.test.cjs) to verify that per-run values
// never leak into the OpenCode config signature.
if (process.env.Z_MAIN_TEST_EXPORTS === '1') {
  module.exports = {
    __test: {
      getOpenCodeMcpServers,
      getOpenCodeRuntimeConfig,
      buildZMediaMcpServer,
      buildZWebMcpServer,
      inferMcpTaskCapabilities,
      applyReviewedHarnessState,
      persistExplicitUserPolicy,
      reviewCompletedRunMemory,
      attributeHarnessUsage,
      consumeHarnessUsage,
      harnessRunOutcome,
      registerHarnessUsage,
      continualHarness,
      buildRecoveredRunDescriptors,
      recoveryRendererEvent,
      recoveringCoreTurns,
      migrateVisionRelaySwitch
    }
  };
}
