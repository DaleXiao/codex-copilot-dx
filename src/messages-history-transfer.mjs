import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { accessSettingsPath } from "./access-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";

const grants = new WeakMap(), HASH = /^[a-f0-9]{64}$/, LIMIT = 1024;
const digest = value => createHash("sha256").update(JSON.stringify(value, (key, entry) => key === "cache_control" ? undefined : entry)).digest("hex");
const parts = message => Array.isArray(message?.content) ? message.content : [];
const thinking = part => ["thinking", "redacted_thinking", "reasoning"].includes(part?.type);
const history = body => body.messages.some(message => message?.role === "assistant" || parts(message).some(part => part?.type === "tool_result"))
  || body.messages.filter(message => message?.role === "user").length > 1;
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
const invalidState = () => fail("ccdx_history_transfer_state_invalid", "History transfer records could not be read. Existing records and conversation were kept.");

// Only a locally prepared request can carry this grant; HTTP fields cannot set it.
export const messagesHistoryTransferGrant = body => grants.get(body);
export function messagesTransferPath(options = {}) {
  return path.join(path.dirname(accessSettingsPath(options)), "conversation-transfers.json");
}
function checkedRecords(value) {
  if (!value || value.version !== 1 || !value.records || typeof value.records !== "object" || Array.isArray(value.records)
    || Object.keys(value).some(key => !["version", "records"].includes(key)) || Object.keys(value.records).length > LIMIT) invalidState();
  for (const [key, record] of Object.entries(value.records)) {
    if (!HASH.test(key) || !record || Object.keys(record).some(key => !["owner", "count", "prefix"].includes(key))
      || !HASH.test(record.owner) || !HASH.test(record.prefix) || !Number.isSafeInteger(record.count) || record.count < 1 || record.count > 1_000_000) invalidState();
  }
  return value.records;
}
function checkBlocks(blocks) {
  for (const part of blocks) {
    if (thinking(part)) continue;
    if (!part || !["text", "image", "document", "tool_use", "tool_result", "tool_reference"].includes(part.type)) {
      fail("ccdx_history_transfer_content_unsupported", "This content cannot be transferred safely. The original conversation was kept.");
    }
    const stack = [part];
    while (stack.length) {
      const value = stack.pop();if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) { for (const child of value) stack.push(child);continue; }
      if (["file_id", "container_id", "encrypted_content", "previous_response_id"].some(key => Object.hasOwn(value, key))
        || ["compaction", "item_reference"].includes(value.type)) {
        fail("ccdx_history_transfer_rebuild_required", "Restore the original messages or attachment before switching. Source-owned state cannot be transferred.");
      }
      for (const [key, child] of Object.entries(value)) if (key !== "input") stack.push(child);
    }
    if (part.type === "tool_result" && Array.isArray(part.content)) checkBlocks(part.content);
  }
}
function checkHistory(body, counting) {
  if (body.previous_response_id || body.conversation || body.container) {
    fail("ccdx_history_transfer_rebuild_required", "Restore complete message history before switching. The original conversation was kept.");
  }
  const pending = new Set();
  for (const message of body.messages) {
    if (!message || !["user", "assistant"].includes(message.role) || !(typeof message.content === "string" || Array.isArray(message.content))) {
      fail("ccdx_history_transfer_invalid", "Message history is incomplete or invalid. The original conversation was kept.");
    }
    if (message.role === "assistant" && pending.size) fail("ccdx_history_transfer_tool_incomplete", "Finish the current tool operation before switching. No tool was repeated.");
    checkBlocks(parts(message));
    for (const part of parts(message)) {
      if (part.type === "tool_use") {
        if (message.role !== "assistant" || typeof part.id !== "string" || pending.has(part.id)) fail("ccdx_history_transfer_tool_incomplete", "Tool history is incomplete. Finish the current operation before switching.");
        pending.add(part.id);
      }
      if (part.type === "tool_result" && (message.role !== "user" || !pending.delete(part.tool_use_id))) {
        fail("ccdx_history_transfer_tool_incomplete", "A tool result has no matching call. Restore complete history before switching.");
      }
    }
  }
  if (!counting && (pending.size || parts(body.messages.at(-1)).some(part => ["tool_use", "tool_result"].includes(part.type)))) {
    fail("ccdx_history_transfer_tool_incomplete", "Finish the current tool operation before switching. No tool was repeated.");
  }
}
function project(body, count) {
  let removed = 0;
  body.messages = body.messages.map((message, index) => {
    if (index >= count || message.role !== "assistant") return message;
    const out = { ...message };delete out.reasoning_content;
    if (Array.isArray(message.content)) {
      out.content = message.content.filter(part => { if (!thinking(part)) return true;removed++;return false; });
      if (!out.content.length) return null;
    }
    return out;
  }).filter(Boolean);
  return removed;
}

