import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { computeImageMcpCodexConfig, computeUpdatedCodexConfig, initialCodexConfig } from "../src/config.mjs";

test("image MCP Codex config: is explicit, idempotent, and exactly reversible", () => {
  const before = "model = \"gpt-5.6-sol\"\n";
  const enabled = computeImageMcpCodexConfig(before, { enabled: true, adapterPort: 2026 });
  assert.equal(enabled.changed, true);
  assert.match(enabled.content, /^\[mcp_servers\.ccdx_image\]$/m);
  assert.deepEqual(parse(enabled.content).mcp_servers.ccdx_image, {
    url: "http://127.0.0.1:2026/mcp/image",
    enabled: true,
    tool_timeout_sec: 210,
  });
  assert.deepEqual(
    computeImageMcpCodexConfig(enabled.content, { enabled: true, adapterPort: 2026 }),
    { content: enabled.content, changed: false },
  );
  assert.deepEqual(
    computeImageMcpCodexConfig(enabled.content, { enabled: false, adapterPort: 2026 }),
    { content: before, changed: true },
  );
});

test("image MCP Codex config: refuses to overwrite a user-owned server name", () => {
  const existing = "[mcp_servers.ccdx_image]\nurl = \"https://example.com/mcp\"\n";
  assert.throws(
    () => computeImageMcpCodexConfig(existing, { enabled: true }),
    /outside the CCDX-managed block/,
  );
});

test("normal startup leaves image disabled unless explicitly enabled", () => {
  for (const options of [undefined, { imageProviderEnabled: false }]) {
    const initial = initialCodexConfig(2026, "127.0.0.1", options);
    assert.equal(parse(initial).mcp_servers?.ccdx_image, undefined);
  }
  const before = "openai_base_url = \"http://127.0.0.1:2026/v1\"\n";
  const updated = computeUpdatedCodexConfig(before);
  assert.doesNotMatch(updated.content, /mcp_servers\.ccdx_image|ccdx:image-mcp/);
  const enabled = computeUpdatedCodexConfig(before, 2026, "127.0.0.1", { imageProviderEnabled: true });
  assert.match(enabled.content, /mcp_servers\.ccdx_image/);
});

test("generic config previews preserve an existing managed image block when activation is unknown", () => {
  const base = "openai_base_url = \"http://127.0.0.1:2026/v1\"\n";
  const enabled = computeImageMcpCodexConfig(base, { enabled: true }).content;
  const preview = computeUpdatedCodexConfig(enabled);
  assert.match(preview.content, /mcp_servers\.ccdx_image/);
  const startupDisabled = computeUpdatedCodexConfig(enabled, 2026, "127.0.0.1", { imageProviderEnabled: false });
  assert.doesNotMatch(startupDisabled.content, /mcp_servers\.ccdx_image/);
});
