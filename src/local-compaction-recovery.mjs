import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createZstdDecompress } from "node:zlib";
import { codexPaths } from "./codex-paths.mjs";
import { isLoopbackAddress, isLoopbackHostHeader, isLanAllowed } from "./security.mjs";
import { decodedBodyLimitPreference } from "./user-settings.mjs";
import { isResponsesToolOutputItem, readResponsesToolOutputParts } from "./responses-content.mjs";
import { prepareResponsesRequest } from "./responses-request.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CALLS = new Map([["function_call", "function_call_output"], ["custom_tool_call", "custom_tool_call_output"]]);

function unavailable(code) {
  return Object.assign(new Error("Verified local plaintext history is unavailable"), { code });
}

function threadId(request, body) {
  const metadata = body?.client_metadata;
  const primary = [request.headers?.["thread-id"], request.headers?.["x-codex-thread-id"], metadata?.thread_id];
  const values = primary.filter(value => value !== undefined);
  if (!values.length) values.push(metadata?.session_id ?? request.headers?.["session-id"] ?? body?.prompt_cache_key);
  if (values.some(value => typeof value !== "string" || !UUID.test(value))) throw unavailable("thread_binding_missing");
  const ids = new Set(values.map(value => value.toLowerCase()));
  if (ids.size !== 1) throw unavailable("thread_binding_conflict");
  return [...ids][0];
}

function opaque(value) {
  if (Array.isArray(value)) return value.some(opaque);
  if (!value || typeof value !== "object") return false;
  return Object.hasOwn(value, "encrypted_content") || value.type === "encrypted_content" || Object.values(value).some(opaque);
}

function plaintext(item) {
  if (!item || typeof item !== "object" || typeof item.type !== "string") throw unavailable("unsupported_rollout_item");
  if (["reasoning", "compaction"].includes(item.type)) return null;
  const out = structuredClone(item);
  for (const key of Object.keys(out)) if (key === "id" || key.startsWith("internal_")) delete out[key];
  // This field is replay metadata, not a replacement for a visible item. Never
  // omit opaque content parts or invent plaintext for an encrypted tool result.
  if ((out.type === "message" && out.content?.length) || (isResponsesToolOutputItem(out) && out.output !== undefined)) {
    delete out.encrypted_content;
  }
  if (opaque(out) || (isResponsesToolOutputItem(out) && opaque(readResponsesToolOutputParts(out)?.parts))) {
    throw unavailable("plaintext_content_missing");
  }
  return out;
}

function fingerprint(item) {
  const normalized = { ...item };
  delete normalized.id;delete normalized.status;
  if (item.type === "message" && Array.isArray(item.content)) normalized.content = item.content.map(part => {
    if (!["input_text", "output_text"].includes(part?.type)) return part;
    const text = { ...part };delete text.annotations;return text;
  });
  return createHash("sha256").update(JSON.stringify(normalized, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]]));
    }
    return value;
  })).digest("hex");
}

async function candidateFiles(directory, id, check) {
  const found = [];
  let entries = 0;
  async function walk(parent, depth) {
    check();
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable("unsafe_rollout_path");
    const iterator = await fs.opendir(parent);
    for await (const entry of iterator) {
      check();
      if (++entries > 4096) throw unavailable("rollout_lookup_limit");
      const file = path.join(parent, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(file, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name) && entry.name.toLowerCase().includes(id)) {
        if (found.length >= 16) throw unavailable("rollout_lookup_limit");
        found.push(file);
      }
    }
  }
  for (const name of ["sessions", "archived_sessions"]) {
    try { await walk(path.join(directory, name), 0); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return found;
}

async function readPrefix(file, directory, id, ciphertext, budget, check, signal) {
  const real = await fs.realpath(file);
  if (!real.startsWith(directory + path.sep)) throw unavailable("unsafe_rollout_path");
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw unavailable("unsafe_rollout_path");
  if (!before.size) throw unavailable("incomplete_rollout");
  const handle = await fs.open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW || 0));
  let stream, raw;
  try {
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw unavailable("rollout_changed");
    raw = handle.createReadStream({ autoClose: false, end: stat.size - 1, highWaterMark: 64 * 1024, signal });
    stream = file.endsWith(".zst") ? raw.pipe(createZstdDecompress()) : raw;
    if (stream !== raw) raw.on("error", error => stream.destroy(error));
    const items = [];
    let metadata = false, matched = false, parts = [], length = 0, bytesRead = 0;
    const record = bytes => {
      check();
      const line = bytes.toString("utf8").replace(/^\uFEFF/, "").trim();
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch { throw unavailable("invalid_rollout"); }
      const value = row.payload;
      if (!metadata) {
        if (row.type !== "session_meta" || value?.id?.toLowerCase() !== id) throw unavailable("rollout_identity_mismatch");
        if (value.history_base || value.forked_from_id || (row.ordinal !== undefined && row.ordinal !== 0)
          || (value.history_mode && !["full", "paginated"].includes(value.history_mode))) throw unavailable("incomplete_rollout");
        metadata = true;return;
      }
      if (row.type === "session_meta" || (row.type === "event_msg" && /rollback|rolled_back|rewind|history_reset|context_reset/.test(value?.type || ""))) {
        throw unavailable("unsupported_history_change");
      }
      if (row.type === "compacted" || row.type === "response_item") {
        const candidates = row.type === "compacted" ? value?.replacement_history : [value];
        if (Array.isArray(candidates) && candidates.some(item => item?.type === "compaction" && item.encrypted_content === ciphertext)) {
          matched = true;return;
        }
      }
      if (row.type === "response_item") {
        const item = plaintext(value);
        if (item) items.push(item);
      }
    };
    for await (const chunk of stream) {
      check();budget.remaining -= chunk.length;bytesRead += chunk.length;
      if (budget.remaining < 0) throw unavailable("rollout_read_limit");
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        parts.push(part);length += part.length;
        if (end < 0) break;
        record(Buffer.concat(parts, length));parts = [];length = 0;
        if (matched) return { items, bytes: bytesRead };
        start = end + 1;
      }
    }
    if (length) record(Buffer.concat(parts, length));
    return matched ? { items, bytes: bytesRead } : null;
  } finally {
    stream?.destroy();raw?.destroy();await handle.close();
  }
}

