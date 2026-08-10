import {
  isResponsesToolOutputItem,
  readResponsesImagePart,
  readResponsesToolOutputParts,
} from "./responses-content.mjs";

const IMAGE_OMISSION_TEXT = "[CCDX: earlier image omitted to fit the upstream request byte budget.]";

function bodyPayload(reqBody, assertActive) {
  assertActive?.();
  const bodyText = JSON.stringify(reqBody);
  assertActive?.();
  return { bodyText, bodyBytes: Buffer.byteLength(bodyText) };
}

function inlineImageIdentity(part) {
  const identity = readResponsesImagePart(part)?.identity;
  return identity ? { kind: "inline:data", value: identity } : null;
}

function imageMarkerPart(record) {
  if (record.kind === "message") {
    return {
      type: record.role === "assistant" ? "output_text" : "input_text",
      text: IMAGE_OMISSION_TEXT,
    };
  }
  return { type: record.usesAnthropicParts ? "text" : "input_text", text: IMAGE_OMISSION_TEXT };
}

function collectResponseImages(inputItems, currentInputStart, assertActive) {
  const records = [];
  const refs = [];
  const addContainer = (parts, options) => {
    if (!Array.isArray(parts)) return;
    const record = {
      parts,
      kind: options.kind,
      role: options.role,
      commit: options.commit,
      stringified: options.stringified,
      originalOutput: options.originalOutput,
      usesAnthropicParts: false,
    };
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      if ((partIndex & 63) === 0) assertActive?.();
      const identity = inlineImageIdentity(parts[partIndex]);
      if (!identity) continue;
      if (parts[partIndex].type === "image") record.usesAnthropicParts = true;
      refs.push({
        record,
        partIndex,
        historical: options.historical,
        identity,
      });
    }
    if (refs.some((ref) => ref.record === record)) records.push(record);
  };

  const historyBoundary = Math.min(Math.max(0, currentInputStart), inputItems.length);
  for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex += 1) {
    if ((itemIndex & 63) === 0) assertActive?.();
    const item = inputItems[itemIndex];
    if (!item || typeof item !== "object") continue;
    const historical = itemIndex < historyBoundary;
    const identity = inlineImageIdentity(item);
    if (identity) {
      const record = {
        parts: inputItems,
        partIndex: itemIndex,
        kind: "top-level",
        role: "user",
        commit: null,
        usesAnthropicParts: false,
      };
      refs.push({ record, partIndex: itemIndex, historical, identity });
      records.push(record);
    }
    if (item.type === "message") {
      addContainer(item.content, { kind: "message", role: item.role, historical });
      continue;
    }
    const toolOutput = readResponsesToolOutputParts(item);
    if (toolOutput) {
      addContainer(toolOutput.parts, {
        kind: "tool-output",
        commit: toolOutput.commit,
        historical,
        stringified: typeof item.output === "string",
        originalOutput: item.output,
      });
    }
  }
  return { records, refs };
}

function orderedHistoricalImageCandidates(refs, assertActive) {
  const seenByKind = new Map();
  const duplicates = [];
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    if ((index & 63) === 0) assertActive?.();
    const { kind, value } = refs[index].identity;
    let seen = seenByKind.get(kind);
    if (!seen) {
      seen = new Set();
      seenByKind.set(kind, seen);
    }
    if (seen.has(value) && refs[index].historical) duplicates.push(index);
    else seen.add(value);
  }
  duplicates.sort((left, right) => left - right);
  const duplicateSet = new Set(duplicates);
  const remaining = refs.map((_, index) => index)
    .filter((index) => refs[index].historical && !duplicateSet.has(index));
  return [
    ...duplicates,
    ...remaining.filter((index) => refs[index].record.kind === "tool-output"),
    ...remaining.filter((index) => refs[index].record.kind !== "tool-output"),
  ];
}

function serializedPartBytes(part, stringified) {
  const serialized = JSON.stringify(part);
  return stringified
    ? Buffer.byteLength(JSON.stringify(serialized)) - 2
    : Buffer.byteLength(serialized);
}

function createRecordDropState(record, assertActive) {
  if (record.kind === "top-level") {
    const marker = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: IMAGE_OMISSION_TEXT }],
    };
    return {
      currentBytes: Buffer.byteLength(JSON.stringify(record.parts[record.partIndex])),
      markerBytes: Buffer.byteLength(JSON.stringify(marker)),
    };
  }

  const elementBytes = new Array(record.parts.length);
  for (let index = 0; index < record.parts.length; index += 1) {
    if ((index & 63) === 0) assertActive?.();
    elementBytes[index] = serializedPartBytes(record.parts[index], record.stringified);
  }
  const remainingElementBytes = elementBytes.reduce((sum, bytes) => sum + bytes, 0);
  const remainingCount = record.parts.length;
  const baseBytes = record.stringified ? 4 : 2;
  const compactBytes = baseBytes + remainingElementBytes + Math.max(0, remainingCount - 1);
  return {
    baseBytes,
    currentBytes: record.stringified
      ? Buffer.byteLength(JSON.stringify(record.originalOutput))
      : compactBytes,
    elementBytes,
    markerElementBytes: serializedPartBytes(imageMarkerPart(record), record.stringified),
    remainingCount,
    remainingElementBytes,
  };
}

