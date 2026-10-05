'use strict';

// Exercise the pinned native kernel against loopback mocks. No real model,
// user configuration, workspace files, or app instance is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { OpenCodeSidecar, buildOpenCodeConfig } = require('../lib/opencode-sidecar');

const appRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(appRoot, 'output');
fs.mkdirSync(outputRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(outputRoot, 'output-limits-native-'));
const cases = [
  { label: 'Claude 4.7 automatic', modelId: 'claude-opus-4-7', apiFormat: 'anthropic', expected: 128000 },
  { label: 'Claude 4.5 automatic', modelId: 'claude-opus-4-5', apiFormat: 'anthropic', expected: 64000 },
  { label: 'GPT 6 Astra Chat automatic legacy limit', modelId: 'gpt-6-astra', apiFormat: 'openai', expected: 128000 },
  { label: 'GPT 6 Astra Responses automatic legacy limit', modelId: 'gpt-6-astra', apiFormat: 'responses', expected: 128000 },
  { label: 'Claude manual override', modelId: 'claude-opus-4-7', apiFormat: 'anthropic', maxOutputTokens: 48000, expected: 48000 },
  { label: 'Legacy Claude manual total includes thinking', modelId: 'claude-opus-4-5', apiFormat: 'anthropic', maxOutputTokens: 48000, expected: 48000 },
  { label: 'Legacy Claude alias manual total includes thinking', modelId: 'anthropic/claude-opus-4-5', apiFormat: 'anthropic', maxOutputTokens: 48000, expected: 48000 },
  { label: 'Claude gateway alias keeps wire ID', modelId: 'anthropic/claude-opus-4-7', apiFormat: 'anthropic', expected: 128000 },
  { label: 'CSU GLM automatic retains native limit', modelId: 'GLM', apiFormat: 'openai', expected: 32000 },
  { label: 'CSU GLM explicit manual override', modelId: 'GLM', apiFormat: 'openai', maxOutputTokens: 48000, expected: 48000 }
].map((item, index) => ({ ...item, providerId: `output-limit-fixture-${index}`, marker: `Z_OUTPUT_LIMIT_CASE_${index}`, requests: [] }));
const failures = [];

function writeEvent(response, type, payload) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function reply(response, endpoint, modelId, text) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  if (endpoint.endsWith('/messages')) {
    writeEvent(response, 'message_start', { type: 'message_start', message: {
      id: 'msg_output_limit_fixture', type: 'message', role: 'assistant', model: modelId,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 }
    } });
    writeEvent(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    writeEvent(response, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    writeEvent(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeEvent(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
    writeEvent(response, 'message_stop', { type: 'message_stop' });
  } else if (endpoint.endsWith('/responses')) {
    let sequence = 0;
    const event = (type, payload) => writeEvent(response, type, { type, sequence_number: sequence++, ...payload });
    const item = { id: 'msg_output_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const part = { type: 'output_text', text: '', annotations: [] };
    const base = { id: 'resp_output_limit_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000),
      model: modelId, status: 'in_progress', output: [], incomplete_details: null, error: null };
    event('response.created', { response: base });
    event('response.output_item.added', { output_index: 0, item });
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
    event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
    const completedPart = { ...part, text };
    const completedItem = { ...item, status: 'completed', content: [completedPart] };
    event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: completedPart });
    event('response.output_item.done', { output_index: 0, item: completedItem });
    event('response.completed', { response: { ...base, status: 'completed', output: [completedItem], usage: {
      input_tokens: 20, output_tokens: 4, total_tokens: 24,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }
    } } });
  } else {
    const base = { id: 'output_limit_fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })}\n\n`);
    response.write('data: [DONE]\n\n');
  }
  response.end();
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw || '{}');
      const item = cases.find(candidate => raw.includes(candidate.marker));
      if (item) item.requests.push({ endpoint: request.url, body });
      reply(response, request.url || '', body.model || 'fixture', item ? 'OUTPUT_LIMIT_OK' : 'Fixture session title');
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});

function unwrap(result) {
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.data;
}

