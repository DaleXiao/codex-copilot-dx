import { writeOrDrain } from "./http-transport.mjs";

function streamErrorData(protocol, error, abort) {
  const code = abort?.reason || "upstream_stream_error";
  const message = `${code}: ${error?.message || "Upstream stream failed"}`;
  if (protocol === "anthropic") {
    return { type: "error", error: { type: "api_error", message } };
  }
  return { type: "error", code, message, param: null };
}

export async function endStreamWithError(res, protocol, error, abort) {
  if (res.destroyed || res.writableEnded) return;
  const data = streamErrorData(protocol, error, abort);
  await writeOrDrain(res, `event: error\ndata: ${JSON.stringify(data)}\n\n`).catch(() => false);
  if (!res.destroyed && !res.writableEnded) res.end();
}
