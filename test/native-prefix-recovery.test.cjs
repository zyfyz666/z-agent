'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readNativePrefix } = require('../lib/native-prefix-recovery-worker.cjs');
const { recoverNativePrefix, legacyHistorySystem, verifiedLegacySeed, nativePrefixDigest, nativePrefixContentDigest } = require('../lib/native-prefix-recovery');
const { desktopHistoryDigest } = require('../lib/desktop-context-checkpoint');
const { verifyNativeDesktopCoverage } = require('../lib/native-desktop-coverage');

const clone = value => JSON.parse(JSON.stringify(value));
const desktopAssistant = (text, id, status = 'done', timeline = []) => ({ role: 'assistant', content: text,
  agentRun: { status, timeline: [...timeline, { type: 'text', openCodeKey: `text:${id}`, content: text }] } });

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-native-prefix-test-'));
  const directory = path.join(dataDir, 'workspace');
  const dbPath = path.join(dataDir, 'opencode-runtime', 'data', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  let open = true;
  t.after(() => {
    if (open) db.close();
    const target = path.resolve(dataDir);
    if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('z-native-prefix-test-')) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, metadata TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?,NULL,?,?)').run('ses_original', directory,
    JSON.stringify({ zSessionID: 'sess_original', zWorkMode: 'normal' }));
  const native = [];
  function append(id, role, parts, extra = {}) {
    const at = 1000 + native.length * 100;
    const info = { role, time: { created: at, ...(role === 'assistant' ? { completed: at + 80 } : {}) },
      ...(role === 'assistant' ? { finish: 'stop' } : {}), ...extra };
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, 'ses_original', at, JSON.stringify(info));
    parts.forEach((part, index) => {
      const { id: partId, ...body } = part;
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(partId, id, 'ses_original', at + index, JSON.stringify(body));
    });
    const message = { info: { ...info, id, sessionID: 'ses_original' },
      parts: parts.map(part => ({ ...part, messageID: id, sessionID: 'ses_original' })) };
    native.push(message);
    return message;
  }
  const turn = text => `${text}\n\n<z-turn-context task_id="fixture">Current runtime data</z-turn-context>`;
  const desktop = [{ role: 'user', content: 'Historical objective and constraints' },
    desktopAssistant('Earlier completed result '.repeat(500), 'prt_earlier'),
    { role: 'user', content: 'Continue requested work' }];
  append('msg_0001', 'user', [{ id: 'prt_0001', type: 'text', text: turn(`${legacyHistorySystem(desktop.slice(0, 2))}\n\nContinue requested work`) }]);
  append('msg_0002', 'assistant', [
    { id: 'prt_0002a', type: 'tool', tool: 'bash', callID: 'call_abort', state: { status: 'completed',
      input: { command: 'fixture-command' }, output: '(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>',
      time: { start: 1101, end: 1170, compacted: 9999 } } },
    { id: 'prt_0002b', type: 'text', text: 'Work before cancellation' }
  ], { parentID: 'msg_0001' });
  desktop.push(desktopAssistant('Work before cancellation', 'prt_0002b', 'interrupted', [
    { type: 'tool_call', callId: 'call_abort', name: 'bash', args: { command: 'fixture-command' } },
    { type: 'tool_result', callId: 'call_abort', name: 'bash', output: '', ok: false, interrupted: true }
  ]), { role: 'user', content: 'Continue after cancellation' });
  append('msg_0003', 'user', [{ id: 'prt_0003', type: 'text', text: turn('Continue after cancellation') }]);
  append('msg_0004', 'assistant', [{ id: 'prt_0004', type: 'text',
    text: 'Final retained result\n\n<z-delivery-contract>\nintent: presentable\nartifact: answer\n</z-delivery-contract>' }], { parentID: 'msg_0003' });
  desktop.push(desktopAssistant('Final retained result', 'prt_0004'));
  Object.assign(desktop.at(-1).agentRun, { todos: [{ text: 'Completed work', done: true }],
    subagents: [{ title: 'Completed child', status: 'done', result: 'Evidence' }] });
  desktop.at(-1).agentRun.timeline.push({ type: 'subagent_status', status: 'completed' }, { type: 'delivery_contract', contract: { intent: 'presentable' } });
  const request = { zSessionId: 'sess_branch', conversationRevision: 2, workMode: 'normal',
    forkHistory: { sourceSessionId: 'sess_original' } };
  return { dataDir, dbPath, directory, db, native, desktop, request, append, turn,
    close() { if (open) { db.close(); open = false; } },
    read(overrides = {}) { return readNativePrefix({ dbPath, directory, messages: desktop, request, ...overrides }); },
    updatePart(id, update) {
      const original = JSON.parse(db.prepare('SELECT data FROM part WHERE id=?').get(id).data);
      update(original);
      db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(original), id);
    } };
}