function recordBytesAfterDrop(record, state, partIndex) {
  if (record.kind === "top-level") return state.markerBytes;
  const remainingCount = state.remainingCount - 1;
  if (remainingCount === 0) return state.baseBytes + state.markerElementBytes;
  const remainingElementBytes = state.remainingElementBytes - state.elementBytes[partIndex];
  return state.baseBytes + remainingElementBytes + remainingCount - 1;
}

function selectImageDrops(refs, bodyBytes, targetBytes, maxHistoricalImages = Number.POSITIVE_INFINITY, assertActive) {
  const candidates = orderedHistoricalImageCandidates(refs, assertActive);
  const selected = new Set();
  const byRecord = new Map();
  let projectedBytes = bodyBytes;
  let historicalImages = refs.reduce((count, ref) => count + (ref.historical ? 1 : 0), 0);
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    if ((candidateIndex & 63) === 0) assertActive?.();
    const index = candidates[candidateIndex];
    if (projectedBytes <= targetBytes && historicalImages <= maxHistoricalImages) break;
    const ref = refs[index];
    let state = byRecord.get(ref.record);
    if (!state) {
      state = createRecordDropState(ref.record, assertActive);
      byRecord.set(ref.record, state);
    }
    const afterBytes = recordBytesAfterDrop(ref.record, state, ref.partIndex);
    const savings = state.currentBytes - afterBytes;
    if (savings <= 0 && historicalImages <= maxHistoricalImages) continue;
    state.currentBytes = afterBytes;
    if (ref.record.kind !== "top-level") {
      state.remainingCount -= 1;
      state.remainingElementBytes -= state.elementBytes[ref.partIndex];
    }
    selected.add(index);
    projectedBytes -= savings;
    historicalImages -= 1;
  }
  return { selected, historicalImages, projectedBytes };
}

function applyImageDrops(records, refs, selected, assertActive) {
  const byRecord = new Map();
  let selectedIndex = 0;
  for (const index of selected) {
    if ((selectedIndex & 63) === 0) assertActive?.();
    selectedIndex += 1;
    const ref = refs[index];
    let indexes = byRecord.get(ref.record);
    if (!indexes) {
      indexes = new Set();
      byRecord.set(ref.record, indexes);
    }
    indexes.add(ref.partIndex);
  }

  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    if ((recordIndex & 63) === 0) assertActive?.();
    const record = records[recordIndex];
    const indexes = byRecord.get(record);
    if (!indexes) continue;
    if (record.kind === "top-level") {
      for (const index of indexes) {
        record.parts[index] = {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: IMAGE_OMISSION_TEXT }],
        };
      }
      continue;
    }
    const kept = record.parts.filter((_, index) => !indexes.has(index));
    if (!kept.length) kept.push(imageMarkerPart(record));
    record.parts.splice(0, record.parts.length, ...kept);
    record.commit?.();
  }
}

function omitHistoricalToolOutputs(inputItems, currentInputStart, bodyBytes, targetBytes, assertActive) {
  let omitted = 0;
  let projectedBytes = bodyBytes;
  const historicalCount = Math.min(Math.max(0, currentInputStart), inputItems.length);
  for (let itemIndex = 0; itemIndex < historicalCount && projectedBytes > targetBytes; itemIndex += 1) {
    if ((itemIndex & 63) === 0) assertActive?.();
    const item = inputItems[itemIndex];
    if (!isResponsesToolOutputItem(item) || item.output === undefined) continue;
    if (typeof item.output === "string" && item.output.startsWith("[CCDX: earlier tool output omitted")) continue;
    const originalBytes = Buffer.byteLength(JSON.stringify(item.output));
    const marker = `[CCDX: earlier tool output omitted to fit the upstream request byte budget; original_bytes=${originalBytes}.]`;
    const markerBytes = Buffer.byteLength(JSON.stringify(marker));
    if (markerBytes >= originalBytes) continue;
    item.output = marker;
    projectedBytes -= originalBytes - markerBytes;
    omitted += 1;
  }
  return omitted;
}

