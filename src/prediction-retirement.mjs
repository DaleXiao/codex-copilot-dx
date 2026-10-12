import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteFileIfChangedSync, atomicWriteFilePairSync } from "./atomic-file.mjs";
import { codexTomlStatements, parseCodexToml, validateManagedConfigEdit } from "./config-toml.mjs";
import { userSettingsPath } from "./user-settings.mjs";
import { codexPaths } from "./codex-paths.mjs";
import { withFileLockSync } from "./lock.mjs";

const SERVER_PATH = ["mcp_servers", "ccdx_suggestion"];
const same = (left, right) => isDeepStrictEqual(left, right);

export function computeRetiredPredictionConfig(content, filePath) {
  const before = parseCodexToml(content);
  const expected = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./suggestion-mcp.mjs", import.meta.url))],
    env: { CCDX_SUGGESTION_CONFIG: filePath },
    tool_timeout_sec: 40n,
  };
  const existing = before.mcp_servers?.ccdx_suggestion;
  const owned = existing && typeof existing.enabled === "boolean"
    && same({ ...existing, enabled: undefined }, { ...expected, enabled: undefined });
  const statements = codexTomlStatements(content);
  const declarations = statements.filter(item => ["table", "value"].includes(item.kind)
    && same(item.keys.slice(0, 2), SERVER_PATH));
  const ranges = owned ? declarations.map(item => {
    const start = content.lastIndexOf("\n", item.start - 1) + 1;
    const end = content.indexOf("\n", item.end);
    return [start, end < 0 ? content.length : end + 1];
  }) : [];
  // Only remove the exact block emitted by 0.9.23. Modified handlers and
  // Codex's own trust records remain untouched.
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `CCDX_SUGGESTION_CONFIG=${quote(filePath)} ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./suggestion-auto.mjs", import.meta.url)))}`;
  const block = `# ccdx:suggestion-auto:start\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\nasync = true\ntimeout = 35\n# ccdx:suggestion-auto:end\n`;
  const hookStart = content.indexOf(block);
  const hookOwned = hookStart >= 0 && content.indexOf(block, hookStart + block.length) < 0
    && statements.some(item => item.kind === "comment" && item.start === hookStart && item.source === "# ccdx:suggestion-auto:start");
  if (hookOwned) ranges.push([hookStart, hookStart + block.length]);
  let updated = content;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) updated = updated.slice(0, start) + updated.slice(end);
  validateManagedConfigEdit(before, updated, [SERVER_PATH, ["hooks", "Stop"]]);
  const after = parseCodexToml(updated);
  const remaining = [...(before.hooks?.Stop || [])];
  if (hookOwned) {
    const index = remaining.findIndex(group => same(group, { hooks: [{ type: "command", command, async: true, timeout: 35n }] }));
    if (index < 0) throw new Error("Retired prediction hook could not be safely removed");
    remaining.splice(index, 1);
  }
  if (!same(after.hooks?.Stop || [], remaining)) throw new Error("Unrelated hooks changed; prediction cleanup was skipped");
  return { content: updated, changed: updated !== content, preserved: Boolean(existing && !owned) || (content.includes("# ccdx:suggestion-auto:start") && !hookOwned) };
}

export function retirePredictionIntegration(options = {}) {
  if (options.dryRun) return retirePredictionIntegrationUnlocked(options);
  const { config } = codexPaths(options);
  // No registration/settings means no lock directory or other write on startup.
  const env = options.env || process.env;
  const settings = path.resolve(env.CCDX_SUGGESTION_CONFIG || path.join(path.dirname(userSettingsPath(options)), "suggestion.json"));
  if (!fs.existsSync(config) && !fs.existsSync(settings)) return { changed: false, preserved: false };
  return withFileLockSync(`${config}.ccdx.lock`, () => retirePredictionIntegrationUnlocked(options));
}
function retirePredictionIntegrationUnlocked({ env = process.env, home = os.homedir(), dryRun = false } = {}) {
  const settings = path.resolve(env.CCDX_SUGGESTION_CONFIG || path.join(path.dirname(userSettingsPath({ env, home })), "suggestion.json"));
  const codex = codexPaths({ env, home }).config;
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(codex)); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot safely read prediction configuration"); }
  let serialized;
  try {
    const preference = JSON.parse(fs.readFileSync(settings, "utf8"));
    if (!preference || typeof preference !== "object" || Array.isArray(preference)
      || typeof preference.enabled !== "boolean" || typeof preference.model !== "string") throw new Error();
    if (preference.enabled || preference.automatic) serialized = JSON.stringify({ ...preference, enabled: false, automatic: false }, null, 2) + "\n";
  } catch (error) { if (error.code !== "ENOENT") throw new Error("Prediction settings are invalid; cleanup was skipped"); }
  const result = content?.includes("ccdx_suggestion") || content?.includes("ccdx:suggestion-auto:start")
    ? computeRetiredPredictionConfig(content, settings) : { content, changed: false, preserved: false };
  if (dryRun) return { changed: result.changed || Boolean(serialized), preserved: result.preserved };
  if (result.changed && serialized) atomicWriteFilePairSync(codex, result.content, settings, serialized);
  else if (result.changed) atomicWriteFileIfChangedSync(codex, result.content);
  else if (serialized) atomicWriteFileIfChangedSync(settings, serialized);
  return { changed: result.changed || Boolean(serialized), preserved: result.preserved };
}