test('uncompacted legacy native context is recovered exactly without rewriting desktop or database', t => {
  const f = fixture(t); f.close();
  const checksum = () => crypto.createHash('sha256').update(fs.readFileSync(f.dbPath)).digest('hex');
  const before = checksum(), desktop = JSON.stringify(f.desktop);
  const result = f.read();
  assert.ok(result.prefix, result.reason);
  assert.equal(result.prefix.desktopPrefix.messageCount, 6);
  assert.equal(result.prefix.provenance.seedMessageCount, 2);
  assert.equal(result.prefix.sourceMessageCount, 4);
  assert.equal(result.prefix.messageID, 'msg_00040');
  assert.equal(result.prefix.sourceHash, nativePrefixDigest(f.native));
  assert.deepEqual(result.prefix.desktopTail, []);
  assert.equal(checksum(), before);
  assert.equal(JSON.stringify(f.desktop), desktop);
  assert.equal(verifyNativeDesktopCoverage(f.native, f.desktop).reason, 'unverified-history-seed', 'summary coverage remains strict');
});

test('native clone comparison normalizes only remapped envelopes and keeps tool pruning state', t => {
  const f = fixture(t);
  const copied = clone(f.native);
  const ids = new Map(copied.map((message, index) => [message.info.id, `msg_copy${index}`]));
  for (const message of copied) {
    if (message.info.parentID) message.info.parentID = ids.get(message.info.parentID);
    message.info.id = ids.get(message.info.id); message.info.sessionID = 'ses_copy';
    message.parts.forEach((part, index) => Object.assign(part, { id: `${message.info.id}_${index}`, messageID: message.info.id, sessionID: 'ses_copy' }));
  }
  assert.equal(nativePrefixDigest(copied), nativePrefixDigest(f.native));
  delete copied[1].parts[0].state.time.compacted;
  assert.notEqual(nativePrefixDigest(copied), nativePrefixDigest(f.native));
});

test('native error-state encoding may drop only its obsolete display title', t => {
  const f = fixture(t);
  const historical = clone(f.native);
  historical[1].parts[0].state = { status: 'error', title: 'Cancelled old tool', input: { command: 'fixture-command' },
    error: 'Cancelled by the user', metadata: { source: 'shell' }, time: { start: 1101, end: 1170 } };
  const encoded = clone(historical); delete encoded[1].parts[0].state.title;
  assert.equal(nativePrefixDigest(encoded), nativePrefixDigest(historical));
  assert.equal(nativePrefixContentDigest(encoded), nativePrefixContentDigest(historical));
  for (const change of [
    state => { state.input.command = 'Different command'; },
    state => { state.error = 'A different error'; },
    state => { state.time.end += 1; }
  ]) {
    const changed = clone(encoded); change(changed[1].parts[0].state);
    assert.notEqual(nativePrefixDigest(changed), nativePrefixDigest(historical));
    assert.notEqual(nativePrefixContentDigest(changed), nativePrefixContentDigest(historical));
  }
  const completed = clone(f.native); completed[1].parts[0].state.title = 'A completed tool title';
  const changedTitle = clone(completed); changedTitle[1].parts[0].state.title = 'Different completed title';
  assert.notEqual(nativePrefixDigest(changedTitle), nativePrefixDigest(completed));
  assert.notEqual(nativePrefixContentDigest(changedTitle), nativePrefixContentDigest(completed));
});

test('source provenance, historical seed changes, and changed native-visible text fail closed', t => {
  const f = fixture(t);
  assert.equal(f.read({ request: { ...f.request, forkHistory: { sourceSessionId: 'sess_unrelated' } } }).prefix, null);
  assert.equal(f.read({ request: { ...f.request, workMode: 'plan' } }).prefix, null);
  const changed = clone(f.desktop); changed[0].content = 'Changed historical objective';
  assert.equal(f.read({ messages: changed }).prefix, null);
  const edited = clone(f.desktop); edited[5].agentRun.timeline[0].content = 'An edited answer';
  assert.equal(f.read({ messages: edited }).prefix, null);
  assert.equal(f.read({ directory: path.join(f.dataDir, 'unrelated-workspace') }).prefix, null);
});

