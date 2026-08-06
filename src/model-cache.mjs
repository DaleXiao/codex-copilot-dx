import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MODEL_CACHE_PROFILES = new Set(["codex", "claude"]);

export function modelCachePath(home = os.homedir(), profile = "codex") {
  if (!MODEL_CACHE_PROFILES.has(profile)) throw new Error(`Unknown model cache profile: ${profile}`);
  const root = path.join(home, ".local", "share", "codex-copilot-dx");
  return profile === "codex"
    ? path.join(root, "models.json")
    : path.join(root, "profiles", profile, "models.json");
}

function modelData(models) {
  const data = Array.isArray(models) ? models : models?.data;
  if (!Array.isArray(data) || !data.some((model) => String(model?.id || "").trim())) return null;
  return data;
}

export function isValidModelList(models) {
  return modelData(models) !== null;
}

export function loadModelCache({
  home = os.homedir(),
  profile = "codex",
  credentialFingerprint = "",
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now,
} = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelCachePath(home, profile), "utf8"));
    const savedAt = Date.parse(parsed.saved_at);
    if (!Number.isFinite(savedAt) || now() - savedAt > maxAgeMs) return null;
    const expectedFingerprint = String(credentialFingerprint || "").trim();
    if (expectedFingerprint && parsed.credential_fingerprint !== expectedFingerprint) return null;
    if (!isValidModelList(parsed.models)) return null;
    return parsed.models;
  } catch {
    return null;
  }
}

export function saveModelCache(models, {
  home = os.homedir(),
  profile = "codex",
  credentialFingerprint = "",
} = {}) {
  if (!isValidModelList(models)) return false;
  const filePath = modelCachePath(home, profile);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const payload = { saved_at: new Date().toISOString(), models };
  const fingerprint = String(credentialFingerprint || "").trim();
  if (fingerprint) payload.credential_fingerprint = fingerprint;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    return true;
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
}
