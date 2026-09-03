import { writeOrDrain } from "./http-transport.mjs";
import { markStreamFailure } from "./stream-performance.mjs";

function streamErrorData(error, abort) {
  const code = abort?.reason || error?.code || "upstream_stream_error";
  const message = `${code}: ${error?.message || "Upstream stream failed"}`;
  return { type: "error", code, message, param: null };
}

export async function endStreamWithError(res, error, abort) {
  markStreamFailure();
  if (res.destroyed || res.writableEnded) return;
  const data = streamErrorData(error, abort);
  await writeOrDrain(res, `event: error\ndata: ${JSON.stringify(data)}\n\n`).catch(() => false);
  if (!res.destroyed && !res.writableEnded) res.end();
}
