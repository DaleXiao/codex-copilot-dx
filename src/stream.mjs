// Yield fetch Response body lines while preserving SSE semantics for callers.
// Strip CRLF tails and release the reader if iteration stops early.
export async function* webStreamLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) yield line.replace(/\r$/, "");
    }
    buf += decoder.decode();
    if (buf.length > 0) yield buf.replace(/\r$/, "");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
