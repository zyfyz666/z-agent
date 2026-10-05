'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { OpenCodeSidecar, buildOpenCodeConfig } = require('../lib/opencode-sidecar');

const appRoot = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z-shell-lifecycle-'));
const provider = 'z-shell-lifecycle-test';
const model = 'shell-test-model';
const cases = [];
const errors = [];
const children = [];
const report = { ok: false, cases: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ps = value => `'${String(value).replaceAll("'", "''")}'`;
function unwrap(result) { if (result.error) throw new Error(JSON.stringify(result.error)); return result.data; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < end, 'fixture condition timed out'); await sleep(100); }
}
function completion(response, message) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = { id: 'shell-fixture', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { role: 'assistant', ...message }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }];
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}
const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw || '{}');
      const text = JSON.stringify(body.messages || []);
      const testCase = cases.findLast(item => text.includes(item.marker));
      if (!body.tools?.length) return completion(response, { content: 'Isolated shell test' });
      assert.ok(testCase, 'unknown isolated test request');
      const index = testCase.requests++;
      const action = testCase.commands[index];
      if (!action) return completion(response, { content: `${testCase.marker}_DONE` });
      assert.ok(body.tools.some(tool => tool.function?.name === 'bash'));
      testCase.requestTimes.push(Date.now());
      completion(response, { tool_calls: [{ index: 0, id: `${testCase.marker}_${index}`, type: 'function',
        function: { name: 'bash', arguments: JSON.stringify(action) } }] });
    } catch (error) { errors.push(error); completion(response, { content: 'FIXTURE_FAILED' }); }
  });
});

function fixtureChild(label, delay = 15000) {
  const file = path.join(directory, `${label}.cjs`);
  const pidFile = path.join(directory, `${label}.pid`);
  const doneFile = path.join(directory, `${label}.done`);
  fs.writeFileSync(file, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
    `process.on('SIGTERM',()=>{});setTimeout(()=>{fs.writeFileSync(${JSON.stringify(doneFile)},'finished');process.exit(0)},${delay});`);
  const child = { file, pidFile, doneFile };
  children.push(child);
  return child;
}
function backgroundCommand(child, option) {
  return `$child=Start-Process -FilePath ${ps(process.execPath)} -ArgumentList ${ps('"' + child.file + '"')} ${option} -PassThru ` +
    `-RedirectStandardOutput ${ps(child.file + '.out')} -RedirectStandardError ${ps(child.file + '.err')}; Write-Output "CHILD_PID=$($child.Id)"`;
}
function testCase(label, commands) {
  const record = { marker: `SHELL_CASE_${label}`, commands, requests: 0, requestTimes: [] };
  cases.push(record); return record;
}

