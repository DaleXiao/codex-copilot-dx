import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { accessSettingsPath } from "./access-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFilePairSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";

const grants = new WeakMap(), HASH = /^[a-f0-9]{64}$/, LIMIT = 1024;
const digest = value => createHash("sha256").update(JSON.stringify(value, (key, entry) => key === "cache_control" ? undefined : entry)).digest("hex");
const semanticDigest = value => createHash("sha256").update(JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest("hex");
const parts = message => Array.isArray(message?.content) ? message.content : [];
const thinking = part => ["thinking", "redacted_thinking", "reasoning"].includes(part?.type);
const history = body => body.messages.some(message => message?.role === "assistant" || parts(message).some(part => part?.type === "tool_result"))
  || body.messages.filter(message => message?.role === "user").length > 1;
const fail = (code, message, reason) => { throw Object.assign(new Error(message), { code, statusCode: 409,
  ...(reason ? { jsonBody: { type: "error", error: { type: "invalid_request_error", code, message, reason } } } : {}) }); };
const invalidState = () => fail("ccdx_history_transfer_state_invalid", "History transfer records could not be read. Existing records and conversation were kept.");

// Only a locally prepared request can carry this grant; HTTP fields cannot set it.
export const messagesHistoryTransferGrant = body => {
  const grant = grants.get(body);return grant?.active ? grant : undefined;
};
export function messagesTransferPath(options = {}) {
  return path.join(path.dirname(accessSettingsPath(options)), "conversation-transfers.json");
}
function checkedRecords(value, canonical = false) {
  if (!value || value.version !== 1 || !value.records || typeof value.records !== "object" || Array.isArray(value.records)
    || Object.keys(value).some(key => !["version", "records"].includes(key)) || Object.keys(value.records).length > LIMIT) invalidState();
  for (const [key, record] of Object.entries(value.records)) {
    if (!HASH.test(key) || !record || Object.keys(record).some(key => !(canonical ? ["owner", "count", "prefix", "raw_count", "raw_prefix"] : ["owner", "count", "prefix"]).includes(key))
      || !HASH.test(record.owner) || !HASH.test(record.prefix) || !Number.isSafeInteger(record.count) || record.count < 1 || record.count > 1_000_000) invalidState();
    if (canonical && (!HASH.test(record.raw_prefix) || !Number.isSafeInteger(record.raw_count) || record.raw_count < 1 || record.raw_count > 1_000_000)) invalidState();
  }
  return value.records;
}
function canonicalBlock(block) {
  if (!block || typeof block !== "object") return block;
  const { cache_control, ...value } = block;
  if (block.type === "tool_result" && Array.isArray(block.content)) value.content = block.content.map(canonicalBlock);
  return value;
}
function canonicalItems(messages) {
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || !["user", "assistant"].includes(message.role)) fail("ccdx_history_transfer_invalid", "Message history is incomplete or invalid.");
    const { content, cache_control, ...fields } = message;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    if (!Array.isArray(blocks)) fail("ccdx_history_transfer_invalid", "Message history is incomplete or invalid.");
    for (const block of blocks.length ? blocks : [null]) out.push({ ...fields, block: canonicalBlock(block) });
  }
  return out;
}
function checkpoint(owner, messages) {
  const items = canonicalItems(messages), raw = { owner, count: messages.length, prefix: digest(messages) };
  return { raw, canonical: { owner, count: items.length, prefix: semanticDigest(items), raw_count: raw.count, raw_prefix: raw.prefix } };
}
function knownPrefix(entry, messages, items) {
  if (entry.canonical) return items.length >= entry.canonical.count
    && semanticDigest(items.slice(0, entry.canonical.count)) === entry.canonical.prefix ? { count: entry.canonical.count } : null;
  if (messages.length < entry.count) return null;
  const prefix = messages.slice(0, entry.count);
  const forms = [prefix,
    prefix.map(message => typeof message.content === "string" ? { ...message, content: [{ type: "text", text: message.content }] } : message),
    prefix.map(message => Array.isArray(message.content) && message.content.length === 1 && message.content[0]?.type === "text"
      && Object.keys(message.content[0]).every(key => ["type", "text"].includes(key)) ? { ...message, content: message.content[0].text } : message)];
  if (!forms.some(form => digest(form) === entry.prefix)) return null;
  const migrated = checkpoint(entry.owner, prefix);return { count: migrated.canonical.count, migrated };
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
    if (message.role === "assistant" && pending.size) fail("ccdx_history_transfer_tool_incomplete", "Finish the current tool operation before switching. No tool was repeated.", "tool_call_pending");
    checkBlocks(parts(message));
    for (const part of parts(message)) {
      if (part.type === "tool_use") {
        if (message.role !== "assistant" || typeof part.id !== "string" || pending.has(part.id)) fail("ccdx_history_transfer_tool_incomplete", "Tool history is incomplete. Finish the current operation before switching.", "tool_history_invalid");
        pending.add(part.id);
      }
      if (part.type === "tool_result" && (message.role !== "user" || !pending.delete(part.tool_use_id))) {
        fail("ccdx_history_transfer_tool_incomplete", "A tool result has no matching call. Restore complete history before switching.", "tool_result_unmatched");
      }
    }
  }
  if (!counting && (pending.size || parts(body.messages.at(-1)).some(part => ["tool_use", "tool_result"].includes(part.type)))) {
    fail("ccdx_history_transfer_tool_incomplete", "Finish the current tool operation before switching. No tool was repeated.", pending.size ? "tool_call_pending" : "active_tool_turn");
  }
}
function project(body, count) {
  let removed = 0, index = 0;
  body.messages = body.messages.map(message => {
    const start = index;index += Array.isArray(message.content) ? Math.max(1, message.content.length) : 1;
    if (start >= count || message.role !== "assistant") return message;
    const out = { ...message };delete out.reasoning_content;
    if (Array.isArray(message.content)) {
      out.content = message.content.filter((part, offset) => { if (start + offset >= count || !thinking(part)) return true;removed++;return false; });
      if (!out.content.length) return null;
    }
    return out;
  }).filter(Boolean);
  return removed;
}