function joinHistory(source, input, compactionIndex, check) {
  if (!source.length || !source.some(item => item.type === "message" && item.role === "user")) throw unavailable("incomplete_rollout");
  const signatures = source.map(fingerprint);
  let cursor = 0;
  const instructions = [];
  for (const original of input.slice(0, compactionIndex)) {
    check();
    const item = plaintext(original);
    if (!item) continue;
    const match = signatures.indexOf(fingerprint(item), cursor);
    if (match >= 0) cursor = match + 1;
    else if (item.type === "message" && ["system", "developer"].includes(item.role)) instructions.push(item);
    else throw unavailable("retained_prefix_mismatch");
  }
  const suffix = input.slice(compactionIndex + 1).map(plaintext).filter(Boolean);
  const items = [...source, ...instructions, ...suffix];
  const calls = new Map();
  for (const item of items) {
    check();
    if (CALLS.has(item.type)) {
      if (!item.call_id || calls.has(item.call_id)) throw unavailable("invalid_tool_pairs");
      calls.set(item.call_id, { type: CALLS.get(item.type), completed: false });
    } else if ([...CALLS.values()].includes(item.type)) {
      const call = calls.get(item.call_id);
      if (!call || call.type !== item.type || call.completed) throw unavailable("invalid_tool_pairs");
      call.completed = true;
    }
  }
  if ([...calls.values()].some(call => !call.completed)) throw unavailable("invalid_tool_pairs");
  return { items, currentInputStart: source.length + instructions.length };
}

// Loaded only after a confirmed provider ownership rejection, never on startup
// or healthy requests. It cannot serve remote/browser callers or mutate logs.
export async function recoverLocalCompaction(reqContext, { request, env = process.env,
  signal, assertActive, reserveHistory, maxBytes, timeoutMs = 5000 } = {}) {
  const started = Date.now();
  const check = () => {
    assertActive?.();
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    if (Date.now() - started > timeoutMs) throw unavailable("rollout_read_timeout");
  };
  check();
  if (isLanAllowed(env) || !isLoopbackAddress(request?.socket?.remoteAddress)
    || !isLoopbackHostHeader(request?.headers?.host) || request?.headers?.origin !== undefined) {
    throw unavailable("local_request_required");
  }
  const id = threadId(request, reqContext.body);
  const input = reqContext.body?.input;
  const compactions = Array.isArray(input) ? input.filter(item => item?.type === "compaction" && item.encrypted_content) : [];
  if (compactions.length !== 1) throw unavailable("multiple_compactions");
  if (typeof compactions[0].encrypted_content !== "string") throw unavailable("invalid_compaction");
  const limit = maxBytes ?? decodedBodyLimitPreference({ env }).bytes;
  let release, transferred = false;
  try {
    release = await reserveHistory?.(limit, { signal });
    check();
    const directory = await fs.realpath(codexPaths({ env }).directory);
    const files = await candidateFiles(directory, id, check);
    const budget = { remaining: limit };
    let source;
    for (const file of files) {
      check();
      const candidate = await readPrefix(file, directory, id, compactions[0].encrypted_content, budget, check, signal);
      if (!candidate) continue;
      if (source) throw unavailable("ambiguous_rollout");
      source = candidate;
    }
    if (!source) throw unavailable("matching_rollout_missing");
    const restored = joinHistory(source.items, input, input.indexOf(compactions[0]), check);
    const body = { ...reqContext.body, input: restored.items };
    delete body.previous_response_id;
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));
    if (bodyBytes > limit) throw unavailable("restored_payload_limit");
    release?.resize?.(bodyBytes);
    const currentItems = new Set(body.input.slice(restored.currentInputStart));
    const prepared = prepareResponsesRequest(body, { mutate: true, copilotBoundary: false, assertActive: check });
    const currentInputStart = prepared.body.input.findIndex(item => currentItems.has(item));
    prepared.currentInputStart = currentInputStart < 0 ? prepared.body.input.length : currentInputStart;
    prepared.surface = reqContext.surface;
    prepared.routePlan = reqContext.routePlan;
    transferred = true;
    return { reqContext: prepared, releasePreparation: release, recovery: { source: "local_codex_rollout", restored_items: restored.items.length,
      compaction_items_removed: 1, reasoning_items_removed: input.filter(item => item?.type === "reasoning").length,
      source_bytes: source.bytes } };
  } finally { if (!transferred) release?.(); }
}
