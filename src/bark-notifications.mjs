import fs from "node:fs";
import files from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createApiSecretStore } from "./api-secrets.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { codexPaths } from "./codex-paths.mjs";
import { claudeClientPaths } from "./claude-client-config.mjs";
import { withFileLockSync } from "./lock.mjs";
import { readBoundedFile, readBoundedFileSync } from "./bounded-file.mjs";
import { readBoundedResponseText } from "./http-transport.mjs";
import { userSettingsPath } from "./user-settings.mjs";
import { ANTIGRAVITY_STOP_SIGNAL } from "./antigravity-stop-hook.mjs";

const DEFAULTS = { enabled: false, minutes: 30, title: "", body: "", language: "en" };
const ID = /^[a-zA-Z0-9-]{1,120}$/;
const ROLLOUT = /^rollout-[^/\\]+\.jsonl$/;
const CLAUDE_SESSION = /^local_[0-9a-f-]{36}\.json$/i;
const MB = 1024 * 1024;
const ICONS = "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png/light/";
const APPS = {
  codex: { name: "Codex", icon: "codex-color.png" },
  claude_app: { name: "Claude", icon: "claude-color.png" },
  antigravity: { name: "Antigravity", icon: "antigravity-color.png" },
};

function invalid() { return new Error("ccdx_bark_invalid"); }

export function parseBarkUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw invalid();
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw invalid();
  // Accept the copied test URL as well as the short URL ending at the key.
  const parts = url.pathname.split("/").slice(1);
  const isKey = part => /^[A-Za-z0-9_-]{16,128}$/.test(part);
  const explicit = url.searchParams.get("device_key");
  if (parts.at(-1) === "push" && explicit !== null) {
    if (!isKey(explicit) || url.searchParams.getAll("device_key").length !== 1) throw invalid();
    url.search = "";
    return { endpoint: url.href, deviceKey: explicit };
  }
  const indices = parts.flatMap((part, index) => index >= parts.length - 4 && isKey(part) ? [index] : []);
  const standard = indices.filter(index => /^[A-Za-z0-9]{22}$/.test(parts[index]));
  const candidates = standard.length ? standard : indices;
  if (candidates.length !== 1) throw invalid();
  const [keyIndex] = candidates;
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
      return [{ id, time, duration: turn.duration_ms, application: "codex" }];
    });
  } finally { await handle.close(); }
}

async function claudeCompletion(file, since, previousCount) {
  const session = record(await readBoundedFile(file, { encoding: "utf8", maxBytes: MB }));
  if (!session || path.basename(file) !== session.sessionId + ".json") return null;
  const count = session.completedTurns ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) return null;
  const start = session.latestUserFrameAt, time = session.lastTurnEdgeAt;
  // Claude Desktop's Code mode increments completedTurns only on a successful SDK result.
  const advanced = previousCount === undefined ? count === 1 && session.createdAt >= since : count > previousCount;
  if (!advanced || session.spawnedFrom || session.lastTurnCutShort || session.lastTurnStopped || session.interruptedAwaitingPerson
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(time) || time < since || time <= start
    || Number.isSafeInteger(session.errorAt) && session.errorAt >= start) return { count };
  const id = createHash("sha256").update("claude_app/" + session.sessionId + "/" + count).digest("hex");
  return { count, event: { id, time, duration: time - start, application: "claude_app" } };
}

function notificationMessage(settings, event) {
  const { name, icon } = APPS[event.application];
  const zh = settings.language === "zh";
  return { title: settings.title || (zh ? name + " 任务完成" : name + " task completed"),
    body: settings.body || (zh ? "一个 " + name + " 任务已完成。" : "A " + name + " task has finished."),
    icon: ICONS + icon, group: "CCDX" };
}

