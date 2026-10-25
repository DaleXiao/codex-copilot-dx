import { httpError } from "./http-errors.mjs";
import { clearResponsesToolOutputPartsCache } from "./responses-content.mjs";
import { loadRuntimeConfig, parsePositiveInteger, RUNTIME_DEFAULTS } from "./runtime-config.mjs";
import { currentRequestContext } from "./request-context.mjs";

const DEFAULT_MAX_BYTES = RUNTIME_DEFAULTS.responseHistoryMaxBytes;
const DEFAULT_MAX_ENTRIES = RUNTIME_DEFAULTS.responseHistoryMaxEntries;

function historyKey(id, namespace = currentRequestContext()?.historyNamespace) {
  if (typeof id === "string" && id.includes("\0")) throw httpError("Invalid previous_response_id", 400);
  return namespace && id ? `\0${namespace}\0${id}` : id;
}

function readableHistoryKey(id) {
  const current = historyKey(id), transfer = currentRequestContext()?.historyTransferNamespace;
  if (!transfer) return current;
  const previous = historyKey(id, transfer);
  if (previous === current) return current;
  if (histories.has(current) && histories.has(previous)) throw httpError("previous_response_id is ambiguous across providers; replay the full plaintext conversation", 400);
  return histories.has(current) ? current : previous;
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonStringByteLength(value) {
  let start = 0;
  let bytes = 2;
  if (value.length >= 1024) {
    const firstEscape = /["\\\u0000-\u001f\uD800-\uDFFF]/u.exec(value);
    if (!firstEscape) return Buffer.byteLength(value) + 2;
    start = firstEscape.index;
    bytes += Buffer.byteLength(value.slice(0, start));
  }
  for (let index = start; index < value.length; index += 1) {
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
let evictedEntriesTotal = 0;
let lookupMisses = 0;
let evictedLookupMisses = 0;
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
  let removedEntries = 0;
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
    removedEntries += 1;
  }
  evictedEntriesTotal += removedEntries;
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

export function clearResponseHistory() {
  if (pinnedTrees.size > 0) {
    const error = new Error("Response history is active; retry cleanup after current requests finish");
    error.code = "ccdx_cache_busy";
    throw error;
  }
  const removed = { entries: histories.size, bytes: totalBytes };
  histories.clear();
  childrenById.clear();
  treeLru.clear();
  pinnedTrees.clear();
  evictedIds.clear();
  totalBytes = 0;
  evictedEntriesTotal = 0;
  lookupMisses = 0;
  evictedLookupMisses = 0;
  return removed;
}

export function clearResponseHistoryForTests() {
  clearResponseHistory();
  maxBytes = DEFAULT_MAX_BYTES;
  maxEntries = DEFAULT_MAX_ENTRIES;
}

export function setResponseHistoryMaxBytes(nextMaxBytes) {
  const parsed = Number(nextMaxBytes);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError("Response history cache limit must be a positive safe integer");
  }
  if (parsed < totalBytes) {
    const error = new Error(`Response history currently uses ${totalBytes} bytes, above the requested ${parsed}-byte limit`);
    error.code = "ccdx_cache_limit_below_usage";
    throw error;
  }
  const previousMaxBytes = maxBytes;
  maxBytes = parsed;
  return { previousMaxBytes, maxBytes };
}

export function configureResponseHistoryForTests({ maxBytes: nextMaxBytes, maxEntries: nextMaxEntries } = {}) {
  if (nextMaxBytes !== undefined) maxBytes = parsePositiveInteger(nextMaxBytes, DEFAULT_MAX_BYTES);
  if (nextMaxEntries !== undefined) maxEntries = parsePositiveInteger(nextMaxEntries, DEFAULT_MAX_ENTRIES);
}

export function responseHistoryStats() {
  const trees = new Map();
  for (const entry of histories.values()) {
    trees.set(entry.rootId, (trees.get(entry.rootId) || 0) + entry.bytes);
  }
  let largestTreeBytes = 0;
  for (const bytes of trees.values()) largestTreeBytes = Math.max(largestTreeBytes, bytes);
  return { entries: histories.size, bytes: totalBytes, evicted: evictedIds.size,
    evicted_entries_total: evictedEntriesTotal,
    lookup_misses: lookupMisses,
    evicted_lookup_misses: evictedLookupMisses,
    tree_count: trees.size,
    largest_tree_bytes: largestTreeBytes,
    pinnedTrees: pinnedTrees.size, maxBytes, maxEntries };
}

export function responseHistoryRootId(responseId) {
  return histories.get(readableHistoryKey(responseId))?.rootId || null;
}

function responseHistoryChain(responseId) {
  const chain = [];
  const seen = new Set();
  let currentId = readableHistoryKey(responseId);
  while (currentId) {
    if (seen.has(currentId)) throw httpError(`Cycle detected in local response history: ${currentId}`, 500);
    seen.add(currentId);
    const entry = histories.get(currentId);
    if (!entry) {
      lookupMisses += 1;
      const wasEvicted = evictedIds.has(currentId);
      if (wasEvicted) evictedLookupMisses += 1;
      const reason = wasEvicted ? " was evicted after reaching the local history limit" : " is not available";
      throw httpError(`previous_response_id${reason}: ${String(currentId).split("\0").at(-1)}`, 400);
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
  id = historyKey(id);
  parentId = parentId ? historyKey(parentId) : null;
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

// Private process handoff only: no HTTP route or plaintext persistence.
export function exportResponseHistory() {
  if (pinnedTrees.size) throw new Error('Response history is busy');
  let bytes = totalBytes;
  for (const [id, entry] of histories) {
    bytes += Buffer.byteLength(id) + Buffer.byteLength(entry.parentId || '') + Buffer.byteLength(entry.rootId) + 512;
    if (bytes > 64 * 1024 * 1024) throw new Error('state_too_large');
  }
  return { version: 1, bytes, entries: [...histories], roots: [...treeLru.keys()], evicted: [...evictedIds],
    counters: { evictedEntriesTotal, lookupMisses, evictedLookupMisses } };
}
export function importResponseHistory(state) {
  if (histories.size || pinnedTrees.size || state?.version !== 1 || !Array.isArray(state.entries) || state.entries.length > maxEntries
    || !Array.isArray(state.roots) || !Array.isArray(state.evicted) || state.evicted.length > 256) throw new Error('Invalid response-history handoff');
  const restored = new Map();let bytes = 0;
  const idOK = id => typeof id === 'string' && id.length > 0 && id.length <= 2048;
  for (const pair of state.entries) {
    if (!Array.isArray(pair) || pair.length !== 2 || !idOK(pair[0]) || restored.has(pair[0])) throw new Error('Invalid response-history handoff');
    const [id, entry] = pair;
    if (!entry || !Array.isArray(entry.inputItems) || !(entry.outputItems === undefined || Array.isArray(entry.outputItems))
      || !(entry.parentId === null || idOK(entry.parentId)) || !idOK(entry.rootId) || typeof entry.hasOpaque !== 'boolean'
      || !(entry.routeAffinity === null || typeof entry.routeAffinity === 'object')) throw new Error('Invalid response-history handoff');
    const owned = structuredClone(entry);
    owned.bytes = jsonByteLength(owned.routeAffinity ? [owned.inputItems, owned.outputItems, { routeAffinity: owned.routeAffinity, hasOpaque: owned.hasOpaque }] : [owned.inputItems, owned.outputItems]);
    bytes += owned.bytes;if (bytes > maxBytes) throw new Error('Response-history handoff exceeds this version\'s limit');
    restored.set(id, owned);
  }
  const roots = new Map();
  for (const [id, entry] of restored) {
    let at = id;const seen = new Set(), chain = [];
    while (!roots.has(at)) {
      if (seen.has(at)) throw new Error('Cyclic response-history handoff');
      seen.add(at);chain.push(at);const current = restored.get(at);
      if (!current) throw new Error('Incomplete response-history handoff');
      if (!current.parentId) { roots.set(at, at);break; }at = current.parentId;
    }
    for (const item of chain) roots.set(item, roots.get(at));
    if (entry.rootId !== roots.get(id)) throw new Error('Invalid response-history root');
  }
  if (state.roots.some(id => !idOK(id) || roots.get(id) !== id) || new Set(state.roots).size !== state.roots.length
    || state.evicted.some(id => !idOK(id) || restored.has(id))) throw new Error('Invalid response-history handoff');
  for (const [id, entry] of restored) { histories.set(id, entry);linkChild(entry.parentId, id); }
  for (const id of state.roots) touchTree(id);
  for (const [id, root] of roots) if (id === root && !treeLru.has(id)) touchTree(id);
  for (const id of state.evicted) evictedIds.add(id);
  totalBytes = bytes;
  const count = name => Number.isSafeInteger(state.counters?.[name]) && state.counters[name] >= 0 ? state.counters[name] : 0;
  evictedEntriesTotal = count('evictedEntriesTotal');lookupMisses = count('lookupMisses');evictedLookupMisses = count('evictedLookupMisses');
}
