'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { combineSystem } = require('../lib/opencode-sidecar');

test('English runs carry a user-facing English response contract', () => {
  const system = combineSystem({ language: 'en', providerId: 'test', modelId: 'test' });
  assert.match(system, /Z interface language is English/i);
  assert.match(system, /every user-facing response[\s\S]*in English/i);
  assert.match(system, /Do not output Chinese/i);
});

test('Chinese runs do not add the English-only response contract', () => {
  const system = combineSystem({ language: 'zh-CN', providerId: 'test', modelId: 'test' });
  assert.doesNotMatch(system, /interface language is English/i);
});

test('Z product identity preserves the actual model and execution architecture', () => {
  const system = combineSystem({ providerId: 'test-provider', modelId: 'test-model' });
  assert.match(system, /You are the test-model model from test-provider, serving as the current text model inside Z\./);
  assert.match(system, /product\/runtime identity \(Z \/ Z runtime\) and actual model identity \(provider\/model\)/);
  assert.match(system, /Z is a desktop agent built on an OpenCode-based execution runtime\./);
  assert.match(system, /Explain the execution architecture when the user asks about it\./);
  assert.doesNotMatch(system, /Z Kernel|current text model inside Z Agent/);
  assert.match(system, /Do not claim a model, Skill, MCP, browser action, media result, permission, workspace, or verification that is not available in this run/);
});
