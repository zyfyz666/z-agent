'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');

async function startBridge() {
  const requests = [];
  const closedOperations = new Set();
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let input = '';
    let operationId = '';
    socket.on('data', chunk => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      operationId = String(request.operationId || '');
      requests.push(request);
      if (request.action === 'click') {
        if (request.params.ref === 'disconnect') socket.end();
        else socket.end(`${JSON.stringify({ ok: false, code: 'BROWSER_ACTION_CANCELLED', error: 'Cancelled',
          ...(request.params.ref === 'dispatched' ? { uncertain: true } : {}) })}\n`);
      }
      if (request.action === 'status') {
        socket.end(`${JSON.stringify({ ok: true, result: { ok: true, url: 'https://example.test/' } })}\n`);
      }
      if (request.action === 'apply_annotation') socket.end(`${JSON.stringify({ok:true,result:{ok:true,styles:request.params.styles,text:request.params.text}})}\n`);
      if (['tabs', 'find', 'snapshot', 'read_page', 'back', 'forward', 'reload', 'open'].includes(request.action)) {
        socket.end(`${JSON.stringify({ ok: true, result: { ok: true, action: request.action, params: request.params } })}\n`);
      }
      if (request.action === 'screenshot') {
        socket.end(`${JSON.stringify({ ok: true, result: {
          ok: true,
          url: 'https://example.test/',
          image: { mimeType: 'image/png', data: 'AAAA' }
        } })}\n`);
      }
    });
    socket.on('close', () => {
      if (operationId) closedOperations.add(operationId);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port, requests, closedOperations };
}