async function antigravityCompletion(file, size, row, since) {
  const handle = await files.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const tail = Buffer.alloc(Math.min(size, MB));
    const offset = size - tail.length;
    const read = await handle.read(tail, 0, tail.length, offset);
    const lines = tail.subarray(0, read.bytesRead).toString("utf8").split("\n");
    if (offset) lines.shift();
    if (lines.pop() !== "") return null;
    const end = record(lines.pop());
    // An idle summary alone also occurs on errors, interruption or overdue background work.
    if (end?.type !== "PLANNER_RESPONSE" || end.source !== "MODEL" || end.status !== "DONE"
      || !Number.isSafeInteger(end.step_index) || end.step_index + 1 !== row.step_count
      || typeof end.content !== "string" || !end.content.trim()
      || end.tool_calls != null && (!Array.isArray(end.tool_calls) || end.tool_calls.length)) return null;
    const input = lines.map(record).findLast(step => step?.type === "USER_INPUT");
    const startIndex = row.last_user_input_step_index === -1 ? 0 : row.last_user_input_step_index;
    if (end.step_index <= startIndex || (input ? input.step_index !== startIndex : !offset || row.last_user_input_step_index < 0)) return null;
    // Long turns may have pushed their input row out of the bounded transcript tail.
    const time = Date.parse(end.created_at), start = Date.parse(input?.created_at ?? row.last_user_input_time);
    if (!Number.isFinite(time) || !Number.isFinite(start) || time < since || time < start
      || Date.parse(row.last_modified_time) < time) return null;
    const id = createHash("sha256").update("antigravity/" + row.conversation_id + "/" + startIndex).digest("hex");
    return { id, time, duration: time - start, application: "antigravity" };
  } finally { await handle.close(); }
}