test('attachments and partial selected assistant boundaries are not certified as native prefixes', t => {
  const f = fixture(t);
  const attached = clone(f.desktop); attached[0].attachments = [{ path: 'evidence.pdf' }];
  assert.equal(f.read({ messages: attached }).prefix, null);
  const partial = clone(f.desktop); partial[5].agentRun.status = 'incomplete';
  assert.equal(f.read({ messages: partial }).prefix, null);
});

test('a nonempty changed result and completed-turn cancellation placeholders cannot replace exact evidence', t => {
  const f = fixture(t);
  const nonempty = clone(f.desktop); nonempty[3].agentRun.timeline[1].output = 'Different result';
  assert.equal(f.read({ messages: nonempty }).prefix, null);
  const completed = clone(f.desktop); completed[3].agentRun.status = 'done';
  assert.equal(f.read({ messages: completed }).prefix, null);
  f.updatePart('prt_0002a', part => { part.state.time.end = 1400; });
  assert.equal(f.read().prefix, null, 'native tool finalization after the selected completed boundary must not leak backwards');
});

test('future native turns are excluded and a desktop tail remains explicit for the caller', t => {
  const f = fixture(t);
  f.append('msg_0005', 'user', [{ id: 'prt_0005', type: 'text', text: f.turn('DISCARDED FUTURE REQUEST') }]);
  f.append('msg_0006', 'assistant', [{ id: 'prt_0006', type: 'text', text: 'DISCARDED FUTURE ANSWER' }], { parentID: 'msg_0005' });
  const result = f.read();
  assert.ok(result.prefix, result.reason);
  assert.equal(result.prefix.messageID, 'msg_0005');
  assert.equal(result.prefix.sourceMessageCount, 4);
  const messages = [...f.desktop, { role: 'user', content: 'A retained new request' }];
  const tail = f.read({ messages }).prefix;
  assert.deepEqual(tail.desktopTail, messages.slice(-1));
  assert.equal(tail.desktopPrefix.messageCount, 6);
});

test('a later part inserted into an older native envelope cannot leak into the selected prefix', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('prt_zzzz_future', 'msg_0002', 'ses_original', 9999,
    JSON.stringify({ type: 'text', text: 'DISCARDED FUTURE TEXT' }));
  assert.equal(f.read().prefix, null);
});

test('legacy seed matching reproduces bounded historical formatting including protocol stripping', t => {
  const f = fixture(t);
  const seed = verifiedLegacySeed(f.native, f.desktop);
  assert.equal(seed.count, 2);
  const text = legacyHistorySystem([{ role: 'user', content: 'before<z-turn-context>private runtime</z-turn-context>after' }]);
  assert.match(text, /user: beforeafter/);
  assert.doesNotMatch(text, /private runtime/);
  assert.ok(legacyHistorySystem(f.desktop.slice(0, 2)).length < f.desktop[1].content.length);
});

