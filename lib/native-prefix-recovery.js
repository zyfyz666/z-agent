'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { protocolBlockPattern } = require('./protocol-text');
const { desktopHistoryDigest } = require('./desktop-context-checkpoint');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

// Session.fork changes only envelope identities, assistant parent links and
// compaction tail IDs. Keep every other field in the read-back comparison,
// including native tool pruning markers and provider metadata.
function nativePrefixDigest(messages, { ignoreToolPruning = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const ids = new Map(list.map((message, index) => [message?.info?.id, `message:${index}`]));
  const normalized = list.map(message => {
    const info = { ...message.info };
    delete info.id; delete info.sessionID;
    if (info.parentID && ids.has(info.parentID)) info.parentID = ids.get(info.parentID);
    const parts = (message.parts || []).map(part => {
      const copy = { ...part };
      delete copy.id; delete copy.messageID; delete copy.sessionID;
      // Older cancelled tools can retain the running-state display title.
      // The pinned native ToolStateError schema omits that field on fork/API
      // encoding. It is not execution evidence; completed titles and every
      // error/input/output/timing field remain part of the comparison.
      if (copy.type === 'tool' && copy.state?.status === 'error' && Object.hasOwn(copy.state, 'title')) {
        copy.state = { ...copy.state };
        delete copy.state.title;
      }
      if (copy.type === 'compaction' && copy.tail_start_id && ids.has(copy.tail_start_id)) {
        copy.tail_start_id = ids.get(copy.tail_start_id);
      }
      if (ignoreToolPruning && copy.type === 'tool' && copy.state?.time) {
        copy.state = { ...copy.state, time: { ...copy.state.time } };
        delete copy.state.time.compacted;
      }
      return copy;
    });
    return { info, parts };
  });
  return crypto.createHash('sha256').update(JSON.stringify(canonical(normalized))).digest('hex');
}

// Pruning updates this marker after later turns, without changing historical
// content. Inherited-prefix receipts tolerate only that one native mutation;
// immediate fork readback continues to use nativePrefixDigest unchanged.
function nativePrefixContentDigest(messages) { return nativePrefixDigest(messages, { ignoreToolPruning: true }); }

// Match the historical sidecar historySystem algorithm exactly. A bounded
// seed is accepted only as the context this proven native session already
// used; it is not promoted to a complete summary of the omitted archive.
function legacyHistorySystem(history = []) {
  const candidates = (Array.isArray(history) ? history : []).slice(-24);
  const turns = [];
  let remainingChars = 64_000;
  for (let index = candidates.length - 1; index >= 0 && remainingChars > 0; index--) {
    const message = candidates[index];
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    let content = String(message?.content || '');
    for (const suffix of ['turn-context', 'reasoning-sidepath', 'continual-harness', 'long-horizon-protocol', 'experience-edges']) {
      content = content.replace(protocolBlockPattern(suffix, { allowAttributes: true }), '');
    }
    content = content.trim();
    if (!content) continue;
    const prefix = `${role}: `;
    const available = Math.max(0, Math.min(6_000, remainingChars - prefix.length));
    if (!available) break;
    const clipped = content.slice(0, available);
    turns.unshift(`${prefix}${clipped}`);
    remainingChars -= prefix.length + clipped.length;
  }
  if (!turns.length) return '';
  return [
    'The following is bounded prior history from this Z session. It is used only when the native OpenCode session had to be recreated. Use only this history; do not invent unrelated context.',
    '<z-session-history>', ...turns, '</z-session-history>'
  ].join('\n');
}

function verifiedLegacySeed(nativeMessages, desktop) {
  const first = nativeMessages?.[0];
  if (first?.info?.role !== 'user') return null;
  let text = (first.parts || []).filter(part => part.type === 'text').map(part => String(part.text || '')).join('\n').trim();
  const turn = text.lastIndexOf('<z-turn-context');
  if (turn >= 0) {
    if (!/^<z-turn-context(?:\s[^>]*)?>[\s\S]*<\/z-turn-context>\s*$/.test(text.slice(turn))) return null;
    text = text.slice(0, turn).trim();
  }
  const closing = '</z-session-history>';
  const end = text.indexOf(closing);
  if (end < 0) return null;
  const seed = text.slice(0, end + closing.length);
  const remainder = text.slice(end + closing.length).trim();
  const matches = [];
  for (let count = 1; count < desktop.length; count++) {
    if (desktop[count]?.role !== 'user' || String(desktop[count].content || '').trim() !== remainder) continue;
    if (legacyHistorySystem(desktop.slice(0, count)) === seed) matches.push(count);
  }
  if (matches.length !== 1) return null;
  const count = matches[0];
  return { text, count, remainder, desktopDigest: desktopHistoryDigest(desktop.slice(0, count)) };
}

async function recoverNativePrefix({ appRoot, dataDir, request = {}, directory, signal } = {}) {
  const messages = request.forkHistory?.messages || request.checkpointDesktopHistory;
  if (signal?.aborted || !Array.isArray(messages) || !messages.length || !dataDir || !directory) return null;
  const dbPath = path.join(dataDir, 'opencode-runtime', 'data', 'opencode', 'opencode.db');
  if (!fs.existsSync(dbPath)) return null;
  const runtime = require('./codegraph-runtime').resolveNodeCommand(appRoot);
  if (!runtime.ok) return null;
  const worker = path.join(__dirname, 'native-prefix-recovery-worker.cjs').replace(
    `${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const input = JSON.stringify({ dbPath, directory, messages, request: {
    zSessionId: request.zSessionId, branchId: request.branchId,
    conversationRevision: request.conversationRevision, workMode: request.workMode,
    forkHistory: request.forkHistory && { sourceSessionId: request.forkHistory.sourceSessionId }
  } });
  if (Buffer.byteLength(input, 'utf8') > 40 * 1024 * 1024) return null;
  return new Promise(resolve => {
    const child = execFile(runtime.command, ['--disable-warning=ExperimentalWarning', worker], {
      windowsHide: true, shell: false, timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
      signal, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout).prefix || null); } catch { resolve(null); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

module.exports = { recoverNativePrefix, nativePrefixDigest, nativePrefixContentDigest, legacyHistorySystem, verifiedLegacySeed };
