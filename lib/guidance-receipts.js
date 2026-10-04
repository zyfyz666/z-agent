'use strict';

const PREFIX = 'Z_GUIDANCE_RECEIPT ';
const TOKEN_PATTERN = /\[\[Z_GUIDANCE_RECEIPT:([a-f0-9]{32})\]\]/g;
const OBSERVER = Symbol.for('z.guidance.request.observer');

function guidanceTokens(body) {
  if (typeof body !== 'string' || !body.includes('[[Z_GUIDANCE_RECEIPT:')) return [];
  let data;
  try { data = JSON.parse(body); } catch { return []; }
  // Kernel prompt acknowledgements have a model object. Only provider model
  // requests have a model name and the serialized conversation payload.
  if (typeof data?.model !== 'string' || !data.model) return [];
  const conversation = Array.isArray(data.messages) ? data.messages : data.input;
  if (!Array.isArray(conversation) && typeof conversation !== 'string') return [];
  const userInput = typeof conversation === 'string' ? conversation : conversation
    .filter(message => message?.role === 'user').map(message => message.content);
  return [...new Set([...JSON.stringify(userInput).matchAll(TOKEN_PATTERN)].map(match => match[1]))];
}

function installGuidanceRequestObserver({ target = globalThis, report = receipt => process.stdout.write(`${PREFIX}${JSON.stringify(receipt)}\n`) } = {}) {
  if (target[OBSERVER] || typeof target.fetch !== 'function') return;
  const original = target.fetch;
  target[OBSERVER] = true;
  target.fetch = async function observedFetch(input, init) {
    let tokens = [];
    try {
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      if (method === 'POST') {
        let body = init?.body;
        if (body == null && typeof input?.clone === 'function') body = await input.clone().text();
        if (ArrayBuffer.isView(body)) body = new TextDecoder().decode(body);
        tokens = guidanceTokens(body);
      }
    } catch {} // Observation must never change or prevent a model request.
    const response = await Reflect.apply(original, this, [input, init]);
    // A successful provider response confirms that this exact serialized
    // request reached the endpoint. It does not assert that the model obeyed it.
    if (tokens.length && response.ok) {
      const at = Date.now();
      for (const token of tokens) { try { report({ token, at }); } catch {} }
    }
    return response;
  };
}

function createGuidanceReceiptDecoder(onReceipt) {
  let pending = '';
  return chunk => {
    pending += String(chunk || '');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop().slice(-4096);
    for (const line of lines) {
      if (!line.startsWith(PREFIX)) continue;
      try {
        const receipt = JSON.parse(line.slice(PREFIX.length));
        if (/^[a-f0-9]{32}$/.test(receipt?.token) && Number.isFinite(receipt.at) && receipt.at > 0) onReceipt(receipt);
      } catch {}
    }
  };
}

module.exports = { guidanceTokens, installGuidanceRequestObserver, createGuidanceReceiptDecoder };
