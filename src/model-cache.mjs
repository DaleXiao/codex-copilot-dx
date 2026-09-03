import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MODEL_CACHE_SOFT_TTL_MS = 2 * 60 * 60 * 1000;
export const MODEL_CACHE_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function modelCachePath(home = os.homedir()) {
  return path.join(home, ".local", "share", "codex-copilot-dx", "models.json");
}

function modelData(models) {
  const data = Array.isArray(models) ? models : models?.data;
  if (!Array.isArray(data) || !data.some((model) => String(model?.id || "").trim())) return null;
  return data;
}

export function isValidModelList(models) {
  return modelData(models) !== null;
}

function normalizedTtl(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function loadModelCacheEntry({
  home = os.homedir(),
  credentialFingerprint = "",
  softTtlMs = MODEL_CACHE_SOFT_TTL_MS,
  hardTtlMs,
  maxAgeMs,
  now = Date.now,
} = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelCachePath(home), "utf8"));
    const savedAt = Date.parse(parsed.saved_at);
    if (!Number.isFinite(savedAt)) return null;
    const expectedFingerprint = String(credentialFingerprint || "").trim();
    if (expectedFingerprint && parsed.credential_fingerprint !== expectedFingerprint) return null;
    if (!isValidModelList(parsed.models)) return null;
    const resolvedHardTtlMs = normalizedTtl(
      hardTtlMs,
      normalizedTtl(maxAgeMs, MODEL_CACHE_HARD_TTL_MS),
    );
    const resolvedSoftTtlMs = Math.min(
      normalizedTtl(softTtlMs, MODEL_CACHE_SOFT_TTL_MS),
      resolvedHardTtlMs,
    );
    const ageMs = Math.max(0, now() - savedAt);
    if (ageMs > resolvedHardTtlMs) return null;
    return {
      models: parsed.models,
      savedAtMs: savedAt,
      ageMs,
      state: ageMs > resolvedSoftTtlMs ? "stale" : "fresh",
    };
  } catch {
    return null;
  }
}

export function loadModelCache(options = {}) {
  return loadModelCacheEntry(options)?.models || null;
}

export function saveModelCache(models, {
  home = os.homedir(),
  credentialFingerprint = "",
  isCurrent = () => true,
  now = Date.now,
} = {}) {
  if (!isValidModelList(models)) return false;
  if (typeof isCurrent === "function" && !isCurrent()) return false;
  const filePath = modelCachePath(home);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const payload = { saved_at: new Date(now()).toISOString(), models };
  const fingerprint = String(credentialFingerprint || "").trim();
  if (fingerprint) payload.credential_fingerprint = fingerprint;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    if (typeof isCurrent === "function" && !isCurrent()) return false;
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    return true;
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
}
