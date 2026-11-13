import { loadRuntimeConfig } from "./runtime-config.mjs";

const MAX_BYTES = loadRuntimeConfig().maxSseBufferBytes;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function googleUsageEvent(value) {
  const response = value?.response || value, usage = response?.usageMetadata;
  if (!usage || typeof usage !== "object") return null;
  const prompt = count(usage.promptTokenCount), output = count(usage.candidatesTokenCount);
  const thoughts = count(usage.thoughtsTokenCount), tools = count(usage.toolUsePromptTokenCount);
  return {
    id: response.responseId, model: response.modelVersion,
    usage: {
      prompt_tokens: prompt === undefined ? undefined : prompt + (tools ?? 0),
      completion_tokens: output === undefined ? undefined : output + (thoughts ?? 0),
      total_tokens: count(usage.totalTokenCount),
      prompt_tokens_details: { cached_tokens: count(usage.cachedContentTokenCount) },
      completion_tokens_details: { reasoning_tokens: thoughts },
    },
  };
}

// Observe the same chunks the caller forwards, without buffering delivery,
// changing bytes or reading ahead. Oversized metadata is unavailable, not zero.
export function createGoogleResponseObserver({ streaming, onEvent, maxBytes = MAX_BYTES }) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts = [], bytes = 0, data = [], frameBytes = 0, skipLF = false, skipFrame = false, unavailable = false;
  const parse = text => {
    if (!text || text === "[DONE]") return;
    try { const value = JSON.parse(text);for (const item of Array.isArray(value) ? value : [value]) onEvent(item); }
    catch { unavailable = true; }
  };
  const line = () => {
    const text = parts.join("");parts = [];bytes = 0;
    if (!text) {
      if (!skipFrame) parse(data.join("\n"));
      data = [];frameBytes = 0;skipFrame = false;
    } else if (!skipFrame && text.startsWith("data:")) {
      const value = text.slice(5).replace(/^ /, "");frameBytes += Buffer.byteLength(value);
      if (frameBytes > maxBytes) { data = [];skipFrame = true;unavailable = true; }
      else data.push(value);
    }
  };
  const consume = text => {
    if (!streaming) {
      if (unavailable) return;
      bytes += Buffer.byteLength(text);
      if (bytes > maxBytes) { parts = [];unavailable = true; } else parts.push(text);
      return;
    }
    let start = 0;
    if (skipLF && text.length) { if (text[0] === "\n") start = 1;skipLF = false; }
    const newline = /[\r\n]/g;newline.lastIndex = start;let match;
    const append = fragment => {
      if (skipFrame) return;
      bytes += Buffer.byteLength(fragment);
      if (bytes > maxBytes) { parts = [];data = [];skipFrame = true;unavailable = true; }
      else parts.push(fragment);
    };
    while ((match = newline.exec(text))) {
      const hadLine = bytes > 0 || parts.length > 0 || skipFrame && match.index > start;
      append(text.slice(start, match.index));
      if (skipFrame && (hadLine || match.index > start)) { parts = [];bytes = 0; }
      else line();
      start = match.index + 1;
      if (match[0] === "\r") {
        if (text[start] === "\n") start++;
        else if (start === text.length) skipLF = true;
        newline.lastIndex = start;
      }
    }
    append(text.slice(start));
  };
  return {
    push(chunk) { try { consume(decoder.decode(chunk, { stream: true })); } catch { unavailable = true;parts = [];data = []; } },
    finish() {
      try {
        consume(decoder.decode());
        if (streaming) { if (parts.length) line();if (!skipFrame && data.length) parse(data.join("\n")); }
        else if (!unavailable) parse(parts.join(""));
      } catch { unavailable = true; }
      parts = [];data = [];
      return { unavailable };
    },
  };
}
