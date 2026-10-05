'use strict';

// A read-only projection of WD activity. It neither runs the detector nor
// changes its decisions; snapshots can safely cross IPC and be persisted.
const MAX_EVENTS = 30;
const counter = value => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
function plainText(value, limit = 2000) {
  try { return String(value ?? '').slice(0, limit); } catch { return ''; }
}
const ruleList = value => (Array.isArray(value) ? value : []).map(item => plainText(item, 100)).filter(Boolean).slice(0, 20);

class WDMonitorState {
  constructor({ enabled = true, judgeEvery = 6, now = Date.now } = {}) {
    this.now = now;
    this.sequence = 0;
    this.lastModelDecisionCheck = 0;
    this.value = {
      enabled: enabled === true,
      phase: enabled === true ? 'waiting' : 'disabled',
      judgeEvery: Math.max(1, counter(judgeEvery)),
      observedSteps: 0,
      judgedSteps: 0,
      checks: 0,
      interventions: 0,
      observations: 0,
      streak: 0,
      updatedAt: counter(this.now()),
      events: [],
      health: null,
      healthEvents: []
    };
  }

  snapshot() {
    return { ...this.value, ...(this.value.model ? { model: { ...this.value.model } } : {}),
      health: this.value.health ? this.copyHealth(this.value.health) : null,
      healthEvents: this.value.healthEvents.map(event => ({ ...event, ...(event.tool ? { tool: { ...event.tool } } : {}) })),
      events: this.value.events.map(event => ({
      ...event, rules: [...event.rules], advisories: [...event.advisories]
    })) };
  }

  copyHealth(value) {
    return { ...value, ...(value.tool ? { tool: { ...value.tool } } : {}) };
  }

  healthStatus(value) {
    if (!value || !['working', 'waiting_user', 'overdue', 'unknown', 'silent', 'completed'].includes(value.state)) return false;
    const previous = this.value.health;
    if (previous && (previous.state === 'completed' || counter(value.checkedAt) < previous.checkedAt)) return false;
    const health = {
      state: value.state, checkedAt: counter(value.checkedAt), lastProgressAt: counter(value.lastProgressAt),
      message: plainText(value.message), waitingPermissions: counter(value.waitingPermissions),
      waitingQuestions: counter(value.waitingQuestions)
    };
    if (value.tool && typeof value.tool === 'object') health.tool = {
      callId: plainText(value.tool.callId, 300), name: plainText(value.tool.name, 200),
      status: plainText(value.tool.status, 40), startedAt: counter(value.tool.startedAt),
      timeoutMs: counter(value.tool.timeoutMs), deadlineAt: counter(value.tool.deadlineAt),
      lastProgressAt: counter(value.tool.lastProgressAt)
    };
    const key = item => JSON.stringify([item?.state, item?.message, item?.waitingPermissions,
      item?.waitingQuestions, item?.tool?.callId, item?.tool?.status, item?.tool?.deadlineAt]);
    if (key(previous) !== key(health)) {
      this.value.healthEvents.push({ id: `health-${++this.sequence}`, ts: health.checkedAt, ...this.copyHealth(health) });
      this.value.healthEvents = this.value.healthEvents.slice(-MAX_EVENTS);
    }
    const changed = JSON.stringify(previous) !== JSON.stringify(health);
    this.value.health = health;
    this.value.updatedAt = Math.max(this.value.updatedAt, health.checkedAt);
    return changed;
  }

  modelStatus(value) {
    this.value.model = { name: plainText(value.name, 150), modelId: plainText(value.modelId, 200),
      phase: plainText(value.phase, 30), checks: counter(value.checks),
      message: plainText(value.message, 1200), error: plainText(value.error, 200) };
    const decision = value.lastDecision;
    const check = counter(decision?.check);
    if (check > this.lastModelDecisionCheck && check === counter(value.checks)
      && ['observe', 'remind'].includes(decision?.action)) {
      this.lastModelDecisionCheck = check;
      // Confirmed reminders are already recorded by onGuidance. An observe
      // judgment is history only and must not increase intervention counts.
      if (decision.action === 'observe') this.decision({ ...decision, rules: ['model_observer'], advisories: [] });
    }
    this.value.updatedAt = counter(this.now());
  }

  observe(observation = {}) {
    if (!this.value.enabled) return false;
    let changed = false;
    for (const field of ['observedSteps', 'judgedSteps', 'checks', 'streak']) {
      if (observation[field] === undefined) continue;
      const next = counter(observation[field]);
      if (this.value[field] !== next) {
        this.value[field] = next;
        changed = true;
      }
    }
    if (this.value.phase === 'waiting' && this.value.observedSteps > 0) {
      this.value.phase = 'observing';
      changed = true;
    }
    if (changed) this.value.updatedAt = counter(this.now());
    return changed;
  }

  decision(verdict = {}) {
    if (!this.value.enabled) return null;
    const observationOnly = verdict.action === 'observe';
    const event = {
      id: `wd-${++this.sequence}`,
      ts: verdict.ts == null ? counter(this.now()) : counter(verdict.ts),
      step: counter(verdict.step),
      action: plainText(verdict.action, 40),
      rules: ruleList(verdict.rules),
      advisories: ruleList(verdict.advisories),
      severity: counter(verdict.severity),
      message: plainText(verdict.message),
      delivery: observationOnly ? 'not-needed' : 'pending'
    };
    this.value.events.push(event);
    this.value.events = this.value.events.slice(-MAX_EVENTS);
    if (observationOnly) this.value.observations += 1;
    else {
      this.value.interventions += 1;
      this.value.streak = counter(verdict.streak);
    }
    this.value.updatedAt = event.ts;
    return event.id;
  }

  delivery(id, result, error) {
    const event = this.value.events.find(item => item.id === id);
    if (!event || event.action === 'observe') return false;
    // Request acceptance alone is not delivery. A queue acknowledgement is
    // kept distinct from confirmation that the guidance reached the kernel.
    const delivery = !error && result?.ok !== false && result?.delivered === true
      ? 'delivered'
      : !error && result?.ok !== false && result?.queued === true ? 'queued' : 'failed';
    const deliveryError = delivery === 'failed'
      ? plainText(error?.message || error || result?.error || '未收到提醒送达确认。', 500)
      : '';
    if (event.delivery === delivery && (event.deliveryError || '') === deliveryError) return false;
    event.delivery = delivery;
    if (deliveryError) event.deliveryError = deliveryError;
    else delete event.deliveryError;
    this.value.updatedAt = counter(this.now());
    return true;
  }

  stop(outcome = 'completed') {
    if (!this.value.enabled) return false;
    const phase = outcome === 'error' || this.value.phase === 'error' ? 'error' : 'completed';
    if (this.value.phase === phase && this.value.outcome === outcome) return false;
    this.value.phase = phase;
    // The phase says that monitoring stopped; outcome distinguishes a user
    // interruption from successful completion without inventing a sixth phase.
    this.value.outcome = ['completed', 'interrupted', 'error'].includes(outcome) ? outcome : 'completed';
    this.value.updatedAt = counter(this.now());
    return true;
  }

  fail() {
    if (!this.value.enabled || this.value.phase === 'error') return false;
    this.value.phase = 'error';
    this.value.updatedAt = counter(this.now());
    return true;
  }
}

module.exports = { MAX_EVENTS, WDMonitorState };