(async () => {
  const sidecar = new OpenCodeSidecar({ appRoot, dataDir: path.join(directory, 'data') });
  async function prompt(record, session) {
    const selected = session || unwrap(await sidecar.client.session.create({ directory }));
    const result = unwrap(await sidecar.client.session.prompt({ sessionID: selected.id, directory,
      model: { providerID: provider, modelID: model }, agent: 'build',
      parts: [{ type: 'text', text: record.marker }] }, { signal: AbortSignal.timeout(25000) }));
    assert.ok(result.parts.some(part => part.type === 'text' && part.text.includes(record.marker + '_DONE')));
    return { session: selected, result };
  }
  async function toolParts(session, record) {
    const messages = unwrap(await sidecar.client.session.messages({ sessionID: session.id, directory }));
    return messages.flatMap(message => message.parts || []).filter(part => part.type === 'tool' && part.callID?.startsWith(record.marker));
  }
  try {
    assert.equal(process.platform, 'win32', 'this native regression targets the pinned Windows runtime');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = buildOpenCodeConfig({ providerId: provider, modelId: model, accessMode: 'full',
      apiKey: 'isolated-fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      enableSubagents: false, mcpServers: [], capabilities: { contextWindow: 32768, maxOutputTokens: 8192 },
      permissions: { allowFileRead: true, allowFileWrite: true, allowShell: true, allowNetwork: false } });
    await sidecar.start(config);
    assert.match(sidecar.server.executable, /shell-lifecycle-v2/);
    for (const [label, option] of [['BACKGROUND_SAME_WINDOW', '-NoNewWindow'], ['BACKGROUND_HIDDEN', '-WindowStyle Hidden']]) {
      const child = fixtureChild(label);
      const record = testCase(label, [{ command: backgroundCommand(child, option), timeout: 10000 },
        { command: 'Write-Output "FOLLOWUP_OK"', timeout: 3000 }]);
      const started = Date.now();
      const { session } = await prompt(record);
      const elapsed = Date.now() - started;
      const parts = await toolParts(session, record);
      assert.ok(fs.existsSync(child.pidFile), `fixture child did not start: ${JSON.stringify(parts.map(part => part.state))}`);
      child.pid = Number(fs.readFileSync(child.pidFile, 'utf8'));
      assert.equal(alive(child.pid), true, 'background task must survive shell completion');
      assert.equal(fs.existsSync(child.doneFile), false, 'tool must return before background work finishes');
      assert.equal(parts.length, 2);
      const toolMs = parts[0].state.time.end - parts[0].state.time.start;
      assert.ok(toolMs < 5000, `background shell execution blocked ${toolMs}ms`);
      assert.ok(parts[0].state.output.includes('CHILD_PID='));
      assert.ok(parts[1].state.output.includes('FOLLOWUP_OK'));
      report.cases.push({ label, elapsed, toolMs, backgroundPreserved: true });
    }
    const foreground = fixtureChild('FOREGROUND', 30000);
    const timed = testCase('TIMEOUT', [{ command: `& ${ps(process.execPath)} ${ps(foreground.file)}`, timeout: 1000 },
      { command: 'Write-Output "FOLLOWUP_OK"', timeout: 3000 }]);
    let started = Date.now();
    const timedResult = await prompt(timed);
    assert.ok(Date.now() - started < 10000, 'foreground timeout cleanup must be bounded');
    foreground.pid = Number(fs.readFileSync(foreground.pidFile, 'utf8'));
    await until(() => !alive(foreground.pid), 3000);
    const timedParts = await toolParts(timedResult.session, timed);
    assert.match(timedParts[0].state.output, /exceeding timeout 1000 ms/);
    assert.match(timedParts[1].state.output, /FOLLOWUP_OK/);
    report.cases.push({ label: 'TIMEOUT', elapsed: Date.now() - started, foregroundStopped: true, continued: true });

    const abortedChild = fixtureChild('ABORTED', 30000);
    const aborted = testCase('ABORT', [{ command: backgroundCommand(abortedChild, '-NoNewWindow') + '; Start-Sleep -Seconds 30', timeout: 30000 }]);
    const abortSession = unwrap(await sidecar.client.session.create({ directory }));
    const pending = sidecar.client.session.prompt({ sessionID: abortSession.id, directory,
      model: { providerID: provider, modelID: model }, agent: 'build',
      parts: [{ type: 'text', text: aborted.marker }] }, { signal: AbortSignal.timeout(25000) });
    await until(() => fs.existsSync(abortedChild.pidFile), 10000);
    abortedChild.pid = Number(fs.readFileSync(abortedChild.pidFile, 'utf8'));
    started = Date.now();
    unwrap(await sidecar.client.session.abort({ sessionID: abortSession.id, directory }));
    await pending;
    assert.ok(Date.now() - started < 8000, 'abort with inherited pipes must return promptly');
    await until(() => !alive(abortedChild.pid), 3000);
    const resumed = testCase('RESUME_AFTER_ABORT', [{ command: 'Write-Output "FOLLOWUP_OK"', timeout: 3000 }]);
    await prompt(resumed, abortSession);
    report.cases.push({ label: 'ABORT', elapsed: Date.now() - started, foregroundTreeStopped: true, continued: true });

    const outputCase = testCase('OUTPUT_DRAIN', [{ command: 'Write-Output ("x" * 16384); [Console]::Error.WriteLine("STDERR_TAIL"); Write-Output "STDOUT_TAIL"', timeout: 5000 }]);
    const outputResult = await prompt(outputCase);
    const output = (await toolParts(outputResult.session, outputCase))[0].state.output;
    assert.match(output, /STDERR_TAIL/); assert.match(output, /STDOUT_TAIL/);
    report.cases.push({ label: 'OUTPUT_DRAIN', stdoutAndStderrPreserved: true });
    for (const child of children.slice(0, 2)) await until(() => fs.existsSync(child.doneFile), 20000);
    assert.deepEqual(errors, []);
    report.ok = true;
  } finally {
    const process = sidecar.server?.child;
    const exited = process && process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
    sidecar.close(); await exited;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const child of children) {
      const pid = child.pid || (fs.existsSync(child.pidFile) ? Number(fs.readFileSync(child.pidFile, 'utf8')) : 0);
      if (pid > 0 && alive(pid)) { try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }); } catch {} }
    }
    fs.mkdirSync(path.join(appRoot, 'output', 'shell-lifecycle'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'output', 'shell-lifecycle', 'report.json'), JSON.stringify(report, null, 2));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('z-shell-lifecycle-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
