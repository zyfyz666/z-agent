'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const {
  OpenCodeSidecar, buildOpenCodeConfig, stageCodingEnvironmentModule,
  isPermissionAskedEvent, permissionNameFromEvent, permissionRequestID
} = require('../lib/opencode-sidecar');

// Exercise the real bundled kernel and coding plugin, using an isolated data
// directory and one localhost model fixture. No user credentials are loaded.
process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryRoot, 'z-external-directory-kernel-'));
const workspace = path.join(root, 'Task workspace with spaces');
const externalProject = path.join(root, 'External project with spaces');
const dataDir = path.join(root, 'Isolated kernel data');
const providerId = 'external-directory-fixture';
const modelId = 'external-directory-model';
const original = 'EXTERNAL_PRIVATE_CONTENT_4197\npending line\n';
const cases = [];
const errors = [];
const modelRequests = [];
const permissionReplies = [];
const seenPermissions = new Set();
const writeTools = ['apply_patch', 'edit', 'write'];
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(externalProject, { recursive: true });
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'LOCAL_PLUGIN_RULE_4197: keep the task folder separate from the requested external project.\n');

function fixtureCase(name, options = {}) {
  const file = path.join(externalProject, `${name}.txt`);
  const item = { name, marker: `EXTERNAL_CASE_${name}_4197`, file, accessMode: 'full',
    workMode: 'normal', allowFileWrite: true, requests: 0, permissions: [], ...options };
  if (!item.newFile) fs.writeFileSync(file, original);
  cases.push(item);
  return item;
}

fixtureCase('full');
fixtureCase('approved', { accessMode: 'request' });
fixtureCase('reject_read', { accessMode: 'request', rejectExternal: true });
fixtureCase('reject_write', { accessMode: 'request', rejectExternal: true, newFile: true });
fixtureCase('plan', { workMode: 'plan', writesUnavailable: true });
fixtureCase('write_deny', { allowFileWrite: false, writesUnavailable: true });

function completion(response, message) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const payload = { id: 'external-directory-fixture', object: 'chat.completion.chunk', model: modelId,
    choices: [{ index: 0, delta: { role: 'assistant', ...message }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  payload.choices = [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }];
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function actionsFor(item) {
  if (item.name === 'reject_read' || item.writesUnavailable) return [['read', { filePath: item.file }]];
  if (item.name === 'reject_write') return [['write', { filePath: item.file, content: 'MUST_NOT_BE_WRITTEN\n' }]];
  const actions = [
    ['read', { filePath: item.file }],
    ['edit', { filePath: item.file, oldString: 'pending line', newString: 'edited line' }]
  ];
  if (item.name === 'full') actions.push(['apply_patch', {
    patchText: `*** Begin Patch\n*** Update File: ${item.file.replaceAll('\\', '/')}\n@@\n-edited line\n+patched line\n*** End Patch`
  }]);
  actions.push(['read', { filePath: item.file }]);
  return actions;
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(raw || '{}');
      assert.equal(body.model, modelId, 'all model work stays on the localhost fixture');
      modelRequests.push(body.model);
      assert.ok(modelRequests.length <= 48, 'the fixture must not enter an unbounded follow-up loop');
      const messages = body.messages || [];
      const lastUser = messages.findLastIndex(message => message.role === 'user');
      const prompt = JSON.stringify(messages[lastUser]?.content || '');
      const item = cases.find(candidate => prompt.includes(candidate.marker));
      if (!item || !body.tools?.length) return completion(response, { content: 'External project access test' });
      item.requests++;
      const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
      assert.match(system, /LOCAL_PLUGIN_RULE_4197/, 'the staged coding environment plugin actually executes');
      assert.match(system, /Z PROJECT ENVIRONMENT/);
      const availableWrites = body.tools.map(tool => tool.function?.name).filter(name => writeTools.includes(name)).sort();
      assert.deepEqual(availableWrites, item.writesUnavailable ? [] : writeTools,
        `${item.name}: plan and explicit write-deny still hide native mutation tools`);
      assert.ok(body.tools.some(tool => tool.function?.name === 'read'));
      const replies = messages.slice(lastUser + 1).filter(message => message.role === 'tool');
      const outputs = replies.map(message => String(message.content));
      assert.ok(outputs.every(output => !output.includes('Path outside workspace')),
        `${item.name}: context discovery cannot preempt native external-directory policy`);
      const actions = actionsFor(item);
      const action = actions[replies.length];
      if (!action) {
        if (item.rejectExternal) {
          assert.ok(outputs.every(output => !output.includes('EXTERNAL_PRIVATE_CONTENT_4197')),
            'rejected external reads never expose the file contents');
          assert.match(outputs.at(-1), /reject|denied|permission/i, 'denial reaches the model as a tool error');
        } else {
          assert.match(outputs[0], /EXTERNAL_PRIVATE_CONTENT_4197/);
          assert.match(outputs.at(-1), item.name === 'full' ? /patched line/ : item.name === 'approved' ? /edited line/ : /pending line/);
        }
        return completion(response, { content: `EXTERNAL_RESULT_${item.name}_OK` });
      }
      completion(response, { tool_calls: [{ index: 0, id: `call-${item.name}-${replies.length}`, type: 'function',
        function: { name: action[0], arguments: JSON.stringify(action[1]) } }] });
    } catch (error) {
      errors.push(error.message);
      completion(response, { content: `FIXTURE_ASSERTION_FAILED: ${error.message}` });
    }
  });
});

