import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { computeImageMcpCodexConfig, computeUpdatedCodexConfig, ensureCodexConfig, ImageMcpConfigError } from "../src/config.mjs";

const URL_VALUE = "http://127.0.0.1:2026/mcp/image";
const START = "# ccdx:image-mcp:start";
const END = "# ccdx:image-mcp:end";
const TOP = 'openai_base_url = "http://127.0.0.1:2026/v1"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n';
const FEATURES = "\n[features]\ncontext_management = true\n";
const BLOCK = `[mcp_servers.ccdx_image]\nurl = "${URL_VALUE}"\nenabled = true\ntool_timeout_sec = 210\n`;

function configFile(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-config-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "config.toml");
  fs.writeFileSync(filePath, content);
  return filePath;
}

for (const [name, prefix, suffix] of [
  ["absent", "", ""], ["start-only", `${START}\n`, ""], ["end-only", "", `${END}\n`],
  ["reversed", `${END}\n`, `${START}\n`], ["duplicate", `${START}\n${START}\n`, `${END}\n${END}\n`],
  ["indented", `  ${START}\n`, `\t${END}\n`],
]) {
  test(`equivalent image config survives ${name} markers and disable removes only that server`, () => {
    const unrelated = '[mcp_servers.other]\ncommand = "keep" # user comment\n';
    const before = `${TOP}${prefix}${BLOCK}${unrelated}${suffix}${FEATURES}`;
    assert.deepEqual(computeUpdatedCodexConfig(before, 2026, "127.0.0.1", { imageProviderEnabled: true }), { content: before, changed: false });
    const disabled = computeImageMcpCodexConfig(before, { enabled: false });
    assert.equal(parse(disabled.content).mcp_servers.ccdx_image, undefined);
    assert.deepEqual(parse(disabled.content).mcp_servers.other, { command: "keep" });
    assert.ok(disabled.content.includes(unrelated));
    assert.doesNotMatch(disabled.content, /ccdx:image-mcp/);
    assert.deepEqual(computeImageMcpCodexConfig(disabled.content, { enabled: false }), { content: disabled.content, changed: false });
  });
}

test("quoted, dotted, inline-leaf, reordered and multiline declarations remain idempotent and removable", () => {
  for (const declaration of [
    `[ "mcp_servers" . 'ccdx_image' ] # preserved\n'url' = '${URL_VALUE}'\n"tool_timeout_sec" = 0xD2\nenabled = true\n`,
    `mcp_servers.ccdx_image.url = '${URL_VALUE}'\nmcp_servers.ccdx_image.enabled = true\nmcp_servers.ccdx_image.tool_timeout_sec = 210\n`,
    `mcp_servers.ccdx_image = { url = '${URL_VALUE}', enabled = true, tool_timeout_sec = 210 }\n`,
    `[mcp_servers]\nccdx_image.url = '${URL_VALUE}'\nccdx_image.tool_timeout_sec = 210\nccdx_image.enabled = true\n`,
    `[mcp_servers.ccdx_image]\nenabled = true\nurl = '''\n${URL_VALUE}'''\ntool_timeout_sec = 210\n`,
  ]) {
    const before = `${TOP}${declaration}${FEATURES}`;
    assert.deepEqual(computeUpdatedCodexConfig(before, 2026, "127.0.0.1", { imageProviderEnabled: true }), { content: before, changed: false });
    const disabled = computeImageMcpCodexConfig(before, { enabled: false });
    assert.equal(parse(disabled.content).mcp_servers?.ccdx_image, undefined);
    assert.deepEqual(parse(disabled.content).features, { context_management: true });
  }
});

test("CRLF configuration and marker-like strings are not normalized on equivalent startup", (t) => {
  const before = `${TOP}notes = '''\n${START}\n${END}\n'''\n${START}\n${BLOCK}${END}\n${FEATURES}`.replaceAll("\n", "\r\n");
  const filePath = configFile(t, before);
  const stat = fs.statSync(filePath);
  assert.deepEqual(ensureCodexConfig(2026, { filePath, imageProviderEnabled: true }), { imageMcpSkipped: false });
  assert.equal(fs.readFileSync(filePath, "utf8"), before);
  assert.equal(fs.statSync(filePath).mtimeMs, stat.mtimeMs);
  const disabled = computeImageMcpCodexConfig(before, { enabled: false });
  assert.equal(parse(disabled.content).notes, parse(before).notes);
  assert.equal(parse(disabled.content).mcp_servers?.ccdx_image, undefined);
});

test("markerless defaults migrate with their previous core address, including IPv6", () => {
  for (const [oldOrigin, host] of [["http://127.0.0.1:2026", "127.0.0.1"], ["http://[::1]:2026", "::1"]]) {
    const before = `${TOP.replace("http://127.0.0.1:2026", oldOrigin)}${BLOCK.replace(URL_VALUE, `${oldOrigin}/mcp/image`)}${FEATURES}`;
    const updated = computeUpdatedCodexConfig(before, 3030, host, { imageProviderEnabled: true });
    const config = parse(updated.content);
    assert.equal(config.openai_base_url, `${oldOrigin.replace(":2026", ":3030")}/v1`);
    assert.equal(config.mcp_servers.ccdx_image.url, `${oldOrigin.replace(":2026", ":3030")}/mcp/image`);
    assert.deepEqual(computeUpdatedCodexConfig(updated.content, 3030, host, { imageProviderEnabled: true }), { content: updated.content, changed: false });
  }
});