// Caller selects eligible clients. This module knows only Messages and source
// fingerprints; it neither changes routing nor stores conversation contents.
export function createMessagesHistoryTransfer(options = {}) {
  const file = messagesTransferPath(options), active = new Map();let records;
  function read() {
    try { return checkedRecords(JSON.parse(readBoundedFileSync(file, { encoding: "utf8", maxBytes: 512 * 1024 }))); }
    catch (error) { if (error.code === "ENOENT") return {};invalidState(); }
  }
  function save(key, record) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    withFileLockSync(`${file}.lock`, () => {
      const next = read();delete next[key];next[key] = record;
      while (Object.keys(next).length > LIMIT) delete next[Object.keys(next)[0]];
      atomicWriteFileSync(file, JSON.stringify({ version: 1, records: next }) + "\n", { mode: 0o600 });records = next;
    });
  }
  return { prepare({ key, owner, previousOwner, profile, body, countTokens = false, knownOwners = [] }) {
    if (!Array.isArray(body?.messages) || body.input !== undefined) return null;
    records ||= read();const entry = records[key], changed = entry ? entry.owner !== owner : Boolean(previousOwner && previousOwner !== owner);
    const initial = knownOwners.includes(entry?.owner || previousOwner);
    const hasHistory = history(body), noncommitting = countTokens || Boolean(changed || entry) && !hasHistory;
    if (noncommitting) {
      if (changed || entry) {
        checkHistory(body, true);
        const count = entry?.owner === owner && body.messages.length >= entry.count && digest(body.messages.slice(0, entry.count)) === entry.prefix
          ? entry.count : body.messages.length;
        project(body, count);
      }
      grants.set(body, { profile, noncommitting: true, initial });
      let toolLease, committed = false;
      return { handled: true, commit(state) {
        // A no-history model probe must not pin the conversation. An actual
        // tool call must: its following results continue this very same turn.
        if (countTokens || !state?.tool || committed) return;
        const lease = active.get(key);
        if (lease && lease.owner !== owner) fail("ccdx_history_transfer_busy", "Wait for the current response to finish before switching sources.");
        save(key, { owner, count: body.messages.length, prefix: digest(body.messages) });committed = true;
        toolLease = lease || { owner, count: 0 };toolLease.count++;active.set(key, toolLease);
      }, release() {
        grants.delete(body);if (toolLease && --toolLease.count === 0) active.delete(key);toolLease = null;
      } };
    }
    const lease = active.get(key);
    if (lease && lease.owner !== owner) fail("ccdx_history_transfer_busy", "Wait for the current response to finish before switching sources.");
    let candidate = null, removed = 0;
    if (changed || entry) {
      let count;
      if (!changed && body.messages.length >= entry.count && digest(body.messages.slice(0, entry.count)) === entry.prefix) count = entry.count;
      else {
        checkHistory(body, false);count = body.messages.length;candidate = { owner, count, prefix: digest(body.messages) };
      }
      removed = project(body, count);grants.set(body, { profile, noncommitting: false, initial });
    }
    const current = lease || { owner, count: 0 };current.count++;active.set(key, current);
    let released = false, committed = false;
    return { handled: Boolean(changed || entry), commit() {
      if (committed || released) return;
      if (candidate) save(key, candidate);
      committed = true;
      if (candidate && changed) options.onTransfer?.({ removed_thinking: removed });
    }, release() {
      if (released) return;released = true;grants.delete(body);
      if (--current.count === 0) active.delete(key);
    } };
  } };
}
