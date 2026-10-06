'use strict';

const { projectTimeline: projectGuidanceTimeline } = require('../renderer/guidance-timeline');

// Session files are a UI archive, not an API transcript. Project only the
// conversation and execution evidence when seeding a new fork/rewind kernel.
// This never edits the archive or clips message/tool text to a size budget.
function pick(record, keys) {
  const result = {};
  for (const key of keys) if (record?.[key] !== undefined) result[key] = record[key];
  return result;
}

function attachmentReferences(items) {
  return (Array.isArray(items) ? items : []).map(item => pick(item, [
    'name', 'path', 'url', 'type', 'kind', 'mimeType', 'size', 'assetId', 'fileId', 'sourceAssetId'
  ]));
}

function projectTimeline(items, content, preserveTimelineKeys) {
  const source = Array.isArray(items) ? items : [];
  // The final answer is also stored as a timeline item. Remove only that
  // duplicate, not identical text spoken earlier at a different point.
  const lastText = source.findLastIndex(item => item?.type === 'text');
  const text = source.filter(item => item?.type === 'text').map(item => String(item.content || '').trim()).filter(Boolean).join('\n\n');
  const aggregate = content && text === content.trim() && source.filter(item => item?.type === 'text').length > 1;
  const finalInTimeline = preserveTimelineKeys && lastText >= 0 && content
    && String(source[lastText].content || '').trim() === content.trim();
  const timeline = source.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    // Progress labels and latency/compaction telemetry are presentation only.
    if (item.type === 'progress') return [];
    if (!aggregate && !finalInTimeline && index === lastText && item.type === 'text' && String(item.content || '').trim() === content.trim()) return [];
    const projected = pick(item, [
      'type', 'role', 'name', 'tool', 'callId', 'args', 'input', 'output', 'content', 'text',
      'ok', 'error', 'status', 'interrupted', 'inputUnavailableAtBoundary', 'deliveryState', 'delivered', 'source',
      'contract', 'verification', 'review'
    ]);
    // These keys bind mid-run guidance to the assistant fragments preceding
    // it. They are transcript ordering data when guidance boundaries exist.
    if (preserveTimelineKeys && item.openCodeKey) projected.openCodeKey = item.openCodeKey;
    if (Array.isArray(item.attachments)) projected.attachments = attachmentReferences(item.attachments);
    return Object.keys(projected).length > 1 ? [projected] : [];
  });
  return { timeline, content: aggregate || finalInTimeline ? '' : content };
}

function projectHistoryMessage(message = {}, preserveTimelineKeys = false) {
  const run = message.agentRun || {};
  const content = String(message.content || run.textContent || '');
  const projected = pick(message, ['role', 'ts']);
  const activity = projectTimeline(run.timeline, content, preserveTimelineKeys);
  projected.content = activity.content;
  if (Array.isArray(message.attachments)) projected.attachments = attachmentReferences(message.attachments);
  if (Array.isArray(message.mediaAssets)) projected.mediaAssets = attachmentReferences(message.mediaAssets);
  if (message.media && typeof message.media === 'object') projected.media = Array.isArray(message.media)
    ? attachmentReferences(message.media) : attachmentReferences([message.media])[0];
  if (message.liveGuidance) projected.liveGuidance = pick(message.liveGuidance,
    ['status', 'deliveryEvidence', 'error', 'timelineKey', 'displayBoundary']);
  if (message.agentRun) {
    projected.agentRun = pick(run, ['status', 'error', 'todos', 'planFile']);
    if (preserveTimelineKeys && run.guidanceTimelineKey) projected.agentRun.guidanceTimelineKey = run.guidanceTimelineKey;
    if (activity.timeline.length) projected.agentRun.timeline = activity.timeline;
    // Older records may have no timeline. Keep their only execution evidence
    // rather than assuming the newer renderer already recorded it there.
    if (!Array.isArray(run.timeline) || !run.timeline.length) {
      if (Array.isArray(run.toolCalls)) projected.agentRun.toolCalls = run.toolCalls.map(tool => pick(tool,
        ['callId', 'name', 'args', 'input', 'output', 'ok', 'error', 'status', 'interrupted']));
    }
    if (run.thinkingContent && !(Array.isArray(run.timeline) ? run.timeline : []).some(item => item?.type === 'thinking')) {
      projected.agentRun.thinkingContent = run.thinkingContent;
    }
    if (Array.isArray(run.subagents) && run.subagents.length) projected.agentRun.subagents = run.subagents.map(child => {
      const result = pick(child, ['callId', 'name', 'title', 'role', 'task', 'prompt', 'status', 'result', 'error']);
      if (!result.result) result.result = (Array.isArray(child.timeline) ? child.timeline : [])
        .findLast(item => item?.type === 'text' && String(item.content || '').trim())?.content
        || child.textContent || child.summary || '';
      return result;
    });
  }
  return projected;
}

