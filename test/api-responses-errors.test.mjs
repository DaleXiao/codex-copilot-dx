import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiProvider } from '../src/providers/api.mjs';
import { proxyCopilotResponses } from '../src/responses-proxy.mjs';
import { createAdapterHandler } from '../src/adapter.mjs';
import { createRequestAdmission } from '../src/request-admission.mjs';
import { invokeAdapterRequest } from '../test-support/adapter.mjs';
import { Readable } from 'node:stream';
import { createUpstreamErrorCapture } from '../src/upstream-error-capture.mjs';
import { runWithRequestContext } from '../src/request-context.mjs';

test('one-shot diagnostics stay on the original provider path and redact credentials before retention', async () => {
  const capture = createUpstreamErrorCapture(), observed = [], key = 'fixture-private-literal';
  const provider = createApiProvider({ config: { id: 'api_capture', name: 'Capture', base_url: 'https://example.test/v1',
    endpoints: { messages: 'https://example.test/v1/messages' }, secret_ref: 'a'.repeat(32), auth_header: 'bearer', models: [{ id: 'kimi', protocols: ['messages'] }] },
    env: {}, errorCapture: capture, secrets: { get: async () => key }, networkFactory: async () => ({ close() {}, fetch: async () =>
      Response.json({ error: { type: 'invalid_request_error', message: 'Unexpected message field; key=' + key + '; content: private request echo' } }, { status: 400 }) }) });
  const request = id => runWithRequestContext({ requestId: id, onHttpError: e => observed.push(e) }, () => provider.client.messages({ model: 'kimi', max_tokens: 32, messages: [] }));
  try {
    await request('before');assert.deepEqual(observed, []);
    capture.arm('api_capture', 'kimi');const response = await request('chosen');
    assert.equal(response.status, 400);assert.equal(capture.snapshot().state, 'captured');
    assert.equal(capture.snapshot().request_id, 'chosen');assert.equal(observed.length, 1);
    assert.doesNotMatch(JSON.stringify(observed) + JSON.stringify(capture.snapshot()), /fixture-private-literal|private request echo/);
    assert.doesNotMatch(await response.text(), /Unexpected message field|fixture-private-literal|private request echo/);
    await request('after');assert.equal(observed.length, 1);
  } finally { provider.close(); }
});

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

test('sanitized upstream reason survives both Responses modes without exposing vendor text', async () => {
  for (const stream of [false, true]) {
    let calls = 0;
    const provider = createApiProvider({ config: { id: 'api_errors', name: 'Errors', enabled: true, base_url: 'https://example.test/v1',
      endpoints: { responses: 'https://example.test/v1/responses' }, secret_ref: 'a'.repeat(64), auth_header: 'bearer', models: [{ id: 'test', protocols: ['responses'] }] },
      env: {}, platform: 'linux', secrets: { get: async () => 'synthetic-private-key' }, networkFactory: async () => ({ close() {}, fetch: async () => {
        calls++;return Response.json({ error: { code: 'rate_limit_exceeded', message: 'synthetic-private-key and prompt' } }, { status: 429, headers: { 'Retry-After': '12' } });
      } }) });
    const res = { headersSent: false, writeHead(code, headers) { this.status = code;this.headers = headers;this.headersSent = true; }, end(text) { this.text = text; } };
    try {
      await proxyCopilotResponses({ body: { model: 'test', input: 'synthetic', stream }, surface: 'responses' }, {}, res,
        provider.client.responses, { compatibility: provider.compatibility });
      const error = JSON.parse(res.text).error;
      assert.equal(error.code, 'ccdx_api_http_429');assert.equal(error.upstream_code, 'rate_limit_exceeded');
      assert.equal(res.headers['Retry-After'], '12');assert.equal(calls, 1);assert.doesNotMatch(res.text, /synthetic-private-key|prompt/);
    } finally { provider.close(); }
  }
});

test('a slow API error releases the Responses admission before reading its body', async () => {
  let reading, released = 0;const started = new Promise(resolve => { reading = resolve; });
  const provider = createApiProvider({ config: { id: 'api_errors', name: 'Errors', enabled: true, base_url: 'https://example.test/v1',
    endpoints: { responses: 'https://example.test/v1/responses' }, secret_ref: 'a'.repeat(64), auth_header: 'bearer', models: [{ id: 'test', protocols: ['responses'] }] },
    env: {}, platform: 'linux', secrets: { get: async () => 'synthetic-key' }, networkFactory: async () => ({ close() {}, fetch: async () =>
      new Response(new ReadableStream({ pull() { reading();return new Promise(() => {}); }, cancel() {} }), { status: 429 }) }) });
  const res = { headersSent: false, writeHead(code) { this.status = code;this.headersSent = true; }, end(text) { this.text = text; } };
  try {
    const pending = proxyCopilotResponses({ body: { model: 'test', input: 'synthetic', stream: false }, surface: 'responses' }, {}, res,
      provider.client.responses, { compatibility: provider.compatibility, releaseRequest: () => { released++; } });
    await started;await new Promise(setImmediate);assert.equal(released, 1);await pending;assert.equal(res.status, 429);
  } finally { provider.close(); }
});

test('a successful conversation is admitted while another API error body is delayed', { timeout: 5000 }, async t => {
  let reading;const started = new Promise(resolve => { reading = resolve; });
  const provider = createApiProvider({ config: { id: 'api_errors', name: 'Errors', enabled: true, base_url: 'https://example.test/v1',
    endpoints: { responses: 'https://example.test/v1/responses' }, secret_ref: 'a'.repeat(64), auth_header: 'bearer', models: [{ id: 'test', protocols: ['responses'] }] },
    env: {}, platform: 'linux', secrets: { get: async () => 'synthetic-key' }, networkFactory: async () => ({ close() {}, fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (JSON.stringify(body.input).includes('failure')) return new Response(new ReadableStream({ pull() { reading();return new Promise(() => {}); }, cancel() {} }), { status: 429 });
      return Response.json({ id: 'resp_fixture', object: 'response', status: 'completed', model: 'test', output: [] });
    } }) });
  const admission = createRequestAdmission({ maxBytes: 512, maxQueued: 4 });
  const handler = createAdapterHandler({ provider, codexClient: provider.client, modelRegistry: provider.registry, acquireRequest: admission,
    privacy: { wrap: fn => fn, restoreResponse: (_res, value) => value, snapshot: () => ({}), close() {} } });
  t.after(() => { handler.cleanup?.();provider.close(); });
  const call = input => {
    const bytes = Buffer.from(JSON.stringify({ model: 'test', input, stream: false })), req = Readable.from([bytes]);
    req.headers = { 'content-type': 'application/json', 'content-length': String(bytes.length) };
    req.method = 'POST';req.url = '/v1/responses';req.socket = { remoteAddress: '127.0.0.1' };
    return invokeAdapterRequest({}, req, handler);
  };
  const failure = call('failure' + 'x'.repeat(350));await started;await new Promise(setImmediate);
  assert.equal(admission.stats().activeBytes, 0);
  const success = await call('success' + 'x'.repeat(350));assert.equal(success.status, 200);
  assert.equal((await failure).status, 429);assert.equal(admission.stats().queued, 0);
});
