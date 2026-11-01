import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClientGatewayKeys } from "../src/client-gateway-keys.mjs";
import { inspectAdapterCompatibility } from "../src/doctor-compat.mjs";

for (const host of ["127.0.0.1", "external.example.test"]) test("compatibility supports a vendor model and confines local credentials: " + host, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-compat-access-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const keys = readClientGatewayKeys({ home, env: {} }), calls = [];
  const result = await inspectAdapterCompatibility({ home, env: {}, host, timeoutMs: 100,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, host === "127.0.0.1" ? `Bearer ${keys.codex}` : undefined);
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "vendor/custom-model", supported_endpoints: ["/responses"] }] });
      const response = { id: "synthetic-" + calls.length, object: "response", status: "completed", output: [] };
      if (url.endsWith("/compact")) return Response.json({ ...response, object: "response.compaction", output: [{ type: "compaction" }] });
      if (JSON.parse(init.body).stream) return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
      return Response.json(response);
    } });
  assert.equal(result.length, 5);assert.ok(result.every(check => check.kind === "ok"));
  assert.ok(result.some(check => check.message.includes("vendor/custom-model")));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(keys.codex));
});