function orderGuidedHistory(messages) {
  const replacements = new Map();
  const consumed = new Set();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const run = message?.agentRun;
    if (message?.role !== 'assistant' || !run?.guidanceTimelineKey || !Array.isArray(run.timeline)) continue;
    const guides = messages.map((guide, guideIndex) => ({ guide, guideIndex })).filter(({ guide, guideIndex }) =>
      !consumed.has(guideIndex) && guide?.role === 'user' && guide.liveGuidance?.timelineKey === run.guidanceTimelineKey
      && guide.liveGuidance.displayBoundary?.version === 1);
    if (!guides.length) continue;
    // Model history follows arrival order. A result arriving after guidance
    // stays after it, even though the UI updates the earlier tool card in place.
    const slices = projectGuidanceTimeline(run.timeline, guides.map(({ guide }) => guide.liveGuidance.displayBoundary),
      { pairToolResults: false });
    const finalContent = String(message.content || run.textContent || '');
    const timelineText = run.timeline.filter(item => item?.type === 'text').map(item => String(item.content || '').trim()).filter(Boolean);
    const finalInTimeline = finalContent && (timelineText.at(-1) === finalContent.trim()
      || timelineText.join('\n\n') === finalContent.trim());
    const ordered = [];
    for (let part = 0; part < slices.length; part++) {
      const last = part === slices.length - 1;
      const content = last && !finalInTimeline ? finalContent : '';
      if (slices[part].length || content || (last && run.subagents?.length)) {
        const sliceRun = last ? { ...run } : { status: 'incomplete' };
        delete sliceRun.guidanceTimelineKey;
        ordered.push({ ...message, content, agentRun: { ...sliceRun, textContent: '', timeline: slices[part] } });
      }
      if (guides[part]) ordered.push(guides[part].guide);
    }
    const indices = [index, ...guides.map(({ guideIndex }) => guideIndex)];
    replacements.set(Math.min(...indices), ordered);
    for (const consumedIndex of indices) consumed.add(consumedIndex);
  }
  return messages.flatMap((message, index) => replacements.get(index) || (consumed.has(index) ? [] : [message]));
}

function projectHistoryForModel(messages) {
  // A stopped, unreceived interjection remains visible as an audit record.
  // Its ordinary queued user turn is the only model-facing copy, including
  // when a fork or rewind must reconstruct a brand-new native session.
  const modelMessages = (Array.isArray(messages) ? messages : []).filter(message =>
    !((message?.liveGuidance?.continuationIntentId || message?.liveGuidance?.continuationStatus) && message.liveGuidance.nativeDetached === true
      && message.liveGuidance.deliveryEvidence !== 'provider-response'));
  const list = orderGuidedHistory(modelMessages);
  const preserveTimelineKeys = list.some(message => message?.liveGuidance?.displayBoundary);
  return list.map(message => projectHistoryMessage(message, preserveTimelineKeys));
}

module.exports = { projectHistoryForModel };
