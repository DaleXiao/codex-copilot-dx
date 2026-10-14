const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // Public GitHub Copilot client ID.
const SCOPE = "read:user";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRES_SECONDS = 900;
export const DEFAULT_DEVICE_CODE_TIMEOUT_MS = 30 * 1000;
const MAX_DEVICE_FLOW_JSON_BYTES = 64 * 1024;

// Map GitHub polling responses to a small local state machine.
export function interpretPoll(data) {
  if (typeof data.access_token === "string" && data.access_token) return { state: "done", token: data.access_token };
  switch (data.error) {
    case "authorization_pending": return { state: "wait" };
    case "slow_down": return { state: "slow" };
    default: return { state: "fail", error: data.error || "unknown" };
  }
}

export function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function sleep(ms, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function awaitWithSignal(operation, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function discardBoundedResponseBody(response) {
  const transport = await import("./http-transport.mjs");
  return transport.discardBoundedResponseBody(response);
}

async function readDeviceFlowJson(response, signal, label) {
  if (typeof response?.body?.getReader === "function") {
    const transport = await import("./http-transport.mjs");
    const text = await awaitWithSignal(() => transport.readBoundedResponseText(response, {
      maxBytes: MAX_DEVICE_FLOW_JSON_BYTES,
      label,
    }), signal);
    return JSON.parse(text);
  }
  return awaitWithSignal(() => response.json(), signal);
}

export function cancelResponseBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}

function deviceCodeTimeoutError(timeoutMs) {
  const error = new Error(`Device code request timed out after ${timeoutMs}ms`);
  error.code = "CCDX_DEVICE_CODE_TIMEOUT";
  return error;
}

export async function requestGithubDeviceCode({
  fetchImpl = fetch,
  signal,
  timeoutMs = DEFAULT_DEVICE_CODE_TIMEOUT_MS,
} = {}) {
  const parsedTimeout = Number(timeoutMs);
  const deadlineMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_DEVICE_CODE_TIMEOUT_MS;
  const controller = new AbortController();
  let response;
  const onCallerAbort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (signal?.aborted) onCallerAbort();
  const timer = setTimeout(() => controller.abort(deviceCodeTimeoutError(deadlineMs)), deadlineMs);
  try {
    response = await awaitWithSignal(() => fetchImpl("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
      signal: controller.signal,
    }), controller.signal);
    if (!response.ok) {
      await awaitWithSignal(() => discardBoundedResponseBody(response), controller.signal);
      return { response, data: null, jsonError: null };
    }
    try {
      const data = await readDeviceFlowJson(response, controller.signal, "Device code response");
      return { response, data, jsonError: null };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return { response, data: null, jsonError: error };
    }
  } catch (error) {
    cancelResponseBody(response);
    if (signal?.aborted) throw abortError(signal);
    if (controller.signal.aborted) throw abortError(controller.signal);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function pollGithubDeviceFlow({
  deviceCode,
  interval,
  expiresIn,
  fetchImpl = fetch,
  signal,
  sleepImpl = sleep,
  now = Date.now,
} = {}) {
  const parsedInterval = Number(interval);
  const parsedExpires = Number(expiresIn);
  let waitMs = (Number.isFinite(parsedInterval) && parsedInterval > 0
    ? parsedInterval
    : DEFAULT_DEVICE_INTERVAL_SECONDS) * 1000;
  const expiresMs = (Number.isFinite(parsedExpires) && parsedExpires > 0
    ? parsedExpires
    : DEFAULT_DEVICE_EXPIRES_SECONDS) * 1000;
  const deadline = now() + expiresMs;

  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { state: "expired" };
    await sleepImpl(Math.min(waitMs, remainingMs), { signal });
    if (signal?.aborted) throw abortError(signal);
    if (now() >= deadline) return { state: "expired" };

    const pollController = new AbortController();
    let deadlineExpired = false;
    const onCallerAbort = () => pollController.abort(signal.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      pollController.abort();
    }, Math.max(1, deadline - now()));
    let result;
    let pollResponse;
    try {
      pollResponse = await fetchImpl(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: pollController.signal,
      });
      if (now() >= deadline) {
        await awaitWithSignal(() => discardBoundedResponseBody(pollResponse), pollController.signal);
        return { state: "expired" };
      }
      if (!pollResponse.ok) {
        await awaitWithSignal(() => discardBoundedResponseBody(pollResponse), pollController.signal);
        if (now() >= deadline) return { state: "expired" };
        continue;
      }
      result = interpretPoll(await readDeviceFlowJson(
        pollResponse,
        pollController.signal,
        "Device Flow poll response",
      ));
      if (now() >= deadline) return { state: "expired" };
    } catch (error) {
      cancelResponseBody(pollResponse);
      if (signal?.aborted) throw abortError(signal);
      if (deadlineExpired || now() >= deadline) return { state: "expired" };
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
    if (result.state === "slow") {
      waitMs += 5000;
      continue;
    }
    if (result.state !== "wait") return result;
  }
}


