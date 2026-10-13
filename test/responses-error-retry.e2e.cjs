'use strict';

// Real native kernel + staged provider bundles; all model traffic stays on the
// loopback fixture. Never attach to the desktop app or its saved runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { OpenCodeSidecar, buildOpenCodeConfig, stageResponsesProviderModule,
  stageGptlProviderModule, stopChildProcess } = require('../lib/opencode-sidecar');
const { PROMPT_RETRY_ATTEMPTS } = require('../lib/opencode-stability');
const { retryPolicy } = require('../vendor/opencode/runtime-patch.json');
const maxAttempts = retryPolicy.maxRetries + 1;

process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
process.env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
const appRoot = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-responses-error-retry-'));
const modelId = 'gpt-6-astra';
const exactMessage = 'An error occurred while processing the request.';
const fixtures = [];
const fixtureErrors = [];
const report = [];
let sequence = 0;

function unwrap(result) {
  if (result?.error) throw new Error(JSON.stringify(result.error));
  return result?.data;
}

async function deadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function startStream(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let sequenceNumber = 0;
  return value => response.write(`data: ${JSON.stringify({ ...value, sequence_number: sequenceNumber++ })}\n\n`);
}

function failStream(response, message = exactMessage) {
  const emit = startStream(response);
  emit({ type: 'error', error: { type: 'server_error', code: null, message, param: null } });
  response.end();
}

function badGateway(response) {
  response.writeHead(502, { 'Content-Type': 'text/html' });
  response.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
}

function completeStream(response, item) {
  const emit = startStream(response);
  const id = `resp_fixture_${++sequence}`;
  const info = { id, created_at: 1, model: modelId, status: 'in_progress', output: [],
    error: null, incomplete_details: null };
  emit({ type: 'response.created', response: info });
  if (item.type === 'function_call') {
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } });
    emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
    emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0,
      delta: item.content[0].text });
  }
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { ...info, status: 'completed', output: [item],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  response.end();
}

function textStream(response, text) {
  completeStream(response, { id: `msg_fixture_${++sequence}`, type: 'message', role: 'assistant',
    status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.match(request.url, /\/responses$/);
      const body = JSON.parse(raw);
      assert.equal(body.model, modelId);
      // Native title generation is not an execution attempt.
      if (!body.tools?.length) return textStream(response, 'Isolated error regression');
      const fixture = fixtures.findLast(item => JSON.stringify(body.input || []).includes(item.marker));
      assert.ok(fixture, 'unknown native model request');
      const toolOutput = (body.input || []).find(item => item.type === 'function_call_output'
        && item.call_id === fixture.callId);
      fixture.requests.push({ hasCompletedTool: !!toolOutput });
      assert.ok(fixture.requests.length <= maxAttempts + Number(fixture.sideEffect),
        'fixture exceeded its recovery/cancellation request budget');
      if (fixture.sideEffect && !toolOutput) {
        assert.ok(body.tools.some(tool => tool.name === 'bash'), 'native bash tool was not offered');
        fixture.toolOffers++;
        return completeStream(response, { id: `fc_${fixture.marker}_${fixture.toolOffers}`,
          type: 'function_call', status: 'completed', call_id: fixture.callId,
          name: 'bash', arguments: JSON.stringify({ command: fixture.command,
            description: 'Increment the isolated regression counter once', timeout: 5000 }) });
      }
      if (fixture.sideEffect) {
        assert.match(JSON.stringify(toolOutput.output), /SIDE_EFFECT_DONE/,
          'the next inference must preserve the completed tool result');
      }
      if (!fixture.persistent && fixture.errorsSent >= fixture.failuresBeforeSuccess) {
        return textStream(response, `${fixture.marker}_DONE`);
      }
      fixture.errorsSent++;
      if (fixture.gateway) badGateway(response);
      else failStream(response, fixture.message);
      if (fixture.cancel && fixture.errorsSent === fixture.cancelAfterErrors) fixture.onPersistentError?.();
    } catch (error) {
      fixtureErrors.push(error.message);
      if (!response.headersSent) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: error.message } }));
      }
      else response.end();
    }
  });
});

