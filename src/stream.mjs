// Yield fetch Response body lines while preserving SSE semantics for callers.
// Strip CRLF tails and release the reader if iteration stops early.
import { loadRuntimeConfig } from "./runtime-config.mjs";

const MAX_SSE_BUFFER_BYTES = loadRuntimeConfig().maxSseBufferBytes;

function assertSseBufferLimit(buffer, maxBufferBytes) {
  if (Buffer.byteLength(buffer) > maxBufferBytes) {
    throw new Error(`Upstream SSE buffer exceeds ${maxBufferBytes} bytes`);
  }
}

export async function* webStreamLines(response, { onChunk, maxBufferBytes = MAX_SSE_BUFFER_BYTES } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.(value);
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      assertSseBufferLimit(buf, maxBufferBytes);
      for (const line of lines) {
        assertSseBufferLimit(line, maxBufferBytes);
        yield line.replace(/\r$/, "");
      }
    }
    buf += decoder.decode();
    assertSseBufferLimit(buf, maxBufferBytes);
    if (buf.length > 0) yield buf.replace(/\r$/, "");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