function startMcp(port, { networkAllowed = true } = {}) {
  const child = spawn(process.execPath, [path.join(appRoot, 'lib', 'z-browser-mcp.js')], {
    cwd: appRoot,
    env: {
      ...process.env,
      Z_BROWSER_BRIDGE_PORT: String(port),
      Z_BROWSER_BRIDGE_TOKEN: 'test-token',
      Z_BROWSER_ALLOW_NETWORK: String(networkAllowed)
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    while (buffered.includes('\n')) {
      const newline = buffered.indexOf('\n');
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 5_000);
    pending.set(id, message => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return { child, send, request };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Condition was not met before timeout.');
}

test('Z browser MCP transports operation identity and cancellation', async t => {
  const bridge = await startBridge();
  const mcp = startMcp(bridge.port);
  t.after(() => {
    mcp.child.kill();
    bridge.server.close();
  });

  const initialized = await mcp.request(1, 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(initialized.result.serverInfo.name, 'Z Built-in Browser');
  const listed = await mcp.request(2, 'tools/list');
  const snapshot = listed.result.tools.find(tool => tool.name === 'browser_snapshot');
  assert.match(snapshot.description, /latest snapshot/i);
  assert.ok(listed.result.tools.find(tool=>tool.name==='browser_apply_annotation'));
  const annotation=await mcp.request(20,'tools/call',{name:'browser_apply_annotation',arguments:{text:'修改文字',styles:{fontSize:'23px'}}});
  assert.equal(annotation.result.structuredContent.text,'修改文字');
  assert.equal(annotation.result.structuredContent.styles.fontSize,'23px');

  const status = await mcp.request(3, 'tools/call', { name: 'browser_status', arguments: {} });
  assert.equal(status.result.structuredContent.url, 'https://example.test/');
  assert.match(bridge.requests[0].operationId, /^browser-/);
  assert.equal(bridge.requests[0].token, 'test-token');

  const screenshotTool = listed.result.tools.find(tool => tool.name === 'browser_screenshot');
  assert.equal(screenshotTool.inputSchema.properties.question.type, 'string');
  assert.equal(screenshotTool.inputSchema.properties.compare_to_previous.type, 'boolean');
  const screenshot = await mcp.request(4, 'tools/call', { name: 'browser_screenshot',
    arguments: { question: '双皮带是否可见', compare_to_previous: true } });
  assert.equal(screenshot.result.structuredContent.ok, true);
  assert.equal(screenshot.result.content.some(part => part.type === 'image'), true);
  const screenshotRequest = bridge.requests.find(request => request.action === 'screenshot');
  assert.equal(screenshotRequest.params.question, '双皮带是否可见');
  assert.equal(screenshotRequest.params.compare_to_previous, true);

  const waiting = mcp.request(5, 'tools/call', { name: 'browser_wait', arguments: { timeout_ms: 5000 } });
  await waitFor(() => bridge.requests.some(request => request.action === 'wait'));
  const waitRequest = bridge.requests.find(request => request.action === 'wait');
  mcp.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
  const cancelled = await waiting;
  assert.equal(cancelled.result.isError, true);
  assert.equal(cancelled.result.structuredContent.code, 'BROWSER_ACTION_CANCELLED');
  assert.equal(cancelled.result.structuredContent.uncertain, true);
  await waitFor(() => bridge.closedOperations.has(waitRequest.operationId));
});

test('browser tools preserve explicit tab targets and semantic/pagination arguments end to end', async t => {
  const bridge = await startBridge();
  const mcp = startMcp(bridge.port);
  t.after(() => { mcp.child.kill(); bridge.server.close(); });
  const listed = (await mcp.request(1, 'tools/list')).result.tools;
  for (const tool of listed) {
    if (tool.name !== 'browser_apply_annotation') assert.equal(tool.inputSchema.properties.tab_id.type, 'string');
  }
  assert.deepEqual(listed.find(tool => tool.name === 'browser_tabs').inputSchema.properties.action.enum, ['list', 'new', 'select', 'close']);
  assert.ok(listed.find(tool => tool.name === 'browser_wait').inputSchema.properties.state.enum.includes('editable'));
  const examples = [
    ['browser_tabs', 'tabs', { action: 'new', target_type: 'url', url_or_path: 'https://example.test/second' }],
    ['browser_tabs', 'tabs', { action: 'select', tab_id: 'tab-second' }],
    ['browser_find', 'find', { tab_id: 'tab-second', role: 'button', name: 'Submit', exact: true, offset: 2, limit: 5 }],
    ['browser_snapshot', 'snapshot', { tab_id: 'tab-first', viewport_only: true, query: 'Account', offset: 180, limit: 20 }],
    ['browser_read_page', 'read_page', { tab_id: 'tab-first', offset: 16000, limit: 4000, ref: 'e21' }],
    ['open_builtin_browser', 'open', { target_type: 'url', url_or_path: 'https://example.test/third', new_tab: true }]
  ];
  for (let index = 0; index < examples.length; index++) {
    const [name, action, input] = examples[index];
    const response = await mcp.request(10 + index, 'tools/call', { name, arguments: input });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.action, action);
    assert.deepEqual(response.result.structuredContent.params, input);
  }
  const history = await mcp.request(30, 'tools/call', { name: 'browser_history', arguments: { action: 'back', tab_id: 'tab-first' } });
  assert.deepEqual(history.result.structuredContent.params, { tab_id: 'tab-first' });
  const before = bridge.requests.length;
  const invalid = await mcp.request(31, 'tools/call', { name: 'browser_history', arguments: { action: 'open', tab_id: 'tab-first' } });
  assert.equal(invalid.result.isError, true);
  assert.equal(bridge.requests.length, before);
  const conflicting = await mcp.request(32, 'tools/call', { name: 'open_builtin_browser', arguments: {
    target_type: 'url', url_or_path: 'https://example.test/new', tab_id: 'tab-first', new_tab: true
  } });
  assert.equal(conflicting.result.isError, true);
  assert.match(conflicting.result.structuredContent.error, /either new_tab or tab_id/);
  assert.equal(bridge.requests.length, before, 'Conflicting tab options never navigate an existing page');
});

test('browser MCP preserves dispatch uncertainty but not for authoritative queued cancellation', async t => {
  const bridge = await startBridge();
  const mcp = startMcp(bridge.port);
  t.after(() => { mcp.child.kill(); bridge.server.close(); });
  for (const [index, ref] of ['queued', 'dispatched', 'disconnect'].entries()) {
    const response = await mcp.request(index + 1, 'tools/call', { name: 'browser_click', arguments: { ref } });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.uncertain === true, ref !== 'queued');
    assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
  }
});

test('network-disabled tools allow tab inventory and local tabs but reject remote tab creation', async t => {
  const bridge = await startBridge();
  const mcp = startMcp(bridge.port, { networkAllowed: false });
  t.after(() => { mcp.child.kill(); bridge.server.close(); });
  const blocked = await mcp.request(1, 'tools/call', { name: 'browser_tabs', arguments: {
    action: 'new', target_type: 'url', url_or_path: 'https://example.test/'
  } });
  assert.equal(blocked.result.isError, true);
  assert.equal(bridge.requests.length, 0);
  for (const [index, input] of [{ action: 'list' }, { action: 'new' },
    { action: 'new', target_type: 'file', url_or_path: 'C:/synthetic/preview.html' }].entries()) {
    const response = await mcp.request(index + 2, 'tools/call', { name: 'browser_tabs', arguments: input });
    assert.equal(response.result.isError, false);
  }
});
