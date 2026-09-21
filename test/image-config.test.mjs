import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { computeImageMcpCodexConfig, computeUpdatedCodexConfig, ImageMcpConfigError, initialCodexConfig } from "../src/config.mjs";

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

test("startup reuses a marker-stripped CCDX image block without rewriting its registration", () => {
  // A config rewrite may drop comments while retaining the same effective values.
  const orphaned = `openai_base_url = "http://127.0.0.1:2026/v1"

[mcp_servers.computer-use]
command = "keep"

[mcp_servers.ccdx_image]
url = "http://127.0.0.1:2026/mcp/image"
enabled = true
tool_timeout_sec = 210

[mcp_servers.pencil]
command = "keep"
`;
  const first = computeUpdatedCodexConfig(orphaned, 2026, "127.0.0.1", { imageProviderEnabled: true });
  assert.equal(first.changed, true);
  const config = parse(first.content);
  assert.deepEqual(config.mcp_servers.ccdx_image, {
    url: "http://127.0.0.1:2026/mcp/image",
    enabled: true,
    tool_timeout_sec: 210,
  });
  assert.deepEqual(config.mcp_servers["computer-use"], { command: "keep" });
  assert.deepEqual(config.mcp_servers.pencil, { command: "keep" });
  assert.equal(first.content.split("[mcp_servers.ccdx_image]").length - 1, 1);
  assert.doesNotMatch(first.content, /ccdx:image-mcp/);
  assert.ok(first.content.includes(orphaned.slice(orphaned.indexOf("[mcp_servers.computer-use]"))));
  assert.deepEqual(
    computeUpdatedCodexConfig(first.content, 2026, "127.0.0.1", { imageProviderEnabled: true }),
    { content: first.content, changed: false },
  );
});

test("startup still rejects a user-owned image block that differs from CCDX's own", () => {
  for (const body of [
    "url = \"https://user.example/mcp\"\nenabled = true\ntool_timeout_sec = 210\n",
    "url = \"http://127.0.0.1:2026/mcp/image\"\nenabled = false\ntool_timeout_sec = 210\n",
  ]) {
    const before = `[mcp_servers.ccdx_image]\n${body}`;
    assert.throws(
      () => computeUpdatedCodexConfig(before, 2026, "127.0.0.1", { imageProviderEnabled: true }),
      (error) => error instanceof ImageMcpConfigError && /outside the CCDX-managed block/.test(error.message),
    );
    assert.throws(
      () => computeImageMcpCodexConfig(before, { enabled: true }),
      /outside the CCDX-managed block/,
    );
  }
});
