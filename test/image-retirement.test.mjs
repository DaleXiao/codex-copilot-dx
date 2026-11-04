import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { retireLegacyImages, legacyImageProviderPath } from "../src/image-retirement.mjs";
import { clientStateFingerprint } from "../src/service-worker.mjs";
import { computeImageMcpCodexConfig } from "../src/config.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-retirement-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexPath = path.join(home, ".codex", "config.toml"), provider = legacyImageProviderPath({ home, env: {} });
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });fs.mkdirSync(path.dirname(provider), { recursive: true });
  fs.writeFileSync(provider, "malformed legacy credential must not be read");
  return { home, env: {}, codexPath, provider };
}
const oldServer = '[mcp_servers.ccdx_image]\nurl = "http://127.0.0.1:2026/mcp/image"\nenabled = true\ntool_timeout_sec = 210\n';
function owned(file, kind, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hash = createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(file, (kind === "helper" ? `// ccdx:image-helper:${hash}\n` : `<!-- ccdx:image-${kind}:${hash} -->\n`) + body);
}

test("upgrade retires owned MCP, credential, skill, references and helper while preserving historical image files", t => {
  const f = fixture(t), skill = path.join(path.dirname(f.codexPath), "skills", "ccdx-image");
  const other = '[mcp_servers.other]\ncommand = "keep"\n';
  fs.writeFileSync(f.codexPath, 'openai_base_url = "http://127.0.0.1:2026/v1"\n' + oldServer + other);
  for (const [file, kind] of [["SKILL.md", "skill"], ["scripts/generate.mjs", "helper"], ["references/editing.md", "reference"], ["references/helper.md", "reference"]]) owned(path.join(skill, file), kind, "original CCDX guidance\n");
  const saved = path.join(f.home, ".local", "share", "codex-copilot-dx", "images", "image.png");fs.mkdirSync(path.dirname(saved), { recursive: true });fs.writeFileSync(saved, "historical pixels");
  const result = retireLegacyImages(f);
  assert.equal(result.preserved, false);assert.equal(result.credentialRemoved, true);
  assert.equal(fs.existsSync(f.provider), false);assert.equal(fs.existsSync(skill), false);
  const config = parse(fs.readFileSync(f.codexPath, "utf8"));assert.equal(config.mcp_servers.ccdx_image, undefined);assert.equal(config.mcp_servers.other.command, "keep");
  assert.equal(fs.readFileSync(saved, "utf8"), "historical pixels");
  assert.equal(retireLegacyImages(f).changed, false);
});

test("retirement preserves customized files, shared inline TOML and unrelated settings, but still deletes the old credential", t => {
  for (const declaration of ['[mcp_servers.ccdx_image]\nurl = "https://user.example/mcp"\n', 'mcp_servers = { ccdx_image = { url = "http://127.0.0.1:2026/mcp/image", enabled = true, tool_timeout_sec = 210 }, other = { command = "keep" } }\n']) {
    const f = fixture(t), before = declaration + '[features]\ncontext_management = true\n';fs.writeFileSync(f.codexPath, before);
    const skill = path.join(path.dirname(f.codexPath), "skills", "ccdx-image", "SKILL.md");fs.mkdirSync(path.dirname(skill), { recursive: true });fs.writeFileSync(skill, "user-modified instructions");
    const result = retireLegacyImages(f);assert.equal(result.preserved, true);assert.equal(fs.existsSync(f.provider), false);
    assert.equal(fs.readFileSync(f.codexPath, "utf8"), before);assert.equal(fs.readFileSync(skill, "utf8"), "user-modified instructions");
  }
});

test("legacy marker variants and isolated TOML declarations remain safely removable", t => {
  const declarations = [oldServer, '["mcp_servers"."ccdx_image"]\nurl = "http://127.0.0.1:2026/mcp/image"\nenabled = true\ntool_timeout_sec = 210\n',
    'mcp_servers.ccdx_image = { url = "http://127.0.0.1:2026/mcp/image", enabled = true, tool_timeout_sec = 210 }\n'];
  for (const declaration of declarations) for (const marker of ["", "# ccdx:image-mcp:start\n", "# ccdx:image-mcp:end\n"]) {
    const before = 'openai_base_url = "http://127.0.0.1:2026/v1"\n' + marker + declaration + '[features]\ncontext_management = true\n';
    const result = computeImageMcpCodexConfig(before, { enabled: false });assert.equal(parse(result.content).mcp_servers?.ccdx_image, undefined);
    assert.equal(parse(result.content).features.context_management, true);
  }
  assert.throws(() => computeImageMcpCodexConfig("", { enabled: true }), /retired/);
});

test("warm-worker fingerprint keeps legacy image state observable until retirement activation", t => {
  const f = fixture(t);
  const before = clientStateFingerprint(f);
  assert.equal(clientStateFingerprint(f), before);
  assert.equal(fs.existsSync(f.provider), true, "Inspection must not retire an old worker's state");
  fs.writeFileSync(f.provider, "changed legacy image credential");
  assert.notEqual(clientStateFingerprint(f), before);
  retireLegacyImages(f);
  const retired = clientStateFingerprint(f);
  assert.equal(clientStateFingerprint(f), retired);
});
