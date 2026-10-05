'use strict';

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
      'ok', 'error', 'status', 'interrupted', 'deliveryState', 'delivered', 'source',
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

function projectHistoryForModel(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const preserveTimelineKeys = list.some(message => message?.liveGuidance?.displayBoundary);
  return list.map(message => projectHistoryMessage(message, preserveTimelineKeys));
}

module.exports = { projectHistoryForModel };
