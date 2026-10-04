(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZGuidanceTimeline = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isText = item => item?.type === 'text' || item?.type === 'thinking';

  function timelineKey(item, index) {
    const explicit = String(item?.openCodeKey || '').trim();
    if (explicit) return explicit;
    const type = String(item?.type || 'part');
    const callId = String(item?.callId || '').trim();
    return `${type}:${callId || index}`;
  }

  // A boundary records what the renderer had received when guidance was sent.
  // Text lengths matter because one native part can keep streaming across any
  // number of guidance messages without acquiring a new part identity.
  function captureBoundary(rawTimeline) {
    const keys = [];
    const seen = new Set();
    const textLengths = Object.create(null);
    (Array.isArray(rawTimeline) ? rawTimeline : []).forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const key = timelineKey(item, index);
      if (!seen.has(key)) { keys.push(key); seen.add(key); }
      if (isText(item)) textLengths[key] = String(item.content || '').length;
    });
    return { version: 1, keys, textLengths };
  }

  function normalizeBoundary(boundary) {
    return {
      keys: new Set(Array.isArray(boundary?.keys) ? boundary.keys.filter(key => typeof key === 'string') : []),
      textLengths: boundary?.textLengths && typeof boundary.textLengths === 'object' ? boundary.textLengths : {}
    };
  }

  function firstObservedSegment(key, boundaries) {
    const index = boundaries.findIndex(boundary => boundary.keys.has(key));
    return index < 0 ? boundaries.length : index;
  }

  function toolResultSegments(timeline, boundaries) {
    const calls = [];
    const byCallId = new Map();
    timeline.forEach((item, index) => {
      if (item?.type !== 'tool_call') return;
      const call = { item, index, segment: firstObservedSegment(timelineKey(item, index), boundaries), claimed: false };
      calls.push(call);
      const callId = String(item.callId || '').trim();
      if (callId) byCallId.set(callId, call);
    });
    const destinations = new Map();
    timeline.forEach((item, index) => {
      if (item?.type !== 'tool_result') return;
      const callId = String(item.callId || '').trim();
      const call = callId
        ? byCallId.get(callId)
        : calls.find(candidate => !candidate.claimed && candidate.index < index
          && (!item.name || candidate.item.name === item.name));
      if (!call) return;
      call.claimed = true;
      destinations.set(index, call.segment);
    });
    return destinations;
  }

  function escaped(source, position) {
    let slashes = 0;
    while (position > 0 && source[--position] === '\\') slashes++;
    return slashes % 2 === 1;
  }

  // Match the renderer's fenced-code and display-math delimiters. These spans
  // only restore syntax around a displayed fragment; their source is never
  // inserted into the saved conversation or the model's context.
  function markdownBlocks(source) {
    const blocks = [];
    const protectedRanges = [];
    const fences = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/gm;
    let opening;
    while ((opening = fences.exec(source))) {
      const fence = opening[1];
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r\\n|\\r|\\n|$)`, 'gm');
      closing.lastIndex = fences.lastIndex;
      const end = closing.exec(source);
      const block = { kind: 'code', start: opening.index, bodyStart: fences.lastIndex,
        bodyEnd: end ? end.index : source.length, end: end ? closing.lastIndex : source.length,
        opening: opening[0], closing: fence, closed: !!end };
      blocks.push(block); protectedRanges.push(block);
      fences.lastIndex = block.end;
    }
    // Dollar and bracket notation inside inline code is also literal.
    const inline = /(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g;
    let code;
    let fenceIndex = 0;
    while ((code = inline.exec(source))) {
      while (blocks[fenceIndex]?.end <= code.index) fenceIndex++;
      if (blocks[fenceIndex] && blocks[fenceIndex].start < inline.lastIndex) continue;
      protectedRanges.push({ start: code.index, end: inline.lastIndex });
    }
    protectedRanges.sort((left, right) => left.start - right.start);
    let protectedIndex = 0;
    const mathOpenings = /\$\$|\\\[/g;
    while ((opening = mathOpenings.exec(source))) {
      const start = opening.index;
      while (protectedRanges[protectedIndex]?.end <= start) protectedIndex++;
      const protectedRange = protectedRanges[protectedIndex];
      if (protectedRange && protectedRange.start <= start) {
        mathOpenings.lastIndex = protectedRange.end;
        continue;
      }
      if (escaped(source, start)) continue;
      const prefix = source.slice(Math.max(0, start - 2048), start);
      if (/(?:https?:\/\/|file:\/\/|www\.|[A-Za-z]:[\\/])[^\s<>"'`]*$/i.test(prefix)) continue;
      const delimiter = opening[0];
      const right = delimiter === '\\[' ? '\\]' : '$$';
      let closing = source.indexOf(right, mathOpenings.lastIndex);
      while (closing >= 0 && escaped(source, closing)) closing = source.indexOf(right, closing + right.length);
      const end = closing < 0 ? source.length : closing + right.length;
      // The math renderer does not parse an expression across protected code.
      if (protectedRange && protectedRange.start < end) continue;
      blocks.push({ kind: 'math', start, bodyStart: mathOpenings.lastIndex,
        bodyEnd: closing < 0 ? source.length : closing, end,
        opening: delimiter, closing: right, closed: closing >= 0 });
      mathOpenings.lastIndex = end;
    }
    return blocks.sort((left, right) => left.start - right.start);
  }

  function markdownFragment(source, start, end, blocks) {
    const pieces = [];
    let cursor = start;
    for (const block of blocks) {
      if (block.end <= start) continue;
      if (block.start >= end) break;
      const overlapStart = Math.max(start, block.start);
      if (overlapStart > cursor) pieces.push(source.slice(cursor, overlapStart));
      if (start <= block.start && end >= block.end && block.closed) {
        pieces.push(source.slice(block.start, block.end));
      } else {
        const bodyStart = Math.max(start, block.bodyStart);
        const bodyEnd = Math.min(end, block.bodyEnd);
        const body = bodyEnd > bodyStart ? source.slice(bodyStart, bodyEnd) : '';
        if (body) {
          pieces.push(block.opening, body);
          if (block.kind === 'code' && !/[\r\n]$/.test(body)) pieces.push('\n');
          pieces.push(block.closing);
          // A closing fence occupies its own line even when ordinary prose
          // follows it in this fragment. Math delimiters do not need a newline.
          if (block.kind === 'code' && end > block.end) pieces.push('\n');
        }
      }
      cursor = Math.min(end, block.end);
    }
    if (cursor < end) pieces.push(source.slice(cursor, end));
    return pieces.join('');
  }

  function textSlice(item, content, start, end, beforeGuidance, blocks) {
    const slice = { ...item, content: content.slice(start, end), ...(beforeGuidance ? { streaming: false } : {}) };
    if (item.type === 'text' && (beforeGuidance || start > 0 || end < content.length)) {
      const markdown = markdownFragment(content, start, end, blocks);
      if (markdown !== slice.content) slice.guidanceMarkdown = markdown;
    }
    return slice;
  }

  function markdownContent(item) {
    return typeof item?.guidanceMarkdown === 'string' ? item.guidanceMarkdown : String(item?.content || '');
  }

  // This is a presentation projection, never model history. Keep the raw run
  // untouched and retain even empty segments so guidance stays in send order.
  function projectTimeline(rawTimeline, rawBoundaries) {
    const timeline = Array.isArray(rawTimeline) ? rawTimeline : [];
    const boundaries = (Array.isArray(rawBoundaries) ? rawBoundaries : []).map(normalizeBoundary);
    const segments = Array.from({ length: boundaries.length + 1 }, () => []);
    const resultSegments = toolResultSegments(timeline, boundaries);
    const lastLoader = timeline.reduce((last, item, index) => item?.type === 'progress' && item.variant === 'agent-loader' ? index : last, -1);
    timeline.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const key = timelineKey(item, index);
      if (!isText(item)) {
        // Waiting is transient run status, not completed activity at a guidance
        // boundary. It belongs only to the current tail, once.
        if (item.type === 'progress' && item.variant === 'agent-loader') {
          if (index === lastLoader) segments[boundaries.length].push({ ...item });
          return;
        }
        const segment = resultSegments.has(index) ? resultSegments.get(index) : firstObservedSegment(key, boundaries);
        segments[segment].push({ ...item });
        return;
      }
      const content = String(item.content || '');
      if (!content) {
        const segment = firstObservedSegment(key, boundaries);
        segments[segment].push({ ...item, ...(segment < boundaries.length ? { streaming: false } : {}) });
        return;
      }
      let offset = 0;
      const blocks = item.type === 'text' && boundaries.length ? markdownBlocks(content) : [];
      boundaries.forEach((boundary, segment) => {
        // A key can first appear as an empty/progress item. Missing text length
        // must not pull text received later back before that guidance.
        if (!boundary.keys.has(key) || !owns(boundary.textLengths, key)) return;
        const length = Number(boundary.textLengths[key]);
        if (!Number.isFinite(length)) return;
        const end = Math.max(offset, Math.min(content.length, Math.max(0, Math.floor(length))));
        if (end > offset) segments[segment].push(textSlice(item, content, offset, end, true, blocks));
        offset = end;
      });
      if (offset < content.length) segments[boundaries.length].push(textSlice(item, content, offset, content.length, false, blocks));
    });
    return segments;
  }

  return { captureBoundary, projectTimeline, markdownContent };
});