test("legacy marked defaults support address changes and disable before first core setup", () => {
  const original = computeImageMcpCodexConfig('model = "gpt-5.5"\n', { enabled: true, adapterPort: 3030 }).content;
  const changed = computeImageMcpCodexConfig(original, { enabled: true, adapterPort: 4040 });
  assert.equal(parse(changed.content).mcp_servers.ccdx_image.url, "http://127.0.0.1:4040/mcp/image");
  assert.equal(computeImageMcpCodexConfig(changed.content, { enabled: false }).content, 'model = "gpt-5.5"\n');
});

test("default HTTP ports are compared semantically without rewriting a compatible registration", () => {
  const before = BLOCK.replace(":2026", ":80");
  assert.deepEqual(computeImageMcpCodexConfig(before, { enabled: true, adapterPort: 80 }), { content: before, changed: false });
  assert.equal(parse(computeImageMcpCodexConfig(before, { enabled: false, adapterPort: 80 }).content).mcp_servers?.ccdx_image, undefined);
});

test("compatible user timeouts and tool policies are reused, not adopted or deleted", () => {
  for (const custom of [BLOCK.replace("210", "5"), `${BLOCK}[mcp_servers.ccdx_image.tools.generate_image]\napproval_mode = "prompt"\n`]) {
    const before = `${TOP}${START}\n${custom}${END}\n${FEATURES}`;
    assert.deepEqual(computeUpdatedCodexConfig(before, 2026, "127.0.0.1", { imageProviderEnabled: true }), { content: before, changed: false });
    assert.deepEqual(computeImageMcpCodexConfig(before, { enabled: false }), { content: before, changed: false });
  }
});

test("no-op image operations preserve an absent final newline and an empty file", () => {
  for (const before of ["", TOP.trimEnd(), '[mcp_servers.ccdx_image]\nurl = "https://user.example/mcp"']) {
    assert.deepEqual(computeImageMcpCodexConfig(before, { enabled: false }), { content: before, changed: false });
  }
  const compatible = `${TOP}${BLOCK}${FEATURES}`.trimEnd();
  assert.deepEqual(computeImageMcpCodexConfig(compatible, { enabled: true }), { content: compatible, changed: false });
});

test("true image conflicts warn once while core setup succeeds, preserving image declarations", (t) => {
  const messages = [];
  t.mock.method(console, "warn", (text) => messages.push(text));
  for (const image of [
    `${START}\n${BLOCK.replace(URL_VALUE, "https://user.example/mcp?key=private-fixture")}`,
    `${BLOCK.replace("enabled = true", "enabled = false")}${END}\n`,
    'mcp_servers = { other = { command = "keep" } }\n',
    'mcp_servers = "private-fixture"\n',
  ]) {
    const before = `${image}${FEATURES}`;
    const filePath = configFile(t, before);
    const result = ensureCodexConfig(2026, { filePath, imageProviderEnabled: true });
    assert.deepEqual(result, { imageMcpSkipped: true });
    const after = fs.readFileSync(filePath, "utf8");
    for (const line of image.trimEnd().split("\n")) assert.ok(after.includes(line));
    assert.equal(parse(after).openai_base_url, "http://127.0.0.1:2026/v1");
    assert.deepEqual(parse(after).mcp_servers, parse(before).mcp_servers);
    const stat = fs.statSync(filePath);
    ensureCodexConfig(2026, { filePath, imageProviderEnabled: true });
    assert.equal(fs.statSync(filePath).mtimeMs, stat.mtimeMs);
  }
  assert.equal(messages.length, 8);
  assert.doesNotMatch(messages.join("\n"), /private-fixture/);
});

test("a remote user server is not adopted merely because it matches the previous model origin", () => {
  const before = `${TOP.replace("http://127.0.0.1:2026", "http://user.example")}${BLOCK.replace(URL_VALUE, "http://user.example/mcp/image")}${FEATURES}`;
  assert.throws(() => computeUpdatedCodexConfig(before, 2026, "127.0.0.1", { imageProviderEnabled: true }), ImageMcpConfigError);
  assert.deepEqual(computeImageMcpCodexConfig(before, { enabled: false }), { content: before, changed: false });
});

test("shared inline parents are reused or preserved rather than erasing their siblings", (t) => {
  const inline = `mcp_servers = { ccdx_image = { url = '${URL_VALUE}', enabled = true, tool_timeout_sec = 210 }, other = { command = 'keep' } }\n`;
  const before = `${TOP}${inline}${FEATURES}`;
  assert.deepEqual(computeImageMcpCodexConfig(before, { enabled: true }), { content: before, changed: false });
  assert.deepEqual(computeImageMcpCodexConfig(before, { enabled: false }), { content: before, changed: false });
  const filePath = configFile(t, before);
  t.mock.method(console, "warn", () => {});
  assert.equal(ensureCodexConfig(3030, { filePath, imageProviderEnabled: true }).imageMcpSkipped, true);
  assert.ok(fs.readFileSync(filePath, "utf8").includes(inline));
});

