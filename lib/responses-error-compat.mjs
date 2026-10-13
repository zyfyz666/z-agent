// Some Responses gateways send the nested error envelope with a nullable
// code. The SDK accepts that envelope only when code is a string. Repair just
// that field before validation; leave retry and partial-output handling to it.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeErrorBlock(block) {
  const text = decoder.decode(block);
  const lines = text.split(/\r\n|\r|\n/);
  const dataLines = lines.flatMap((line, index) => line.startsWith('data:')
    ? [{ index, data: line.slice(5).replace(/^ /, '') }] : []);
  if (!dataLines.length) return block;
  let event;
  try { event = JSON.parse(dataLines.map(line => line.data).join('\n')); }
  catch { return block; }
  const error = event?.error;
  if (event?.type !== 'error' || !error || typeof error !== 'object'
    || Array.isArray(error) || error.code != null) return block;

  const code = typeof error.type === 'string' && error.type.trim() ? error.type : 'unknown_error';
  const normalized = { ...event, error: { ...error, code } };
  const first = dataLines[0].index;
  const remaining = new Set(dataLines.slice(1).map(line => line.index));
  const newline = text.match(/\r\n|\r|\n/)?.[0] || '\n';
  return encoder.encode(lines.flatMap((line, index) => index === first
    ? [`data: ${JSON.stringify(normalized)}`] : remaining.has(index) ? [] : [line]).join(newline));
}

export function normalizeResponsesErrorStream(response) {
  if (!response.ok || !response.body || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) return response;
  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  let scanned = 0;
  let lineStart = 0;
  let ended = false;
  const cancelUpstream = async reason => {
    try { await reader.cancel(reason); } catch { /* preserve the original failure */ }
    try { reader.releaseLock(); } catch { /* a cancelled read may still be settling */ }
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (!ended) {
          // Frame bytes before decoding so untouched events, including their
          // line endings and UTF-8 chunk boundaries, are passed through exactly.
          while (scanned < buffer.length) {
            const byte = buffer[scanned];
            if (byte !== 10 && byte !== 13) { scanned++; continue; }
            if (byte === 13 && scanned + 1 === buffer.length) break;
            const end = scanned + (byte === 13 && buffer[scanned + 1] === 10 ? 2 : 1);
            const blank = scanned === lineStart;
            scanned = end;
            lineStart = end;
            if (!blank) continue;
            const block = buffer.subarray(0, end);
            buffer = buffer.subarray(end);
            scanned = 0;
            lineStart = 0;
            controller.enqueue(normalizeErrorBlock(block));
            return;
          }
          const next = await reader.read();
          if (ended) return;
          if (next.done) {
            ended = true;
            if (buffer.length) controller.enqueue(normalizeErrorBlock(buffer));
            controller.close();
            reader.releaseLock();
            return;
          }
          const combined = new Uint8Array(buffer.length + next.value.length);
          combined.set(buffer);
          combined.set(next.value, buffer.length);
          buffer = combined;
        }
      } catch (error) {
        ended = true;
        controller.error(error);
        void cancelUpstream(error);
      }
    },
    cancel(reason) { ended = true; buffer = new Uint8Array(0); return cancelUpstream(reason); }
  }, { highWaterMark: 0 });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
