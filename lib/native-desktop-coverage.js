'use strict';

const { desktopHistoryDigest, projectedHistoryDigest, restoreDesktopContextCheckpoint } = require('./desktop-context-checkpoint');
const { stripProtocolBlocks } = require('./delivery-contract');
const { splitTaggedThinkingText } = require('./thinking-text');

const COMPACTION_CONTINUE = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
const USER_INTENTS = [
  'User intent: adjust the remaining work without interrupting the active operation.',
  'User intent: finish gracefully after making the current state coherent; do not hard-cancel.'
];
const RUNTIME_INTENT = 'Runtime requirement: satisfy this in the remaining work without interrupting the active operation.';
const OUTPUT_CONTINUATIONS = [
  'The previous model turn ended because max_output_tokens was reached before a complete user-facing answer.',
  'The previous model turn completed without a user-visible answer (empty or whitespace-only text, no tool calls).'
].map(reason => ['Z OUTPUT CONTINUATION', reason,
  'Continue the same task now. Do not restart. Produce the remaining user-visible answer or the next tool calls needed to finish.',
  'If the previous turn already completed the work, reply with the concise final result only.'].join('\n'));

function textOf(message) {
  return (Array.isArray(message?.parts) ? message.parts : []).filter(part => part?.type === 'text')
    .map(part => String(part.text || '')).join('\n').trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function equalValue(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

function withoutTurnContext(text) {
  const marker = text.lastIndexOf('<z-turn-context');
  if (marker < 0) return text.trim();
  const suffix = text.slice(marker);
  if (!/^<z-turn-context(?:\s[^>]*)?>[\s\S]*<\/z-turn-context>\s*$/.test(suffix)) return null;
  return text.slice(0, marker).trim();
}

function parseEnvelope(text, tag) {
  const opening = `<${tag}>`, closing = `</${tag}>`;
  const begin = text.indexOf(opening), end = text.indexOf(closing, begin + opening.length);
  if (begin < 0 || end < 0 || text.indexOf(opening, begin + opening.length) >= 0
    || text.indexOf(closing, end + closing.length) >= 0) return null;
  try {
    return { payload: JSON.parse(text.slice(begin + opening.length, end)),
      remainder: text.slice(end + closing.length).trim() };
  } catch { return null; }
}

function candidatePrefixCounts(messages, projected, hint, start = 0) {
  const candidates = new Set();
  const add = value => { if (Number.isSafeInteger(value) && value >= start && value <= messages.length) candidates.add(value); };
  add(hint);
  add(start + projected.length);
  const lastTs = projected.at(-1)?.ts;
  if (lastTs !== undefined) messages.forEach((message, index) => { if (index >= start && message?.ts === lastTs) add(index + 1); });
  return [...candidates];
}

function readSeed(firstText, desktop, options) {
  // Native-prefix recovery recreates the model's existing bounded context,
  // rather than asserting that a summary covers the entire desktop archive.
  // Its worker verifies provenance and recomputes the exact legacy seed.
  const legacy = options.trustedNativePrefix && options.legacySeed;
  if (legacy && legacy.text === firstText && Number.isSafeInteger(legacy.count)
    && legacy.count > 0 && legacy.count <= desktop.length
    && desktopHistoryDigest(desktop.slice(0, legacy.count)) === legacy.desktopDigest) {
    return { ok: true, count: legacy.count, text: legacy.remainder };
  }
  if (firstText.includes('<z-session-history>') || firstText.includes('<z-restored-context>')) {
    return { ok: false, reason: 'unverified-history-seed' };
  }
  if (firstText.includes('<z-conversation-branch-history>')) {
    const parsed = parseEnvelope(firstText, 'z-conversation-branch-history');
    if (!parsed || !Array.isArray(parsed.payload?.messages)) return { ok: false, reason: 'invalid-history-seed' };
    const projected = parsed.payload.messages;
    const digest = projectedHistoryDigest(projected);
    const count = candidatePrefixCounts(desktop, projected, Number(parsed.payload.branchPointMessageIndex) + 1)
      .find(end => desktopHistoryDigest(desktop.slice(0, end)) === digest);
    if (count === undefined) return { ok: false, reason: 'seed-prefix-mismatch' };
    return { ok: true, count, text: parsed.remainder };
  }
  if (firstText.includes('<z-desktop-context-checkpoint>')) {
    const parsed = parseEnvelope(firstText, 'z-desktop-context-checkpoint');
    const seed = parsed?.payload;
    if (!seed || !Array.isArray(seed.desktopTail)) return { ok: false, reason: 'invalid-checkpoint-seed' };
    for (const checkpoint of options.checkpoints || []) {
      if (seed.checkpointId !== checkpoint?.checkpointHash && seed.checkpointId !== checkpoint?.inheritedFrom?.checkpointHash) continue;
      const count = checkpoint.desktopPrefix?.messageCount;
      const restored = restoreDesktopContextCheckpoint(checkpoint, { messages: desktop.slice(0, count), request: options.request });
      if (!restored.ok || !equalValue(seed.desktopPrefix, checkpoint.desktopPrefix)
        || seed.summary !== checkpoint.context.summary
        || !equalValue(seed.nativeTail, checkpoint.context.nativeTail)) continue;
      const digest = projectedHistoryDigest(seed.desktopTail);
      const end = candidatePrefixCounts(desktop, seed.desktopTail, count + seed.desktopTail.length, count)
        .find(candidate => desktopHistoryDigest(desktop.slice(count, candidate)) === digest);
      if (end !== undefined) return { ok: true, count: end, text: parsed.remainder };
    }
    return { ok: false, reason: 'checkpoint-seed-unverified' };
  }
  return { ok: true, count: 0, text: firstText };
}

function parseGuidance(text) {
  const match = /^(Z LIVE USER INTERJECTION|Z RUNTIME REQUIREMENT)\n\nGuidance version: (\d+)\n\n(?:\[\[Z_GUIDANCE_RECEIPT:([^\]\r\n]+)\]\]\n\n)?([\s\S]+)\n\n([^\n]+)$/.exec(text);
  if (!match) return null;
  const runtime = match[1] === 'Z RUNTIME REQUIREMENT';
  if (runtime ? ![RUNTIME_INTENT, USER_INTENTS[1]].includes(match[5]) : !USER_INTENTS.includes(match[5])) return null;
  return { runtime, version: Number(match[2]), text: match[4].trim() };
}

function isInterjectionCheckpoint(text, guidance) {
  const match = /^Z LIVE INTERJECTION CHECKPOINT\n\nCurrent boundary: [^\n]+\n\nLive guidance already inserted into this session: (\[[^\n]*\])\n\nApply these instructions to the remaining work now\. Preserve verified work already completed and do not repeat it without a concrete reason\.\n\n(?:The user requested a graceful finish\. Stop adding optional work or extra validation, leave the workspace in a coherent state, and prepare to summarize\. Do not abort the run\.|Continue the task in the corrected direction\. Use tools when needed and report only what is actually verified\.)$/.exec(text);
  if (!match) return false;
  try {
    const items = JSON.parse(match[1]);
    return items.length > 0 && items.every(item => typeof item.text === 'string'
      && guidance.some(known => known.version === item.version && known.text === item.text.trim()));
  } catch { return false; }
}

function modelVisibleDesktopUser(message) {
  return message?.role === 'user' && !(message.liveGuidance?.nativeDetached === true
    && message.liveGuidance.deliveryEvidence !== 'provider-response');
}

// Prove that a native transcript actually covers a desktop prefix before a
// native summary is allowed to replace that prefix. Times and token counters
// are deliberately not evidence: seeds require exact digests; later turns
// require exact user text and stable native part identities and content.
function verifyNativeDesktopCoverage(nativeMessages, desktopMessages, options = {}) {
  const reject = (reason, details) => ({ ok: false, reason, ...(details ? { details } : {}) });
  const native = Array.isArray(nativeMessages) ? nativeMessages : [];
  const desktop = Array.isArray(desktopMessages) ? desktopMessages : [];
  if (!native.length || !desktop.length) return reject('empty-history');
  if (native[0]?.info?.role !== 'user') return reject('missing-native-start');
  const ids = native.map(message => message?.info?.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) return reject('invalid-native-identities');
  const firstText = withoutTurnContext(textOf(native[0]));
  if (firstText === null) return reject('invalid-turn-context');
  const seed = readSeed(firstText, desktop, options);
  if (!seed.ok) return seed;
  const expectedUsers = desktop.map((message, index) => ({ message, index }))
    .filter(({ message, index }) => index >= seed.count && modelVisibleDesktopUser(message));
  const userPositions = new Map();
  const guidance = [];
  const observerMessages = new Set(desktop.flatMap(message => (message?.agentRun?.watchdog?.events || [])
    .flatMap(event => [event?.message, event?.guidance, event?.reminder].filter(value => typeof value === 'string').map(value => value.trim()))));
  let cursor = 0;
  let compacted = false;
  for (let index = 0; index < native.length; index++) {
    const message = native[index];
    if (message.info.role !== 'user') continue;
    const parts = message.parts || [];
    if (parts.length && parts.every(part => part.type === 'compaction')) { compacted = true; continue; }
    const text = index === 0 ? seed.text : withoutTurnContext(textOf(message));
    if (text === null) return reject('invalid-turn-context');
    const next = expectedUsers[cursor];
    const interjection = parseGuidance(text);
    const matches = next && (String(next.message.content || '').trim() === text
      || (next.message.liveGuidance && !interjection?.runtime
        && interjection?.text === String(next.message.content || '').trim()));
    if (matches) {
      // File-content conversion differs across protocol generations. Without
      // an exact attachment receipt, do not certify those turns by filename.
      if ((next.message.attachments || []).length || parts.some(part => part.type === 'file')) return reject('unverified-attachment');
      userPositions.set(next.index, index);
      if (interjection) guidance.push(interjection);
      cursor++;
      continue;
    }
    if (index === 0 && seed.count > 0 && !text) continue;
    if (interjection?.runtime || (interjection && observerMessages.has(interjection.text))) {
      guidance.push(interjection);
      continue;
    }
    if (isInterjectionCheckpoint(text, guidance) || OUTPUT_CONTINUATIONS.includes(text)
      || (compacted && text === COMPACTION_CONTINUE)) continue;
    return reject('native-user-mismatch');
  }
  if (cursor !== expectedUsers.length) return reject('desktop-user-missing');

  const parts = new Map();
  const tools = new Map();
  for (let messageIndex = 0; messageIndex < native.length; messageIndex++) {
    const message = native[messageIndex];
    for (let partIndex = 0; partIndex < (message.parts || []).length; partIndex++) {
      const part = message.parts[partIndex];
      if (!part?.id) continue;
      if (parts.has(part.id)) return reject('duplicate-native-part');
      parts.set(part.id, { part, message, messageIndex, partIndex });
      if (part.type === 'tool' && part.callID) {
        if (tools.has(part.callID)) return reject('duplicate-native-tool');
        tools.set(part.callID, { part, message, messageIndex });
      }
    }
  }
  const seen = new Set();
  const seenTools = new Set();
  const provenGuides = new Set();
  let latestText = null;
  let previousPartPosition = -1;
  for (let index = seed.count; index < desktop.length; index++) {
    const message = desktop[index];
    if (message?.role !== 'assistant') {
      if (message?.role !== 'user') return reject('unsupported-desktop-role');
      continue;
    }
    const timeline = message.agentRun?.timeline;
    if (!Array.isArray(timeline)) return reject('missing-desktop-part-identities');
    // A guide is inserted before the desktop assistant archive that owns it,
    // although that assistant began before the guide. Use the ordinary user
    // turn for the lower bound and the next ordinary user for the upper bound.
    let start = seed.count;
    for (let before = index - 1; before >= seed.count; before--) {
      if (modelVisibleDesktopUser(desktop[before]) && !desktop[before].liveGuidance) { start = before; break; }
    }
    const lower = userPositions.get(start) ?? 0;
    const nextUser = desktop.findIndex((candidate, candidateIndex) => candidateIndex > index
      && modelVisibleDesktopUser(candidate) && !candidate.liveGuidance);
    const upper = nextUser < 0 ? native.length : userPositions.get(nextUser);
    const inTurn = entry => entry.messageIndex > lower && entry.messageIndex < upper;
    for (const item of timeline.filter(item => ['tool_call', 'tool_result'].includes(item?.type))) {
      const entry = tools.get(item.callId);
      if (!entry || entry.message.info.role !== 'assistant' || !inTurn(entry)
        || (item.name && item.name !== entry.part.tool) || item.inputUnavailableAtBoundary) return reject('desktop-tool-mismatch');
      const key = `${item.type}:${item.callId}`;
      if (seenTools.has(key)) return reject('duplicate-desktop-tool');
      seenTools.add(key);
      const state = entry.part.state || {};
      if (item.type === 'tool_call') {
        if (!equalValue(item.args ?? item.input, state.input)) return reject('desktop-tool-input-mismatch');
      } else {
        // Older desktop cancellation snapshots saved an empty interrupted
        // result before the native shell finished its abort cleanup. A later
        // completed native boundary may retain that authoritative result.
        const cancelledPlaceholder = options.trustedNativePrefix && message.agentRun?.status === 'interrupted' && item.interrupted === true
          && item.ok === false && item.output === '' && ['completed', 'error'].includes(state.status)
          && Number(state.time?.end) > 0 && Number(state.time.end) <= Number(native.at(-1)?.info?.time?.completed);
        if (!['completed', 'error'].includes(state.status)
          || (!cancelledPlaceholder && (!equalValue(item.output, state.status === 'error' ? state.error : state.output)
          || (typeof item.ok === 'boolean' && item.ok !== (state.status === 'completed'))))) {
          return reject('desktop-tool-output-mismatch', options.trustedNativePrefix ? { desktopIndex: index, callId: item.callId } : undefined);
        }
      }
    }
    if (!options.trustedNativePrefix && ((message.agentRun?.subagents || []).length || (message.agentRun?.todos || []).length
      || message.agentRun?.planFile || (message.agentRun?.thinkingContent && !timeline.some(item => item.type === 'thinking'))
      || timeline.some(item => item && !['text', 'thinking', 'tool_call', 'tool_result', 'progress'].includes(item.type)))) {
      return reject('unverified-desktop-evidence');
    }
    const textParts = timeline.filter(item => ['text', 'thinking'].includes(item?.type) && String(item.content || '').trim());
    if (!textParts.length) return reject('missing-desktop-part-identities');
    for (const item of textParts) {
      const match = /^(text|reasoning):(prt_[A-Za-z0-9_-]+)$/.exec(String(item.openCodeKey || ''));
      const entry = parts.get(match?.[2]);
      const kind = item.type === 'text' ? 'text' : 'reasoning';
      const nativeText = options.trustedNativePrefix && kind === 'text'
        ? splitTaggedThinkingText(stripProtocolBlocks(entry?.part?.text || '')).text : entry?.part?.text;
      if (!entry || match[1] !== kind || entry.part.type !== kind || entry.message.info.role !== 'assistant' || !inTurn(entry)
        || String(nativeText || '').trim() !== String(item.content || '').trim()) {
        return reject('desktop-part-mismatch', options.trustedNativePrefix ? { desktopIndex: index,
          partKey: item.openCodeKey, present: !!entry, inTurn: entry && inTurn(entry) } : undefined);
      }
      const position = entry.messageIndex * 1000000 + entry.partIndex;
      if (seen.has(match[2]) || position < previousPartPosition) return reject('desktop-part-order-mismatch');
      seen.add(match[2]);
      previousPartPosition = position;
      if (kind === 'text' && !entry.message.info.summary) latestText = { ...entry, desktopIndex: index };
    }
    const guides = expectedUsers.filter(({ message: candidate }) => candidate.liveGuidance?.timelineKey
      && candidate.liveGuidance.timelineKey === message.agentRun.guidanceTimelineKey);
    for (const guide of guides) {
      const boundary = guide.message.liveGuidance.displayBoundary;
      const guidePosition = userPositions.get(guide.index);
      if (boundary?.version !== 1 || !Array.isArray(boundary.keys) || !Number.isInteger(guidePosition)) {
        return reject('unverified-guidance-boundary');
      }
      // A native assistant message can keep streaming after a guide has
      // arrived; its envelope ID then precedes the guide but later parts do
      // not. Exact full native-prefix copying retains that existing model
      // ordering. It must not claim that message order proves an in-flight
      // desktop display boundary. The final completed boundary below still
      // excludes partial guidance, and the user text/owner/part IDs and
      // projected content have all been checked above.
      if (options.trustedNativePrefix) { provenGuides.add(guide.index); continue; }
      for (const item of textParts) {
        const entry = parts.get(String(item.openCodeKey).split(':')[1]);
        const before = entry.messageIndex < guidePosition;
        if (boundary.keys.includes(item.openCodeKey) !== before
          || (before && boundary.textLengths?.[item.openCodeKey] !== String(item.content || '').length)) {
          return reject('guidance-part-order-mismatch', options.trustedNativePrefix ? {
            desktopIndex: index, guideIndex: guide.index, key: item.openCodeKey, before,
            boundaryLength: boundary.textLengths?.[item.openCodeKey], contentLength: String(item.content || '').length,
            included: boundary.keys.includes(item.openCodeKey)
          } : undefined);
        }
      }
      provenGuides.add(guide.index);
    }
    const content = String(message.content || message.agentRun?.textContent || '').trim();
    if (content && !(options.trustedNativePrefix && ['error', 'interrupted'].includes(message.agentRun?.status))
      && !textParts.some(item => item.type === 'text' && String(item.content || '').trim() === content)
      && textParts.filter(item => item.type === 'text').map(item => String(item.content || '').trim()).join('\n\n') !== content) {
      return reject('desktop-answer-mismatch');
    }
  }
  if (expectedUsers.some(({ message, index }) => message.liveGuidance && !provenGuides.has(index))) {
    return reject('unverified-guidance-boundary');
  }
  const last = desktop.at(-1);
  if (last?.role !== 'assistant' || !['done', 'completed'].includes(last.agentRun?.status)
    || !latestText || latestText.desktopIndex !== desktop.length - 1
    || !Number(latestText.message.info.time?.completed) || latestText.message.info.error) return reject('unfinished-desktop-boundary');
  if (latestText.message.parts.slice(latestText.partIndex + 1).some(part => {
    if (part.type === 'step-finish') return false;
    if (['text', 'reasoning'].includes(part.type) && seen.has(part.id)) return false;
    return !(part.type === 'tool' && seenTools.has(`tool_call:${part.callID}`)
      && seenTools.has(`tool_result:${part.callID}`) && ['completed', 'error'].includes(part.state?.status));
  })) return reject('native-parts-after-desktop-boundary');
  const trailing = native.slice(latestText.messageIndex + 1);
  const markers = new Set(trailing.filter(message => message.info.role === 'user'
    && message.parts?.length && message.parts.every(part => part.type === 'compaction')).map(message => message.info.id));
  if (trailing.some(message => !(markers.has(message.info.id) || (message.info.role === 'assistant'
    && message.info.summary === true && markers.has(message.info.parentID)
    && Number(message.info.time?.completed) && !message.info.error)))) return reject('native-after-desktop-boundary');
  return { ok: true, seedMessageCount: seed.count };
}

module.exports = { verifyNativeDesktopCoverage };
