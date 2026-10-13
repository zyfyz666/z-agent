'use strict';

// Real staged native kernel and provider bundles. Every model request goes to
// the loopback fixture; no desktop app or saved user runtime is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { retryPolicy } = require('../vendor/opencode/runtime-patch.json');
const maxAttempts = retryPolicy.maxRetries + 1;
let OpenCodeSidecar, buildOpenCodeConfig, stageResponsesProviderModule,
  stageGptlProviderModule, stopChildProcess;

process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
process.env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
const appRoot = path.resolve(__dirname, '..');
const output = path.join(appRoot, 'output', 'subagent-error-retry');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z-subagent-error-retry-'));
const modelId = 'gpt-6-astra';
const exactMessage = 'An error occurred while processing the request.';
const invalidMessage = 'The isolated child request is invalid and must not be retried.';
const permissions = { allowFileRead: true, allowFileWrite: false, allowShell: false, allowNetwork: false };
const fixtures = [];
const fixtureErrors = [];
const nativeLogs = [];
const report = { ok: false, cases: [], errors: [] };
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

async function waitForNativePatch() {
  const patchFile = path.join(appRoot, 'vendor', 'opencode', 'runtime-patch.json');
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const patch = fs.readFileSync(patchFile, 'utf8');
    if (patch.includes('[Z_NATIVE_RETRY_EXHAUSTED]') && patch.includes('[Z_SUBAGENT_FAILED]')) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('The native bounded-retry and task-failure patches are required before this E2E runs.');
}

function startStream(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let sequenceNumber = 0;
  return value => response.write(`data: ${JSON.stringify({ ...value, sequence_number: sequenceNumber++ })}\n\n`);
}

function failStream(response) {
  // Keep this gateway event exact, including nullable code/param and sequence 0.
  const emit = startStream(response);
  emit({ type: 'error', error: { type: 'server_error', code: null, message: exactMessage, param: null } });
  response.end();
}

function invalidRequest(response) {
  response.writeHead(400, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_request_error',
    message: invalidMessage, param: null } }));
}

