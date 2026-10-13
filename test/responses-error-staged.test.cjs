'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { stageResponsesProviderModule, stageGptlProviderModule } = require('../lib/opencode-sidecar');

// Load the same standalone artifacts copied into Z's runtime, not just the
// source modules. This catches shipping an old bundle after a source repair.
for (const [name, stage, factoryName] of [
  ['Responses', stageResponsesProviderModule, 'createZOpenAIResponsesProvider'],
  ['GPTL Responses', stageGptlProviderModule, 'createZGptlProvider']
]) {
  test(`${name}: staged adapter preserves nullable-code service errors`, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-error-compat-stage-'));
    t.after(() => {
      assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dataDir).startsWith('z-error-compat-stage-'));
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const moduleUrl = stage({ appRoot: path.resolve(__dirname, '..'), dataDir });
    const providerModule = await import(moduleUrl);
    for (const streamEnabled of [true, false]) {
      let requests = 0;
      const provider = providerModule[factoryName]({
        name: 'error-fixture', apiKey: 'synthetic', baseURL: 'https://example.invalid/v1',
        apiFormat: 'responses', streamEnabled,
        fetch: async () => {
          requests++;
          return new Response(`data: ${JSON.stringify({ type: 'error', error: {
            type: 'server_error', code: null,
            message: 'An error occurred while processing the request.', param: null
          }, sequence_number: 0 })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        }
      });
      await assert.rejects(provider.languageModel('gpt-6-astra').doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic compatibility check' }] }],
        abortSignal: AbortSignal.timeout(5000)
      }), error => {
        assert.equal(error.name, 'AI_APICallError');
        assert.equal(error.statusCode, 500);
        assert.equal(error.isRetryable, true);
        assert.equal(error.message, 'An error occurred while processing the request.');
        return true;
      });
      assert.equal(requests, 1, 'the adapter repairs the event without replaying the request itself');
    }
  });
}
