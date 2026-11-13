import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "./atomic-file.mjs";
import { readBoundedFile } from "./bounded-file.mjs";
import { userSettingsPath } from "./user-settings.mjs";

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_APPS = 9;
export const clientVersionName = client => ({ codex: "Codex App", claude: "Claude App", antigravity: "Antigravity" })[client] || client;
const validId = value => /^(?:codex|claude)_(?:system|user|windows)_(?:chatgpt|codex|claude)$/.test(value)
  || /^antigravity_(?:system|user)_gemini$/.test(value);
const validVersion = value => typeof value === "string" && /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(value);
const optionalVersion = value => value == null || validVersion(value);
const validDate = value => value == null || typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value);
const fields = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const validEntry = value => fields(value, ["version", "build", "cli_version", "previous", "changed_at"])
  && validVersion(value.version) && optionalVersion(value.build) && optionalVersion(value.cli_version)
  && validDate(value.changed_at) && (value.previous == null || fields(value.previous, ["version", "build", "cli_version"])
    && validVersion(value.previous.version) && optionalVersion(value.previous.build) && optionalVersion(value.previous.cli_version));
const changed = (left, right) => left.version !== right.version
  || Boolean(left.build && right.build && left.build !== right.build)
  || Boolean(left.cli_version && right.cli_version && left.cli_version !== right.cli_version);
const sameFile = (left, right) => left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino && left.dev === right.dev;
const installed = value => ({ version: value.version, build: value.build || null, cli_version: value.cli_version || null });
const tag = (text, key) => new RegExp(`<key>${key}</key>\\s*<(string|integer)>([^<]+)</\\1>`).exec(text)?.[2]?.trim();

async function stableRead(file) {
  const before = await fs.stat(file), data = await readBoundedFile(file, { maxBytes: MAX_METADATA_BYTES, encoding: "utf8" }), after = await fs.stat(file);
  if (!sameFile(before, after)) throw new Error("App metadata changed during inspection");
  return { data, identity: after };
}

async function macBundle(root, scope, name, client) {
  const bundle = path.join(root, name), infoPath = path.join(bundle, "Contents", "Info.plist"), info = await stableRead(infoPath), plist = info.data;
  const expected = client === "codex" ? "com.openai.codex" : client === "claude" ? "com.anthropic.claudefordesktop" : "com.google.GeminiMacOS";
  const version = tag(plist, "CFBundleShortVersionString"), build = tag(plist, "CFBundleVersion");
  if (tag(plist, "CFBundleIdentifier") !== expected || !validVersion(version) || !optionalVersion(build)) return null;
  let cliVersion = null;
  if (client === "codex") try {
    const metadata = JSON.parse((await stableRead(path.join(bundle, "Contents", "Resources", "codex-cli", "codex-package.json"))).data);
    if (validVersion(metadata.version)) cliVersion = metadata.version;
  } catch { /* Older App bundles need not provide CLI metadata. */ }
  if (client === "codex" && !sameFile(info.identity, await fs.stat(infoPath))) return null;
  return { id: `${client}_${scope}_${name.slice(0, -4).toLowerCase()}`, name, client, scope, version, build: build || null, cli_version: cliVersion };
}

export async function inspectInstalledClientVersions({ home = os.homedir(), env = process.env, platform = process.platform,
  systemApplications = "/Applications", windowsCodexVersion } = {}) {
  if (platform === "darwin") {
    const roots = [["system", systemApplications], ["user", path.join(home, "Applications")]], jobs = [];
    for (const [scope, root] of roots) for (const [name, client] of [["ChatGPT.app", "codex"], ["Codex.app", "codex"], ["Claude.app", "claude"], ["Gemini.app", "antigravity"]]) {
      jobs.push(macBundle(root, scope, name, client).catch(() => null));
    }
    return (await Promise.all(jobs)).filter(Boolean);
  }
  if (platform === "win32") {
    const inspect = windowsCodexVersion || (await import("./native-prediction-windows.mjs")).inspectWindowsCodexVersion;
    const version = await inspect({ env }).catch(() => null);
    return validVersion(version) ? [{ id: "codex_windows_codex", name: "Codex", client: "codex", scope: "windows", version, build: null, cli_version: null }] : [];
  }
  return [];
}