test('native full-prefix recovery accepts a complete streamed assistant across guidance but not a partial boundary', t => {
  const f = fixture(t);
  const before = { type: 'text', content: 'Before guide', openCodeKey: 'text:prt_0007a' };
  const after = { type: 'text', content: 'Text streamed after guide', openCodeKey: 'text:prt_0007b' };
  f.append('msg_0005', 'user', [{ id: 'prt_0005', type: 'text', text: f.turn('One more complete task') }]);
  f.append('msg_0006', 'assistant', [{ id: 'prt_0007a', type: 'text', text: before.content },
    { id: 'prt_0007b', type: 'text', text: after.content }], { parentID: 'msg_0005' });
  f.append('msg_0007', 'user', [{ id: 'prt_0008', type: 'text', text:
    'Z LIVE USER INTERJECTION\n\nGuidance version: 1\n\n[[Z_GUIDANCE_RECEIPT:fixture]]\n\nUse corrected requirement\n\nUser intent: adjust the remaining work without interrupting the active operation.' }]);
  f.append('msg_0008', 'assistant', [{ id: 'prt_0009', type: 'text', text: 'Final after guidance' }], { parentID: 'msg_0007' });
  const guide = { role: 'user', content: 'Use corrected requirement', liveGuidance: { timelineKey: 'owner',
    deliveryEvidence: 'provider-response', displayBoundary: { version: 1, keys: [before.openCodeKey],
      textLengths: { [before.openCodeKey]: before.content.length } } } };
  const completed = desktopAssistant('Final after guidance', 'prt_0009', 'done', [before, after]);
  completed.agentRun.guidanceTimelineKey = 'owner';
  const messages = [...f.desktop, { role: 'user', content: 'One more complete task' }, guide, completed];
  const result = f.read({ messages });
  assert.equal(result.prefix?.desktopPrefix.messageCount, messages.length, result.reason);
  const partial = clone(messages); partial.at(-1).agentRun.status = 'incomplete';
  const fallback = f.read({ messages: partial });
  assert.equal(fallback.prefix?.desktopPrefix.messageCount, f.desktop.length);
  assert.equal(fallback.prefix?.messageID, 'msg_0005', 'unproved guidance never includes the later native text');
  const changed = clone(messages); changed[7].content = 'A different guide';
  assert.equal(f.read({ messages: changed }).prefix?.desktopPrefix.messageCount, f.desktop.length);
});

test('worker recovery and cancellation stay bounded without starting a kernel or provider', async t => {
  const f = fixture(t);
  const request = { ...f.request, forkHistory: { ...f.request.forkHistory, messages: f.desktop } };
  const result = await recoverNativePrefix({ appRoot: path.resolve(__dirname, '..'), dataDir: f.dataDir,
    directory: f.directory, request });
  assert.equal(result?.desktopPrefix.messageCount, 6);
  f.db.exec('BEGIN EXCLUSIVE');
  const controller = new AbortController();
  let timer;
  try {
    const start = Date.now();
    const pending = recoverNativePrefix({ appRoot: path.resolve(__dirname, '..'), dataDir: f.dataDir,
      directory: f.directory, request, signal: controller.signal });
    timer = setTimeout(() => controller.abort(), 30);
    assert.equal(await pending, null);
    assert.ok(Date.now() - start < 3000);
  } finally { clearTimeout(timer); f.db.exec('ROLLBACK'); }
});

function forkWithNewTurn(f, { source = f.native, desktop = f.desktop, label = 'copy', owner = 'sess_branch' } = {}) {
  const id = `ses_${label}`;
  const messageId = index => `msg_${label}_${String(index + 1).padStart(4, '0')}`;
  const partId = (index, partIndex) => `prt_${label}_${String(index + 1).padStart(4, '0')}_${String(partIndex).padStart(4, '0')}`;
  const ids = new Map(source.map((message, index) => [message.info.id, messageId(index)]));
  const native = clone(source).map((message, index) => {
    message.info.id = messageId(index); message.info.sessionID = id;
    if (message.info.parentID) message.info.parentID = ids.get(message.info.parentID) || message.info.parentID;
    message.parts.forEach((part, partIndex) => {
      part.id = partId(index, partIndex); part.messageID = message.info.id; part.sessionID = id;
      if (part.type === 'compaction' && part.tail_start_id) part.tail_start_id = ids.get(part.tail_start_id);
    });
    return message;
  });
  const metadata = { zSessionID: owner, zWorkMode: 'normal', zNativePrefix: {
    version: 1, messageCount: native.length, contentHash: nativePrefixContentDigest(native),
    sourceHash: nativePrefixDigest(native), sourceSessionId: source[0].info.sessionID,
    desktopPrefix: { messageCount: desktop.length, digest: desktopHistoryDigest(desktop) }
  } };
  f.db.prepare('INSERT INTO session VALUES (?,NULL,?,?)').run(id, f.directory, JSON.stringify(metadata));
  const nextIndex = native.length;
  native.push({ info: { id: messageId(nextIndex), sessionID: id, role: 'user', time: { created: 3000 } },
    parts: [{ id: partId(nextIndex, 0), messageID: messageId(nextIndex), sessionID: id,
      type: 'text', text: f.turn(`Continue in ${label}`) }] },
  { info: { id: messageId(nextIndex + 1), sessionID: id, role: 'assistant', parentID: messageId(nextIndex),
    time: { created: 3100, completed: 3200 }, finish: 'stop' },
  parts: [{ id: partId(nextIndex + 1, 0), messageID: messageId(nextIndex + 1), sessionID: id,
    type: 'text', text: `Completed in ${label}` }] });
  for (const message of native) {
    const { id: nativeId, sessionID, ...info } = message.info;
    f.db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(nativeId, sessionID, info.time.created, JSON.stringify(info));
    message.parts.forEach((part, index) => {
      const { id: nativePartId, sessionID: partSessionID, messageID, ...data } = part;
      f.db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(nativePartId, messageID, partSessionID,
        info.time.created + index, JSON.stringify(data));
    });
  }
  const messages = [...clone(desktop), { role: 'user', content: `Continue in ${label}` },
    desktopAssistant(`Completed in ${label}`, partId(nextIndex + 1, 0))];
  const request = { zSessionId: `sess_after_${label}`, workMode: 'normal', conversationRevision: 3,
    forkHistory: { sourceSessionId: owner } };
  return { id, native, messages, request, metadata, toolId: partId(1, 0),
    read: () => f.read({ messages, request }) };
}

