import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

const requestContextStorage = new AsyncLocalStorage();
export const REQUEST_PURPOSES = Object.freeze(["conversation", "compaction", "diagnostic", "compatibility", "unknown"]);
export function requestPurpose(value, fallback = "conversation") {
  return REQUEST_PURPOSES.includes(value) ? value : fallback;
}

export function createRequestId() {
  return randomUUID();
}

export function runWithRequestContext(context, callback) {
  context.purpose = requestPurpose(context.purpose);
  return requestContextStorage.run(context, callback);
}

export function currentRequestContext() {
  return requestContextStorage.getStore() || null;
}

// Capture before route validation; never retain a body or an arbitrary string.
export function observeRequestedModel(body) {
  const value = body?.model, context = currentRequestContext();
  if (context && typeof value === "string" && /^[\w][\w./:@+-]{0,159}$/.test(value)
    && redactDiagnosticText(value) === value) { context.requestedModel = value;context.streamPerformance?.setModel?.(value); }
}
