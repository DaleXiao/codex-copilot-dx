import { randomUUID } from "node:crypto";
import { status } from "./status.mjs";
import { debugLog } from "./log.mjs";
import { createCopilotClientRuntime } from "./copilot-client.mjs";
import { discardBoundedResponseBody } from "./http-transport.mjs";

export {
  optimizeImageDataUrl,
  optimizeImagesInBody,
  createTaskLimiter,
  parseImageConcurrency,
  prepareResponsesPayload,
  runWithConcurrency,
  summarizeReqBody,
} from "./image-optimization.mjs";

export const DEFAULT_API_BASE = "https://api.githubcopilot.com";
const DEFAULT_UPSTREAM_RETRIES = 2;
const MAX_UPSTREAM_RETRIES = 5;
const DEFAULT_UPSTREAM_RETRY_DELAY_MS = 300;
const MAX_UPSTREAM_RETRY_DELAY_MS = 5000;
const UPSTREAM_RETRIES = parseUpstreamRetries(process.env.CCDX_UPSTREAM_RETRIES);
const UPSTREAM_RETRY_DELAY_MS = parseUpstreamRetryDelayMs(process.env.CCDX_UPSTREAM_RETRY_DELAY_MS);

export function parseUpstreamRetries(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_UPSTREAM_RETRIES) : DEFAULT_UPSTREAM_RETRIES;
}

export function parseUpstreamRetryDelayMs(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_UPSTREAM_RETRY_DELAY_MS) : DEFAULT_UPSTREAM_RETRY_DELAY_MS;
}

