import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const requestContextStorage = new AsyncLocalStorage();

export function createRequestId() {
  return randomUUID();
}

export function runWithRequestContext(context, callback) {
  return requestContextStorage.run(context, callback);
}

export function currentRequestContext() {
  return requestContextStorage.getStore() || null;
}
