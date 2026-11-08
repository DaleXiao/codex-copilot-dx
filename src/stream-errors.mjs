import { randomUUID } from "node:crypto";
import { writeOrDrain } from "./http-transport.mjs";
import { markStreamFailure } from "./stream-performance.mjs";

export function responseFailedEvent(error, { response, model, sequenceNumber, template } = {}) {
  const prior = response && typeof response === "object" && !Array.isArray(response) ? response : {};
  const detail = error && typeof error === "object" && !Array.isArray(error) ? error : {};
  const code = typeof detail.code === "string" && detail.code ? detail.code : "upstream_stream_error";
  const message = typeof detail.message === "string" && detail.message ? detail.message
    : typeof error === "string" && error ? error : "Upstream stream failed";
  return {
    ...template,
    type: "response.failed",
    sequence_number: Number.isSafeInteger(sequenceNumber) && sequenceNumber >= 0 ? sequenceNumber : 0,
    response: {
      ...prior,
      id: typeof prior.id === "string" && prior.id ? prior.id : `resp_ccdx_${randomUUID().replaceAll("-", "")}`,
      object: "response",
      created_at: Number.isSafeInteger(prior.created_at) && prior.created_at >= 0 ? prior.created_at : Math.floor(Date.now() / 1000),
      model: typeof prior.model === "string" && prior.model ? prior.model : typeof model === "string" && model ? model : "unknown",
      status: "failed",
      output: Array.isArray(prior.output) ? prior.output : [],
      error: { ...detail, code, message },
    },
  };
}

function streamErrorData(error, abort, metadata) {
  const code = abort?.reason || error?.code || "upstream_stream_error";
  const message = `${code}: ${error?.message || "Upstream stream failed"}`;
  return responseFailedEvent({ code, message }, metadata);
}

export async function endStreamWithError(res, error, abort, metadata) {
  markStreamFailure();
  if (res.destroyed || res.writableEnded) return;
  const data = streamErrorData(error, abort, metadata);
  // Allow a final error frame after an upstream timeout, but never wait forever
  // for a client that has stopped reading (including protocol-error paths).
  await writeOrDrain(res, `event: response.failed\ndata: ${JSON.stringify(data)}\n\n`, {
    signal: AbortSignal.timeout(1000),
  }).catch(() => false);
  if (!res.destroyed && !res.writableEnded) res.end();
}
