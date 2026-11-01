import fs from "node:fs";
import path from "node:path";
import { stringify } from "smol-toml";
import { codexPaths } from "./codex-paths.mjs";
import { parseCodexToml, codexTomlStatements, validateManagedConfigEdit } from "./config-toml.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFilePairSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";
import { assertCodexClosed } from "./native-prediction-profile.mjs";

const KEY = "composer-predictions-enabled";
const ATOMS = "electron-persisted-atom-state";
const object = value => value && typeof value === "object" && !Array.isArray(value);
const read = file => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFileSync(file)); }
  catch (error) { if (error.code === "ENOENT") return "";throw error; }
};
const stateAt = text => {
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error("Codex display settings are invalid; existing settings were preserved"); }
};

export function predictionDisplayPreference(options = {}) {
  const { directory, config } = codexPaths(options);
  const modern = parseCodexToml(read(config)).desktop?.[KEY];
  if (modern !== undefined) {
    if (typeof modern !== "boolean") throw new Error("Codex prediction display setting must be boolean");
    return { enabled: modern, source: "desktop" };
  }
  const legacy = read(path.join(directory, ".codex-global-state.json"));
  const saved = stateAt(legacy);
  if (!object(saved) || (saved[ATOMS] !== undefined && !object(saved[ATOMS]))) throw new Error("Codex display settings are invalid; existing settings were preserved");
  const value = modern ?? saved[ATOMS]?.[KEY];
  if (value !== undefined && typeof value !== "boolean") throw new Error("Codex prediction display setting must be boolean");
  return { enabled: value !== false, source: modern !== undefined ? "desktop" : value !== undefined ? "legacy" : "default" };
}

// Codex moved this setting from persisted atoms to desktop TOML. Update both
// representations while closed; the App owns migration and its live state.
export function writePredictionDisplayPreference(enabled, options = {}) {
  if (typeof enabled !== "boolean") throw new Error("Prediction display requires a boolean");
  const { directory, config } = codexPaths(options);
  const legacyFile = path.join(directory, ".codex-global-state.json");
  return withFileLockSync(`${config}.ccdx.lock`, () => {
    assertCodexClosed(options);
    const content = read(config), legacy = read(legacyFile), before = parseCodexToml(content);
    const saved = stateAt(legacy);
    if (!object(saved) || (saved[ATOMS] !== undefined && !object(saved[ATOMS]))) throw new Error("Codex display settings are invalid; existing settings were preserved");
    if (before.desktop !== undefined && !object(before.desktop)) throw new Error("Codex desktop settings are invalid; existing settings were preserved");
    const statements = codexTomlStatements(content);
    const exact = statements.find(item => item.kind === "value" && item.keys.length === 2 && item.keys[0] === "desktop" && item.keys[1] === KEY);
    let next = content;
    if (exact) next = content.slice(0, exact.valueStart) + enabled + content.slice(exact.valueEnd);
    else {
      const inline = statements.find(item => item.kind === "value" && item.keys.length === 1 && item.keys[0] === "desktop");
      const table = statements.find(item => item.kind === "table" && item.keys.length === 1 && item.keys[0] === "desktop");
      if (inline) next = content.slice(0, inline.start) + content.slice(inline.end) + "\n" + stringify({ desktop: { ...before.desktop, [KEY]: enabled } });
      else if (table) next = content.slice(0, table.end) + `\n${KEY} = ${enabled}` + content.slice(table.end);
      else {
        const first = statements.find(item => item.kind === "table")?.start ?? content.length;
        next = content.slice(0, first) + `\ndesktop.${KEY} = ${enabled}\n` + content.slice(first);
      }
    }
    validateManagedConfigEdit(before, next, [["desktop", KEY]]);
    if (parseCodexToml(next).desktop?.[KEY] !== enabled) throw new Error("Prediction display could not be updated; existing settings were preserved");
    saved[ATOMS] = { ...saved[ATOMS], [KEY]: enabled };
    assertCodexClosed(options);
    if (read(config) !== content || read(legacyFile) !== legacy) throw new Error("Codex settings changed; retry after quitting the App");
    const data = JSON.stringify(saved) + "\n";
    if (next === content && data === legacy) return { enabled, changed: false };
    fs.mkdirSync(directory, { recursive: true });
    atomicWriteFilePairSync(config, next, legacyFile, data);
    return { enabled, changed: true };
  });
}
