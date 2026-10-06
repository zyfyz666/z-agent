'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function normalizeGuidanceAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('引导附件格式无效。');
  return value.map(attachment => {
    const filePath = String(attachment?.path || '').trim();
    if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) throw new Error('引导附件路径无效。');
    return Object.freeze({
      path: path.resolve(filePath),
      name: String(attachment.name || path.basename(filePath)).slice(0, 240),
      kind: attachment.kind === 'directory' ? 'directory' : 'file',
      mimeType: String(attachment.mimeType || '').trim().toLowerCase(),
      size: Math.max(0, Number(attachment.size) || 0)
    });
  });
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateGuidanceAttachments(attachments, { filesDir, permissions = {} } = {}) {
  if (attachments.length && permissions.allowFileRead === false) throw new Error('当前任务未允许读取文件，无法发送引导附件。');
  return attachments.map(attachment => {
    let stat;
    let realPath;
    try {
      realPath = fs.realpathSync(attachment.path);
      stat = fs.statSync(realPath);
    } catch { throw new Error(`引导附件不存在或无法读取：${attachment.name}`); }
    if (attachment.kind === 'directory') {
      if (!stat.isDirectory()) throw new Error(`引导附件不是目录：${attachment.name}`);
      // A directory attachment is a path reference only. It grants no file
      // tool permission and never embeds directory contents into the prompt.
      return { ...attachment, path: realPath, size: 0 };
    }
    if (!stat.isFile()) throw new Error(`引导附件不是普通文件：${attachment.name}`);
    let uploads;
    try { uploads = fs.realpathSync(filesDir); } catch { throw new Error('引导附件上传目录不可用。'); }
    if (!containedBy(uploads, realPath)) throw new Error(`请重新上传引导附件：${attachment.name}`);
    if (stat.size > 50 * 1024 * 1024) throw new Error(`引导附件不能超过 50MB：${attachment.name}`);
    return { ...attachment, path: realPath, size: stat.size };
  });
}

let nativeIdTime = 0;
let nativeIdCounter = 0;
function createGuidanceMessageId() {
  const now = Date.now();
  if (now !== nativeIdTime) { nativeIdTime = now; nativeIdCounter = 0; }
  nativeIdCounter += 1;
  const timestamp = BigInt.asUintN(48, BigInt(now) * 4096n + BigInt(nativeIdCounter)).toString(16).padStart(12, '0');
  return `msg_${timestamp}${crypto.randomBytes(7).toString('hex')}`;
}

module.exports = { normalizeGuidanceAttachments, validateGuidanceAttachments, createGuidanceMessageId };
