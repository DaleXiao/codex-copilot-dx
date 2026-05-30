// 把 fetch Response 的 body 按 \n 拆成行，逐行 yield（保留 SSE 语义，调用方自行处理 data:/event:）。
// 剥除行尾 \r 以兼容 CRLF；提前 break 时通过 finally 取消 reader，释放 body 锁。
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
