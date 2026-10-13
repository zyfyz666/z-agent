'use strict';

// Exercise actual native file expansion, tool-result filtering, and provider
// serialization against a loopback fixture. No real model or user data is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { OpenCodeSidecar, buildOpenCodeConfig, buildPromptParts } = require('../lib/opencode-sidecar');
const { resolveModelCapabilities } = require('../lib/model-capabilities');

const appRoot = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-astra-pdf-input-'));
const routes = [
  { name: 'responses', modelId: 'gpt-6-astra', apiFormat: 'responses' },
  { name: 'gptl-responses', modelId: 'gpt-6-astra', apiFormat: 'responses', gptl: true },
  { name: 'gptl-chat', modelId: 'gpt-6-astra', apiFormat: 'openai', gptl: true },
  { name: 'chat', modelId: 'gpt-6-astra', apiFormat: 'openai' },
  { name: 'claude-anthropic', modelId: 'claude-opus-4-7', apiFormat: 'anthropic' }
];
const scenarios = ['attachment', 'native-read', 'guidance'];
const cases = [];
const failures = [];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, message, milliseconds = 45000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function pdfFixture() {
  const stream = 'BT /F1 18 Tf 30 120 Td (Synthetic Astra PDF transport fixture.) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

const pdfBytes = pdfFixture();
const pdfPath = path.join(directory, 'synthetic.PDF');
const textPath = path.join(directory, 'continue.txt');
fs.writeFileSync(pdfPath, pdfBytes);
fs.writeFileSync(textPath, 'Local tool boundary for guidance delivery.\n');

function wireFiles(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (value.type === 'input_file') output.push({ type: 'input_file', ...value });
  else if (value.type === 'file' && value.file) output.push({ type: 'file', ...value.file });
  else if (value.type === 'document' && value.source?.media_type === 'application/pdf') output.push(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => wireFiles(item, output));
    else if (child && typeof child === 'object') wireFiles(child, output);
  }
  return output;
}

function verifyPdfRequest(item, request) {
  const files = wireFiles(request.body);
  assert.ok(files.length, `${item.marker}: provider request must contain PDF bytes`);
  for (const file of files) {
    if (item.apiFormat === 'anthropic') {
      assert.equal(file.type, 'document', item.marker);
      assert.equal(file.source.type, 'base64', `${item.marker}: native PDF must be embedded`);
      assert.equal(file.source.media_type, 'application/pdf', item.marker);
      assert.ok(Buffer.from(file.source.data, 'base64').equals(pdfBytes), `${item.marker}: PDF bytes changed`);
      continue;
    }
    assert.equal(file.type, item.apiFormat === 'responses' ? 'input_file' : 'file', item.marker);
    assert.match(file.file_data || '', /^data:application\/pdf;base64,/, item.marker);
    assert.ok(Buffer.from(file.file_data.split(',')[1], 'base64').equals(pdfBytes), `${item.marker}: PDF bytes changed`);
    assert.equal(file.file_url, undefined, `${item.marker}: a local file URL must be expanded before the provider call`);
    assert.ok(file.filename?.endsWith('.pdf') || file.filename?.endsWith('.PDF'), `${item.marker}: filename`);
  }
  assert.doesNotMatch(JSON.stringify(request.body), /Cannot read .*does not support pdf input|PDF contents have not been sent|binary file[^\n]*raw bytes/);
  item.verifiedRequests++;
}

