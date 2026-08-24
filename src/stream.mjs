// Yield fetch Response body lines while preserving SSE semantics for callers.
// Strip CRLF tails and release the reader if iteration stops early.
import { loadRuntimeConfig } from "./runtime-config.mjs";

const MAX_SSE_BUFFER_BYTES = loadRuntimeConfig().maxSseBufferBytes;

function appendLineFragment(parts, fragment, currentBytes, maxBufferBytes) {
  if (!fragment) return currentBytes;
  const nextBytes = currentBytes + Buffer.byteLength(fragment);
  if (nextBytes > maxBufferBytes) {
    throw new Error(`Upstream SSE buffer exceeds ${maxBufferBytes} bytes`);
  }
  parts.push(fragment);
  return nextBytes;
}

export async function* webStreamLines(response, { onChunk, maxBufferBytes = MAX_SSE_BUFFER_BYTES } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineParts = [];
  let lineBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.(value);
      const decoded = decoder.decode(value, { stream: true });
      let start = 0;
      while (start < decoded.length) {
        const newline = decoded.indexOf("\n", start);
        if (newline === -1) {
          lineBytes = appendLineFragment(lineParts, decoded.slice(start), lineBytes, maxBufferBytes);
          break;
        }
        lineBytes = appendLineFragment(lineParts, decoded.slice(start, newline), lineBytes, maxBufferBytes);
        const line = lineParts.length > 1 ? lineParts.join("") : (lineParts[0] || "");
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
        lineParts = [];
        lineBytes = 0;
        start = newline + 1;
      }
    }
    lineBytes = appendLineFragment(lineParts, decoder.decode(), lineBytes, maxBufferBytes);
    if (lineParts.length > 0) {
      const line = lineParts.length > 1 ? lineParts.join("") : lineParts[0];
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
