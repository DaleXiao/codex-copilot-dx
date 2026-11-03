import { privacyFailure } from "./privacy-model.mjs";

export function validatePrivacyFindings(texts, found) {
  if (!Array.isArray(found) || found.length !== texts.length) throw privacyFailure("engine_invalid");
  return found.map((items, index) => {
    if (items === null) return [];
    if (!Array.isArray(items)) throw privacyFailure("engine_invalid");
    const bytes = Buffer.from(texts[index]);
    for (const span of items) {
      if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start
        || span.end > bytes.length || !Number.isFinite(span.score) || span.score < 0 || span.score > 1 || typeof span.label !== "string"
        || (bytes[span.start] & 0xC0) === 0x80 || span.end < bytes.length && (bytes[span.end] & 0xC0) === 0x80) throw privacyFailure("engine_invalid");
    }
    return items;
  });
}

export function mergePrivacyFindings(spans) {
  const labels = new Map(), result = [];
  for (const span of spans) {
    if (span.score < 0.8) { result.push({ ...span });continue; }
    if (!labels.has(span.label)) labels.set(span.label, []);
    labels.get(span.label).push(span);
  }
  for (const group of labels.values()) {
    group.sort((a, b) => a.start - b.start || a.end - b.end);
    let previous;
    for (const span of group) {
      if (previous && span.start <= previous.end) {
        previous.end = Math.max(previous.end, span.end);previous.score = Math.max(previous.score, span.score);
      } else { previous = { ...span };result.push(previous); }
    }
  }
  return result.sort((a, b) => a.start - b.start || b.end - a.end);
}