test("configuration I/O and TOML errors remain fatal and preserve original bytes", (t) => {
  const invalid = 'secret = "private-fixture\n';
  const filePath = configFile(t, invalid);
  assert.throws(() => ensureCodexConfig(2026, { filePath, imageProviderEnabled: true }), (error) => {
    assert.ok(!(error instanceof ImageMcpConfigError));
    assert.doesNotMatch(error.message, /private-fixture/);
    return true;
  });
  assert.equal(fs.readFileSync(filePath, "utf8"), invalid);
  const before = `${TOP}${BLOCK}${FEATURES}`;
  fs.writeFileSync(filePath, before);
  const rename = fs.renameSync;
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === filePath) throw Object.assign(new Error("fixture write denied"), { code: "EACCES" });
    return rename(from, to);
  });
  assert.throws(() => ensureCodexConfig(3030, { filePath, imageProviderEnabled: true }), /fixture write denied/);
  assert.equal(fs.readFileSync(filePath, "utf8"), before);
  const conflict = '[mcp_servers.ccdx_image]\nurl = "https://user.example/mcp"\n';
  fs.writeFileSync(filePath, conflict);
  assert.throws(() => ensureCodexConfig(3030, { filePath, imageProviderEnabled: true }), /fixture write denied/);
  assert.equal(fs.readFileSync(filePath, "utf8"), conflict);
  assert.equal(warnings.length, 0, "Do not promise continued startup before a core write succeeds");
});

test("disabled startup never edits image entries, even damaged or previously managed ones", (t) => {
  for (const image of [BLOCK, `${START}\n${BLOCK}`, `mcp_servers = { ccdx_image = { url = '${URL_VALUE}', enabled = true, tool_timeout_sec = 210 } }\n`]) {
    const before = `${TOP}${image}${FEATURES}`;
    const filePath = configFile(t, before);
    const stat = fs.statSync(filePath);
    const warn = t.mock.method(console, "warn", () => { throw new Error("Disabled images must not warn"); });
    assert.deepEqual(ensureCodexConfig(2026, { filePath, imageProviderEnabled: false }), { imageMcpSkipped: false });
    assert.equal(fs.readFileSync(filePath, "utf8"), before);
    assert.equal(fs.statSync(filePath).mtimeMs, stat.mtimeMs);
    warn.mock.restore();
  }
});

test("image-only write failure does not undo or fail essential core setup", (t) => {
  const rename = fs.renameSync;
  const warnings = [];
  t.mock.method(console, "warn", message => warnings.push(message));
  for (const mode of ["core-current", "new-file", "address-change"]) {
    const original = mode === "address-change" ? `${TOP}${BLOCK}${FEATURES}` : `${TOP}${FEATURES}`;
    const filePath = configFile(t, original);
    if (mode === "new-file") fs.unlinkSync(filePath);
    const port = mode === "address-change" ? 3030 : 2026;
    let writes = 0;
    const stub = t.mock.method(fs, "renameSync", (from, to) => {
      if (to === filePath && ++writes === (mode === "core-current" ? 1 : 2)) {
        throw Object.assign(new Error("fixture optional write denied"), { code: "EACCES" });
      }
      return rename(from, to);
    });
    assert.deepEqual(ensureCodexConfig(port, { filePath, imageProviderEnabled: true }), { imageMcpSkipped: true });
    stub.mock.restore();
    const after = parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(after.openai_base_url, `http://127.0.0.1:${port}/v1`);
    assert.equal(after.mcp_servers?.ccdx_image?.url, mode === "address-change" ? URL_VALUE : undefined);
  }
  assert.equal(warnings.length, 3);
  for (const warning of warnings) assert.match(warning, /Core proxy startup will continue/);
});

test("image maintenance preserves a config changed by another writer after core setup", (t) => {
  const filePath = configFile(t, `${TOP.replace(":2026", ":9")}${FEATURES}`);
  const rename = fs.renameSync;
  let writes = 0;
  t.mock.method(console, "warn", () => {});
  t.mock.method(fs, "renameSync", (from, to) => {
    rename(from, to);
    if (to === filePath && ++writes === 1) fs.appendFileSync(filePath, "\n# external config edit\n");
  });
  assert.deepEqual(ensureCodexConfig(2026, { filePath, imageProviderEnabled: true }), { imageMcpSkipped: true });
  assert.equal(writes, 1);
  const after = fs.readFileSync(filePath, "utf8");
  assert.ok(after.endsWith("# external config edit\n"));
  assert.equal(parse(after).mcp_servers?.ccdx_image, undefined);
  assert.equal(parse(after).openai_base_url, "http://127.0.0.1:2026/v1");
});
