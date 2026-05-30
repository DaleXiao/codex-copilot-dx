// 把 fetch Response 的 body 按 \n 拆成行，逐行 yield（保留 SSE 语义，调用方自行处理 data:/event:）。
export async function* webStreamLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) yield line;
  }
  if (buf.length > 0) yield buf;
}
