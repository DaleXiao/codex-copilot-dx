import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

const scope = new AsyncLocalStorage();
const requests = new WeakMap();
const create = channel("undici:request:create");
const chunks = channel("undici:request:bodyChunkSent");
const sent = channel("undici:request:bodySent");
const errors = channel("undici:request:error");
const transportCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH"]);
let active = 0;

function onCreate({ request }) {
  const state = scope.getStore();
  if (!state?.callback || state.request) return;
  state.request = request;
  requests.set(request, state);
  state.callback("start");
}

function onChunk({ request, chunk }) {
  const state = requests.get(request);
  if (!state) return;
  const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk?.byteLength;
  if (Number.isSafeInteger(bytes) && bytes > 0) state.callback("chunk", bytes);
}

function onSent({ request }) {
  requests.get(request)?.callback("sent");
}

function onError({ request, error }) {
  const state = requests.get(request);
  // An intentional abort destroys the socket. Its error is not evidence that
  // the connection had already failed.
  if (!state || state.signal?.aborted || error?.name === "AbortError") return;
  const code = error?.cause?.code || error?.code;
  if (transportCodes.has(code)) state.callback("error", code);
}

// Only subscribe while an observed POST is open. Retain the request identity
// for correlation; do not read its URL, headers or body.
export async function fetchWithBodyWriteTiming(url, init, callback, fetchImpl = fetch) {
  if (active++ === 0) {
    create.subscribe(onCreate);
    chunks.subscribe(onChunk);
    sent.subscribe(onSent);
    errors.subscribe(onError);
  }
  const state = { callback, request: null, signal: init.signal };
  try {
    return await scope.run(state, fetchImpl, url, init);
  } finally {
    if (state.request) requests.delete(state.request);
    state.request = state.callback = null;
    if (--active === 0) {
      create.unsubscribe(onCreate);
      chunks.unsubscribe(onChunk);
      sent.unsubscribe(onSent);
      errors.unsubscribe(onError);
    }
  }
}
