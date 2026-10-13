'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const encoder = new TextEncoder();
const originalError = { type: 'error', error: { type: 'server_error', code: null,
  message: 'An error occurred while processing the request.', param: null }, sequence_number: 0 };
const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const response = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });

function parseEvents(text) {
  return text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
    .filter(Boolean).map(value => JSON.parse(value));
}

test('nullable and missing nested error codes preserve the error envelope and SSE metadata', async () => {
  const { normalizeResponsesErrorStream } = await import('../lib/responses-error-compat.mjs');
  for (const missing of [false, true]) {
    const original = structuredClone(originalError);
    if (missing) delete original.error.code;
    original.error.message = '服务暂时不可用 — retry later';
    original.error.request_id = 'request-fixture';
    original.extra = { keep: true };
    const prefix = ': heartbeat\r\nevent: error\r\nid: frame-1\r\n';
    const input = prefix + `data: ${JSON.stringify(original)}\r\n\r\n`;
    const result = await normalizeResponsesErrorStream(response(input)).text();
    assert.ok(result.startsWith(prefix));
    assert.deepEqual(parseEvents(result), [{ ...original, error: { ...original.error, code: 'server_error' } }]);
  }
});

test('unknown error types do not become server_error and existing codes are untouched', async () => {
  const { normalizeResponsesErrorStream } = await import('../lib/responses-error-compat.mjs');
  for (const type of ['', null, undefined]) {
    const event = { ...originalError, error: { ...originalError.error, type } };
    const [normalized] = parseEvents(await normalizeResponsesErrorStream(response(sse(event))).text());
    assert.equal(normalized.error.code, 'unknown_error');
    assert.equal(normalized.error.type, type);
  }
  for (const code of ['', 'authentication_error', 123]) {
    const input = sse({ ...originalError, error: { ...originalError.error, code } });
    assert.equal(await normalizeResponsesErrorStream(response(input)).text(), input);
  }
});

test('normal, malformed, and top-level error events remain byte-for-byte unchanged', async () => {
  const { normalizeResponsesErrorStream } = await import('../lib/responses-error-compat.mjs');
  const input = ': comment\r\n\r\n' + sse({ type: 'response.output_text.delta', delta: '中文' })
    + sse({ type: 'error', code: null, message: 'Top-level error', param: null, sequence_number: 1 })
    + sse({ type: 'response.failed', response: { error: { code: null, message: 'keep' } } })
    + sse({ type: 'error', error: [] }) + 'data: malformed\n\ndata: [DONE]\n\n';
  assert.deepEqual(new Uint8Array(await normalizeResponsesErrorStream(response(input)).arrayBuffer()), encoder.encode(input));
});

test('fragmented UTF-8, multi-line JSON, and a final frame without a separator normalize safely', async () => {
  const { normalizeResponsesErrorStream } = await import('../lib/responses-error-compat.mjs');
  const normal = 'data: {"type":"response.output_text.delta","delta":"中文"}\r\n\r\n';
  const input = normal + 'event: error\r\ndata: {"type":"error",\r\ndata: "sequence_number":0,"error":{"type":"server_error","code":null,"message":"错误","param":null}}';
  const bytes = encoder.encode(input);
  let index = 0;
  const upstream = new Response(new ReadableStream({
    pull(controller) { if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); else controller.close(); }
  }), { headers: { 'content-type': 'text/event-stream' } });
  const output = await normalizeResponsesErrorStream(upstream).text();
  assert.ok(output.startsWith(normal));
  const events = parseEvents(output);
  assert.equal(events[1].error.code, 'server_error');
  assert.equal(events[1].error.message, '错误');
});

test('non-SSE and failed HTTP responses retain identity; cancellation reaches upstream', async () => {
  const { normalizeResponsesErrorStream } = await import('../lib/responses-error-compat.mjs');
  for (const item of [new Response('{}'), new Response(sse(originalError), { status: 500, headers: { 'content-type': 'text/event-stream' } })]) {
    assert.equal(normalizeResponsesErrorStream(item), item);
  }
  let reason;
  const upstream = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n')); },
    cancel(value) { reason = value; }
  }), { headers: { 'content-type': 'text/event-stream', 'content-length': '1', 'content-encoding': 'gzip', 'x-request-id': 'fixture' } });
  const normalized = normalizeResponsesErrorStream(upstream);
  assert.equal(normalized.headers.get('content-length'), null);
  assert.equal(normalized.headers.get('content-encoding'), null);
  assert.equal(normalized.headers.get('x-request-id'), 'fixture');
  const reader = normalized.body.getReader();
  await reader.read();
  await reader.cancel('fixture stopped');
  assert.equal(reason, 'fixture stopped');
});

