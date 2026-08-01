import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { DEFAULT_CODEX_AUTO_REVIEW_MODEL } from "./models.mjs";

const AUTO_REVIEW_MODEL_KEY = "auto_review_model";

export function userSettingsPath({ env = process.env, home = os.homedir() } = {}) {
  const xdgConfigHome = String(env.XDG_CONFIG_HOME || "").trim();
  const configRoot = xdgConfigHome || path.join(home, ".config");
  return path.join(configRoot, "codex-copilot-dx", "config.json");
}

function invalidSettings(filePath, reason) {
  return new Error(`Invalid ccdx settings at ${filePath}: ${reason}`);
}

export function readUserSettings({ env = process.env, home = os.homedir(), strict = false } = {}) {
  const filePath = userSettingsPath({ env, home });
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidSettings(filePath, "expected a JSON object");
    }
    if (Object.hasOwn(parsed, AUTO_REVIEW_MODEL_KEY)) {
      const value = parsed[AUTO_REVIEW_MODEL_KEY];
      if (typeof value !== "string" || !value.trim()) {
        throw invalidSettings(filePath, `${AUTO_REVIEW_MODEL_KEY} must be a non-empty string`);
      }
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (strict) {
      if (String(error?.message || "").startsWith("Invalid ccdx settings")) throw error;
      throw invalidSettings(filePath, error?.message || String(error));
    }
    return {};
  }
}

export function savedAutoReviewModel(options = {}) {
  const settings = readUserSettings(options);
  return String(settings[AUTO_REVIEW_MODEL_KEY] || "").trim();
}

export function autoReviewModelPreference({ env = process.env, home = os.homedir() } = {}) {
  const environmentModel = String(env.CCDX_AUTO_REVIEW_MODEL || "").trim();
  if (environmentModel) return { model: environmentModel, source: "environment" };

  const savedModel = savedAutoReviewModel({ env, home });
  if (savedModel) return { model: savedModel, source: "settings" };
  return { model: DEFAULT_CODEX_AUTO_REVIEW_MODEL, source: "default" };
}

export function writeAutoReviewModel(model, { env = process.env, home = os.homedir() } = {}) {
  const filePath = userSettingsPath({ env, home });
  const settings = readUserSettings({ env, home, strict: true });
  const value = String(model || "").trim();
  const next = { ...settings };
  if (value) next[AUTO_REVIEW_MODEL_KEY] = value;
  else delete next[AUTO_REVIEW_MODEL_KEY];

  const changed = atomicWriteFileIfChangedSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { changed, filePath, model: value || DEFAULT_CODEX_AUTO_REVIEW_MODEL };
}
