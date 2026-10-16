import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { withFileLockSync } from "./lock.mjs";

export const M365_GATEWAY_PORT = 2027;

export function m365Paths({ home = os.homedir() } = {}) {
  const directory = path.join(home, ".local", "share", "codex-copilot-dx", "profiles", "m365");
  return { directory, settings: path.join(directory, "settings.json"), account: path.join(directory, "account.json"),
    catalog: path.join(directory, "models.json"), gateway: path.join(directory, "gateway.json"),
    ownership: path.join(directory, "client-config.json") };
}

export function readM365Json(file, fallback = null) {
  try {
    if (!fs.lstatSync(file).isFile()) throw Error("Expected a regular file");
    const value = JSON.parse(readBoundedFileSync(file, { encoding: "utf8", maxBytes: 4 * 1024 * 1024 }));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected an object");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw Object.assign(new Error("M365 local configuration could not be read; existing files were preserved"), { code: "m365_config_invalid" });
  }
}

export function writeM365Json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { if (!fs.lstatSync(file).isFile()) throw Error("M365 configuration target is not a regular file"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const changed = atomicWriteFileIfChangedSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, preserveMode: false });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return changed;
}

function validateSettings(value) {
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw Object.assign(new Error("M365 settings are invalid; existing settings were preserved"), { code: "m365_config_invalid" });
  }
  return { ...value, enabled: value.enabled !== false };
}

export function readM365Settings(options = {}) {
  return validateSettings(readM365Json(m365Paths(options).settings, {}));
}

export function updateM365Settings(update, options = {}) {
  const file = m365Paths(options).settings;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, () => {
    const current = readM365Settings(options), next = validateSettings({ ...current, ...update });
    writeM365Json(file, next);
    return next;
  });
}

export function m365AccountKey(account) {
  if (!account || typeof account.id !== "string" || !account.id || account.id.length > 512
    || typeof account.tenant !== "string" || !account.tenant || account.tenant.length > 128
    || typeof account.login !== "string" || !account.login || account.login.length > 320
    || /[\u0000-\u0020\u007f]/.test(account.id + account.tenant + account.login)) {
    throw Object.assign(new Error("M365 account identity is unavailable"), { code: "m365_account_invalid" });
  }
  return createHash("sha256").update(`${account.tenant}\0${account.id}`).digest("hex");
}

export function readM365Account(options = {}) {
  const account = readM365Json(m365Paths(options).account);
  if (account) m365AccountKey(account);
  return account;
}

export function ensureM365GatewayKey(options = {}) {
  const file = m365Paths(options).gateway;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, () => {
    const saved = readM365Json(file);
    if (saved) {
      if (!/^ccdx_m365_[a-f0-9]{64}$/.test(saved.key || "")) throw Object.assign(new Error("M365 gateway key is invalid; it was preserved"), { code: "m365_gateway_key_invalid" });
      return saved.key;
    }
    const key = `ccdx_m365_${randomBytes(32).toString("hex")}`;
    writeM365Json(file, { key });
    return key;
  });
}
