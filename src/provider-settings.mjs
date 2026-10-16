import fs from "node:fs";
import path from "node:path";
import { userSettingsPath } from "./user-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";

export function providerSettingsPath(options = {}) {
  return path.join(path.dirname(userSettingsPath(options)), "providers.json");
}
const invalid = () => Object.assign(new Error("Provider selection is invalid; review providers.json before starting ccdx. The existing file was preserved"), { code: "ccdx_provider_selection_invalid" });
function checked(value) {
  if (!value || value.version !== 1 || !["github", "m365"].includes(value.codex)) throw invalid();
  if (value.m365 !== undefined && (!value.m365 || typeof value.m365 !== "object"
    || ["model", "auto_review_model"].some(key => typeof value.m365[key] !== "string" || !/^gpt-[\w.-]{1,120}$/.test(value.m365[key])))) throw invalid();
  if (value.codex === "m365" && !value.m365) throw invalid();
  if (value.m365?.auto_review_effort !== undefined && value.m365.auto_review_effort !== null
    && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.m365.auto_review_effort)) throw invalid();
  return value;
}
export function readProviderSettings(options = {}) {
  try { return checked(JSON.parse(readBoundedFileSync(providerSettingsPath(options), { encoding: "utf8", maxBytes: 8192 }))); }
  catch (error) { if (error.code === "ENOENT") return { version: 1, codex: "github" };throw invalid(); }
}
export function writeProviderSettings(provider, preference, options = {}) {
  const file = providerSettingsPath(options);fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, () => {
    const current = readProviderSettings(options);
    const next = checked({ ...current, codex: provider, ...(provider === "m365" ? { m365: preference } : {}) });
    atomicWriteFileIfChangedSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });return next;
  });
}