function fixtureFor(route, label, { sideEffect = false, persistent = false, cancel = false,
  gateway = false, failuresBeforeSuccess = 1, cancelAfterErrors = 2 } = {}) {
  const marker = `ERROR_CASE_${route}_${label}`;
  const workspace = path.join(temporary, marker);
  fs.mkdirSync(workspace);
  const counter = path.join(workspace, 'counter.txt');
  const script = path.join(workspace, 'increment.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs');const p=${JSON.stringify(counter)};` +
    `const n=(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1;` +
    `fs.writeFileSync(p,String(n));console.log('SIDE_EFFECT_DONE:'+n);`);
  const quote = value => `'${String(value).replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
  const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`;
  const fixture = { marker, workspace, counter, command, sideEffect, persistent, cancel, gateway,
    failuresBeforeSuccess, cancelAfterErrors, toolOffers: 0,
    callId: `call_${marker}`, message: gateway ? 'Bad Gateway' : exactMessage, requests: [], errorsSent: 0 };
  fixtures.push(fixture);
  return fixture;
}

async function runFixture(sidecar, config, providerId, route, fixture) {
  const runId = `run_${fixture.marker}`;
  const events = [];
  const nativeRetries = [];
  let nativeSessionId = '';
  const started = Date.now();
  let failure = '';
  let result;
  let cancellation;
  fixture.onPersistentError = () => {
    cancellation = (async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      const statuses = unwrap(await sidecar.client.session.status({ directory: fixture.workspace }));
      fixture.statusBeforeCancel = statuses?.[nativeSessionId]?.type || 'idle';
      fixture.cancelRequested = true;
      const cancelStarted = Date.now();
      fixture.cancelResult = await deadline(sidecar.cancel(runId), 10_000, 'native cancellation');
      fixture.cancelElapsedMs = Date.now() - cancelStarted;
    })();
    // Observe rejections here as well as awaiting the same promise below.
    cancellation.catch(() => {});
  };
  try {
    result = await deadline(sidecar.run({ runId, providerId, modelId, openCodeConfig: config,
      prompt: fixture.marker, workspace: fixture.workspace, directory: fixture.workspace,
      hasUserWorkspace: true, utility: true, workMode: 'normal', accessMode: 'full',
      enableSubagents: false, observerEnabled: false,
      permissions: { allowFileRead: true, allowFileWrite: true, allowShell: true, allowNetwork: false }
    }, event => {
      if (event.type === 'z.opencode.started') nativeSessionId = event.data?.sessionID || '';
      if (event.type === 'z.model.retrying') events.push(event.type);
      const status = event.properties?.status || event.data?.status;
      if (event.type === 'session.status' && status?.type === 'retry') nativeRetries.push(status);
    }), 120_000, fixture.marker);
    failure = String(result?.error || '');
  } catch (error) {
    failure = String(error?.message || error);
    result = error?.runResult;
  }

  if (cancellation) await cancellation;
  if (fixture.cancel) {
    assert.equal(failure, '');
    assert.equal(fixture.cancelRequested, true);
    assert.equal(fixture.cancelResult?.ok, true);
    assert.equal(result?.status, 'interrupted', 'persistent provider errors must remain cancellable');
    assert.equal(fixture.errorsSent, fixture.cancelAfterErrors);
    assert.equal(fixture.statusBeforeCancel, 'retry', 'cancellation should interrupt the backoff wait');
    assert.ok(fixture.cancelElapsedMs < 5000, 'cancellation must not wait out the retry delay');
    const before = fixture.requests.length;
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(fixture.requests.length, before, 'native kept retrying after cancellation');
    const statuses = unwrap(await sidecar.client.session.status({ directory: fixture.workspace }));
    assert.ok(!statuses?.[nativeSessionId] || statuses[nativeSessionId].type === 'idle');
  } else if (fixture.persistent) {
    assert.equal(fixture.cancelRequested, undefined, 'exhaustion must not require user cancellation');
    assert.equal(result?.status, 'error', `${fixture.marker}: ${failure}`);
    assert.match(failure, /Z_NATIVE_RETRY_EXHAUSTED/);
    assert.match(result.error, /An error occurred while processing the request\./);
    assert.equal(fixture.errorsSent, maxAttempts, 'exactly the initial attempt plus the native retry budget');
    assert.equal(fixture.requests.length, maxAttempts + Number(fixture.sideEffect));
    assert.equal(nativeRetries.length, retryPolicy.maxRetries);
    assert.equal(events.length, 0, 'native exhaustion must not start another prompt retry budget');
    const before = fixture.requests.length;
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(fixture.requests.length, before, 'native kept retrying after exhaustion');
    const statuses = unwrap(await sidecar.client.session.status({ directory: fixture.workspace }));
    assert.ok(!statuses?.[nativeSessionId] || statuses[nativeSessionId].type === 'idle');
    if (fixture.sideEffect) {
      assert.equal(result.toolCalls.filter(tool => tool.callId === fixture.callId && tool.status === 'completed').length, 1,
        'terminal failure must retain completed work for the desktop');
    }
  } else {
    assert.equal(failure, '', `${fixture.marker}: ${failure}; fixtureErrors=${JSON.stringify(fixtureErrors)}`);
    assert.equal(result?.status, 'done', 'transient provider failures must recover within the retry budget');
    assert.match(result?.text || '', new RegExp(`${fixture.marker}_DONE`));
    assert.equal(fixture.errorsSent, fixture.failuresBeforeSuccess);
    assert.equal(fixture.requests.length, fixture.failuresBeforeSuccess + 1 + Number(fixture.sideEffect));
    assert.equal(nativeRetries.length, fixture.failuresBeforeSuccess);
    assert.equal(events.length, 0, 'native recovery must stay within the existing prompt');
  }
  assert.doesNotMatch(failure, /Type validation failed|invalid_union|Known response chunk failed schema validation/);
  assert.ok(nativeRetries.length > 0, 'the original server error did not reach native retry handling');
  for (const retry of nativeRetries) {
    assert.ok(retry.message.includes(fixture.message), `retry lost the gateway error: ${retry.message}`);
    assert.doesNotMatch(retry.message, /Type validation failed|invalid_union/);
  }
  assert.ok(fixture.requests.length >= 1);
  assert.ok(events.length <= PROMPT_RETRY_ATTEMPTS - 1, 'sidecar prompt retry must remain bounded');
  assert.ok(nativeSessionId, 'native run session was not reported');
  const messages = unwrap(await sidecar.client.session.messages({ sessionID: nativeSessionId,
    directory: fixture.workspace }));
  const tools = messages.flatMap(message => message.parts || []).filter(part => part.type === 'tool');
  const unfinished = tools.filter(part => !['completed', 'error', 'cancelled', 'interrupted'].includes(part.state?.status));
  assert.equal(unfinished.length, 0, 'failure left an unsettled native tool');
  if (fixture.sideEffect) {
    assert.equal(fs.readFileSync(fixture.counter, 'utf8'), '1', 'completed tool side effect was repeated');
    assert.equal(fixture.toolOffers, 1, 'retry lost the completed tool history');
    assert.equal(tools.filter(part => part.callID === fixture.callId && part.state?.status === 'completed').length, 1);
    assert.ok(fixture.requests.slice(1).every(request => request.hasCompletedTool));
  } else {
    assert.equal(tools.length, 0);
    assert.equal(fs.existsSync(fixture.counter), false);
  }
  report.push({ route, scenario: fixture.marker, requests: fixture.requests.length,
    errorResponses: fixture.errorsSent, promptRetries: events.length,
    nativeRetryEvents: nativeRetries.length, sideEffects: fixture.sideEffect ? 1 : 0,
    status: result.status, ...(fixture.cancel ? { statusBeforeCancel: fixture.statusBeforeCancel,
      cancelElapsedMs: fixture.cancelElapsedMs } : {}),
    elapsedMs: Date.now() - started });
  console.log(JSON.stringify(report.at(-1)));
}

(async () => {
  let sidecar;
  let primaryError;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    for (const route of ['responses', 'gptl']) {
      const dataDir = path.join(temporary, route, 'data');
      const providerId = `isolated-${route}-errors`;
      sidecar = new OpenCodeSidecar({ appRoot, dataDir, log: { info() {}, warn() {}, error() {} } });
      const config = buildOpenCodeConfig({ providerId, modelId, apiFormat: 'responses',
        gptl: route === 'gptl', apiKey: 'isolated-fixture-key', baseUrl,
        responsesProviderModule: stageResponsesProviderModule({ appRoot, dataDir }),
        gptlProviderModule: stageGptlProviderModule({ appRoot, dataDir }),
        accessMode: 'full', enableSubagents: false, mcpServers: [],
        contextWindow: 262144, compactionThreshold: 200000, maxOutputTokens: 2048,
        capabilities: { maxOutputTokens: 2048 },
        permissions: { allowFileRead: true, allowFileWrite: true, allowShell: true, allowNetwork: false } });
      await deadline(sidecar.start(config), 90_000, `${route} startup`);
      for (const fixture of [fixtureFor(route, 'BEFORE_OUTPUT'),
        fixtureFor(route, 'AFTER_TOOL', { sideEffect: true }),
        fixtureFor(route, 'GATEWAY_AFTER_TOOL', { sideEffect: true, gateway: true, failuresBeforeSuccess: 4 }),
        fixtureFor(route, 'PERSISTENT_EXHAUSTED', { persistent: true }),
        fixtureFor(route, 'PERSISTENT_AFTER_TOOL', { persistent: true, sideEffect: true }),
        fixtureFor(route, 'PERSISTENT_CANCEL', { persistent: true, cancel: true, cancelAfterErrors: 4 })]) {
        await runFixture(sidecar, config, providerId, route, fixture);
        assert.deepEqual(fixtureErrors, []);
      }
      const child = sidecar.server?.child;
      const exited = child && child.exitCode === null ? once(child, 'exit') : Promise.resolve();
      sidecar.close();
      await deadline(exited, 10_000, `${route} shutdown`);
      sidecar = null;
    }
    console.log(JSON.stringify({ ok: true, cases: report }, null, 2));
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    try {
      const child = sidecar?.server?.child || sidecar?.startingChild;
      sidecar?.close();
      if (child && child.exitCode === null) {
        assert.equal(await deadline(stopChildProcess(child), 12_000, 'fixture process cleanup'), true);
      }
    } catch (error) { cleanupErrors.push(error); }
    try {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    } catch (error) { cleanupErrors.push(error); }
    try {
      const target = path.resolve(temporary);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith('z-responses-error-retry-'));
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      if (!primaryError) primaryError = cleanupErrors[0];
      else console.error(`Fixture cleanup also failed: ${cleanupErrors.map(error => error.message).join('; ')}`);
    }
  }
  if (primaryError) throw primaryError;
})().catch(error => { console.error(error); process.exitCode = 1; });
