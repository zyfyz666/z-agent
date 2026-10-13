'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { buildOpenCodeConfig, buildPromptParts, OpenCodeSidecar } = require('../lib/opencode-sidecar');

function requestWithPdfCapability(enabled = true) {
  const options = { providerId: 'pdf-test', modelId: 'gpt-6-astra',
    capabilities: { imageInput: true, pdfInput: enabled } };
  return { ...options, openCodeConfig: buildOpenCodeConfig(options) };
}

function pdfFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-pdf-attachments-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, '论文 附件.PDF');
  const bytes = Buffer.from('%PDF-1.4\nPDF byte-preservation fixture\n%%EOF\n');
  fs.writeFileSync(filePath, bytes);
  return { dir, filePath, bytes };
}

test('PDF attachments become native file input with their original name and bytes', t => {
  const { filePath, bytes } = pdfFixture(t);
  for (const mimeType of ['', 'application/octet-stream', 'application/pdf', 'APPLICATION/PDF; charset=binary']) {
    const parts = buildPromptParts({ ...requestWithPdfCapability(), prompt: 'Read this paper.',
      attachments: [{ path: filePath, name: '论文.PDF', mimeType }] });
    assert.equal(parts[0].text, 'Read this paper.');
    assert.equal(parts.length, 2);
    assert.equal(parts[1].type, 'file');
    assert.equal(parts[1].mime, 'application/pdf');
    assert.equal(parts[1].filename, '论文.PDF');
    assert.deepEqual(fs.readFileSync(fileURLToPath(parts[1].url)), bytes);
  }
});

test('PDF input uses the original filename if an upload path has no extension', t => {
  const { dir, bytes } = pdfFixture(t);
  const filePath = path.join(dir, 'upload-id');
  fs.writeFileSync(filePath, bytes);
  const parts = buildPromptParts({ ...requestWithPdfCapability(),
    attachments: [{ path: filePath, name: 'original.pdf', mimeType: 'application/octet-stream' }] });
  assert.equal(parts[1].type, 'file');
  assert.equal(parts[1].mime, 'application/pdf');
});

test('a model without PDF support explicitly reports that PDF contents were not sent', t => {
  const { filePath } = pdfFixture(t);
  const request = requestWithPdfCapability(false);
  // A stale capability snapshot must not override the actual native config.
  request.capabilities.pdfInput = true;
  const parts = buildPromptParts({ ...request, attachments: [{ path: filePath }] });
  assert.equal(parts.some(part => part.type === 'file'), false);
  assert.match(parts[1].text, /PDF contents have not been sent/);
});

test('disabling image relay does not enable PDF for an unknown model', () => {
  const config = buildOpenCodeConfig({ providerId: 'pdf-test', modelId: 'unknown', visionRelayEnabled: false });
  const model = config.provider['pdf-test'].models.unknown;
  assert.equal(model.attachment, true);
  assert.deepEqual(model.modalities.input, ['text', 'image']);
});

test('PDF support can be declared independently of image support', () => {
  const config = buildOpenCodeConfig({ providerId: 'pdf-test', modelId: 'pdf-model', capabilities: { pdfInput: true } });
  const model = config.provider['pdf-test'].models['pdf-model'];
  assert.equal(model.attachment, true);
  assert.deepEqual(model.modalities.input, ['text', 'pdf']);
});

test('missing PDF attachments cannot silently become a prompt with no PDF', t => {
  const { dir } = pdfFixture(t);
  assert.throws(() => buildPromptParts({ ...requestWithPdfCapability(),
    attachments: [{ path: path.join(dir, 'missing.pdf') }] }), { code: 'PDF_ATTACHMENT_UNAVAILABLE' });
});

test('PDF input validates individual and combined raw file sizes before upload', t => {
  const { dir } = pdfFixture(t);
  const filePath = path.join(dir, 'large.pdf');
  fs.writeFileSync(filePath, '');
  fs.truncateSync(filePath, 50_000_000);
  assert.throws(() => buildPromptParts({ ...requestWithPdfCapability(),
    attachments: [{ path: filePath }] }), { code: 'PDF_ATTACHMENT_TOO_LARGE' });
  fs.truncateSync(filePath, 25_000_001);
  assert.throws(() => buildPromptParts({ ...requestWithPdfCapability(),
    attachments: [{ path: filePath }, { path: filePath }] }), { code: 'PDF_ATTACHMENT_TOO_LARGE' });
});

test('PDF input preserves text, image and directory attachments in the same message', t => {
  const { dir, filePath } = pdfFixture(t);
  const textPath = path.join(dir, 'notes.txt');
  const imagePath = path.join(dir, 'chart.png');
  fs.writeFileSync(textPath, 'Read page two.');
  fs.writeFileSync(imagePath, 'image fixture');
  const parts = buildPromptParts({ ...requestWithPdfCapability(), attachments: [
    { path: filePath }, { path: textPath }, { path: imagePath }, { path: dir }
  ] });
  assert.deepEqual(parts.filter(part => part.type === 'file').map(part => part.mime), ['application/pdf', 'image/png']);
  assert.ok(parts.some(part => part.text?.includes('Read page two.')));
  assert.ok(parts.some(part => part.text?.includes('contents are not embedded')));
});

test('mid-run guidance uses the active task PDF capability and sends the file beside its receipt', async t => {
  const { filePath, bytes } = pdfFixture(t);
  const sidecar = new OpenCodeSidecar();
  const submitted = [];
  sidecar.client = { session: { promptAsync: async payload => { submitted.push(payload); return { data: true }; } } };
  const run = { runId: 'pdf-run', request: { ...requestWithPdfCapability(), zSessionId: 'pdf-task' },
    openCodeSessionID: 'native-pdf-task', directory: process.cwd(), acceptingInterjections: true,
    guidanceVersion: 0, interjections: [], onEvent: () => {} };
  sidecar.activeRuns.set(run.runId, run);
  t.after(() => sidecar.activeRuns.clear());
  const receipt = await sidecar.deliverInterjection(run.runId, { source: 'user', requestId: 'pdf-guide',
    guidance: 'Use the attached paper.', attachments: [{ path: filePath }] });
  assert.equal(receipt.accepted, true);
  assert.equal(submitted[0].noReply, true);
  assert.match(submitted[0].parts[0].text, /Z_GUIDANCE_RECEIPT:/);
  const part = submitted[0].parts.find(part => part.mime === 'application/pdf');
  assert.ok(part, 'guidance lost the PDF before insertion');
  assert.deepEqual(fs.readFileSync(fileURLToPath(part.url)), bytes);
});
