'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeSidecar, buildOpenCodeConfig } = require('../lib/opencode-sidecar');

// The real kernel runs against one local fixture provider in isolated storage.
// This process never supplies user credentials or a remote model endpoint.
process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
const appRoot = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryRoot, 'z-automatic-workspace-kernel-'));
const workspace = path.join(root, 'tasks', 'default-conversation');
const dataDir = path.join(root, 'data');
const file = path.join(workspace, 'notes.txt');
const providerId = 'automatic-workspace-fixture';
const modelId = 'automatic-workspace-model';
const firstMarker = 'AUTO_WORKSPACE_CREATE_4197';
const secondMarker = 'AUTO_WORKSPACE_CONTINUE_4197';
const firstContent = 'first line\npending line\n';
const finalContent = 'first line\ncontinued line\n';
const errors = [];
const modelRequests = [];
const toolRequests = [];
const events = [];
fs.mkdirSync(workspace, { recursive: true });

function completion(response, model, message) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const payload = { id: 'automatic-workspace-fixture', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: { role: 'assistant', ...message }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  payload.choices = [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }];
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end('data: [DONE]\n\n');
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
      assert.equal(body.model, modelId, 'all model work, including helper requests, stays on the fixture');
      modelRequests.push(body.model);
      assert.ok(modelRequests.length <= 16, 'the fixture must not enter an unbounded follow-up loop');
      const messages = body.messages || [];
      const lastUser = messages.findLastIndex(message => message.role === 'user');
      const prompt = JSON.stringify(messages[lastUser]?.content || '');
      const continuing = prompt.includes(secondMarker);
      const active = body.tools?.length && (continuing || prompt.includes(firstMarker));
      if (!active) return completion(response, modelId, { content: 'Automatic task directory test' });

      assert.match(prompt, /persistent task directory has already been assigned/);
      assert.match(prompt, /Work directly in this directory and create the requested files/);
      assert.doesNotMatch(prompt, /End the task immediately|请先选择工作区/);
      for (const name of ['write', 'read', 'edit']) {
        assert.ok(body.tools.some(tool => tool.function?.name === name), `native ${name} is available`);
      }
      const replies = messages.slice(lastUser + 1).filter(message => message.role === 'tool');
      const outputs = replies.map(message => String(message.content));
      const actions = continuing
        ? [
            ['read', { filePath: file }],
            ['edit', { filePath: file, oldString: 'pending line', newString: 'continued line' }],
            ['read', { filePath: file }]
          ]
        : [
            ['write', { filePath: file, content: firstContent }],
            ['read', { filePath: file }]
          ];
      const action = actions[replies.length];
      if (!action) {
        assert.match(outputs.at(-1), continuing ? /continued line/ : /pending line/,
          'the final native read returns the file contents to the model');
        if (continuing) assert.match(outputs[0], /pending line/, 'the second turn can read the first turn output');
        return completion(response, modelId, { content: continuing ? 'CONTINUED_FILE_OK' : 'CREATED_FILE_OK' });
      }
      const turn = continuing ? 'continue' : 'create';
      toolRequests.push({ turn, tool: action[0] });
      return completion(response, modelId, { tool_calls: [{
        index: 0, id: `call-${turn}-${replies.length}`, type: 'function',
        function: { name: action[0], arguments: JSON.stringify(action[1]) }
      }] });
    } catch (error) {
      errors.push(error.message);
      completion(response, modelId, { content: 'FIXTURE_ASSERTION_FAILED' });
    }
  });
});

function unwrap(result) {
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.data;
}

