export const MAX_UPSTREAM_IMAGES = 50;

function isImagePart(part) {
  return part && typeof part === "object"
    && ["input_image", "image", "image_url"].includes(part.type);
}

function imageIdentity(part) {
  if (!isImagePart(part)) return null;

  if (part.type === "image") {
    const source = part.source;
    if (typeof source?.data === "string") {
      return { kind: `image:${source.type || "base64"}:${source.media_type || ""}`, value: source.data };
    }
    if (typeof source?.url === "string") {
      return { kind: `image:url:${part.detail || ""}`, value: source.url };
    }
  }

  const raw = part.image_url ?? part.url;
  const url = typeof raw === "string" ? raw : raw?.url;
  if (typeof url === "string") {
    const detail = part.detail ?? raw?.detail ?? "";
    return { kind: `${part.type}:url:${detail}`, value: url };
  }
  if (typeof part.file_id === "string") {
    return { kind: `${part.type}:file`, value: part.file_id };
  }
  return null;
}

function markerPart(record, maxImages) {
  const text = `[Earlier image omitted to stay within the upstream ${maxImages}-image request limit.]`;
  if (record.kind === "message") {
    return {
      type: record.role === "assistant" ? "output_text" : "input_text",
      text,
    };
  }
  return { type: record.usesAnthropicParts ? "text" : "input_text", text };
}

function addPartContainer(records, refs, parts, options) {
  if (!Array.isArray(parts)) return;
  const record = {
    parts,
    kind: options.kind,
    role: options.role,
    commit: options.commit,
    usesAnthropicParts: false,
  };
  let found = false;
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    if (!isImagePart(part)) continue;
    found = true;
    if (part.type === "image") record.usesAnthropicParts = true;
    refs.push({
      record,
      partIndex,
      itemIndex: options.itemIndex,
      identity: imageIdentity(part),
    });
  }
  if (found) records.push(record);
}

function collectImages(inputItems) {
  const records = [];
  const refs = [];
  const topLevelRecord = {
    parts: inputItems,
    kind: "top-level",
    role: "user",
    commit: null,
    usesAnthropicParts: false,
  };
  let hasTopLevelImages = false;

  for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex += 1) {
    const item = inputItems[itemIndex];
    if (!item || typeof item !== "object") continue;

    if (isImagePart(item)) {
      hasTopLevelImages = true;
      refs.push({
        record: topLevelRecord,
        partIndex: itemIndex,
        itemIndex,
        identity: imageIdentity(item),
      });
    }

    if (item.type === "message") {
      addPartContainer(records, refs, item.content, {
        kind: "message",
        role: item.role,
        itemIndex,
      });
    }

    if (item.type !== "function_call_output") continue;
    if (Array.isArray(item.output)) {
      addPartContainer(records, refs, item.output, {
        kind: "tool-output",
        itemIndex,
      });
      continue;
    }
    if (typeof item.output !== "string" || !item.output.trim().startsWith("[")) continue;
    try {
      const parsed = JSON.parse(item.output);
      if (!Array.isArray(parsed)) continue;
      addPartContainer(records, refs, parsed, {
        kind: "tool-output",
        itemIndex,
        commit: () => { item.output = JSON.stringify(parsed); },
      });
    } catch {
      // Preserve non-JSON tool output unchanged.
    }
  }

  if (hasTopLevelImages) records.push(topLevelRecord);
  return { records, refs };
}

function applyDrops(records, refs, dropped, maxImages) {
  const droppedByRecord = new Map();
  for (const refIndex of dropped) {
    const ref = refs[refIndex];
    let indexes = droppedByRecord.get(ref.record);
    if (!indexes) {
      indexes = new Set();
      droppedByRecord.set(ref.record, indexes);
    }
    indexes.add(ref.partIndex);
  }

  for (const record of records) {
    const indexes = droppedByRecord.get(record);
    if (!indexes) continue;
    const kept = record.parts.filter((_, index) => !indexes.has(index));
    if (!kept.length && record.kind !== "top-level") kept.push(markerPart(record, maxImages));
    record.parts.splice(0, record.parts.length, ...kept);
    record.commit?.();
  }
}

export function enforceResponsesImageLimit(inputItems, {
  currentInputStart = 0,
  maxImages = MAX_UPSTREAM_IMAGES,
  beforeMutate = () => {},
} = {}) {
  const limit = Number.isFinite(maxImages) && maxImages > 0
    ? Math.floor(maxImages)
    : MAX_UPSTREAM_IMAGES;
  if (!Array.isArray(inputItems)) {
    return { total: 0, kept: 0, omitted: 0, duplicates: 0, historicalOmitted: 0, currentOmitted: 0 };
  }

  const { records, refs } = collectImages(inputItems);
  if (refs.length <= limit) {
    return { total: refs.length, kept: refs.length, omitted: 0, duplicates: 0, historicalOmitted: 0, currentOmitted: 0 };
  }

  const dropped = new Set();
  const seenByKind = new Map();
  const duplicateCandidates = [];
  let kept = refs.length;
  let duplicates = 0;

  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const identity = refs[index].identity;
    if (!identity) continue;
    let seen = seenByKind.get(identity.kind);
    if (!seen) {
      seen = new Set();
      seenByKind.set(identity.kind, seen);
    }
    if (seen.has(identity.value)) {
      duplicateCandidates.push(index);
    } else {
      seen.add(identity.value);
    }
  }

  duplicateCandidates.sort((left, right) => left - right);
  for (const index of duplicateCandidates) {
    if (kept <= limit) break;
    dropped.add(index);
    kept -= 1;
    duplicates += 1;
  }

  for (let index = 0; index < refs.length && kept > limit; index += 1) {
    if (dropped.has(index)) continue;
    dropped.add(index);
    kept -= 1;
  }

  let historicalOmitted = 0;
  let currentOmitted = 0;
  for (const index of dropped) {
    if (refs[index].itemIndex >= currentInputStart) currentOmitted += 1;
    else historicalOmitted += 1;
  }
  beforeMutate({ historicalOmitted, currentOmitted });
  applyDrops(records, refs, dropped, limit);

  return {
    total: refs.length,
    kept,
    omitted: dropped.size,
    duplicates,
    historicalOmitted,
    currentOmitted,
  };
}
