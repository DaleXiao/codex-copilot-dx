import fs from "node:fs";
import files from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createApiSecretStore } from "./api-secrets.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { codexPaths } from "./codex-paths.mjs";
import { withFileLockSync } from "./lock.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { readBoundedResponseText } from "./http-transport.mjs";
import { userSettingsPath } from "./user-settings.mjs";

const DEFAULTS = { enabled: false, minutes: 30, title: "", body: "" };
const ID = /^[a-zA-Z0-9-]{1,120}$/;
const ROLLOUT = /^rollout-[^/\\]+\.jsonl$/;
const MB = 1024 * 1024;
const ICON = "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png/light/codex-color.png";

function invalid() { return new Error("ccdx_bark_invalid"); }

export function parseBarkUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw invalid();
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw invalid();
  // Accept the copied test URL as well as the short URL ending at the key.
  const parts = url.pathname.split("/").slice(1);
  const keyIndex = parts.findIndex(part => /^[A-Za-z0-9_-]{16,128}$/.test(part));
  if (keyIndex < 0 || parts.length > keyIndex + 4) throw invalid();
  url.pathname = "/" + [...parts.slice(0, keyIndex), "push"].join("/");
  url.search = "";
  return { endpoint: url.href, deviceKey: parts[keyIndex] };
}

function record(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function completions(file, since) {
  const stat = await files.lstat(file);
  if (!stat.isFile() || !stat.size) return [];
  const handle = await files.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== stat.ino) return [];
    const head = Buffer.alloc(Math.min(current.size, 64 * 1024));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const first = head.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const meta = record(first), source = meta?.payload?.source;
    if (meta?.type !== "session_meta" || !ID.test(meta.payload?.id || "")
      || source && typeof source === "object" && Object.hasOwn(source, "subagent") || source === "subagent") return [];
    const tail = Buffer.alloc(Math.min(current.size, MB));
    const offset = current.size - tail.length;
    const read = await handle.read(tail, 0, tail.length, offset);
    const rows = tail.subarray(0, read.bytesRead).toString("utf8").split("\n");
    if (offset) rows.shift();
    rows.pop(); // Only complete lines are eligible.
    return rows.flatMap(line => {
      if (!line.includes('"task_complete"') && !line.includes('"turn_complete"')) return [];
      const row = record(line), turn = row?.payload, time = Date.parse(row?.timestamp);
      if (row?.type !== "event_msg" || !["task_complete", "turn_complete"].includes(turn?.type)
        || !Number.isFinite(time) || time < since || !ID.test(turn.turn_id || "")
        || !Number.isSafeInteger(turn.duration_ms) || turn.duration_ms < 0
        || typeof turn.last_agent_message !== "string" || !turn.last_agent_message.trim()
        || turn.root_turn_id && turn.root_turn_id !== turn.turn_id
        || turn.status != null && turn.status !== "completed") return [];
      const id = createHash("sha256").update(meta.payload.id + "/" + turn.turn_id).digest("hex");
      return [{ id, time, duration: turn.duration_ms }];
    });
  } finally { await handle.close(); }
}

