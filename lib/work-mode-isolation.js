'use strict';
const { readCompatibleField } = require('./legacy-compat');

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
  return readCompatibleField(session?.metadata, 'zModeIsolation') === 1
    && readCompatibleField(session?.metadata, 'zWorkMode') === String(request.workMode || 'normal');
}
module.exports = { agiEnabled, evolutionEnabled, isolateWorkMode, sessionModeMatches };