function writeEvent(response, type, payload) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function reply(response, endpoint, { text, tool, modelId = 'gpt-6-astra' }) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  if (endpoint.endsWith('/messages')) {
    writeEvent(response, 'message_start', { type: 'message_start', message: {
      id: 'msg_pdf_fixture', type: 'message', role: 'assistant', model: modelId,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 }
    } });
    writeEvent(response, 'content_block_start', { type: 'content_block_start', index: 0,
      content_block: tool ? { type: 'tool_use', id: 'call_pdf_fixture', name: tool.name, input: {} }
        : { type: 'text', text: '' } });
    writeEvent(response, 'content_block_delta', { type: 'content_block_delta', index: 0,
      delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.arguments) }
        : { type: 'text_delta', text } });
    writeEvent(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeEvent(response, 'message_delta', { type: 'message_delta',
      delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
    writeEvent(response, 'message_stop', { type: 'message_stop' });
  } else if (endpoint.endsWith('/responses')) {
    let sequence = 0;
    const event = (type, payload) => writeEvent(response, type, { type, sequence_number: sequence++, ...payload });
    const base = { id: 'resp_pdf_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000),
      model: modelId, status: 'in_progress', output: [], incomplete_details: null, error: null };
    event('response.created', { response: base });
    let completedItem;
    if (tool) {
      const item = { id: 'fc_pdf_fixture', type: 'function_call', call_id: 'call_pdf_fixture',
        name: tool.name, arguments: '', status: 'in_progress' };
      event('response.output_item.added', { output_index: 0, item });
      const argumentsText = JSON.stringify(tool.arguments);
      event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: argumentsText });
      event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: argumentsText });
      completedItem = { ...item, arguments: argumentsText, status: 'completed' };
    } else {
      const item = { id: 'msg_pdf_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      const part = { type: 'output_text', text: '', annotations: [] };
      event('response.output_item.added', { output_index: 0, item });
      event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part });
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
      event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
      const completedPart = { ...part, text };
      event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: completedPart });
      completedItem = { ...item, status: 'completed', content: [completedPart] };
    }
    event('response.output_item.done', { output_index: 0, item: completedItem });
    event('response.completed', { response: { ...base, status: 'completed', output: [completedItem], usage: {
      input_tokens: 20, output_tokens: 4, total_tokens: 24,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }
    } } });
  } else {
    const base = { id: 'chat_pdf_fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId };
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_pdf_fixture', type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: text };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })}\n\n`);
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
      if (!item || !body.tools?.length) return reply(response, request.url || '', { text: 'PDF fixture session', modelId: body.model });
      const row = { endpoint: request.url, body };
      item.requests.push(row);
      assert.equal(body.model, item.modelId, `${item.marker}: model identity`);
      const endpoint = item.apiFormat === 'anthropic' ? '/messages'
        : item.apiFormat === 'responses' ? '/responses' : '/chat/completions';
      assert.ok(request.url.endsWith(endpoint), `${item.marker}: protocol changed`);
      if (item.scenario !== 'attachment' && item.requests.length === 1) {
        assert.equal(wireFiles(body).length, 0, `${item.marker}: initial request should have no attachment`);
        const readTool = body.tools.find(tool => (tool.function?.name || tool.name) === 'read');
        assert.ok(readTool, `${item.marker}: native read tool unavailable`);
        const sendRead = () => reply(response, request.url, {
          modelId: item.modelId,
          tool: { name: readTool.function?.name || readTool.name,
            arguments: { filePath: item.scenario === 'native-read' ? pdfPath : textPath } }
        });
        if (item.scenario === 'guidance') {
          item.release = sendRead;
          item.firstRequest.resolve();
          return;
        }
        return sendRead();
      }
      verifyPdfRequest(item, row);
      reply(response, request.url, { text: 'PDF_BYTES_OK', modelId: item.modelId });
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) reply(response, request.url || '', { text: `PDF_FIXTURE_FAILED: ${error.message}` });
      else response.end();
    }
  });
});

function unwrap(result) {
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.data;
}

