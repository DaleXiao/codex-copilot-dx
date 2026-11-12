import test from "node:test";
import assert from "node:assert/strict";
import { startAdapter } from "../src/adapter.mjs";
import { maskPrivacyRequest, protectPrivacyResponse } from "../src/privacy-transform.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

const headers = { host: "127.0.0.1:2026", authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account" };
const request = { model: "gemini-4-carbon", id: "session-fixture", commands: { search_query: [{ q: "fixture query" }],
  open: [{ ref_id: "turn0search0", lineno: 12 }] }, settings: { external_web_access: "live" } };

test("Carbon search passes the complete native request and output to its configured backend", async () => {
  let seen;
  const expected = { output: "fixture source", results: [{ type: "text_result", ref_id: "turn0search0", url: "https://example.test/" }] };
  const response = await invokeAdapter({ carbonSearchFn: async (body, options) => {
    seen = { body: structuredClone(body), headers: options.headers };
    return Response.json(expected);
  } }, { url: "/v1/alpha/search", body: request, headers });
  assert.equal(response.status, 200);
  assert.deepEqual(seen.body, request);assert.equal(seen.headers, undefined);
  assert.deepEqual(JSON.parse(response.text), expected);
});

test("Carbon search rejects browser origins, unknown models and unavailable backends", async () => {
  let calls = 0;
  const options = { carbonSearchFn: async () => { calls += 1;return Response.json({ output: "should not run" }); } };
  const browser = await invokeAdapter(options, { url: "/v1/alpha/search", body: request, headers: { ...headers, origin: "https://example.test" } });
  assert.equal(browser.status, 403);
  const otherModel = await invokeAdapter(options, { url: "/v1/alpha/search", body: { ...request, model: "gpt-other" }, headers });
  assert.equal(otherModel.status, 400);
  const unavailable = await invokeAdapter({ carbonSearchFn: async () => {
    throw Object.assign(new Error("Search is unavailable"), { statusCode: 503 });
  } }, { url: "/v1/alpha/search", body: request, headers });
  assert.equal(unavailable.status, 503);
  assert.equal(calls, 0);
});

test("Carbon search resolves a bound model and refuses a different source", async () => {
  let calls = 0;
  const runtime = { resolveCodex(body) { body.model = "gemini-4-carbon";return { id: "github" }; },
    current: () => ({ id: "github" }) };
  const options = { providerRuntime: runtime, carbonSearchFn: async () => { calls += 1;return Response.json({ output: "ok" }); } };
  const success = await invokeAdapter(options, { url: "/v1/alpha/search", body: { ...request, model: "github/carbon" }, headers });
  assert.equal(success.status, 200);
  runtime.resolveCodex = body => { body.model = "gemini-4-carbon";return { id: "api_other" }; };
  const refused = await invokeAdapter(options, { url: "/v1/alpha/search", body: { ...request, model: "api_other/carbon" }, headers });
  assert.equal(refused.status, 400);assert.equal(calls, 1);
});

test("Carbon search preserves privacy masking and restores search results", async t => {
  const secret = "ghp_" + "q".repeat(36), sessions = new WeakMap();let sent;
  const privacy = {
    wrap(fn, { res, protocol }) {
      return async (body, options) => {
        const session = await maskPrivacyRequest(body, { protocol, secret: Buffer.alloc(32, 1), find: async texts => texts.map(() => []) });
        sessions.set(res, session);protectPrivacyResponse(res, session);
        return fn(session.body, options);
      };
    },
    restoreResponse: (res, value) => sessions.get(res)?.restoreValue(value) || value,
    close() {},
  };
  const server = await startAdapter(0, "127.0.0.1", { privacy, carbonSearchFn: async body => {
    sent = JSON.stringify(body);
    return Response.json({ output: body.commands.search_query[0].q, results: [] });
  } });
  t.after(() => new Promise(resolve => { server.closeAllConnections();server.close(resolve); }));
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/v1/alpha/search", { method: "POST",
    headers: { authorization: headers.authorization, "chatgpt-account-id": headers["chatgpt-account-id"], "content-type": "application/json" },
    body: JSON.stringify({ ...request, input: secret, commands: { search_query: [{ q: "find " + secret }] } }) });
  assert.equal(response.status, 200);
  assert.equal(sent.includes(secret), false);assert.match(sent, /\{\{CCDX_[a-f0-9]{24}\}\}/);
  assert.equal((await response.json()).output, "find " + secret);
});

test("Carbon search surfaces a rate limit without retrying", async () => {
  let calls = 0;
  const response = await invokeAdapter({ carbonSearchFn: async () => {
    calls += 1;return new Response('{"error":{"code":"rate_limited"}}', { status: 429,
      headers: { "content-type": "application/json", "retry-after": "5" } });
  } }, { url: "/v1/alpha/search", body: request, headers });
  assert.equal(response.status, 429);
  assert.equal(response.headers["Retry-After"], "5");
  assert.equal(calls, 1);
});

test("Carbon search passes through Copilot's retry-after hint", async () => {
  const response = await invokeAdapter({ carbonSearchFn: async () => {
    throw Object.assign(new Error("rate limited"), { statusCode: 429, retryAfter: "5" });
  } }, { url: "/v1/alpha/search", body: request, headers });
  assert.equal(response.status, 429);assert.equal(response.headers["Retry-After"], "5");
});

test("Carbon search timeout cancels its single upstream request", async () => {
  let calls = 0, aborted = false;
  const response = await invokeAdapter({ upstreamTimeoutMs: 5, carbonSearchFn: async (_body, { signal }) => {
    calls += 1;
    return await new Promise((_, reject) => signal.addEventListener("abort", () => {
      aborted = true;reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true }));
  } }, { url: "/v1/alpha/search", body: request, headers });
  assert.equal(response.status, 504);assert.equal(calls, 1);assert.equal(aborted, true);
});