async function antigravityIdleConversations(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT conversation_id, last_user_input_step_index, last_user_input_time, last_modified_time, step_count
      FROM conversation_summaries
      WHERE status = 'CASCADE_RUN_STATUS_IDLE' AND not_fully_idle = 0 AND killed = 0
        AND nesting_depth = 0 AND COALESCE(parent_conversation_id, '') = ''
      ORDER BY last_modified_time DESC LIMIT 256`).all();
  } finally { db.close(); }
}

export function createBarkNotifications({ env = process.env, home = os.homedir(), platform = process.platform, fetchImpl = fetch,
  secretStore = createApiSecretStore({ env, home, platform }), now = Date.now, scanIntervalMs = 10000 } = {}) {
  const folder = path.dirname(userSettingsPath({ env, home }));
  const file = path.join(folder, "bark.json"), ledger = path.join(folder, "bark-delivered.json");
  const claude = claudeClientPaths({ env, home, platform });
  const sources = [
    { directory: path.join(codexPaths({ env, home }).directory, "sessions"), pattern: ROLLOUT, application: "codex" },
    ...[...new Set([claude.threep, claude.normal])].map(file => ({
      directory: path.join(path.dirname(file), "claude-code-sessions"), pattern: CLAUDE_SESSION, application: "claude_app",
    })),
  ];
  const antigravity = path.join(home, ".gemini", "antigravity");
  let timer, lastResult = null, closed = false, running = false, watching = false, since = now();
  let settings = readSettings(), antigravityCatalog, insecureRef;
  let stopWatcher, antigravityScan, scanFlight, closeFlight;
  const shutdown = new AbortController();
  const scanned = new Map();

  function readSettings() {
    try {
      const value = JSON.parse(readBoundedFileSync(file, { encoding: "utf8", maxBytes: 8192 }));
      if (!value || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.minutes)
        || value.minutes < 0 || value.minutes > 10080 || typeof value.title !== "string" || typeof value.body !== "string") return { ...DEFAULTS };
      const ref = /^[a-f0-9]{32}$/.test(value.ref || "") ? value.ref : undefined;
      // 1.4.17 persisted placeholders as text. Only migrate its exact default copy.
      const legacy = value.language === undefined;
      const zh = value.language === "zh" || legacy && ["Codex 任务完成", "一个 Codex 长任务已完成。"].some(word => word === value.title || word === value.body);
      const title = legacy && ["Codex task completed", "Codex 任务完成"].includes(value.title) ? "" : value.title;
      const body = legacy && ["A long Codex task has finished.", "一个 Codex 长任务已完成。"].includes(value.body) ? "" : value.body;
      return { enabled: value.enabled && Boolean(ref), minutes: value.minutes, title, body, language: zh ? "zh" : "en", ref,
        transport: value.transport === "https" ? "https" : undefined };
    } catch { return { ...DEFAULTS }; }
  }

  function claim(event) {
    return withFileLockSync(ledger + ".lock", () => {
      let raw;
      try { raw = record(readBoundedFileSync(ledger, { encoding: "utf8", maxBytes: 64 * 1024 })); }
      catch (error) {
        if (error.code !== "ENOENT" && !(error.code === "ccdx_local_file_limit" && fs.lstatSync(ledger).isFile())) throw error;
      }
      const valid = Array.isArray(raw) ? raw.filter(entry => entry && typeof entry.id === "string"
        && /^[a-f0-9]{64}$/.test(entry.id) && Number.isSafeInteger(entry.time)) : [];
      if (valid.some(entry => entry.id === event.id)) return false;
      const sent = valid.filter(entry => entry.time >= now() - 86400000).slice(-255);
      sent.push({ id: event.id, time: event.time });
      atomicWriteFileSync(ledger, JSON.stringify(sent), { mode: 0o600 });
      return true;
    });
  }

  async function scan() {
    if (running) return;
    running = true;
    const snapshot = settings;
    let foundSource = false;
    try {
      if (snapshot.ref && !snapshot.transport && insecureRef?.ref !== snapshot.ref) {
        try {
          const destination = parseBarkUrl(await secretStore.get(snapshot.ref));
          if (snapshot === settings) insecureRef = { ref: snapshot.ref, http: destination.endpoint.startsWith("http:") };
        } catch { /* Delivery reports credential and address errors. */ }
      }
      for (const source of sources) {
        if (closed || snapshot !== settings) return;
        const root = await files.realpath(source.directory).catch(() => null);
        if (!root) continue;
        foundSource = await scanSource(source, root, snapshot) || foundSource;
      }
      if (!closed && snapshot === settings) foundSource = await scanAntigravity(snapshot) || foundSource;
    } finally {
      if (snapshot === settings) watching = foundSource;
      running = false;schedule();
    }
  }

  function remember(file, value) {
    scanned.set(file, value);
    if (scanned.size > 4096) scanned.delete(scanned.keys().next().value);
  }

  async function deliver(event, snapshot) {
    if (closed || snapshot !== settings || event.duration < snapshot.minutes * 60000) return;
    try {
      const destination = parseBarkUrl(await secretStore.get(snapshot.ref));
      if (closed || snapshot !== settings) return;
      try { if (!claim(event)) return; }
      catch { lastResult = "ledger_failed";return; }
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(5000)]);
      const result = await fetchImpl(destination.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal,
        body: JSON.stringify({ device_key: destination.deviceKey, ...notificationMessage(snapshot, event) }),
      });
      const reply = await readBoundedResponseText(result, { maxBytes: 4096, label: "Bark response", signal });
      if (!closed && snapshot === settings) lastResult = result.ok && record(reply)?.code === 200 ? "sent" : "failed";
    } catch {
      if (!closed && snapshot === settings) lastResult = "failed";
    }
  }

  function scanAntigravity(snapshot) {
    antigravityScan ||= readAntigravity(snapshot).finally(() => { antigravityScan = undefined; });
    return antigravityScan;
  }

  async function readAntigravity(snapshot) {
    let root, rows;
    try {
      root = await files.realpath(antigravity);
      const file = path.join(root, "conversation_summaries.db");
      const db = await files.lstat(file, { bigint: true });
      if (!db.isFile()) { antigravityCatalog = undefined;return false; }
      const wal = await files.lstat(file + "-wal", { bigint: true }).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      const stamp = [file, db.dev, db.ino, db.size, db.mtimeNs, db.ctimeNs,
        wal?.dev, wal?.ino, wal?.size, wal?.mtimeNs, wal?.ctimeNs].join(":");
      if (antigravityCatalog?.stamp !== stamp) antigravityCatalog = { stamp, rows: await antigravityIdleConversations(file) };
      rows = antigravityCatalog.rows;
    } catch { antigravityCatalog = undefined;return false; }
    for (const row of rows) {
      if (closed || snapshot !== settings) break;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.conversation_id || "")
        || !Number.isSafeInteger(row.last_user_input_step_index) || row.last_user_input_step_index < -1
        || !(Date.parse(row.last_modified_time) >= since)) continue;
      const key = "antigravity:" + row.conversation_id;
      try {
        const file = path.join(root, "brain", row.conversation_id, ".system_generated", "logs", "transcript.jsonl");
        if (await files.realpath(file) !== file) continue;
        const stat = await files.lstat(file);
        if (!stat.isFile() || !stat.size) continue;
        // Both files matter: the summary may be written before the final transcript line.
        const stamp = [row.last_modified_time, row.step_count, stat.ino, stat.size, stat.mtimeMs].join(":");
        if (scanned.get(key)?.stamp === stamp) continue;
        const event = await antigravityCompletion(file, stat.size, row, since);
        if (event) await deliver(event, snapshot);
        if (snapshot === settings) remember(key, { stamp });
      } catch { /* The client may be writing or rotating its transcript. */ }
    }
    return true;
  }

  async function scanSource(source, root, snapshot) {
    try {
      const entries = (await files.readdir(root, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile() && source.pattern.test(entry.name));
      if (closed || snapshot !== settings) return;
      const selected = [];
      if (entries.length > 4096) {
        for (const entry of entries) {
          if (closed || snapshot !== settings) return;
          const file = path.join(entry.parentPath, entry.name);
          const stat = await files.stat(file).catch(() => null);
          if (stat?.isFile()) selected.push({ file, stat });
        }
        selected.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        selected.length = Math.min(selected.length, 4096);
      } else {
        for (const entry of entries) selected.push({ file: path.join(entry.parentPath, entry.name) });
      }
      for (const entry of selected) {
        if (closed || snapshot !== settings) break;
        try {
          const { file } = entry;
          const stat = entry.stat ?? await files.stat(file);
          if (source.application === "codex" && stat.mtimeMs < since - 1000) continue;
          const stamp = [stat.ino, stat.size, stat.mtimeMs].join(":");
          const previous = scanned.get(file);
          if (previous?.stamp === stamp) continue;
          if (!(await files.realpath(file)).startsWith(root + path.sep)) continue;
          const claude = source.application === "claude_app" ? await claudeCompletion(file, since, previous?.count) : null;
          const events = source.application === "codex" ? await completions(file, since) : claude?.event ? [claude.event] : [];
          for (const event of events) await deliver(event, snapshot);
          if (snapshot === settings) remember(file, { stamp, count: claude?.count });
        } catch { /* The client may be writing or rotating its session file. */ }
      }
      return true;
    } catch { return false; }
  }

  function schedule(interval = scanIntervalMs) {
    clearTimeout(timer);
    if (!closed && settings.enabled) timer = setTimeout(() => { scanFlight = scan(); }, interval).unref();
  }

  function watchAntigravityStop() {
    stopWatcher?.close();
    stopWatcher = undefined;
    if (!settings.enabled) return;
    try {
      const watcher = fs.watch(folder, { persistent: false }, (_event, file) => {
        if (!closed && settings.enabled && file === ANTIGRAVITY_STOP_SIGNAL) {
          void scanAntigravity(settings).catch(() => {});
        }
      });
      watcher.on("error", () => watcher.close());
      stopWatcher = watcher;
    } catch { /* The regular scan continues when file notifications are unavailable. */ }
  }

  function snapshot() {
    const { enabled, minutes, title, body, ref } = settings;
    return { enabled, minutes, title, body, sources: Object.keys(APPS), configured: Boolean(ref), watching, delivery: lastResult,
      insecure: Boolean(ref && insecureRef?.ref === ref && insecureRef.http) };
  }

  watchAntigravityStop();
  schedule(0);
  return {
    snapshot,
    async save({ enabled, minutes, title, body, url = "", language = settings.language }) {
      if (typeof enabled !== "boolean" || !Number.isSafeInteger(minutes) || minutes < 0 || minutes > 10080
        || typeof title !== "string" || title.length > 160 || typeof body !== "string" || body.length > 500
        || typeof url !== "string" || !["en", "zh"].includes(language)) throw invalid();
      const prior = settings.ref;
      const replacement = url.trim() !== "";
      if (replacement && !parseBarkUrl(url).endpoint.startsWith("https:")) throw new Error("ccdx_bark_https_required");
      if (enabled && !replacement && !prior) throw invalid();
      const ref = replacement ? randomBytes(16).toString("hex") : prior;
      if (replacement) await secretStore.set(ref, url.trim());
      const next = { enabled, minutes, title: title.trim(), body: body.trim(), language, ref,
        transport: replacement ? "https" : settings.transport };
      try {
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        atomicWriteFileSync(file, JSON.stringify(next), { mode: 0o600 });
      } catch (error) {
        if (replacement) await secretStore.remove(ref).catch(() => {});
        throw error;
      }
      if (replacement && prior) await secretStore.remove(prior).catch(() => {});
      watching = false;lastResult = null;settings = next;since = now();scanned.clear();
      watchAntigravityStop();
      schedule(0);
      return snapshot();
    },
    close() {
      if (closeFlight) return closeFlight;
      closed = true;clearTimeout(timer);stopWatcher?.close();shutdown.abort();
      let deadline;
      closeFlight = Promise.race([
        Promise.allSettled([scanFlight, antigravityScan]),
        new Promise(resolve => { deadline = setTimeout(resolve, 5000).unref(); }),
      ]).finally(() => { clearTimeout(deadline);secretStore.close?.(); });
      return closeFlight;
    },
  };
}
