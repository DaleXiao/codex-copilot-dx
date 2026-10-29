import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexToml } from "../src/config-toml.mjs";
import { computeRetiredPredictionConfig, retirePredictionIntegration } from "../src/prediction-retirement.mjs";
import { parseCliArgs, cliHelp } from "../src/cli-options.mjs";

function fixture(settings) {
  const mcp = `[mcp_servers.ccdx_suggestion]\nenabled = true\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fileURLToPath(new URL("../src/suggestion-mcp.mjs", import.meta.url))])}\nenv = { CCDX_SUGGESTION_CONFIG = ${JSON.stringify(settings)} }\ntool_timeout_sec = 40\n`;
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `CCDX_SUGGESTION_CONFIG=${quote(settings)} ${quote(process.execPath)} ${quote(fileURLToPath(new URL("../src/suggestion-auto.mjs", import.meta.url)))}`;
  const hook = `# ccdx:suggestion-auto:start\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\nasync = true\ntimeout = 35\n# ccdx:suggestion-auto:end\n`;
  return { mcp, hook };
}
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-retirement-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, "suggestion.json"), env = { CODEX_HOME: home, CCDX_SUGGESTION_CONFIG: settings };
  return { home, settings, env, codex: path.join(home, "config.toml") };
}

test("removed suggestion commands fail without reviving the retired integration", () => {
  for (const args of [["suggestion", "on"], ["suggestion", "model"], ["suggestion", "off"], ["suggestion", "status"]]) assert.throws(() => parseCliArgs(args), /Unknown command/);
  assert.doesNotMatch(cliHelp(), /suggestion on/);
});

test("cleanup preserves image MCP, native settings, user hooks and trust records", t => {
  const s = setup(t), { mcp, hook } = fixture(s.settings);
  const original = 'model="gpt-6.1-sol"\n[mcp_servers.ccdx_image]\nurl="http://127.0.0.1:2026/mcp/image"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype="command"\ncommand="user-hook"\n';
  const trust = '[hooks.state."own-key"]\ntrusted_hash="keep"\n';
  const result = computeRetiredPredictionConfig(original + mcp + hook + trust, s.settings);
  assert.equal(result.changed, true);assert.equal(result.preserved, false);
  const parsed = parseCodexToml(result.content), expected = parseCodexToml(original + trust);
  assert.deepEqual(parsed, expected);
  assert.equal(computeRetiredPredictionConfig(result.content, s.settings).changed, false);
});

test("edited, profile and inline declarations are not taken over", t => {
  const s = setup(t), { mcp, hook } = fixture(s.settings);
  for (const content of [mcp.replace("tool_timeout_sec = 40", "tool_timeout_sec = 90"), hook.replace("timeout = 35", "timeout = 50"), '[profiles.user.mcp_servers.ccdx_suggestion]\ncommand="user"\n', 'mcp_servers={ccdx_suggestion={command="user"},ccdx_image={command="image"}}\n']) {
    const result = computeRetiredPredictionConfig(content, s.settings);
    assert.equal(result.changed, false);assert.equal(result.content, content);
  }
});

test("default users get no writes; legacy settings are disabled and unrelated keys retained", t => {
  const s = setup(t);
  assert.equal(retirePredictionIntegration(s).changed, false);assert.equal(fs.existsSync(s.codex), false);assert.equal(fs.existsSync(s.settings), false);
  const { mcp, hook } = fixture(s.settings);
  fs.writeFileSync(s.codex, mcp + hook);
  fs.writeFileSync(s.settings, JSON.stringify({ enabled: true, automatic: true, model: "gpt-6-luna", extra: "keep" }));
  const before = fs.readFileSync(s.codex, "utf8");
  assert.equal(retirePredictionIntegration({ ...s, dryRun: true }).changed, true);
  assert.equal(fs.readFileSync(s.codex, "utf8"), before);
  assert.equal(JSON.parse(fs.readFileSync(s.settings)).enabled, true);
  assert.equal(retirePredictionIntegration(s).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.settings)), { enabled: false, automatic: false, model: "gpt-6-luna", extra: "keep" });
  assert.equal(parseCodexToml(fs.readFileSync(s.codex, "utf8")).mcp_servers, undefined);
  assert.equal(retirePredictionIntegration(s).changed, false);
});

test("malformed or unowned configuration remains recoverable and untouched", t => {
  const s = setup(t);
  fs.writeFileSync(s.codex, '[mcp_servers.ccdx_suggestion]\ncommand="user-owned"\n');
  fs.writeFileSync(s.settings, JSON.stringify({ enabled: true, model: "gpt-6-luna" }));
  const before = fs.readFileSync(s.codex, "utf8");
  assert.equal(retirePredictionIntegration(s).preserved, true);assert.equal(fs.readFileSync(s.codex, "utf8"), before);
  fs.writeFileSync(s.settings, "not-json");
  assert.throws(() => retirePredictionIntegration(s), /invalid/);assert.equal(fs.readFileSync(s.codex, "utf8"), before);
});

test("marker text inside a string cannot authorize hook removal", t => {
  const s = setup(t), { hook } = fixture(s.settings);
  const content = "note = '''\n" + hook + "'''\n";
  const result = computeRetiredPredictionConfig(content, s.settings);
  assert.equal(result.changed, false);assert.equal(result.content, content);
});