export function parseApiBase(data) {
  const configured = data?.endpoints?.api;
  if (typeof configured !== "string" || !configured.trim()) return DEFAULT_API_BASE;
  let parsed;
  try {
    parsed = new URL(configured.trim());
  } catch {
    throw Object.assign(new Error("Copilot API endpoint is invalid"), {
      code: "CCDX_INVALID_COPILOT_API_ENDPOINT",
    });
  }
  if (parsed.protocol !== "https:"
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw Object.assign(new Error("Copilot API endpoint is invalid"), {
      code: "CCDX_INVALID_COPILOT_API_ENDPOINT",
    });
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname && pathname !== "/" ? pathname : ""}`;
}

export function responsesEndpointPath() {
  return "/responses";
}
const RETRYABLE_UPSTREAM_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
]);
const RETRYABLE_POST_CONNECT_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
]);
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 502, 503, 504]);

function upstreamTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

function upstreamErrorCode(err) {
  return err?.cause?.code || err?.code || "";
}

function isAbortError(err, signal) {
  return signal?.aborted || err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (!signal) return;
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requestMethod(init = {}) {
  return String(init.method || "GET").toUpperCase();
}

export function isRetryableUpstreamError(err, { signal, method = "GET" } = {}) {
  if (isAbortError(err, signal)) return false;
  const code = upstreamErrorCode(err);
  if (!["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase())) {
    const syscall = err?.cause?.syscall || err?.syscall || "";
    return RETRYABLE_POST_CONNECT_ERROR_CODES.has(code)
      || (syscall === "connect" && ["ETIMEDOUT", "ECONNRESET"].includes(code));
  }
  return RETRYABLE_UPSTREAM_ERROR_CODES.has(code);
}

export function isRetryableUpstreamStatus(status, method = "GET") {
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
  return safeMethod && RETRYABLE_UPSTREAM_STATUSES.has(status);
}

function upstreamRetryDelay(attempt, baseDelayMs) {
  return Math.min(baseDelayMs * (2 ** attempt), MAX_UPSTREAM_RETRY_DELAY_MS);
}

function describeUpstreamError(err) {
  const code = upstreamErrorCode(err);
  return [code, err?.cause?.message || err?.message].filter(Boolean).join(": ") || "network error";
}

export async function fetchCopilotUpstream(
  url,
  init = {},
  {
    fetchImpl = fetch,
    retries = UPSTREAM_RETRIES,
    retryDelayMs = UPSTREAM_RETRY_DELAY_MS,
  } = {},
) {
  const retryCount = parseUpstreamRetries(retries);
  const baseDelay = parseUpstreamRetryDelayMs(retryDelayMs);
  const method = requestMethod(init);
  const signal = init.signal;
  const target = upstreamTarget(url);
  const totalStart = Date.now();

  for (let attempt = 0; ; attempt += 1) {
    const attemptStart = Date.now();
    debugLog(`upstream ${method} ${target} attempt=${attempt + 1}/${retryCount + 1}`);
    try {
      const resp = await fetchImpl(url, init);
      debugLog(`upstream ${method} ${target} status=${resp.status} attempt=${attempt + 1}/${retryCount + 1} attempt_ms=${Date.now() - attemptStart} total_ms=${Date.now() - totalStart}`);
      if (attempt < retryCount && isRetryableUpstreamStatus(resp.status, method)) {
        await discardBoundedResponseBody(resp);
        const delay = upstreamRetryDelay(attempt, baseDelay);
        console.warn(status("warn", `upstream ${target} returned ${resp.status}; retry ${attempt + 1}/${retryCount} in ${delay}ms`));
        await sleep(delay, { signal });
        continue;
      }
      return resp;
    } catch (e) {
      debugLog(`upstream ${method} ${target} error=${describeUpstreamError(e)} attempt=${attempt + 1}/${retryCount + 1} attempt_ms=${Date.now() - attemptStart} total_ms=${Date.now() - totalStart}`);
      if (attempt >= retryCount || !isRetryableUpstreamError(e, { signal, method })) throw e;
      const delay = upstreamRetryDelay(attempt, baseDelay);
      console.warn(status("warn", `upstream ${target} ${describeUpstreamError(e)}; retry ${attempt + 1}/${retryCount} in ${delay}ms`));
      await sleep(delay, { signal });
    }
  }
}

export function computeInitiator(messages) {
  const isAgent = Array.isArray(messages)
    && messages.some((m) => m && ["assistant", "tool"].includes(m.role));
  return isAgent ? "agent" : "user";
}

export function computeVision(messages) {
  return Array.isArray(messages) && messages.some(
    (m) => m && typeof m.content !== "string"
      && Array.isArray(m.content)
      && m.content.some((p) => p && p.type === "image_url"),
  );
}

export function buildHeaders({ token, version, initiator, vision }) {
  const h = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": `vscode/${version}`,
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "Openai-Intent": "conversation-panel",
    "X-Github-Api-Version": "2025-04-01",
    "X-Request-Id": randomUUID(),
    "X-Vscode-User-Agent-Library-Version": "electron-fetch",
    "X-Initiator": initiator,
  };
  if (vision) h["Copilot-Vision-Request"] = "true";
  return h;
}

export const FALLBACK_VSCODE_VERSION = "1.122.1";

let cachedVersion = FALLBACK_VSCODE_VERSION;

export function parseVSCodeVersion(json) {
  return (json && typeof json.productVersion === "string" && json.productVersion)
    ? json.productVersion
    : FALLBACK_VSCODE_VERSION;
}

export function getVSCodeVersion() {
  return cachedVersion;
}

// Refresh the VS Code version asynchronously; keep the fallback on failure.
export async function refreshVSCodeVersion() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(
      "https://update.code.visualstudio.com/api/update/darwin-arm64/stable/latest",
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (resp.ok) {
      cachedVersion = parseVSCodeVersion(await resp.json());
      console.log(status("info", `VS Code version: ${cachedVersion}`));
    }
  } catch {
    // Keep the fallback quietly.
  }
  return cachedVersion;
}

// Stateful Copilot data lives inside client instances. These module-level
// wrappers preserve every existing export as the default Codex compatibility
// layer while retaining isolated client injection for internal callers.
export function createCopilotClient(options = {}) {
  return createCopilotClientRuntime({
    ...options,
    defaultApiBase: DEFAULT_API_BASE,
    parseApiBase,
    fetchCopilotUpstream,
    buildHeaders,
    getVSCodeVersion,
    computeInitiator,
    computeVision,
    responsesEndpointPath,
  });
}

export const defaultCopilotClient = createCopilotClient({ profile: "codex" });

export function cacheModelEndpoints(models) {
  return defaultCopilotClient.cacheModelEndpoints(models);
}

export function getCachedModelEndpoints(modelId) {
  return defaultCopilotClient.getCachedModelEndpoints(modelId);
}

export function resetModelEndpointCacheForTests() {
  return defaultCopilotClient.resetModelEndpointCacheForTests();
}

export function getApiBase() {
  return defaultCopilotClient.getApiBase();
}

export function copilotRuntimeStatus(now = Date.now()) {
  return defaultCopilotClient.runtimeStatus(now);
}

export function getCopilotToken(options = {}) {
  return defaultCopilotClient.getCopilotToken(options);
}

export function resetCopilotTokenForTests() {
  defaultCopilotClient.resetTokenForTests();
  defaultCopilotClient.resetModelListSingleflightForTests();
}

export function chatCompletions(chatReq, options = {}) {
  return defaultCopilotClient.chatCompletions(chatReq, options);
}

export function listModels(options = {}) {
  return defaultCopilotClient.listModels(options);
}

export function resetModelListSingleflightForTests() {
  return defaultCopilotClient.resetModelListSingleflightForTests();
}

export function responses(reqBody, options = {}) {
  return defaultCopilotClient.responses(reqBody, options);
}

export function responsesCompact(reqBody, options = {}) {
  return defaultCopilotClient.responsesCompact(reqBody, options);
}