(async () => {
  const sidecar = new OpenCodeSidecar({ appRoot, dataDir: path.join(directory, 'data') });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const configs = routes.map(route => {
      const modelId = route.modelId;
      const providerId = `astra-pdf-${route.name}`;
      const capabilities = resolveModelCapabilities(providerId, { id: modelId });
      assert.equal(capabilities.pdfInput, true, `${route.name}: real capability resolution`);
      const config = buildOpenCodeConfig({
        ...route, providerId, modelId, capabilities, baseUrl, apiKey: 'synthetic-loopback-key',
        responsesProviderModule: pathToFileURL(path.join(appRoot, 'lib', 'opencode-openai-responses-provider.bundle.mjs')).href,
        gptlProviderModule: pathToFileURL(path.join(appRoot, 'lib', 'opencode-gptl-provider.bundle.mjs')).href,
        permissions: { allowFileRead: true, allowFileWrite: false, allowShell: false, allowNetwork: false },
        accessMode: 'full', enableSubagents: false, mcpServers: []
      });
      assert.ok(config.provider[providerId].models[modelId].modalities.input.includes('pdf'));
      for (const scenario of scenarios) cases.push({ ...route, providerId, capabilities, scenario,
        marker: `Z_ASTRA_PDF_${cases.length}_CASE`, requests: [], verifiedRequests: 0, firstRequest: deferred() });
      return config;
    });
    const config = { ...configs[0], provider: Object.assign({}, ...configs.map(item => item.provider)),
      plugin: [], mcp: {}, skills: { paths: [] }, compaction: { ...configs[0].compaction, auto: false } };
    await sidecar.start(config);

    for (const item of cases) {
      const session = unwrap(await sidecar.client.session.create({ directory, title: `${item.name} ${item.scenario}` }));
      const request = { providerId: item.providerId, modelId: item.modelId, capabilities: item.capabilities, openCodeConfig: config,
        zSessionId: item.marker, prompt: item.marker,
        attachments: item.scenario === 'attachment' ? [{ path: pdfPath, name: 'synthetic.PDF', mimeType: 'application/octet-stream' }] : [] };
      const prompt = sidecar.client.session.prompt({ sessionID: session.id, directory,
        model: { providerID: item.providerId, modelID: item.modelId }, agent: 'build', parts: buildPromptParts(request)
      }, { signal: AbortSignal.timeout(45000) });
      // Register a rejection handler while the fixture holds the first stream.
      void prompt.catch(() => {});
      try {
        if (item.scenario === 'guidance') {
          await bounded(item.firstRequest.promise, `${item.marker}: first request never arrived`);
          sidecar.activeRuns.set(item.marker, { runId: item.marker, request, openCodeSessionID: session.id, directory,
            acceptingInterjections: true, guidanceVersion: 0, interjections: [], onEvent: () => {},
            abortController: new AbortController(), eventController: new AbortController() });
          const receipt = await bounded(sidecar.deliverInterjection(item.marker, {
            source: 'user', requestId: `${item.marker}-guide`, kind: 'guidance', guidance: 'Use this PDF for the current task.',
            attachments: [{ path: pdfPath, name: 'synthetic.PDF', mimeType: 'application/pdf' }]
          }), `${item.marker}: guidance insertion never completed`);
          assert.equal(receipt.accepted, true);
          // promptAsync acknowledges scheduling; native persistence can finish
          // just after that 204. Hold the model stream until the exact message
          // exists so timing cannot decide whether its PDF reaches the next turn.
          const guidance = await bounded((async () => {
            for (;;) {
              const inserted = unwrap(await sidecar.client.session.messages({ sessionID: session.id, directory }));
              const message = inserted.find(row => row.info.id === receipt.nativeMessageId);
              if (message?.parts.some(part => part.type === 'file' && part.mime === 'application/pdf')) return message;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          })(), `${item.marker}: native guidance PDF never persisted`, 5000);
          assert.ok(guidance?.parts.some(part => part.type === 'file' && part.mime === 'application/pdf'), `${item.marker}: native guidance PDF missing`);
          item.release();
        }
        const result = unwrap(await prompt);
        assert.ok(result.parts.some(part => part.type === 'text' && part.text.includes('PDF_BYTES_OK')), JSON.stringify(result));
        assert.ok(item.verifiedRequests > 0, `${item.marker}: no PDF verified`);
        if (item.scenario === 'native-read') {
          const messages = unwrap(await sidecar.client.session.messages({ sessionID: session.id, directory }));
          const reads = messages.flatMap(message => message.parts || []).filter(part => part.type === 'tool' && part.tool === 'read');
          assert.ok(reads.some(part => part.state?.status === 'completed' && part.state.output.includes('PDF read successfully')),
            `${item.marker}: the actual native PDF read must complete`);
        }
        console.log(`${item.name} / ${item.scenario}: native PDF bytes verified (${item.requests.length} requests)`);
      } finally {
        sidecar.activeRuns.delete(item.marker);
      }
    }
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ ok: true, cases: cases.length, loopbackOnly: true,
      pdfBytes: pdfBytes.length, pdfSha256: crypto.createHash('sha256').update(pdfBytes).digest('hex') }));
  } finally {
    const child = sidecar.server?.child;
    const stopped = child && child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    sidecar.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await bounded(stopped, 'The isolated native kernel did not stop', 15000);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('z-astra-pdf-input-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
