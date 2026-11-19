import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "./atomic-file.mjs";
import { readBoundedFile, readBoundedFileSync } from "./bounded-file.mjs";
import { withFileLock } from "./lock.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

const HOUR = 3600000, HOURS = 24, PER_HOUR = 32, MAX_BYTES = 512 * 1024;
const APPS = new Set(["codex_app", "codex_cli", "codex", "claude_app", "claude_code", "claude", "gemini_app", "api"]);
const PHASES = new Set(["local", "send", "headers", "stream", "upstream", "unknown"]);
export const failureHistoryPath = (home = os.homedir()) => path.join(home, ".local", "share", "codex-copilot-dx", "failure-history.json");
const requestId = value => typeof value === "string" && /^[\da-f-]{36}$/i.test(value) ? value : null;
const modelName = value => typeof value === "string" && /^[\w][\w./:@+-]{0,119}$/.test(value) && redactDiagnosticText(value) === value ? value : "unknown";
const groupKey = value => JSON.stringify([value.application, value.model, value.phase]);
const hour = now => Math.floor(now / HOUR) * HOUR;
const keep = (now, value) => Number.isSafeInteger(value) && value >= hour(now) - (HOURS - 1) * HOUR && value <= hour(now) && value % HOUR === 0;

function put(buckets, row) {
  let groups = buckets.get(row.hour);
  if (!groups) buckets.set(row.hour, groups = new Map());
  let key = groupKey(row);
  if (!groups.has(key) && groups.size >= PER_HOUR - 1) {
    row = { ...row, application: "api", model: "unknown", phase: "unknown" };
    key = groupKey(row);
  }
  const previous = groups.get(key);
  groups.set(key, { ...row, count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count || 0) + row.count),
    last: !previous || row.last.at >= previous.last.at ? row.last : previous.last });
}

function parse(text, now) {
  const result = new Map();
  for (const row of JSON.parse(text)?.rows || []) {
    if (!row || !keep(now, row.hour) || !APPS.has(row.application) || !PHASES.has(row.phase) ||
      !Number.isSafeInteger(row.count) || row.count < 1 || !Number.isSafeInteger(row.last?.at) || hour(row.last.at) !== row.hour) continue;
    put(result, { hour: row.hour, application: row.application, model: modelName(row.model), phase: row.phase, count: row.count,
      last: { at: row.last.at, status: Number.isInteger(row.last.status) && row.last.status >= 400 && row.last.status <= 599 ? row.last.status : null,
        request_id: requestId(row.last.request_id), client_request_id: requestId(row.last.client_request_id) } });
  }
  return result;
}

const options = { encoding: "utf8", maxBytes: MAX_BYTES };
const values = buckets => [...buckets.values()].flatMap(group => [...group.values()]);
const prune = (buckets, now) => { for (const key of buckets.keys()) if (!keep(now, key)) buckets.delete(key); };
function phase(details) {
  const attempt = details.attempt_timings?.at(-1);
  if (details.origin === "upstream_http") return "upstream";
  if (details.origin === "upstream_event" || attempt?.headers_ms != null) return "stream";
  if (attempt?.body_sent_ms != null) return "headers";
  return details.upstream_attempts > 0 ? "send" : "local";
}

export function createFailureHistory({ file, now = Date.now } = {}) {
  let buckets = new Map(), pending = new Map(), saving, cached, clock;
  if (file) try { buckets = parse(readBoundedFileSync(file, options), now()); } catch { /* Optional local history is not required for startup. */ }
  function flush() {
    if (!file || saving || !pending.size) return saving;
    const batch = pending;
    pending = new Map();
    saving = withFileLock(file + ".lock", async () => {
      const current = now();
      let disk = new Map();
      try { disk = parse(await readBoundedFile(file, options), current); }
      catch { /* Start a fresh bounded projection on unreadable history. */ }
      for (const row of values(batch)) if (keep(current, row.hour)) put(disk, row);
      await atomicWriteFile(file, JSON.stringify({ rows: values(disk) }), { mode: 0o600, preserveMode: false });
    }, { timeoutMs: 1000 }).catch(() => { /* An I/O error cannot delay or fail inference. */ })
      .finally(() => { saving = undefined;flush(); });
    return saving;
  }
  return {
    record(details) {
      const at = now(), row = { hour: hour(at), application: APPS.has(details.application) ? details.application : "api",
        model: modelName(details.model), phase: phase(details), count: 1,
        last: { at, status: Number.isInteger(details.http_status) && details.http_status >= 400 ? details.http_status : null,
          request_id: requestId(details.request_id), client_request_id: requestId(details.attempt_timings?.at(-1)?.client_request_id) } };
      put(buckets, row);prune(buckets, at);cached = null;
      if (file) { put(pending, row);prune(pending, at);flush(); }
    },
    snapshot() {
      const at = now(), current = hour(at);
      if (cached && clock === current) return cached;
      prune(buckets, at);clock = current;
      const groups = new Map();
      for (const row of values(buckets)) {
        const key = groupKey(row), previous = groups.get(key);
        groups.set(key, { application: row.application, model: row.model, phase: row.phase, count: (previous?.count || 0) + row.count,
          last: !previous || row.last.at >= previous.last.at ? row.last : previous.last });
      }
      const all = [...groups.values()].sort((a, b) => b.count - a.count || b.last.at - a.last.at);
      return cached = { from: new Date(clock - (HOURS - 1) * HOUR).toISOString(),
        total: all.reduce((sum, group) => sum + group.count, 0), groups: all.slice(0, 40), omitted: Math.max(0, all.length - 40) };
    },
    async flush() { while (flush()) await saving; },
  };
}
