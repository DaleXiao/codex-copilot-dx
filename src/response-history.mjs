import { httpError } from "./http-transport.mjs";
import { clearResponsesToolOutputPartsCache } from "./responses-content.mjs";
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
const pinnedTrees = new Map();
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

function pinTree(rootId) {
  if (!rootId) return;
  pinnedTrees.set(rootId, (pinnedTrees.get(rootId) || 0) + 1);
}

function unpinTree(rootId) {
  const count = pinnedTrees.get(rootId) || 0;
  if (count <= 1) pinnedTrees.delete(rootId);
  else pinnedTrees.set(rootId, count - 1);
}

function treeIsPinned(rootId) {
  return (pinnedTrees.get(rootId) || 0) > 0;
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

function subtreeUsage(rootId) {
  const pending = [rootId];
  const seen = new Set();
  let bytes = 0;
  let entries = 0;
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = histories.get(id);
    if (entry) {
      entries += 1;
      bytes += entry.bytes;
    }
    const children = childrenById.get(id);
    if (children) pending.push(...children);
  }
  return { bytes, entries };
}

function makeRoomFor({ additionalBytes, additionalEntries, protectedRoots }) {
  let projectedBytes = totalBytes + additionalBytes;
  let projectedEntries = histories.size + additionalEntries;
  if (projectedEntries <= maxEntries && projectedBytes <= maxBytes) return true;

  const candidates = [];
  for (const rootId of treeLru.keys()) {
    if (protectedRoots.has(rootId) || treeIsPinned(rootId)) continue;
    const usage = subtreeUsage(rootId);
    candidates.push(rootId);
    projectedBytes -= usage.bytes;
    projectedEntries -= usage.entries;
    if (projectedEntries <= maxEntries && projectedBytes <= maxBytes) break;
  }
  if (projectedEntries > maxEntries || projectedBytes > maxBytes) return false;
  for (const rootId of candidates) removeSubtree(rootId);
  return true;
}

export function clearResponseHistoryForTests() {
  histories.clear();
  childrenById.clear();
  treeLru.clear();
  pinnedTrees.clear();
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

export function responseHistoryRootId(responseId) {
  return histories.get(responseId)?.rootId || null;
}

function responseHistoryChain(responseId) {
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
  return { chain, rootId: chain[0]?.rootId };
}

export function responseHistoryMaterializedBytes(responseId) {
  const { chain } = responseHistoryChain(responseId);
  return chain.reduce((bytes, entry) => bytes + entry.bytes, 0);
}

export function acquireResponseHistorySnapshot(responseId, { assertActive, signal } = {}) {
  assertActive?.();
  if (signal?.aborted) throw signal.reason || new DOMException("The operation was aborted", "AbortError");
  const { chain, rootId } = responseHistoryChain(responseId);
  const entries = chain.slice().reverse();
  const bytes = chain.reduce((total, entry) => total + entry.bytes, 0);
  pinTree(rootId);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", release);
    unpinTree(rootId);
  };
  signal?.addEventListener("abort", release, { once: true });

  return Object.freeze({
    responseId,
    rootId,
    bytes,
    materialize({ assertActive: assertSnapshotActive, routeMetadata } = {}) {
      assertSnapshotActive?.();
      if (released) throw new Error("Response history snapshot has been released");
      const items = [];
      for (let index = 0; index < entries.length; index += 1) {
        if ((index & 63) === 0) assertSnapshotActive?.();
        const entry = entries[index];
        routeMetadata?.push({
          affinity: entry.routeAffinity || null,
          hasOpaque: entry.hasOpaque === true,
        });
        items.push(...entry.inputItems, ...entry.outputItems);
      }
      assertSnapshotActive?.();
      const materialized = cloneJson(items);
      assertSnapshotActive?.();
      touchTree(rootId);
      return materialized;
    },
    release,
  });
}

export function materializeResponseHistory(responseId, { assertActive, routeMetadata } = {}) {
  assertActive?.();
  const { chain, rootId } = responseHistoryChain(responseId);
  const items = [];
  for (let index = 0; index < chain.length; index += 1) {
    if ((index & 63) === 0) assertActive?.();
    const entry = chain[chain.length - index - 1];
    routeMetadata?.push({
      affinity: entry.routeAffinity || null,
      hasOpaque: entry.hasOpaque === true,
    });
    items.push(...entry.inputItems, ...entry.outputItems);
  }
  assertActive?.();
  const materialized = cloneJson(items);
  assertActive?.();
  touchTree(rootId);
  return materialized;
}

export function rememberResponseHistoryNode({
  id,
  parentId,
  inputItems,
  outputItems,
  hasOpaque = false,
  routeAffinity = null,
  takeOwnership = false,
}) {
  if (!id || !Array.isArray(inputItems)) return false;
  const existing = histories.get(id);
  const parentEntry = parentId ? histories.get(parentId) : null;
  if (parentId && !parentEntry) {
    if (!existing) rememberEvictedId(id);
    return false;
  }
  clearResponsesToolOutputPartsCache(inputItems);
  clearResponsesToolOutputPartsCache(outputItems);
  const historyValue = routeAffinity
    ? [inputItems, outputItems, { routeAffinity, hasOpaque: hasOpaque === true }]
    : [inputItems, outputItems];
  const bytes = jsonByteLength(historyValue);
  if (bytes > maxBytes) {
    if (!existing) rememberEvictedId(id);
    else if (!treeIsPinned(existing.rootId)) removeSubtree(id);
    return false;
  }
  const rootId = parentEntry?.rootId || id;
  const entry = {
    parentId: parentId || null,
    rootId,
    inputItems: takeOwnership ? inputItems : cloneJson(inputItems),
    outputItems: takeOwnership ? outputItems : cloneJson(outputItems),
    hasOpaque: hasOpaque === true,
    routeAffinity: routeAffinity ? cloneJson(routeAffinity) : null,
    bytes,
  };
  const oldRootId = existing?.rootId;
  const protectedRoots = new Set([rootId]);
  if (oldRootId) protectedRoots.add(oldRootId);
  if (!makeRoomFor({
    additionalBytes: bytes - (existing?.bytes || 0),
    additionalEntries: existing ? 0 : 1,
    protectedRoots,
  })) {
    if (!existing) {
      if (parentEntry && !treeIsPinned(rootId)) removeSubtree(rootId);
      rememberEvictedId(id);
    }
    return false;
  }
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
  return true;
}