async function providerFixture(kind, events, { apiFormat = 'responses' } = {}) {
  let calls = 0;
  const options = { name: 'fixture', apiKey: 'fixture-key', baseURL: 'http://127.0.0.1:9/v1', apiFormat,
    fetch: async () => { calls++; return response(events); } };
  const mod = await import(kind === 'responses' ? '../lib/opencode-openai-responses-provider.mjs' : '../lib/opencode-gptl-provider.mjs');
  const provider = (kind === 'responses' ? mod.createZOpenAIResponsesProvider : mod.createZGptlProvider)(options);
  return { model: provider('gpt-6-astra'), calls: () => calls };
}

const request = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic stream fixture' }] }] };

for (const kind of ['responses', 'gptl']) {
  test(`${kind}: SDK recognizes an early nullable-code server error without validation noise`, async () => {
    const fixture = await providerFixture(kind, sse(originalError));
    await assert.rejects(fixture.model.doStream(request), error => {
      assert.equal(error.name, 'AI_APICallError');
      assert.equal(error.message, originalError.error.message);
      assert.equal(error.statusCode, 500);
      assert.equal(error.isRetryable, true);
      assert.equal(error.data.error.type, 'server_error');
      assert.equal(error.data.error.param, null);
      return true;
    });
    assert.equal(fixture.calls(), 1, 'the compatibility layer must not retry requests');
  });

  test(`${kind}: authentication and invalid-request errors stay non-retryable`, async () => {
    for (const [type, status, message] of [['authentication_error', 401, 'Invalid API key'],
      ['invalid_request_error', 400, 'The supplied request is invalid']]) {
      const event = { ...originalError, error: { ...originalError.error, type, message } };
      const fixture = await providerFixture(kind, sse(event));
      await assert.rejects(fixture.model.doStream(request), error => {
        assert.equal(error.name, 'AI_APICallError');
        assert.equal(error.statusCode, status);
        assert.equal(error.isRetryable, false);
        assert.equal(error.message, message);
        return true;
      });
      assert.equal(fixture.calls(), 1);
    }
  });

  test(`${kind}: error after a tool call stays in the stream and never replays the request`, async () => {
    const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'write_fixture', arguments: '' };
    const events = sse({ type: 'response.output_item.added', sequence_number: 0, output_index: 0, item })
      + sse({ type: 'response.function_call_arguments.delta', sequence_number: 1, item_id: item.id, output_index: 0, delta: '{"value":1}' })
      + sse({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: { ...item, arguments: '{"value":1}', status: 'completed' } })
      + sse({ ...originalError, sequence_number: 3 });
    const fixture = await providerFixture(kind, events);
    const result = await fixture.model.doStream({ ...request,
      tools: [{ type: 'function', name: 'write_fixture', inputSchema: { type: 'object', properties: { value: { type: 'number' } } } }] });
    const parts = [];
    for await (const part of result.stream) parts.push(part);
    const call = parts.findIndex(part => part.type === 'tool-call');
    const error = parts.findIndex(part => part.type === 'error');
    assert.ok(call >= 0 && error > call, 'the completed tool call must remain before the stream error');
    assert.equal(parts[call].input, '{"value":1}');
    assert.equal(parts[error].error.message, originalError.error.message);
    assert.notEqual(parts[error].error.name, 'AI_APICallError', 'do not promote a partial stream to an early request failure');
    assert.equal(parts.at(-1).finishReason.unified, 'error');
    assert.equal(fixture.calls(), 1);
  });
}

test('GPTL Chat requests bypass Responses-only normalization', async () => {
  const { makeGptlFetch } = await import('../lib/opencode-gptl-provider.mjs');
  const input = sse(originalError);
  const fetch = makeGptlFetch(async () => response(input));
  const result = await fetch('http://127.0.0.1:9/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', messages: [] })
  });
  assert.equal(await result.text(), input);
});