test('repeated forks authenticate the copied prefix instead of requiring its old desktop part IDs', t => {
  const f = fixture(t);
  const first = forkWithNewTurn(f);
  const restored = first.read();
  assert.equal(restored.prefix?.desktopPrefix.messageCount, first.messages.length, restored.reason);
  assert.equal(restored.prefix?.provenance.inheritedNativeMessageCount, f.native.length);
  assert.deepEqual(restored.prefix?.desktopTail, []);
  const second = forkWithNewTurn(f, { source: first.native, desktop: first.messages, label: 'second', owner: 'sess_after_copy' });
  const repeated = second.read();
  assert.equal(repeated.prefix?.desktopPrefix.messageCount, second.messages.length, repeated.reason);
  assert.equal(repeated.prefix?.provenance.inheritedNativeMessageCount, first.native.length);
  assert.deepEqual(repeated.prefix?.desktopTail, []);
});

test('normal later tool pruning preserves inherited content proof while immediate readback stays strict', t => {
  const f = fixture(t), copy = forkWithNewTurn(f);
  const before = clone(copy.native.slice(0, f.native.length));
  f.updatePart(copy.toolId, part => { part.state.time.compacted += 5000; });
  const after = clone(before); after[1].parts[0].state.time.compacted += 5000;
  assert.equal(nativePrefixContentDigest(after), nativePrefixContentDigest(before));
  assert.notEqual(nativePrefixDigest(after), nativePrefixDigest(before));
  assert.equal(copy.read().prefix?.desktopPrefix.messageCount, copy.messages.length);
});

test('inherited receipts reject altered desktop, native body, tool input/output and non-pruning times', t => {
  const f = fixture(t), copy = forkWithNewTurn(f);
  const changedDesktop = clone(copy.messages); changedDesktop[0].content = 'An altered historical instruction';
  assert.equal(f.read({ messages: changedDesktop, request: copy.request }).prefix, null);
  const tool = JSON.parse(f.db.prepare('SELECT data FROM part WHERE id=?').get(copy.toolId).data);
  for (const change of [
    part => { part.state.input.command = 'Different command'; },
    part => { part.state.output = 'Different tool result'; },
    part => { part.state.time.end += 1; }
  ]) {
    const changed = clone(tool); change(changed);
    f.db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(changed), copy.toolId);
    assert.equal(copy.read().prefix, null);
  }
  f.db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(tool), copy.toolId);
  f.updatePart(copy.native[3].parts[0].id, part => { part.text = 'An altered old answer'; });
  assert.equal(copy.read().prefix, null);
});

test('an absent or invalid inherited content receipt cannot bypass stale desktop identities', t => {
  const f = fixture(t), copy = forkWithNewTurn(f);
  for (const metadata of [
    { zSessionID: 'sess_branch', zWorkMode: 'normal' },
    { ...copy.metadata, zNativePrefix: { ...copy.metadata.zNativePrefix, contentHash: '0'.repeat(64) } },
    { ...copy.metadata, zNativePrefix: { ...copy.metadata.zNativePrefix, messageCount: 999 } }
  ]) {
    f.db.prepare('UPDATE session SET metadata=? WHERE id=?').run(JSON.stringify(metadata), copy.id);
    assert.equal(copy.read().prefix, null);
  }
});