function textItem(text) {
  return { id: `msg_fixture_${++sequence}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
}

function completeStream(response, items) {
  const emit = startStream(response);
  const info = { id: `resp_fixture_${++sequence}`, created_at: 1, model: modelId,
    status: 'in_progress', output: [], error: null, incomplete_details: null };
  emit({ type: 'response.created', response: info });
  for (const [index, item] of items.entries()) {
    if (item.type === 'function_call') {
      emit({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '' } });
      emit({ type: 'response.function_call_arguments.delta', item_id: item.id,
        output_index: index, delta: item.arguments });
      emit({ type: 'response.function_call_arguments.done', item_id: item.id,
        output_index: index, arguments: item.arguments });
    } else {
      emit({ type: 'response.output_item.added', output_index: index, item: { ...item, content: [] } });
      emit({ type: 'response.output_text.delta', item_id: item.id,
        output_index: index, content_index: 0, delta: item.content[0].text });
    }
    emit({ type: 'response.output_item.done', output_index: index, item });
  }
  emit({ type: 'response.completed', response: { ...info, status: 'completed', output: items,
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  response.end();
}

function nativeTool(body, name) {
  const tool = body.tools?.find(item => item.type === 'function' && item.name === name);
  assert.ok(tool, `native ${name} tool was not offered`);
  assert.equal(tool.parameters?.type, 'object', `native ${name} schema must be an object`);
  return tool;
}

function taskCall(body, fixture) {
  const tool = nativeTool(body, 'task');
  const properties = tool.parameters.properties || {};
  for (const key of ['description', 'prompt', 'subagent_type']) {
    assert.equal(properties[key]?.type, 'string', `native task schema missing ${key}`);
  }
  if (properties.subagent_type.enum) assert.ok(properties.subagent_type.enum.includes('explorer'));
  const args = { description: 'Isolated child failure regression', subagent_type: 'explorer',
    prompt: `z-plan: {"id":"failure-probe","acceptance":"Return the isolated fixture evidence or its exact failure"}\n`
      + `${fixture.childMarker}\nRead only ${fixture.evidenceFile} if a file read is needed. Return a concise report.` };
  for (const key of tool.parameters.required || []) assert.ok(key in args,
    `native task gained an unsupported required parameter: ${key}`);
  fixture.taskSchema = tool.parameters;
  fixture.taskOffers++;
  return { id: `fc_${fixture.marker}`, type: 'function_call', status: 'completed',
    call_id: fixture.taskCallId, name: 'task', arguments: JSON.stringify(args) };
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
      const serialized = JSON.stringify(body.input || []);
      const fixture = fixtures.findLast(item => serialized.includes(item.marker));
      // Native title generation is auxiliary and uses no tools.
      if (!fixture && !body.tools?.length) return completeStream(response, [textItem('Isolated child regression')]);
      assert.ok(fixture, 'unknown native model request');
      const parent = body.tools?.some(tool => tool.name === 'task');
      const requestRecord = { kind: parent ? 'parent' : 'child', body };
      fixture.requests.push(requestRecord);
      assert.ok(fixture.requests.length <= maxAttempts + 2, 'native child exceeded the bounded fixture request budget');
      if (parent) {
        fixture.parentRequests++;
        const taskOutput = (body.input || []).find(item => item.type === 'function_call_output'
          && item.call_id === fixture.taskCallId);
        if (fixture.parentRequests === 1) {
          assert.equal(taskOutput, undefined);
          return completeStream(response, [taskCall(body, fixture)]);
        }
        assert.equal(fixture.parentRequests, 2, 'main model must finish after consuming the failed task');
        assert.ok(taskOutput, 'main model continuation lost the native task result');
        fixture.parentTaskOutput = typeof taskOutput.output === 'string'
          ? taskOutput.output : JSON.stringify(taskOutput.output);
        assert.match(fixture.parentTaskOutput, /\[Z_SUBAGENT_FAILED\]/,
          'child failure was returned as a completed or empty task result');
        assert.ok(fixture.parentTaskOutput.includes(fixture.message), 'main model lost the original child error');
        assert.doesNotMatch(fixture.parentTaskOutput, /Type validation failed|invalid_union|Known response chunk failed schema validation/);
        if (!fixture.nonretryable) assert.match(fixture.parentTaskOutput, /\[Z_NATIVE_RETRY_EXHAUSTED\]/);
        else assert.doesNotMatch(fixture.parentTaskOutput, /\[Z_NATIVE_RETRY_EXHAUSTED\]/);
        return completeStream(response, [textItem(`${fixture.marker}_PARENT_DONE`)]);
      }
      assert.ok(serialized.includes(fixture.childMarker), 'unexpected child prompt');
      fixture.childRequests++;
      if (fixture.nonretryable) {
        const readOutput = (body.input || []).find(item => item.type === 'function_call_output'
          && item.call_id === fixture.readCallId);
        if (fixture.childRequests === 1) {
          assert.equal(readOutput, undefined);
          const read = nativeTool(body, 'read');
          assert.equal(read.parameters.properties?.filePath?.type, 'string');
          fixture.readOffers++;
          return completeStream(response, [textItem(fixture.partialText), {
            id: `fc_read_${fixture.marker}`, type: 'function_call', status: 'completed',
            call_id: fixture.readCallId, name: 'read', arguments: JSON.stringify({ filePath: fixture.evidenceFile })
          }]);
        }
        assert.equal(fixture.childRequests, 2, 'non-retryable child error triggered another inference');
        assert.ok(readOutput, 'completed child tool output was lost');
        assert.ok(JSON.stringify(readOutput.output).includes(fixture.evidence), 'child read returned the wrong fixture evidence');
        fixture.errorsSent++;
        return invalidRequest(response);
      }
      fixture.errorsSent++;
      assert.ok(fixture.errorsSent <= maxAttempts, 'persistent child error exceeded the native retry budget');
      failStream(response);
    } catch (error) {
      fixtureErrors.push(error.stack || String(error));
      if (!response.headersSent) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: error.message } }));
      } else response.end();
    }
  });
});

function fixtureFor(route, nonretryable) {
  const marker = `SUBAGENT_ERROR_${route}_${nonretryable ? 'NONRETRYABLE_AFTER_READ' : 'PERSISTENT_NULL_ERROR'}`;
  const workspace = path.join(temporary, marker);
  fs.mkdirSync(workspace);
  const fixture = { marker, childMarker: `CHILD_${marker}`, workspace, nonretryable,
    message: nonretryable ? invalidMessage : exactMessage,
    evidenceFile: path.join(workspace, 'evidence.txt'), evidence: `${marker}_READ_EVIDENCE`,
    partialText: `${marker}_PARTIAL: I have started inspecting the isolated evidence.`,
    taskCallId: `call_task_${marker}`, readCallId: `call_read_${marker}`,
    requests: [], parentRequests: 0, childRequests: 0, errorsSent: 0, taskOffers: 0, readOffers: 0 };
  fs.writeFileSync(fixture.evidenceFile, `${fixture.evidence}\n`);
  fixtures.push(fixture);
  return fixture;
}

async function runFixture(sidecar, config, providerId, route, fixture) {
  const started = Date.now();
  const runId = `run_${fixture.marker}`;
  let parentSessionId = '';
  const childSessionIds = new Set();
  const events = [];
  fixture.events = events;
  const childRetries = [];
  const result = await deadline(sidecar.run({ runId, providerId, modelId, openCodeConfig: config,
    prompt: fixture.marker, workspace: fixture.workspace, directory: fixture.workspace,
    hasUserWorkspace: true, utility: true, workMode: 'normal', accessMode: 'full',
    enableSubagents: true, observerEnabled: false, permissions
  }, event => {
    events.push(event);
    if (event.type === 'z.opencode.started') parentSessionId = event.data?.sessionID || '';
    if (event.type === 'z.subagent.event' && event.data?.childSessionID) {
      childSessionIds.add(event.data.childSessionID);
      const inner = event.data.event;
      const status = inner?.properties?.status || inner?.data?.status;
      if (inner?.type === 'session.status' && status?.type === 'retry') childRetries.push(status);
    }
  }), 120_000, fixture.marker);
  assert.deepEqual(fixtureErrors, [], 'loopback fixture rejected a native request');
  assert.equal(result?.error || '', '', JSON.stringify(result));
  assert.equal(result?.status, 'done', 'main model did not recover and finish after child failure');
  assert.ok(result?.text?.includes(`${fixture.marker}_PARENT_DONE`));
  assert.equal(fixture.parentRequests, 2);
  assert.equal(fixture.taskOffers, 1, 'task delegation was silently repeated');
  assert.equal(fixture.childRequests, fixture.nonretryable ? 2 : maxAttempts);
  assert.equal(fixture.errorsSent, fixture.nonretryable ? 1 : maxAttempts);
  assert.equal(events.filter(event => event.type === 'z.model.retrying').length, 0,
    'child failure must be consumed in the existing parent prompt');
  assert.ok(parentSessionId, 'native parent session was not reported');
  const parentMessages = unwrap(await sidecar.client.session.messages({ sessionID: parentSessionId,
    directory: fixture.workspace }));
  fixture.parentMessages = parentMessages;
  const parentTools = parentMessages.flatMap(message => message.parts || []).filter(part => part.type === 'tool');
  const tasks = parentTools.filter(part => part.tool === 'task' && part.callID === fixture.taskCallId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].state?.status, 'error', 'native task persisted a failed child as completed');
  assert.match(tasks[0].state.error, /\[Z_SUBAGENT_FAILED\]/);
  assert.ok(tasks[0].state.error.includes(fixture.message));
  const metadata = tasks[0].state.metadata || {};
  const metadataSessionId = metadata.sessionId || metadata.sessionID || metadata.childSessionID;
  if (metadataSessionId) childSessionIds.add(metadataSessionId);
  assert.equal(childSessionIds.size, 1, 'expected exactly one native child session');
  const [childSessionId] = childSessionIds;
  const childMessages = unwrap(await sidecar.client.session.messages({ sessionID: childSessionId,
    directory: fixture.workspace }));
  fixture.childMessages = childMessages;
  const childTools = childMessages.flatMap(message => message.parts || []).filter(part => part.type === 'tool');
  assert.ok(childMessages.some(message => JSON.stringify(message.info?.error || '').includes(fixture.message)),
    'native child history lost the terminal provider error');
  for (const tool of [...parentTools, ...childTools]) assert.ok(
    ['completed', 'error', 'cancelled', 'interrupted'].includes(tool.state?.status),
    `child failure left an unsettled ${tool.tool} tool`);
  if (fixture.nonretryable) {
    assert.equal(fixture.readOffers, 1);
    const reads = childTools.filter(part => part.tool === 'read' && part.callID === fixture.readCallId);
    assert.equal(reads.length, 1, 'completed child read was repeated or erased');
    assert.equal(reads[0].state.status, 'completed');
    assert.ok(reads[0].state.output.includes(fixture.evidence));
    assert.ok(childMessages.flatMap(message => message.parts || []).some(part => part.type === 'text'
      && part.text.includes(fixture.partialText)), 'child partial text was erased by a later error');
    assert.equal(childRetries.length, 0, 'invalid child requests must fail without a native retry');
  } else {
    assert.equal(childTools.length, 0);
    assert.equal(childRetries.length, retryPolicy.maxRetries, 'native child must use the same bounded retry policy as the parent');
    for (const retry of childRetries) assert.ok(retry.message.includes(exactMessage));
  }
  const before = fixture.requests.length;
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(fixture.requests.length, before, 'native child continued inference after terminal failure');
  const statuses = unwrap(await sidecar.client.session.status({ directory: fixture.workspace }));
  for (const sessionId of [parentSessionId, childSessionId]) assert.ok(
    !statuses?.[sessionId] || statuses[sessionId].type === 'idle', 'a native session stayed busy after failure');
  const row = { route, scenario: fixture.marker, parentRequests: fixture.parentRequests,
    childRequests: fixture.childRequests, errorResponses: fixture.errorsSent,
    nativeRetries: childRetries.length, taskStatus: tasks[0].state.status,
    completedChildReads: childTools.filter(tool => tool.tool === 'read' && tool.state.status === 'completed').length,
    status: result.status, elapsedMs: Date.now() - started };
  report.cases.push(row);
  console.log(JSON.stringify(row));
}

(async () => {
  let sidecar;
  let primaryError;
  try {
    await waitForNativePatch();
    // Load the manifest-dependent module only after both patches are present.
    ({ OpenCodeSidecar, buildOpenCodeConfig, stageResponsesProviderModule,
      stageGptlProviderModule, stopChildProcess } = require('../lib/opencode-sidecar'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    for (const route of ['responses', 'gptl']) {
      const dataDir = path.join(temporary, route, 'data');
      const providerId = `isolated-${route}-child-errors`;
      sidecar = new OpenCodeSidecar({ appRoot, dataDir, log: Object.fromEntries(
        ['info', 'warn', 'error'].map(level => [level, (...args) => nativeLogs.push({ route, level, text: args.join(' ') })])) });
      const config = buildOpenCodeConfig({ providerId, modelId, apiFormat: 'responses',
        gptl: route === 'gptl', apiKey: 'isolated-fixture-key', baseUrl,
        responsesProviderModule: stageResponsesProviderModule({ appRoot, dataDir }),
        gptlProviderModule: stageGptlProviderModule({ appRoot, dataDir }),
        accessMode: 'full', enableSubagents: true, mcpServers: [],
        contextWindow: 262144, compactionThreshold: 200000, maxOutputTokens: 2048,
        capabilities: { maxOutputTokens: 2048 }, permissions });
      await deadline(sidecar.start(config), 90_000, `${route} startup`);
      const stagedPath = path.relative(dataDir, sidecar.server.executable);
      assert.ok(stagedPath && !stagedPath.startsWith('..') && !path.isAbsolute(stagedPath),
        'native E2E must use the staged runtime inside its isolated data directory');
      for (const nonretryable of [false, true]) {
        await runFixture(sidecar, config, providerId, route, fixtureFor(route, nonretryable));
      }
      const child = sidecar.server?.child;
      nativeLogs.push({ route, level: 'native-output', text: sidecar.server?.output?.() || '' });
      const exited = child && child.exitCode === null ? once(child, 'exit') : Promise.resolve();
      sidecar.close();
      await deadline(exited, 10_000, `${route} shutdown`);
      sidecar = null;
    }
    assert.deepEqual(fixtureErrors, []);
    report.ok = true;
  } catch (error) { primaryError = error; }
  finally {
    const cleanupErrors = [];
    try {
      const child = sidecar?.server?.child || sidecar?.startingChild;
      if (sidecar) nativeLogs.push({ level: 'native-output', text: sidecar.server?.output?.() || '' });
      sidecar?.close();
      if (child && child.exitCode === null) assert.equal(
        await deadline(stopChildProcess(child), 12_000, 'fixture process cleanup'), true);
    } catch (error) { cleanupErrors.push(error); }
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    } catch (error) { cleanupErrors.push(error); }
    try {
      const target = path.resolve(temporary);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith('z-subagent-error-retry-'));
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      if (!primaryError) primaryError = cleanupErrors[0];
      report.errors.push(...cleanupErrors.map(error => error.stack || String(error)));
    }
    if (primaryError) {
      report.ok = false;
      report.errors.unshift(primaryError.stack || String(primaryError));
    }
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(output, 'native-log.json'), JSON.stringify(nativeLogs, null, 2));
    fs.writeFileSync(path.join(output, 'fixture-evidence.json'), JSON.stringify({ fixtures, fixtureErrors }, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
  if (primaryError) throw primaryError;
})().catch(error => { console.error(error); process.exitCode = 1; });
