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
