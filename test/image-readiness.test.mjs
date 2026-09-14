import assert from "node:assert/strict";
import { test } from "node:test";
import { probeImageTool } from "../src/image-readiness.mjs";

const config = '[mcp_servers.ccdx_image]\nurl = "http://127.0.0.1:3030/mcp/image"\nenabled = true\n';

test("image readiness verifies initialize and tool discovery without generation or provider credentials", async () => {
  const methods = [];
  const result = await probeImageTool(config, { fetchImpl: async (url, init) => {
    assert.equal(url, "http://127.0.0.1:3030/mcp/image");
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, "error");
    const message = JSON.parse(init.body);
    methods.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
      ? { serverInfo: { name: "ccdx-image" }, protocolVersion: "2025-06-18" }
      : { tools: [{ name: "generate_image" }] } });
  } });
  assert.deepEqual(result, { ready: true });
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
});

test("image readiness never probes a disabled, malformed or non-local registration", async () => {
  const fetchImpl = () => { throw new Error("must not fetch"); };
  for (const content of ["", config.replace("true", "false"), config.replace("127.0.0.1", "images.example")]) {
    assert.equal((await probeImageTool(content, { fetchImpl })).ready, false);
  }
});

test("image readiness distinguishes unavailable service from a missing tool and bounds timeout", async () => {
  assert.deepEqual(await probeImageTool(config, { fetchImpl: async () => new Response(null, { status: 404 }) }), {
    ready: false, reason: "HTTP 404",
  });
  const noTool = await probeImageTool(config, { fetchImpl: async (_url, { body }) => {
    const message = JSON.parse(body);
    return message.id === undefined ? new Response(null, { status: 202 }) : Response.json({
      jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { serverInfo: { name: "ccdx-image" } } : { tools: [] },
    });
  } });
  assert.deepEqual(noTool, { ready: false, reason: "tool_unavailable" });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.deepEqual(await probeImageTool(config, {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    }), { ready: false, reason: "timeout" });
  } finally { clearTimeout(keepAlive); }
});