// Caller selects eligible clients. This module knows only Messages and source
// fingerprints; it neither changes routing nor stores conversation contents.
export function createMessagesHistoryTransfer(options = {}) {
  const file = messagesTransferPath(options), canonicalFile = path.join(path.dirname(file), "conversation-prefixes.json"), active = new Map();let records;
  function readFile(target, canonical = false) {
    try { return checkedRecords(JSON.parse(readBoundedFileSync(target, { encoding: "utf8", maxBytes: 512 * 1024 })), canonical); }
    catch (error) { if (error.code === "ENOENT") return {};invalidState(); }
  }
  function read() {
    const raw = readFile(file), canonical = readFile(canonicalFile, true);
    return Object.fromEntries(Object.entries(raw).map(([key, record]) => [key, { ...record,
      ...(canonical[key]?.owner === record.owner && canonical[key].raw_count === record.count && canonical[key].raw_prefix === record.prefix ? { canonical: canonical[key] } : {}) }]));
  }
  function save(key, record) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    withFileLockSync(`${file}.lock`, () => {
      const next = read();delete next[key];next[key] = { ...record.raw, canonical: record.canonical };
      while (Object.keys(next).length > LIMIT) delete next[Object.keys(next)[0]];
      const raw = Object.fromEntries(Object.entries(next).map(([key, { canonical, ...value }]) => [key, value]));
      const canonical = Object.fromEntries(Object.entries(next).filter(([, value]) => value.canonical).map(([key, value]) => [key, value.canonical]));
      checkedRecords({ version: 1, records: raw });checkedRecords({ version: 1, records: canonical }, true);
      atomicWriteFilePairSync(file, JSON.stringify({ version: 1, records: raw }) + "\n", canonicalFile, JSON.stringify({ version: 1, records: canonical }) + "\n");records = next;
    });
  }
  return { prepare({ key, owner, previousOwner, profile, body, countTokens = false, knownOwners = [] }) {
    if (!Array.isArray(body?.messages) || body.input !== undefined) return null;
    records ||= read();const entry = records[key], changed = entry ? entry.owner !== owner : Boolean(previousOwner && previousOwner !== owner);
    const initial = knownOwners.includes(entry?.owner || previousOwner);
    const hasHistory = history(body), noncommitting = countTokens || Boolean(changed || entry) && !hasHistory;
    const items = changed || entry ? canonicalItems(body.messages) : null;
    if (noncommitting) {
      if (changed || entry) {
        checkHistory(body, true);
        const count = entry?.owner === owner ? knownPrefix(entry, body.messages, items)?.count ?? items.length : items.length;
        project(body, count);
      }
      const grant = { profile, noncommitting: true, initial, active: true };grants.set(body, grant);
      const nextCheckpoint = countTokens ? null : checkpoint(owner, body.messages);
      let toolLease, committed = false;
      return { handled: true, commit(state) {
        // A no-history model probe must not pin the conversation. An actual
        // tool call must: its following results continue this very same turn.
        if (countTokens || !state?.tool || committed) return;
        const lease = active.get(key);
        if (lease && lease.owner !== owner) fail("ccdx_history_transfer_busy", "Wait for the current response to finish before switching sources.");
        save(key, nextCheckpoint);committed = true;
        toolLease = lease || { owner, count: 0 };toolLease.count++;active.set(key, toolLease);
      }, release() {
        grant.active = false;if (toolLease && --toolLease.count === 0) active.delete(key);toolLease = null;
      } };
    }
    const lease = active.get(key);
    if (lease && lease.owner !== owner) fail("ccdx_history_transfer_busy", "Wait for the current response to finish before switching sources.");
    let candidate = null, removed = 0, grant;
    if (changed || entry) {
      let count;
      const known = !changed ? knownPrefix(entry, body.messages, items) : null;
      if (known) { count = known.count;candidate = known.migrated || null; }
      else {
        try { checkHistory(body, false); } catch (error) {
          if (error.jsonBody?.error?.reason) error.jsonBody.error.reason = `${changed ? "source_changed" : "prefix_changed"}_${error.jsonBody.error.reason}`;
          throw error;
        }
        count = items.length;candidate = checkpoint(owner, body.messages);
      }
      removed = project(body, count);grant = { profile, noncommitting: false, initial, active: true };grants.set(body, grant);
    }
    const current = lease || { owner, count: 0 };current.count++;active.set(key, current);
    let released = false, committed = false;
    return { handled: Boolean(changed || entry), commit() {
      if (committed || released) return;
      if (candidate) save(key, candidate);
      committed = true;
      if (candidate && changed) options.onTransfer?.({ removed_thinking: removed });
    }, release() {
      if (released) return;released = true;if (grant) grant.active = false;
      if (--current.count === 0) active.delete(key);
    } };
  } };
}
