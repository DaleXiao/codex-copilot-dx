// Yield fetch Response body lines while preserving SSE semantics for callers.
// Handle LF, CRLF and CR endings, and release the reader if iteration stops early.
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
  let skipLF = false, bareCR = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.(value);
      const decoded = decoder.decode(value, { stream: true });
      let start = 0;
      if (!bareCR && decoded.length) {
        const tailCR = lineParts.at(-1)?.endsWith("\r") === true;
        if (tailCR && decoded[0] !== "\n") {
          bareCR = true;
          lineParts[lineParts.length - 1] = lineParts.at(-1).slice(0, -1);lineBytes--;
          yield lineParts.length > 1 ? lineParts.join("") : lineParts[0];
          lineParts = [];lineBytes = 0;
        }
      }
      if (!bareCR) {
        let nextCR = decoded.indexOf("\r", start);
        while (start < decoded.length) {
          const newline = decoded.indexOf("\n", start), end = newline < 0 ? decoded.length : newline;
          if (nextCR >= 0 && nextCR < end - 1) { bareCR = true;break; }
          const part = decoded.slice(start, end);
          if (newline < 0) { lineBytes = appendLineFragment(lineParts, part, lineBytes, maxBufferBytes);break; }
          let line;
          if (!lineParts.length) {
            if (Buffer.byteLength(part) > maxBufferBytes) throw new Error(`Upstream SSE buffer exceeds ${maxBufferBytes} bytes`);
            line = part;
          } else {
            lineBytes = appendLineFragment(lineParts, part, lineBytes, maxBufferBytes);
            line = lineParts.length > 1 ? lineParts.join("") : lineParts[0];
          }
          lineParts = [];lineBytes = 0;start = newline + 1;
          if (nextCR >= 0 && nextCR === end - 1) nextCR = decoded.indexOf("\r", start);
          yield line.endsWith("\r") ? line.slice(0, -1) : line;
        }
        if (!bareCR) continue;
      }
      if (skipLF && decoded.length) { if (decoded[0] === "\n") start = 1;skipLF = false; }
      while (start < decoded.length) {
        const lf = decoded.indexOf("\n", start), cr = decoded.indexOf("\r", start);
        const newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (newline < 0) {
          lineBytes = appendLineFragment(lineParts, decoded.slice(start), lineBytes, maxBufferBytes);
          break;
        }
        lineBytes = appendLineFragment(lineParts, decoded.slice(start, newline), lineBytes, maxBufferBytes);
        const line = lineParts.length > 1 ? lineParts.join("") : (lineParts[0] || "");
        yield line;
        lineParts = [];
        lineBytes = 0;
        start = newline + 1;
        if (decoded[newline] === "\r") {
          if (start === decoded.length) skipLF = true;
          else if (decoded[start] === "\n") start++;
        }
      }
    }
    lineBytes = appendLineFragment(lineParts, decoder.decode(), lineBytes, maxBufferBytes);
    if (lineParts.length > 0) {
      const line = lineParts.length > 1 ? lineParts.join("") : lineParts[0];
      yield !bareCR && line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
