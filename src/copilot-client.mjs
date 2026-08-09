import { createCopilotTokenSession } from "./copilot-token-session.mjs";
import { prepareResponsesPayload, summarizeReqBody } from "./image-optimization.mjs";
import { debugLog } from "./log.mjs";
import { enforceResponsesPayloadByteBudget } from "./responses-byte-budget.mjs";
import { status } from "./status.mjs";
import { withChatStreamUsage } from "./stream-contract.mjs";
import { markUpstreamStarted } from "./stream-performance.mjs";

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function waitForSingleflight(flight, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  flight.waiters += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (handler, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      if (!flight.settled && flight.waiters === 0) flight.controller.abort();
      handler(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    flight.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

export function createCopilotClientRuntime({
  profile = "codex",
  defaultApiBase,
  parseApiBase,
  fetchCopilotUpstream,
  buildHeaders,
  getVSCodeVersion,
  computeInitiator,
  computeVision,
  responsesEndpointPath,
  ...sessionOptions
} = {}) {
  const tokenSession = createCopilotTokenSession({
    ...sessionOptions,
    profile,
    defaultApiBase,
    parseApiBase,
    fetchCopilotUpstream,
  });
  let modelEndpointCache = new Map();
  const modelListFlights = new Map();

  function cacheModelEndpoints(models) {
    const data = Array.isArray(models) ? models : models?.data;
    if (!Array.isArray(data)) return false;
    const next = new Map();
    for (const model of data) {
      const id = String(model?.id || "").trim();
      if (id && Array.isArray(model?.supported_endpoints)) next.set(id, [...model.supported_endpoints]);
    }
    if (!next.size) return false;
    modelEndpointCache = next;
    return true;
  }

  function getCachedModelEndpoints(modelId) {
    return modelEndpointCache.get(String(modelId || "").trim()) || null;
  }

  function resetModelEndpointCacheForTests() {
    modelEndpointCache.clear();
  }

  async function chatCompletions(chatReq, {
    signal,
    fetchImpl,
    retryOptions,
    bodyText,
    onUpstreamStart,
  } = {}) {
    const token = await tokenSession.getToken({ signal });
    const upstreamReq = chatReq.stream === true ? withChatStreamUsage(chatReq) : chatReq;
    const messages = upstreamReq.messages || [];
    const serializedBody = typeof bodyText === "string" && upstreamReq === chatReq
      ? bodyText
      : JSON.stringify(upstreamReq);
    const headers = buildHeaders({
      token,
      version: getVSCodeVersion(),
      initiator: computeInitiator(messages),
      vision: computeVision(messages),
    });
    headers["Content-Length"] = String(Buffer.byteLength(serializedBody));
    onUpstreamStart?.();
    if (upstreamReq.stream === true) markUpstreamStarted();
    return fetchCopilotUpstream(`${tokenSession.getApiBase()}/chat/completions`, {
      method: "POST",
      headers,
      body: serializedBody,
      signal,
    }, { fetchImpl, ...retryOptions });
  }

  async function fetchModels({ signal, fetchImpl, retryOptions }) {
    const token = await tokenSession.getToken({ signal });
    const headers = buildHeaders({ token, version: getVSCodeVersion(), initiator: "user", vision: false });
    const response = await fetchCopilotUpstream(`${tokenSession.getApiBase()}/models`, {
      headers,
      signal,
    }, { fetchImpl, ...retryOptions });
    const body = await response.text();
    if (response.ok) {
      try { cacheModelEndpoints(JSON.parse(body)); } catch {}
    }
    return { status: response.status, body };
  }

  function listModels({ signal, fetchImpl = fetch, retryOptions } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    let flight = modelListFlights.get(fetchImpl);
    if (flight?.controller.signal.aborted) {
      modelListFlights.delete(fetchImpl);
      flight = null;
    }
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, waiters: 0, settled: false, promise: null };
      flight.promise = fetchModels({ signal: controller.signal, fetchImpl, retryOptions })
        .finally(() => {
          flight.settled = true;
          if (modelListFlights.get(fetchImpl) === flight) modelListFlights.delete(fetchImpl);
        });
      modelListFlights.set(fetchImpl, flight);
    }
    return waitForSingleflight(flight, signal);
  }

  function resetModelListSingleflightForTests() {
    for (const flight of modelListFlights.values()) flight.controller.abort();
    modelListFlights.clear();
  }

  async function responses(reqBody, {
    signal,
    fetchImpl,
    retryOptions,
    currentInputStart = 0,
    onUpstreamStart,
    payloadPrepared = false,
    payloadOptions = {},
  } = {}) {
    const token = await tokenSession.getToken({ signal });
    const preparedPayload = await prepareResponsesPayload(reqBody, {
      ...payloadOptions,
      currentInputStart,
      profiles: payloadPrepared ? [] : payloadOptions.profiles,
      skipInitialOptimization: payloadPrepared || payloadOptions.skipInitialOptimization,
      signal,
    });
    const finalizedPayload = enforceResponsesPayloadByteBudget(reqBody, preparedPayload);
    const { bodyText, bodyBytes, stage, adapted } = finalizedPayload;
    const summary = finalizedPayload.stage === preparedPayload.stage
      ? preparedPayload.summary
      : summarizeReqBody(reqBody);
    console.log(status("info", `responses payload bytes=${bodyBytes} input_items=${summary.items} images=${summary.images}`));
    if (adapted) debugLog(`responses payload adapted stage=${stage} bytes=${bodyBytes}/${preparedPayload.targetBytes}`);
    const headers = buildHeaders({ token, version: getVSCodeVersion(), initiator: "user", vision: false });
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers["Content-Length"] = String(bodyBytes);
    headers.Accept = reqBody.stream ? "text/event-stream" : "application/json";
    try {
      onUpstreamStart?.();
      if (reqBody.stream === true) markUpstreamStarted();
      return await fetchCopilotUpstream(`${tokenSession.getApiBase()}${responsesEndpointPath()}`, {
        method: "POST",
        headers,
        body: bodyText,
        signal,
      }, { fetchImpl, ...retryOptions });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const cause = error?.cause;
      const causeText = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(": ")})` : "";
      throw new Error(`Copilot responses fetch failed: ${error.message}${causeText}`);
    }
  }

  function responsesCompact(reqBody, options = {}) {
    return responses(reqBody, options);
  }

  function runtimeStatus(now = Date.now()) {
    return {
      ...tokenSession.runtimeStatus(now),
      model_endpoint_cache_entries: modelEndpointCache.size,
      model_list_flights: modelListFlights.size,
    };
  }

  function resetForTests() {
    tokenSession.resetForTests();
    resetModelEndpointCacheForTests();
    resetModelListSingleflightForTests();
  }

  return Object.freeze({
    profile,
    cacheModelEndpoints,
    getCachedModelEndpoints,
    resetModelEndpointCacheForTests,
    getApiBase: tokenSession.getApiBase,
    runtimeStatus,
    getCopilotToken: tokenSession.getToken,
    resetTokenForTests: tokenSession.resetForTests,
    chatCompletions,
    listModels,
    resetModelListSingleflightForTests,
    responses,
    responsesCompact,
    resetForTests,
  });
}