export function trimResponsesHistoryToByteBudget(reqBody, {
  assertActive,
  currentInputStart = 0,
  targetBytes,
  initialBodyText,
  initialBodyBytes,
} = {}) {
  assertActive?.();
  let bodyText = initialBodyText ?? JSON.stringify(reqBody);
  assertActive?.();
  let bodyBytes = initialBodyBytes ?? Buffer.byteLength(bodyText);
  const limit = Number.isFinite(targetBytes) && targetBytes > 0 ? Math.floor(targetBytes) : bodyBytes;
  const inputItems = Array.isArray(reqBody?.input) ? reqBody.input : [];
  let imagesOmitted = 0;
  let toolOutputsOmitted = 0;

  while (bodyBytes > limit) {
    assertActive?.();
    const { records, refs } = collectResponseImages(inputItems, currentInputStart, assertActive);
    if (!refs.length) break;
    const { selected } = selectImageDrops(refs, bodyBytes, limit, Number.POSITIVE_INFINITY, assertActive);
    if (!selected.size) break;
    applyImageDrops(records, refs, selected, assertActive);
    imagesOmitted += selected.size;
    ({ bodyText, bodyBytes } = bodyPayload(reqBody, assertActive));
  }

  while (bodyBytes > limit) {
    assertActive?.();
    const omitted = omitHistoricalToolOutputs(inputItems, currentInputStart, bodyBytes, limit, assertActive);
    if (omitted === 0) break;
    toolOutputsOmitted += omitted;
    ({ bodyText, bodyBytes } = bodyPayload(reqBody, assertActive));
  }

  return {
    bodyText,
    bodyBytes,
    overBudget: bodyBytes > limit,
    targetBytes: limit,
    imagesOmitted,
    toolOutputsOmitted,
    adapted: imagesOmitted > 0 || toolOutputsOmitted > 0,
  };
}

export function responsesHistoricalImageStats(inputItems, currentInputStart = 0, { assertActive } = {}) {
  const items = Array.isArray(inputItems) ? inputItems : [];
  const { refs } = collectResponseImages(items, currentInputStart, assertActive);
  const historicalImages = refs.reduce((count, ref) => count + (ref.historical ? 1 : 0), 0);
  return {
    totalImages: refs.length,
    historicalImages,
    currentImages: refs.length - historicalImages,
  };
}

export function trimResponsesHistoricalImages(reqBody, {
  assertActive,
  currentInputStart = 0,
  maxHistoricalImages = Number.POSITIVE_INFINITY,
  targetBytes = Number.POSITIVE_INFINITY,
  initialBodyText,
  initialBodyBytes,
} = {}) {
  assertActive?.();
  let bodyText = initialBodyText ?? JSON.stringify(reqBody);
  assertActive?.();
  let bodyBytes = initialBodyBytes ?? Buffer.byteLength(bodyText);
  const byteLimit = Number.isFinite(targetBytes) && targetBytes > 0
    ? Math.floor(targetBytes)
    : Number.POSITIVE_INFINITY;
  const imageLimit = Number.isFinite(maxHistoricalImages) && maxHistoricalImages >= 0
    ? Math.floor(maxHistoricalImages)
    : Number.POSITIVE_INFINITY;
  const inputItems = Array.isArray(reqBody?.input) ? reqBody.input : [];
  let imagesOmitted = 0;

  while (true) {
    assertActive?.();
    const { records, refs } = collectResponseImages(inputItems, currentInputStart, assertActive);
    const historicalImages = refs.reduce((count, ref) => count + (ref.historical ? 1 : 0), 0);
    if (bodyBytes <= byteLimit && historicalImages <= imageLimit) break;
    if (!historicalImages) break;
    const { selected } = selectImageDrops(refs, bodyBytes, byteLimit, imageLimit, assertActive);
    if (!selected.size) break;
    applyImageDrops(records, refs, selected, assertActive);
    imagesOmitted += selected.size;
    ({ bodyText, bodyBytes } = bodyPayload(reqBody, assertActive));
  }

  const stats = responsesHistoricalImageStats(inputItems, currentInputStart, { assertActive });
  return {
    bodyText,
    bodyBytes,
    targetBytes: byteLimit,
    maxHistoricalImages: imageLimit,
    historicalImages: stats.historicalImages,
    currentImages: stats.currentImages,
    imagesOmitted,
    overBudget: bodyBytes > byteLimit,
    overImageBudget: stats.historicalImages > imageLimit,
    adapted: imagesOmitted > 0,
  };
}

export function enforceResponsesPayloadByteBudget(reqBody, payload, { assertActive } = {}) {
  let finalized = payload;
  if (payload?.overBudget) {
    const trimmed = trimResponsesHistoryToByteBudget(reqBody, {
      assertActive,
      currentInputStart: payload.currentInputStart,
      targetBytes: payload.targetBytes,
      initialBodyText: payload.bodyText,
      initialBodyBytes: payload.bodyBytes,
    });
    finalized = {
      ...payload,
      ...trimmed,
      adapted: Boolean(payload.adapted || trimmed.adapted),
      stage: trimmed.adapted ? `${payload.stage}+history` : payload.stage,
    };
  }
  if (!finalized?.overBudget) return finalized;

  const message = `Responses request body is ${finalized.bodyBytes} bytes after ${finalized.stage}; configured upstream limit is ${finalized.targetBytes} bytes`;
  const error = new Error(message);
  error.statusCode = 413;
  error.code = "ccdx_request_body_too_large";
  error.jsonBody = {
    error: {
      message,
      type: "invalid_request_error",
      code: error.code,
      actual_bytes: finalized.bodyBytes,
      limit_bytes: finalized.targetBytes,
      stage: finalized.stage,
    },
  };
  throw error;
}
