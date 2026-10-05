'use strict';

function agiEnabled(request = {}) {
  return request.workMode === 'agi' && !request.utility && !request.skillOnly;
}
function evolutionEnabled(request = {}) {
  return ['agi', 'evolution'].includes(request.workMode) && !request.utility && !request.skillOnly;
}
function isolateWorkMode(request = {}) {
  const result = { ...request };
  if (!agiEnabled(result)) {
    for (const key of ['reasoningSidepath', 'sidepathState', 'artifactAuditState', 'escalation',
      'longHorizonContext', 'experienceEdgeContext', 'topologyVariantId']) delete result[key];
  }
  if (!evolutionEnabled(result)) {
    result.harnessContext = '';
    result.behaviorPolicies = [];
  }
  return result;
}
function sessionModeMatches(session, request) {
  // Legacy normal sessions also contained AGI instructions: recreate once.
  const metadata = session?.metadata || {};
  return Object.prototype.hasOwnProperty.call(metadata, 'zModeIsolation') && metadata.zModeIsolation === 1
    && Object.prototype.hasOwnProperty.call(metadata, 'zWorkMode') && metadata.zWorkMode === String(request.workMode || 'normal');
}
module.exports = { agiEnabled, evolutionEnabled, isolateWorkMode, sessionModeMatches };
