'use strict';

// This audit captures the actual wire parameters sent by the current Z config
// builder through the real OpenCode kernel. It uses localhost fixtures only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeSidecar, buildOpenCodeConfig, stageCodingEnvironmentModule } = require('../lib/opencode-sidecar');

process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
const appRoot = path.resolve(__dirname, '..');
const tempRoot = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempRoot, 'z-reasoning-parameters-'));
const outputDir = path.join(appRoot, 'output', 'reasoning-parameters');
fs.mkdirSync(outputDir, { recursive: true });
const modelId = 'claude-opus-4-7';
const allCases = [
  ...['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ apiFormat: 'anthropic', effort })),
  ...['low', 'high'].map(effort => ({ apiFormat: 'openai', effort }))
].map(item => ({ ...item, modelId, id: `${item.apiFormat}-${item.effort}`, wire: [] }));
for (const effort of ['xhigh', 'max']) allCases.push({ apiFormat: 'anthropic', modelId, effort, id: `native-${effort}`, nativeOptions: true, wire: [] });
allCases.push({ apiFormat: 'anthropic', modelId: 'claude-sonnet-4-6', effort: 'xhigh', id: 'sonnet-xhigh', wire: [] });
allCases.push({ apiFormat: 'anthropic', modelId: 'claude-opus-4-5', effort: 'max', id: 'opuslegacy-max', wire: [] });
const selectedCase = String(process.env.Z_REASONING_PROBE_CASE || '');
const cases = selectedCase ? allCases.filter(item => item.id === selectedCase) : allCases;
assert.ok(cases.length, 'the requested fixture case must be predefined');
const reportName = selectedCase ? `${cases[0].id}.json` : 'report.json';
const report = { ok: false, kernelVersion: '1.18.11', modelId, endpoint: 'localhost fixture only', cases, errors: [] };

function emitAnthropic(response, responseModel) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const emit = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  emit('message_start', { message: { id: 'msg-reasoning-fixture', type: 'message', role: 'assistant', model: responseModel,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'REASONING_FIXTURE_OK' } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  emit('message_stop', {});
  response.end();
}
function emitOpenAI(response, responseModel) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'reasoning-fixture', object: 'chat.completion.chunk',
    model: responseModel, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit({ role: 'assistant', content: 'REASONING_FIXTURE_OK' });
  emit({}, 'stop');
  response.end('data: [DONE]\n\n');
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      const parts = request.url.match(/^\/([a-z]+-[a-z]+)\/v1\/(messages|chat\/completions)(?:\?[^]*)?$/);
      assert.ok(parts, `Unexpected fixture endpoint ${request.url}`);
      const item = cases.find(value => value.id === parts[1]);
      assert.ok(item);
      assert.equal(parts[2], item.apiFormat === 'anthropic' ? 'messages' : 'chat/completions');
      const body = JSON.parse(raw || '{}');
      assert.equal(body.model, item.modelId);
      assert.ok(item.wire.length < 6, 'bounded fixture calls per run');
      const unexpectedInternalFields = ['reasoningEffort', 'reasoningEffortAdjusted', 'reasoningResolution', 'requestedEffort', 'effectiveEffort']
        .filter(field => Object.hasOwn(body, field));
      assert.deepEqual(unexpectedInternalFields, [], 'internal SDK/diagnostic options never reach the protocol body');
      // Capture only the requested option fields: no prompts, credentials or
      // arbitrary headers are retained in either logs or the audit report.
      item.wire.push({ model: body.model, thinking: body.thinking ?? null, output_config: body.output_config ?? null,
        reasoning_effort: body.reasoning_effort ?? null, max_tokens: body.max_tokens ?? null,
        max_completion_tokens: body.max_completion_tokens ?? null,
        temperature: body.temperature ?? null, stream: body.stream ?? null, unexpectedInternalFields });
      if (item.apiFormat === 'anthropic') emitAnthropic(response, item.modelId);
      else emitOpenAI(response, item.modelId);
    } catch (error) {
      report.errors.push(error.message);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});