export function createBarkNotifications({ env = process.env, home, platform = process.platform, fetchImpl = fetch,
  secretStore = createApiSecretStore({ env, home, platform }), now = Date.now, scanIntervalMs = 10000 } = {}) {
  const folder = path.dirname(userSettingsPath({ env, home }));
  const file = path.join(folder, "bark.json"), ledger = path.join(folder, "bark-delivered.json");
  const sessions = path.join(codexPaths({ env, home }).directory, "sessions");
  let timer, lastResult = null, closed = false, running = false, watching = false, since = now();
  let settings = readSettings();
  const scanned = new Map();

  function readSettings() {
    try {
      const value = JSON.parse(readBoundedFileSync(file, { encoding: "utf8", maxBytes: 8192 }));
      if (!value || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.minutes)
        || value.minutes < 0 || value.minutes > 10080 || typeof value.title !== "string" || typeof value.body !== "string") return { ...DEFAULTS };
      const ref = /^[a-f0-9]{32}$/.test(value.ref || "") ? value.ref : undefined;
      return { enabled: value.enabled && Boolean(ref), minutes: value.minutes, title: value.title, body: value.body, ref };
    } catch { return { ...DEFAULTS }; }
  }

  function claim(event) {
    return withFileLockSync(ledger + ".lock", () => {
      let sent = [];
      try { sent = JSON.parse(readBoundedFileSync(ledger, { encoding: "utf8", maxBytes: 64 * 1024 })); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (sent.some(entry => entry.id === event.id)) return false;
      sent = sent.filter(entry => entry.time >= now() - 86400000).slice(-255);
      sent.push({ id: event.id, time: event.time });
      atomicWriteFileSync(ledger, JSON.stringify(sent), { mode: 0o600 });
      return true;
    });
  }

  async function scan() {
    if (running) return;
    running = true;
    const snapshot = settings;
    try {
      const root = await files.realpath(sessions);
      const entries = (await files.readdir(root, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile() && ROLLOUT.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 4096);
      if (closed || snapshot !== settings) return;
      watching = true;
      for (const entry of entries) {
        if (closed || snapshot !== settings) break;
        try {
          const file = path.join(entry.parentPath, entry.name);
          const stat = await files.stat(file);
          if (stat.mtimeMs < since - 1000) continue;
          const stamp = [stat.ino, stat.size, stat.mtimeMs].join(":");
          if (scanned.get(file) === stamp) continue;
          if (!(await files.realpath(file)).startsWith(root + path.sep)) continue;
          for (const event of await completions(file, since)) {
            if (closed || snapshot !== settings || event.duration < snapshot.minutes * 60000) continue;
            const destination = parseBarkUrl(await secretStore.get(snapshot.ref));
            if (closed || snapshot !== settings || !claim(event)) continue;
            const result = await fetchImpl(destination.endpoint, {
              method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000),
              body: JSON.stringify({ device_key: destination.deviceKey, title: snapshot.title || "Codex task completed",
                body: snapshot.body || "A long Codex task has finished.", icon: ICON, group: "CCDX" }),
            });
            // Bark can report an application error with HTTP success.
            const reply = await readBoundedResponseText(result, { maxBytes: 4096, label: "Bark response" });
            if (snapshot === settings) lastResult = result.ok && record(reply)?.code === 200 ? "sent" : "failed";
          }
          if (snapshot === settings) {
            scanned.set(file, stamp);
            if (scanned.size > 4096) scanned.delete(scanned.keys().next().value);
          }
        } catch (error) { if (error.code !== "ENOENT" && snapshot === settings) lastResult = "failed"; }
      }
    } catch { watching = false; }
    finally { running = false;schedule(); }
  }

  function schedule(interval = scanIntervalMs) {
    clearTimeout(timer);
    if (!closed && settings.enabled) timer = setTimeout(() => { void scan(); }, interval).unref();
  }

  function snapshot() {
    const { enabled, minutes, title, body, ref } = settings;
    return { enabled, minutes, title, body, configured: Boolean(ref), watching, delivery: lastResult };
  }

  schedule(0);
  return {
    snapshot,
    async save({ enabled, minutes, title, body, url = "" }) {
      if (typeof enabled !== "boolean" || !Number.isSafeInteger(minutes) || minutes < 0 || minutes > 10080
        || typeof title !== "string" || title.length > 160 || typeof body !== "string" || body.length > 500
        || typeof url !== "string") throw invalid();
      const prior = settings.ref;
      const replacement = url.trim() !== "";
      if (replacement) parseBarkUrl(url);
      if (enabled && !replacement && !prior) throw invalid();
      const ref = replacement ? randomBytes(16).toString("hex") : prior;
      if (replacement) await secretStore.set(ref, url.trim());
      const next = { enabled, minutes, title: title.trim(), body: body.trim(), ref };
      try {
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        atomicWriteFileSync(file, JSON.stringify(next), { mode: 0o600 });
      } catch (error) {
        if (replacement) await secretStore.remove(ref).catch(() => {});
        throw error;
      }
      if (replacement && prior) await secretStore.remove(prior).catch(() => {});
      watching = false;lastResult = null;settings = next;since = now();scanned.clear();schedule(0);
      return snapshot();
    },
    close() { closed = true;clearTimeout(timer);secretStore.close?.(); },
  };
}