export function createClientVersionMonitor({ home = os.homedir(), env = process.env, platform = process.platform,
  inspect = inspectInstalledClientVersions, persist = true, timeoutMs = 3000, now = Date.now, onChange = () => {}, ...options } = {}) {
  const file = path.join(path.dirname(userSettingsPath({ home, env })), "client-versions.json");
  let saved, writable = true, flight = null, closed = false;
  let state = { checked_at: null, codex: [], claude: [], antigravity: [], claude_unrecognized: false, persistence: "unknown" };
  const snapshot = () => structuredClone(state);
  async function load() {
    if (saved) return saved;
    try {
      const value = JSON.parse(await readBoundedFile(file, { maxBytes: MAX_METADATA_BYTES, encoding: "utf8" }));
      if (!fields(value, ["version", "apps"]) || value.version !== 1 || !value.apps || typeof value.apps !== "object" || Array.isArray(value.apps)
        || Object.entries(value.apps).length > MAX_APPS || Object.entries(value.apps).some(([id, entry]) =>
          !validId(id) || !validEntry(entry))) throw new Error("Invalid saved App versions");
      saved = value.apps;
    } catch (error) {
      if (error.code !== "ENOENT") writable = false;
      saved = {};
    }
    return saved;
  }
  async function run() {
    const baseline = await load(), rows = await inspect({ home, env, platform, ...options });
    if (!Array.isArray(rows) || rows.length > MAX_APPS) throw new Error("Invalid App version results");
    const at = new Date(now()).toISOString(), next = { ...baseline }, updates = [];
    const groups = { codex: [], claude: [], antigravity: [] };
    for (const row of rows) {
      if (!validId(row.id || "")
        || !["codex", "claude", "antigravity"].includes(row.client) || !validVersion(row.version) || !optionalVersion(row.build) || !optionalVersion(row.cli_version)) continue;
      const current = installed(row), previous = baseline[row.id];let entry;
      if (!previous) entry = { ...current, previous: null, changed_at: null };
      else if (changed(previous, current)) {
        entry = { ...current, previous: installed(previous), changed_at: at };updates.push(row.client);
      } else entry = { ...current, build: current.build || previous.build || null, cli_version: current.cli_version || previous.cli_version || null,
        previous: previous.previous || null, changed_at: previous.changed_at || null };
      next[row.id] = entry;
      groups[row.client].push({ id: row.id, name: row.name, scope: row.scope, ...entry, ...current, first_observed: !previous });
    }
    if (closed) return snapshot();
    const modified = JSON.stringify(next) !== JSON.stringify(baseline);
    saved = next;
    const observed = { checked_at: at, ...groups, claude_unrecognized: Boolean(next.claude_system_claude?.version && !/^[34]\./.test(next.claude_system_claude.version)) };
    state = { ...observed, persistence: persist ? writable && modified ? "pending" : writable ? "saved" : "unavailable" : "read_only" };
    if (updates.length) try { onChange([...new Set(updates)], snapshot()); } catch { /* Display only. */ }
    if (persist && writable && modified) try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      if (!closed) await atomicWriteFile(file, `${JSON.stringify({ version: 1, apps: next })}\n`, { mode: 0o600, preserveMode: false });
    } catch { writable = false; }
    if (!closed) state = { ...observed, persistence: persist ? writable ? "saved" : "unavailable" : "read_only" };
    return snapshot();
  }
  function refresh() {
    if (closed) return Promise.resolve(snapshot());
    if (flight) return flight.result;
    let timer, task;
    const work = Promise.resolve().then(run);
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const result = Promise.race([work, timeout]).then(value => {
      if (value) return value;
      state = { ...state, checked_at: new Date(now()).toISOString(), codex: [], claude: [], antigravity: [], persistence: "unavailable" };
      return snapshot();
    }).catch(() => {
      state = { ...state, checked_at: new Date(now()).toISOString(), codex: [], claude: [], antigravity: [], persistence: "unavailable" };
      return snapshot();
    }).finally(() => clearTimeout(timer));
    task = { result };flight = task;
    work.finally(() => { if (flight === task) flight = null; }).catch(() => {});
    return result;
  }
  return { snapshot, refresh, close() { closed = true; } };
}

export function clientVersionChecks(snapshot) {
  return ["codex", "claude", "antigravity"].map(client => {
    const rows = snapshot?.[client] || [], name = clientVersionName(client);
    if (!rows.length) return { id: "client-versions", kind: "info", message: `${name}: installed version not observed` };
    const versions = rows.map(row => `${row.name} ${row.version}${row.build ? ` (build ${row.build})` : ""}${row.cli_version ? `, CLI ${row.cli_version}` : ""}${row.changed_at ? `, changed ${row.changed_at}` : ""}`).join("; ");
    return { id: "client-versions", kind: "info", message: `${name}: ${versions}. Running version and feature compatibility are not confirmed` };
  });
}
