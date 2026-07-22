import { httpError } from "./http-transport.mjs";
import { loadRuntimeConfig, parsePositiveInteger, RUNTIME_DEFAULTS } from "./runtime-config.mjs";

const DEFAULT_MAX_BYTES = RUNTIME_DEFAULTS.responseHistoryMaxBytes;
const DEFAULT_MAX_ENTRIES = RUNTIME_DEFAULTS.responseHistoryMaxEntries;

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
const treeLru = new Map();
const evictedIds = new Set();
let totalBytes = 0;
const HISTORY_RUNTIME_CONFIG = loadRuntimeConfig();
let maxBytes = HISTORY_RUNTIME_CONFIG.responseHistoryMaxBytes;
let maxEntries = HISTORY_RUNTIME_CONFIG.responseHistoryMaxEntries;

function rememberEvictedId(id) {
  evictedIds.add(id);
  while (evictedIds.size > 256) evictedIds.delete(evictedIds.values().next().value);
}

function touchTree(rootId) {
  if (!rootId) return;
  treeLru.delete(rootId);
  treeLru.set(rootId, true);
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
  const affectedRoots = new Set();
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
    affectedRoots.add(entry.rootId);
    unlinkChild(entry.parentId, id);
    childrenById.delete(id);
    totalBytes -= entry.bytes;
    histories.delete(id);
    rememberEvictedId(id);
  }
  for (const affectedRoot of affectedRoots) {
    const entry = histories.get(affectedRoot);
    if (!entry || entry.rootId !== affectedRoot) treeLru.delete(affectedRoot);
  }
  if (!histories.has(rootId)) treeLru.delete(rootId);
}

function assignSubtreeRoot(id, rootId) {
  const pending = [id];
  const seen = new Set();
  while (pending.length) {
    const currentId = pending.pop();
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    const entry = histories.get(currentId);
    if (entry) entry.rootId = rootId;
    const children = childrenById.get(currentId);
    if (children) pending.push(...children);
  }
}

function enforceLimits() {
  while (histories.size > maxEntries || totalBytes > maxBytes) {
    const oldestRootId = treeLru.keys().next().value;
    if (!oldestRootId) break;
    removeSubtree(oldestRootId);
  }
}

export function clearResponseHistoryForTests() {
  histories.clear();
  childrenById.clear();
  treeLru.clear();
  evictedIds.clear();
  totalBytes = 0;
  maxBytes = DEFAULT_MAX_BYTES;
  maxEntries = DEFAULT_MAX_ENTRIES;
}

export function configureResponseHistoryForTests({ maxBytes: nextMaxBytes, maxEntries: nextMaxEntries } = {}) {
  if (nextMaxBytes !== undefined) maxBytes = parsePositiveInteger(nextMaxBytes, DEFAULT_MAX_BYTES);
  if (nextMaxEntries !== undefined) maxEntries = parsePositiveInteger(nextMaxEntries, DEFAULT_MAX_ENTRIES);
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
  const rootId = chain[0]?.rootId;
  const items = [];
  for (const entry of chain.reverse()) items.push(...entry.inputItems, ...entry.outputItems);
  const materialized = cloneJson(items);
  touchTree(rootId);
  return materialized;
}

export function rememberResponseHistoryNode({ id, parentId, inputItems, outputItems, takeOwnership = false }) {
  if (!id || !Array.isArray(inputItems)) return;
  const bytes = jsonByteLength([inputItems, outputItems]);
  if (bytes > maxBytes) {
    if (histories.has(id)) removeSubtree(id);
    rememberEvictedId(id);
    return;
  }
  const existing = histories.get(id);
  const parentEntry = parentId ? histories.get(parentId) : null;
  const rootId = parentEntry?.rootId || (parentId ? existing?.rootId : id) || id;
  const entry = {
    parentId: parentId || null,
    rootId,
    inputItems: takeOwnership ? inputItems : cloneJson(inputItems),
    outputItems: takeOwnership ? outputItems : cloneJson(outputItems),
    bytes,
  };
  const oldRootId = existing?.rootId;
  if (existing) {
    totalBytes -= existing.bytes;
    unlinkChild(existing.parentId, id);
  }
  histories.set(id, entry);
  linkChild(entry.parentId, id);
  if (oldRootId && oldRootId !== rootId) {
    assignSubtreeRoot(id, rootId);
    const oldRoot = histories.get(oldRootId);
    if (!oldRoot || oldRoot.rootId !== oldRootId) treeLru.delete(oldRootId);
  }
  totalBytes += entry.bytes;
  evictedIds.delete(id);
  touchTree(rootId);
  enforceLimits();
}
