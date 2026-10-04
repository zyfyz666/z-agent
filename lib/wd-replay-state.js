'use strict';

const STATUS_EVENT = 'z.thrash.watchdog.status';
const DECISION_EVENT = 'z.thrash.watchdog';
const PHASES = new Set(['waiting', 'observing', 'disabled', 'completed', 'error']);
const COUNTERS = ['judgeEvery', 'observedSteps', 'judgedSteps', 'checks', 'interventions', 'streak', 'updatedAt'];

const isWatchdogEvent = event => event?.type === STATUS_EVENT || event?.type === DECISION_EVENT;
const belongsToRun = (event, runId) => !runId || !event?.data?.runID || String(event.data.runID) === String(runId);

function completeStatus(event, runId) {
  const data = event?.data;
  if (event?.type !== STATUS_EVENT || !belongsToRun(event, runId)
    || !data || typeof data.enabled !== 'boolean' || !PHASES.has(data.phase)
    || !Array.isArray(data.events)
    || COUNTERS.some(key => typeof data[key] !== 'number' || !Number.isFinite(data[key]))) return null;
  try {
    return JSON.parse(JSON.stringify({ type: STATUS_EVENT, data }));
  } catch { return null; }
}

// The general replay ring is intentionally small. Pin one full WD snapshot
// outside it, because a long reasoning/text stream can evict hundreds of events
// without producing a new action (and therefore without a fresh WD status).
function recordReconcileEvent(entry, event, { runId = '', cap = 400 } = {}) {
  if (!entry || (isWatchdogEvent(event) && !belongsToRun(event, runId))) return;
  // Delivery proof must outlive long streams and renderer crashes. Keep the
  // latest receipt per user instruction independently of the text-event ring.
  if (event?.type === 'z.guidance.status' && event.data?.requestId) {
    entry.guidanceStatuses ||= {};
    const previous = entry.guidanceStatuses[event.data.requestId];
    if (previous?.data?.deliveryEvidence !== 'provider-response') {
      entry.guidanceStatuses[event.data.requestId] = JSON.parse(JSON.stringify(event));
    }
  }
  const status = completeStatus(event, runId);
  if (status && (!entry.watchdogStatus || status.data.updatedAt >= entry.watchdogStatus.data.updatedAt)) {
    entry.watchdogStatus = status;
  }
  // A delivery acknowledgement can arrive after cancellation has settled the
  // run. Retain its status without reopening or appending to the completed ring.
  if (entry.completed) return;
  entry.events ||= [];
  entry.events.push(event);
  const limit = Number.isFinite(Number(cap)) ? Math.max(1, Math.trunc(Number(cap))) : 400;
  if (entry.events.length > limit) entry.events.splice(0, entry.events.length - limit);
}

function watchdogReplay(entry, { runId = '' } = {}) {
  const completed = entry?.completed || null;
  const saved = completeStatus(entry?.watchdogStatus, runId);
  const resultStatus = completed?.watchdog ? completeStatus({ type: STATUS_EVENT, data: {
    ...completed.watchdog,
    runID: runId,
    sessionID: completed.openCodeSessionId || ''
  } }, runId) : null;
  // On equal timestamps, the most recently received status is preferable to
  // the earlier point-in-time result (delivery may have resolved in between).
  const latest = !saved || (resultStatus && resultStatus.data.updatedAt > saved.data.updatedAt) ? resultStatus : saved;
  const receipts = Object.values(entry?.guidanceStatuses || {});
  const tail = [...receipts, ...(Array.isArray(entry?.events) ? entry.events : [])
    .filter(event => (event?.type !== 'z.guidance.status' || !receipts.length)
      && (!isWatchdogEvent(event) || (belongsToRun(event, runId) && !latest)))];
  if (!latest) return { events: tail, completed };

  // A timestamp can be shared by pending and delivered updates. Do not replay
  // older WD snapshots/legacy decisions after the authoritative prefix, even
  // at the same millisecond; the other event types keep their original order.
  const { runID: _runID, sessionID: _sessionID, ...watchdog } = latest.data;
  return {
    events: [latest, ...tail],
    completed: completed ? { ...completed, watchdog } : null
  };
}

module.exports = { recordReconcileEvent, watchdogReplay };