(async () => {
  const sidecar = new OpenCodeSidecar({ appRoot, dataDir: path.join(directory, 'data') });
  const results = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const configs = cases.map(item => buildOpenCodeConfig({
      providerId: item.providerId, modelId: item.modelId, apiFormat: item.apiFormat,
      apiKey: 'isolated-loopback-fixture-key', baseUrl, reasoningSpeed: 'max',
      contextWindow: 1000000, compactionThreshold: 800000,
      ...(item.maxOutputTokens ? { maxOutputTokens: item.maxOutputTokens } : {}),
      responsesProviderModule: pathToFileURL(path.join(appRoot, 'lib', 'opencode-openai-responses-provider.bundle.mjs')).href,
      capabilities: { reasoning: true }, enableSubagents: false, mcpServers: [],
      permissions: { allowFileRead: false, allowFileWrite: false, allowNetwork: false }
    }));
    // One shared server catches unknown-model regressions when another model
    // raises the process-wide cap. Each model still has its own smaller limit.
    const config = { ...configs[0], provider: Object.assign({}, ...configs.map(item => item.provider)),
      plugin: [], mcp: {}, skills: { paths: [] }, compaction: { ...configs[0].compaction, auto: false } };
    for (const [index, item] of cases.entries()) {
      const model = configs[index].provider[item.providerId].models[item.modelId];
      // The pinned Anthropic SDK adds manual-thinking tokens after the
      // kernel computes the completion allowance. Adaptive thinking does
      // not use this addition; the asserted wire cap remains the total.
      const thinkingTokens = item.apiFormat === 'anthropic' && model.options?.thinking?.type === 'enabled'
        ? Number(model.options.thinking.budgetTokens) || 0 : 0;
      assert.equal(model.id, item.modelId, `${item.label}: configured wire identity`);
      assert.equal(model.limit.output + thinkingTokens, item.expected, `${item.label}: configured total output`);
      assert.equal(model.limit.context, 1000000, `${item.label}: context must stay 1M`);
      assert.equal(configs[index].compaction.threshold, 800000, `${item.label}: compaction threshold must stay 800K`);
    }
    await sidecar.start(config);
    for (const item of cases) {
      const session = unwrap(await sidecar.client.session.create({ directory, title: item.label }));
      const result = unwrap(await sidecar.client.session.prompt({ sessionID: session.id, directory,
        model: { providerID: item.providerId, modelID: item.modelId }, agent: 'build',
        parts: [{ type: 'text', text: `${item.marker} Reply with the fixture text.` }]
      }, { signal: AbortSignal.timeout(45000) }));
      assert.ok(result.parts.some(part => part.type === 'text' && part.text.includes('OUTPUT_LIMIT_OK')), JSON.stringify(result));
      assert.ok(item.requests.length > 0, `${item.label}: must reach the loopback provider`);
      for (const { endpoint, body } of item.requests) {
        const outputField = item.apiFormat === 'anthropic' ? 'max_tokens'
          : item.apiFormat === 'responses' ? 'max_output_tokens'
            : item.modelId.startsWith('gpt-') ? 'max_completion_tokens' : 'max_tokens';
        assert.equal(body.model, item.modelId, `${item.label}: actual wire identity`);
        assert.equal(body[outputField], item.expected, `${item.label}: native ${outputField} must survive kernel and SDK`);
        const suffix = item.apiFormat === 'anthropic' ? '/messages'
          : item.apiFormat === 'responses' ? '/responses' : '/chat/completions';
        assert.ok(endpoint.endsWith(suffix), `${item.label}: ${endpoint}`);
        if (item.apiFormat === 'anthropic' && body.thinking?.budget_tokens) {
          assert.ok(body.thinking.budget_tokens < body.max_tokens, `${item.label}: thinking budget must leave answer space`);
        }
      }
      const resultRow = { label: item.label, modelId: item.modelId, apiFormat: item.apiFormat,
        outputTokens: item.expected, contextTokens: 1000000, compactionThreshold: 800000, requests: item.requests.length };
      results.push(resultRow);
      console.log(JSON.stringify(resultRow));
    }
    assert.deepEqual(failures, []);
    fs.writeFileSync(path.join(outputRoot, 'model-output-limits-native-results.json'), JSON.stringify({
      ok: true, checkedAt: new Date().toISOString(), opencodeVersion: '1.18.11',
      loopbackOnly: true, cases: results
    }, null, 2) + '\n');
  } finally {
    const child = sidecar.server?.child;
    const stopped = child && child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    sidecar.close();
    await stopped;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(outputRoot));
    assert.ok(path.basename(directory).startsWith('output-limits-native-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