(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    for (const item of cases) {
      const requestedModel = item.modelId;
      const directory = path.join(root, item.id);
      const workspace = path.join(directory, 'isolated workspace');
      const dataDir = path.join(directory, 'isolated data');
      fs.mkdirSync(workspace, { recursive: true });
      const providerId = 'reasoning-fixture';
      const sidecar = new OpenCodeSidecar({ appRoot, dataDir });
      let timer;
      try {
        const config = buildOpenCodeConfig({ providerId, modelId: requestedModel, apiKey: 'local-fixture-only',
          baseUrl: `http://127.0.0.1:${server.address().port}/${item.id}/v1`, apiFormat: item.apiFormat,
          reasoningSpeed: item.effort, accessMode: 'full', enableSubagents: false, mcpServers: [],
          codingEnvironmentModule: stageCodingEnvironmentModule({ appRoot, dataDir }),
          capabilities: { contextWindow: 200000, maxOutputTokens: 64000, reasoning: true } });
        config.enabled_providers = [providerId];
        config.small_model = `${providerId}/${requestedModel}`;
        if (item.nativeOptions) config.provider[providerId].models[requestedModel].options = {
          thinking: { type: 'adaptive', display: 'summarized' }, effort: item.effort
        };
        item.modelOptions = config.provider[providerId].models[requestedModel].options;
        item.declaredLimits = config.provider[providerId].models[requestedModel].limit;
        item.providerModule = config.provider[providerId].npm.includes('@ai-sdk/')
          ? config.provider[providerId].npm : path.basename(config.provider[providerId].npm);
        const result = await Promise.race([
          sidecar.run({ runId: `reasoning-${item.id}`, zSessionId: item.id, providerId, modelId: requestedModel, workspace,
            hasUserWorkspace: true, workMode: 'normal', accessMode: 'full', enableSubagents: false,
            reasoningSpeed: item.effort, openCodeConfig: config, prompt: `REASONING_PROBE_${item.id}: Reply with the fixture confirmation.` }),
          new Promise((_, reject) => { timer = setTimeout(() => {
            void sidecar.cancel(`reasoning-${item.id}`).catch(() => {});
            reject(new Error(`Fixture timed out: ${item.id}`));
          }, 60_000); })
        ]);
        assert.equal(result.status, 'done', result.error);
        assert.match(result.text, /REASONING_FIXTURE_OK/);
        assert.ok(item.wire.length > 0, 'each effort level reaches the actual protocol endpoint');
        for (const wire of item.wire) {
          if (item.apiFormat === 'anthropic') {
            const expectedThinking = item.id === 'opuslegacy-max' ? { type: 'enabled', budget_tokens: 16000 }
              : item.id === 'sonnet-xhigh' ? { type: 'adaptive' } : { type: 'adaptive', display: 'summarized' };
            const expectedEffort = item.id === 'opuslegacy-max' ? 'high' : item.id === 'sonnet-xhigh' ? 'max' : item.effort;
            assert.deepEqual(wire.thinking, expectedThinking, `${item.id}: actual native thinking options`);
            assert.deepEqual(wire.output_config, { effort: expectedEffort }, `${item.id}: actual native effort`);
            assert.equal(wire.reasoning_effort, null, 'native Anthropic does not receive the OpenAI parameter');
          } else {
            assert.equal(wire.reasoning_effort, item.effort, 'OpenAI-compatible effort stays unchanged');
            assert.equal(wire.thinking, null);
            assert.equal(wire.output_config, null);
          }
          assert.equal(wire.max_tokens, item.id === 'opuslegacy-max' ? 48000 : 32000,
            'the native SDK adds the legacy thinking budget to its completion output allowance');
          assert.equal(wire.stream, true);
        }
        console.log(JSON.stringify(item));
      } finally {
        clearTimeout(timer);
        const child = sidecar.server?.child || sidecar.startingChild;
        const stopped = child && child.exitCode === null && child.signalCode === null
          ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
        sidecar.close();
        await stopped;
      }
    }
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.failure = error.stack || error.message;
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(outputDir, reportName), JSON.stringify(report, null, 2));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith('z-reasoning-parameters-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(JSON.stringify({ ok: true, cases: cases.length, endpoint: report.endpoint, report: `output/reasoning-parameters/${reportName}` }));
})().catch(error => { console.error(error); process.exitCode = 1; });
