'use strict';

// Z adapter for thrash-watchdog (vendored in ./vendor/thrash-watchdog; do not
// edit the vendored files). The only Z-specific part is verification: Z's
// own command classification and exit parsing decide what counts as a check.
// Intervention reuses the sidecar's runtime interjection channel.

const { Watchdog, CRITERIA_SHA256 } = require('./vendor/thrash-watchdog');
const { appendAudit, verifyChain } = require('./vendor/thrash-watchdog/audit');
const { fromOpencodeMessages } = require('./vendor/thrash-watchdog/extract');
const { verificationRecord } = require('./verification-state');

const CHECK_KINDS = new Set(['test', 'lint', 'build', 'types', 'syntax']);

// 'passed' | 'failed' for a Z check, null for a command Z knows is not a
// check, undefined to let the vendored classifier decide.
function zClassify(part) {
  const rec = verificationRecord(part);
  if (!rec) return undefined;
  if (!CHECK_KINDS.has(rec.kind)) return null;
  return rec.status === 'passed' ? 'passed' : rec.status === 'failed' ? 'failed' : null;
}

function stepsFromMessages(messages) {
  return fromOpencodeMessages(messages, { classify: zClassify });
}

// One watcher per run. `observe(messages)` returns a decision when the watchdog
// should speak, else null; call it as often as you like (it judges every N actions).
function createThrashWatch({ goal = '', judgeEvery, allowHalt = false, traceId = '' } = {}) {
  const wd = new Watchdog({ goal, judgeEvery, allowHalt, traceId });
  let observedSteps = 0;
  let checks = 0;
  return {
    observe: messages => {
      const steps = stepsFromMessages(messages);
      const previousJudged = wd.state.judged;
      const d = wd.observe(steps);
      observedSteps = steps.length;
      // judged is an action index, not a check count. A check that returns no
      // intervention still advances it; repeated polling does not.
      if (wd.state.judged > 0 && wd.state.judged !== previousJudged) checks += 1;
      return d ? { ...d, step: steps.length } : null;
    },
    get state() { return wd.state; },
    get telemetry() {
      return { judgeEvery: wd.judgeEvery, observedSteps, judgedSteps: wd.state.judged,
        checks, streak: wd.state.streak };
    }
  };
}

function thrashGuidance(d) {
  return [
    `WD THRASH WATCHDOG (${d.action})`,
    d.message,
    'Apply this to the remaining work now. Preserve verified work already completed and do not repeat it without a concrete reason. If you believe the verdict is wrong, state why in one line and continue with evidence.',
    d.marker
  ].filter(Boolean).join('\n');
}

module.exports = {
  CRITERIA_SHA256, createThrashWatch, stepsFromMessages, thrashGuidance, appendAudit, verifyChain
};
