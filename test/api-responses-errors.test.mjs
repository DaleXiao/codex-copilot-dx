import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiProvider } from '../src/providers/api.mjs';
import { proxyCopilotResponses } from '../src/responses-proxy.mjs';

test('Responses errors retain safe JSON and backoff in streaming and JSON requests', async () => {
  for (const stream of [false, true]) for (const status of [401, 403, 429, 500, 503]) {
    let calls = 0, cancelled = 0;
    const provider = createApiProvider({ config: { id: 'api_errors', name: 'Errors', enabled: true, base_url: 'https://example.test/v1',
      endpoints: { responses: 'https://example.test/v1/responses' }, secret_ref: 'a'.repeat(64), auth_header: 'bearer', models: [{ id: 'test', protocols: ['responses'] }] },
      env: {}, platform: 'linux', secrets: { get: async () => 'synthetic-private-key' }, networkFactory: async () => ({ close() {}, fetch: async () => {
        calls++;return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status, headers: { 'Retry-After': '12' } });
      } }) });
    const res = { headersSent: false, writeHead(code, headers) { this.status = code;this.headers = headers;this.headersSent = true; }, end(text) { this.text = text; } };
    try {
      await proxyCopilotResponses({ body: { model: 'test', input: 'synthetic', stream }, surface: 'responses' }, {}, res,
        provider.client.responses, { compatibility: provider.compatibility });
      assert.equal(res.status, status);assert.equal(JSON.parse(res.text).error.code, `ccdx_api_http_${status}`);
      assert.equal(res.headers['Retry-After'], '12');assert.equal(calls, 1);assert.equal(cancelled, 1);
      assert.doesNotMatch(res.text, /synthetic-private-key/);
    } finally { provider.close(); }
  }
});
