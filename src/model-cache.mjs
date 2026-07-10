import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function modelCachePath(home = os.homedir()) {
  return path.join(home, ".local", "share", "codex-copilot-dx", "models.json");
}

function modelData(models) {
  const data = Array.isArray(models) ? models : models?.data;
  return Array.isArray(data) ? data : null;
}

export function loadModelCache({
  home = os.homedir(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now,
} = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelCachePath(home), "utf8"));
    const savedAt = Date.parse(parsed.saved_at);
    if (!Number.isFinite(savedAt) || now() - savedAt > maxAgeMs) return null;
    if (!modelData(parsed.models)) return null;
    return parsed.models;
  } catch {
    return null;
  }
}

export function saveModelCache(models, { home = os.homedir() } = {}) {
  if (!modelData(models)) return false;
  const filePath = modelCachePath(home);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify({ saved_at: new Date().toISOString(), models })}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    return true;
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
}
