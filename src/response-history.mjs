import { httpError } from "./http-transport.mjs";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 4096;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonStringByteLength(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code) ? 2 : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function jsonByteLength(value, seen = new Set()) {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringByteLength(value);
  if (typeof value === "number") return Buffer.byteLength(JSON.stringify(value));
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Circular response history value");
    seen.add(value);
    let bytes = 2 + Math.max(0, value.length - 1);
    for (const item of value) {
      bytes += item === undefined || typeof item === "function" || typeof item === "symbol"
        ? 4
        : jsonByteLength(item, seen);
    }
    seen.delete(value);
    return bytes;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Circular response history value");
    seen.add(value);
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol");
    let bytes = 2 + Math.max(0, entries.length - 1);
    for (const [key, item] of entries) bytes += jsonStringByteLength(key) + 1 + jsonByteLength(item, seen);
    seen.delete(value);
    return bytes;
  }
  return 4;
}

const histories = new Map();
const childrenById = new Map();
const evictedIds = new Set();
let totalBytes = 0;
let maxBytes = positiveInt(process.env.CCDX_RESPONSE_HISTORY_MAX_BYTES, DEFAULT_MAX_BYTES);
let maxEntries = positiveInt(process.env.CCDX_RESPONSE_HISTORY_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);

function rememberEvictedId(id) {
  evictedIds.add(id);
  while (evictedIds.size > 256) evictedIds.delete(evictedIds.values().next().value);
}

function linkChild(parentId, id) {
  if (!parentId) return;
  let children = childrenById.get(parentId);
  if (!children) {
    children = new Set();
    childrenById.set(parentId, children);
  }
  children.add(id);
}

function unlinkChild(parentId, id) {
  if (!parentId) return;
  const children = childrenById.get(parentId);
  if (!children) return;
  children.delete(id);
  if (!children.size) childrenById.delete(parentId);
}

function removeSubtree(rootId) {
  const pending = [rootId];
  const removed = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (removed.has(id)) continue;
    removed.add(id);
    const children = childrenById.get(id);
    if (children) pending.push(...children);
  }
  for (const id of removed) {
    const entry = histories.get(id);
    if (!entry) continue;
    unlinkChild(entry.parentId, id);
    childrenById.delete(id);
    totalBytes -= entry.bytes;
    histories.delete(id);
    rememberEvictedId(id);
  }
}

function enforceLimits() {
  while (histories.size > maxEntries || totalBytes > maxBytes) {
    const oldestId = histories.keys().next().value;
    if (!oldestId) break;
    removeSubtree(oldestId);
  }
}

export function clearResponseHistoryForTests() {
  histories.clear();
  childrenById.clear();
  evictedIds.clear();
  totalBytes = 0;
  maxBytes = DEFAULT_MAX_BYTES;
  maxEntries = DEFAULT_MAX_ENTRIES;
}

export function configureResponseHistoryForTests({ maxBytes: nextMaxBytes, maxEntries: nextMaxEntries } = {}) {
  if (nextMaxBytes !== undefined) maxBytes = positiveInt(nextMaxBytes, DEFAULT_MAX_BYTES);
  if (nextMaxEntries !== undefined) maxEntries = positiveInt(nextMaxEntries, DEFAULT_MAX_ENTRIES);
}

export function responseHistoryStats() {
  return { entries: histories.size, bytes: totalBytes, evicted: evictedIds.size };
}

export function materializeResponseHistory(responseId) {
  const chain = [];
  const seen = new Set();
  let currentId = responseId;
  while (currentId) {
    if (seen.has(currentId)) throw httpError(`Cycle detected in local response history: ${currentId}`, 500);
    seen.add(currentId);
    const entry = histories.get(currentId);
    if (!entry) {
      const reason = evictedIds.has(currentId) ? " was evicted after reaching the local history limit" : " is not available";
      throw httpError(`previous_response_id${reason}: ${currentId}`, 400);
    }
    chain.push(entry);
    currentId = entry.parentId;
  }
  const items = [];
  for (const entry of chain.reverse()) items.push(...entry.inputItems, ...entry.outputItems);
  return cloneJson(items);
}

export function rememberResponseHistoryNode({ id, parentId, inputItems, outputItems, takeOwnership = false }) {
  if (!id || !Array.isArray(inputItems)) return;
  const bytes = jsonByteLength([inputItems, outputItems]);
  if (bytes > maxBytes) {
    if (histories.has(id)) removeSubtree(id);
    rememberEvictedId(id);
    return;
  }
  const entry = {
    parentId: parentId || null,
    inputItems: takeOwnership ? inputItems : cloneJson(inputItems),
    outputItems: takeOwnership ? outputItems : cloneJson(outputItems),
    bytes,
  };
  const existing = histories.get(id);
  if (existing) {
    totalBytes -= existing.bytes;
    unlinkChild(existing.parentId, id);
  }
  histories.set(id, entry);
  linkChild(entry.parentId, id);
  totalBytes += entry.bytes;
  evictedIds.delete(id);
  enforceLimits();
}