async function boundedRun(sidecar, request, item) {
  let timer;
  try {
    return await Promise.race([
      sidecar.run(request, event => {
        if (!isPermissionAskedEvent(event)) return;
        const requestId = permissionRequestID(event);
        if (!requestId || seenPermissions.has(requestId)) return;
        seenPermissions.add(requestId);
        const name = permissionNameFromEvent(event);
        const reply = name === 'external_directory' && item.rejectExternal ? 'reject' : 'once';
        item.permissions.push({ name, reply });
        permissionReplies.push(sidecar.replyPermission({ runId: request.runId, requestId, directory: workspace, reply })
          .then(result => { assert.equal(result.ok, true, JSON.stringify(result)); })
          .catch(error => { errors.push(`Permission reply failed: ${error.message}`); }));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void sidecar.cancel(request.runId).catch(() => {});
          reject(new Error(`Timed out running fixture ${request.runId}`));
        }, 60_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const sidecar = new OpenCodeSidecar({ appRoot, dataDir });
  let summary;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const codingEnvironmentModule = stageCodingEnvironmentModule({ appRoot, dataDir });
    assert.deepEqual(fs.readFileSync(fileURLToPath(codingEnvironmentModule)),
      fs.readFileSync(path.join(appRoot, 'lib', 'coding-environment-plugin.bundle.mjs')),
      'the real kernel loads the current rebuilt plugin bundle');
    const config = buildOpenCodeConfig({ providerId, modelId, apiKey: 'local-fixture-key', baseUrl,
      apiFormat: 'openai', accessMode: 'full', codingEnvironmentModule, enableSubagents: false, mcpServers: [],
      permissions: { allowFileRead: true, allowFileWrite: true, allowNetwork: false },
      capabilities: { contextWindow: 65536, maxOutputTokens: 4096 } });
    config.enabled_providers = [providerId];
    config.small_model = `${providerId}/${modelId}`;
    assert.deepEqual(Object.keys(config.provider), [providerId]);
    assert.deepEqual(config.plugin, [codingEnvironmentModule]);
    for (const item of cases) {
      const result = await boundedRun(sidecar, {
        runId: `external-directory-${item.name}`, zSessionId: `external-${item.name}`,
        providerId, modelId, workspace, hasUserWorkspace: true, workspaceKind: 'default',
        workMode: item.workMode, accessMode: item.accessMode,
        permissions: { allowFileRead: true, allowFileWrite: item.allowFileWrite, allowNetwork: false },
        enableSubagents: false, openCodeConfig: config,
        prompt: `${item.marker}: Work on this explicitly requested external file: ${item.file}. Use the available file tools and respect permission decisions.`
      }, item);
      await Promise.all(permissionReplies);
      assert.deepEqual(errors, []);
      assert.deepEqual(result.toolCalls.map(tool => tool.name), actionsFor(item).map(action => action[0]));
      if (item.rejectExternal) {
        // A native rejection can stop the turn before another model response.
        assert.ok(['done', 'error'].includes(result.status), JSON.stringify(result));
        assert.ok(result.toolCalls.every(tool => !tool.ok && tool.status === 'error'), JSON.stringify(result.toolCalls));
        assert.ok(result.toolCalls.every(tool => !String(tool.output || '').includes('EXTERNAL_PRIVATE_CONTENT_4197')));
        assert.ok(result.toolCalls.some(tool => /reject|denied|permission/i.test(String(tool.output || tool.error || ''))),
          JSON.stringify(result.toolCalls));
        assert.ok(item.permissions.some(permission => permission.name === 'external_directory' && permission.reply === 'reject'));
        assert.equal(item.newFile ? fs.existsSync(item.file) : fs.readFileSync(item.file, 'utf8'), item.newFile ? false : original);
      } else {
        assert.equal(result.status, 'done', result.error);
        assert.match(result.text, new RegExp(`EXTERNAL_RESULT_${item.name}_OK`));
        assert.ok(result.toolCalls.every(tool => tool.ok && tool.status === 'completed'), JSON.stringify(result.toolCalls));
        const expected = item.name === 'full' ? original.replace('pending line', 'patched line')
          : item.name === 'approved' ? original.replace('pending line', 'edited line') : original;
        assert.equal(fs.readFileSync(item.file, 'utf8'), expected);
        if (item.accessMode === 'request') {
          assert.ok(item.permissions.some(permission => permission.name === 'external_directory' && permission.reply === 'once'));
          assert.ok(item.permissions.some(permission => permission.name === 'edit' && permission.reply === 'once'));
        } else assert.deepEqual(item.permissions, [], 'full access does not wait for external directory approval');
      }
      item.toolStatuses = result.toolCalls.map(tool => tool.status);
      console.log(JSON.stringify({ scenario: item.name, ok: true, tools: result.toolCalls.map(tool => tool.name), permissions: item.permissions }));
    }
    summary = { ok: true, scenarios: cases.length, externalPathsContainSpaces: true,
      plugin: 'current staged bundle', endpoint: 'localhost fixture only', modelRequests: modelRequests.length,
      approvedExternalAccess: true, rejectedReadAndWrite: true, planAndWriteDenyPreserved: true };
  } finally {
    // Stop only this test's exact child, then remove only its verified temp root.
    const child = sidecar.server?.child || sidecar.startingChild;
    const stopped = child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    sidecar.close();
    await stopped;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-external-directory-kernel-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(JSON.stringify(summary));
})().catch(error => { console.error(error); process.exitCode = 1; });
