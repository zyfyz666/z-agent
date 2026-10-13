'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonical, digest, validRef, contextError, snapshotMessages, contextContentDigest, estimateSnapshotTokens, portableSnapshotMessages } = require('./context-state');

// Content-addressed objects deduplicate unchanged native messages across
// turns and branches. Manifests are immutable; advancing/reverting a chat
// changes only its head reference. UI archives never enter this store.
class ContextStore {
  constructor(dataDir) { this.root = path.join(path.resolve(dataDir), 'context-store', 'v2'); }
  file(kind, ref) {
    if (!validRef(ref)) throw contextError('上下文快照引用无效。');
    return path.join(this.root, kind, ref.slice(0, 2), `${ref}.json`);
  }
  put(kind, value) {
    const text = JSON.stringify(canonical(value)), ref = digest(value), file = this.file(kind, ref);
    if (fs.existsSync(file)) { this.get(kind, ref); return ref; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx');
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Publish only complete objects, without replacing another writer's
      // object. A crash can leave an unreferenced temp file, never a partial ref.
      try { fs.linkSync(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      this.get(kind, ref);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
    return ref;
  }
  get(kind, ref) {
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file(kind, ref), 'utf8')); }
    catch (error) { throw contextError('找不到完整的模型上下文快照。原始对话未改动。'); }
    if (digest(value) !== ref) throw contextError('模型上下文快照已损坏。原始对话未改动。');
    return value;
  }
  capture(messages, scope = {}) {
    const native = portableSnapshotMessages(snapshotMessages(messages, { seal: true }));
    const refs = native.map(message => this.put('messages', message));
    const manifest = { version: 2, format: 'native-context', messages: refs,
      scope: { sessionId: String(scope.zSessionId || scope.sessionId || ''), directory: String(scope.directory || ''),
        workMode: String(scope.workMode || 'normal') },
      contentDigest: contextContentDigest(native), messageCount: native.length, estimatedTokens: estimateSnapshotTokens(native) };
    return this.put('snapshots', manifest);
  }
  read(ref) {
    const manifest = this.get('snapshots', ref);
    if (manifest.version !== 2 || manifest.format !== 'native-context') throw contextError('上下文快照版本不支持。');
    const messages = manifest.messages.map(id => this.get('messages', id));
    if (messages.length !== manifest.messageCount || contextContentDigest(messages) !== manifest.contentDigest) {
      throw contextError('上下文快照内容不完整。');
    }
    return { manifest, messages };
  }
}
module.exports = { ContextStore };
