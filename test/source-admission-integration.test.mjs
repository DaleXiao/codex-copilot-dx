import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createSourceAdmission, admittedSource } from "../src/source-admission.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { createRequestAdmission } from "../src/request-admission.mjs";
import { readJsonBody } from "../src/http-transport.mjs";
import { summaryRequest } from "../src/context-compaction-wire.mjs";

test("an API's private limit evidence survives safe error projection without leaking vendor text", async () => {
  const scheduler = createSourceAdmission();
  const raw = createApiProvider({ config: { id: "api_feedback", name: "synthetic", secret_ref: "a".repeat(32), auth_header: "bearer", base_url: "https://synthetic.test/v1",
    endpoints: { messages: "https://synthetic.test/v1/messages" }, models: [{ id: "model", protocols: ["messages"] }] }, secrets: { get: async () => "synthetic-key" },
    networkFactory: async () => ({ close() {}, fetch: async () => Response.json({ error: { code: "concurrency_limit", limit: 1, message: "vendor private sentence" } }, { status: 429 }) }) });
  const provider = admittedSource(raw, scheduler), response = await provider.client.messages({ model: "model", max_tokens: 4, messages: [{ role: "user", content: "synthetic" }] });
  assert.equal(scheduler.snapshot()[0].limit, 1);
  const text = await response.text();assert.doesNotMatch(text, /vendor private sentence|synthetic-key|source limit evidence/);
  assert.match(text, /ccdx_api_http_429/);assert.equal(scheduler.snapshot()[0].active, 0);provider.close();scheduler.close();
});

test("response policy markers survive source stream ownership without replacing native internals", async () => {
  const scheduler = createSourceAdmission(), marker = Symbol("guard"), value = {};
  const raw = Response.json({ original: true });Object.defineProperty(raw, marker, { value });
  const response = await scheduler.run({ source: "github" }, async () => raw);
  assert.equal(response[marker], value);assert.deepEqual(await response.json(), { original: true });
  assert.equal(scheduler.snapshot()[0].active, 0);scheduler.close();
});

test("lazy stream metadata preserves JSON, cloning and body-consumption rules", async () => {
  const scheduler = createSourceAdmission();
  const original = Response.json({ value: "synthetic" }, { status: 201, headers: { "x-fixture": "retained" } });
  const response = await scheduler.run({ source: "github" }, async () => original);
  assert.ok(response instanceof Response);assert.equal(response.status, 201);assert.equal(response.headers.get("x-fixture"), "retained");assert.equal(response.bodyUsed, false);
  const copy = response.clone();assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), { value: "synthetic" });assert.deepEqual(await copy.json(), { value: "synthetic" });
  assert.equal(response.bodyUsed, true);await assert.rejects(response.text(), TypeError);assert.equal(scheduler.snapshot()[0].active, 0);scheduler.close();
});

test("cloning leaves the original body available to streaming readers", async () => {
  const scheduler = createSourceAdmission(), response = await scheduler.run({ source: "github" }, async () => new Response("synthetic"));
  const copy = response.clone(), reader = response.body.getReader(), chunks = [];
  for (;;) { const { done, value } = await reader.read();if (done) break;chunks.push(value); }
  assert.equal(Buffer.concat(chunks).toString(), "synthetic");assert.equal(await copy.text(), "synthetic");assert.equal(response.bodyUsed, true);scheduler.close();
});

test("unknown bodies keep their full reservation while arriving, then shrink to held bytes", async () => {
  const gate = createRequestAdmission({ maxBytes: 4096 }), request = new PassThrough();request.headers = {};
  const release = await gate(request), parsed = readJsonBody(request, { admission: release });
  request.write('{"value":');await new Promise(resolve => setImmediate(resolve));assert.equal(gate.stats().activeBytes, 4096);
  request.end('"ok"}');assert.deepEqual(await parsed, { value: "ok" });
  assert.equal(gate.stats().activeBytes, Buffer.byteLength('{"value":"ok"}'));
  const other = await gate({ headers: { "content-length": "2" } });other();release();assert.equal(gate.stats().activeBytes, 0);
});

test("internal Chat summaries preserve one source-compatible output cap", () => {
  const both = summaryRequest({ model: "m", max_tokens: 10, max_completion_tokens: 20 }, "chat", "synthetic");
  assert.equal(both.max_completion_tokens, 20);assert.equal(both.max_tokens, undefined);
  const legacy = summaryRequest({ model: "m", max_tokens: 10 }, "chat", "synthetic");assert.equal(legacy.max_tokens, 10);assert.equal(legacy.max_completion_tokens, undefined);
});