async function boundedRun(sidecar, request) {
  let timer;
  try {
    return await Promise.race([
      sidecar.run(request, event => events.push(event)),
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
    const permissions = { allowFileRead: true, allowFileWrite: true, allowNetwork: false };
    const config = buildOpenCodeConfig({
      providerId, modelId, apiKey: 'local-fixture-key', baseUrl, apiFormat: 'openai',
      accessMode: 'full', permissions, enableSubagents: false, mcpServers: [],
      capabilities: { contextWindow: 65536, maxOutputTokens: 4096 }
    });
    config.enabled_providers = [providerId];
    config.small_model = `${providerId}/${modelId}`;
    assert.deepEqual(Object.keys(config.provider), [providerId]);
    assert.equal(config.provider[providerId].options.baseURL, baseUrl);
    const common = {
      providerId, modelId, yanSessionId: 'default-conversation', workspace,
      hasUserWorkspace: true, workspaceKind: 'default', workMode: 'normal',
      accessMode: 'full', permissions, enableSubagents: false, openCodeConfig: config
    };
    const first = await boundedRun(sidecar, {
      ...common, runId: 'automatic-workspace-create',
      prompt: `${firstMarker}: Create notes.txt in this task directory with two lines, then read it back.`
    });
    assert.deepEqual(errors, []);
    assert.equal(first.status, 'done', first.error);
    assert.match(first.text, /CREATED_FILE_OK/);
    assert.equal(fs.readFileSync(file, 'utf8'), firstContent);
    assert.deepEqual(first.toolCalls.map(tool => tool.name), ['write', 'read']);
    assert.ok(first.toolCalls.every(tool => tool.ok && tool.status === 'completed'));
    assert.match(first.toolCalls.find(tool => tool.name === 'read').output, /pending line/);

    const second = await boundedRun(sidecar, {
      ...common, runId: 'automatic-workspace-continue', openCodeSessionId: first.openCodeSessionId,
      prompt: `${secondMarker}: Read the existing notes.txt, change pending line to continued line, and read it again.`
    });
    assert.deepEqual(errors, []);
    assert.equal(second.status, 'done', second.error);
    assert.equal(second.openCodeSessionId, first.openCodeSessionId, 'a follow-up reuses the real kernel session');
    assert.match(second.text, /CONTINUED_FILE_OK/);
    assert.equal(fs.readFileSync(file, 'utf8'), finalContent);
    assert.deepEqual(second.toolCalls.map(tool => tool.name), ['read', 'edit', 'read']);
    assert.ok(second.toolCalls.every(tool => tool.ok && tool.status === 'completed'));
    assert.match(second.toolCalls.at(-1).output, /continued line/);

    const session = unwrap(await sidecar.client.session.get({ sessionID: second.openCodeSessionId, directory: workspace }));
    const messages = unwrap(await sidecar.client.session.messages({ sessionID: second.openCodeSessionId, directory: workspace }));
    const tools = messages.flatMap(message => message.parts || []).filter(part => part.type === 'tool');
    assert.equal(path.resolve(session.directory), path.resolve(workspace));
    assert.deepEqual(tools.map(part => part.tool), ['write', 'read', 'read', 'edit', 'read']);
    assert.ok(tools.every(part => part.state?.status === 'completed'));
    assert.equal(events.filter(event => event.type === 'yan.opencode.finished').length, 2);
    assert.ok(!events.some(event => ['permission.asked', 'permission.v2.asked', 'permission.updated'].includes(event.type)),
      'normal permitted file work must not wait for folder selection or permission');
    assert.equal(new Set(modelRequests).size, 1);
    summary = { ok: true, turns: 2, sessionReused: true, tools: toolRequests.map(item => item.tool),
      toolStatuses: tools.map(part => part.state.status), modelRequests: modelRequests.length,
      endpoint: 'localhost fixture only', outputVerified: true };
  } finally {
    // Only this test's exact child handle is stopped; no process-name cleanup.
    const child = sidecar.server?.child || sidecar.startingChild;
    const stopped = child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    sidecar.close();
    await stopped;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('z-automatic-workspace-kernel-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(JSON.stringify(summary));
})().catch(error => { console.error(error); process.exitCode = 1; });
