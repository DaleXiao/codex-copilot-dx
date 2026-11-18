import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

const scope = new AsyncLocalStorage();
const requests = new WeakMap();
const create = channel("undici:request:create");
const sent = channel("undici:request:bodySent");
let active = 0;

function onCreate({ request }) {
  const state = scope.getStore();
  if (!state?.callback || state.request) return;
  state.request = request;
  requests.set(request, state);
}

function onSent({ request }) {
  const state = requests.get(request);
  if (!state) return;
  requests.delete(request);
  const callback = state.callback;
  state.callback = null;
  callback?.();
}

// Only subscribe while an observed POST is open. Retain the request identity
// for correlation; do not read its URL, headers or body.
export async function fetchWithBodyWriteTiming(url, init, callback) {
  if (active++ === 0) {
    create.subscribe(onCreate);
    sent.subscribe(onSent);
  }
  const state = { callback, request: null };
  try {
    return await scope.run(state, fetch, url, init);
  } finally {
    if (state.request) requests.delete(state.request);
    state.request = state.callback = null;
    if (--active === 0) {
      create.unsubscribe(onCreate);
      sent.unsubscribe(onSent);
    }
  }
}
