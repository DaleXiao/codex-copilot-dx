import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { status } from "./status.mjs";
import { debugLog } from "./log.mjs";
import { ensureGithubTokenMetadata, githubReauthMessage, githubTokenPath, importDiscoveredGithubToken } from "./auth.mjs";
import { prepareResponsesPayload } from "./image-optimization.mjs";

export {
  optimizeImageDataUrl,
  optimizeImagesInBody,
  parseImageConcurrency,
  prepareResponsesPayload,
  runWithConcurrency,
  summarizeReqBody,
} from "./image-optimization.mjs";

export const DEFAULT_API_BASE = "https://api.githubcopilot.com";
let apiBase = DEFAULT_API_BASE;

// Cache of model id -> supported_endpoints, populated from listModels(). Used to
// route requests to /responses vs /chat/completions based on real model metadata.
let modelEndpointCache = new Map();

export function cacheModelEndpoints(models) {
  const data = Array.isArray(models) ? models : models?.data;
  if (!Array.isArray(data)) return false;
  const next = new Map();
  for (const model of data) {
    const id = String(model?.id || "").trim();
    if (id && Array.isArray(model?.supported_endpoints)) {
      next.set(id, [...model.supported_endpoints]);
    }
  }
  if (!next.size) return false;
  modelEndpointCache = next;
  return true;
}

// Returns the cached supported_endpoints for a model id, or null if unknown.
export function getCachedModelEndpoints(modelId) {
  return modelEndpointCache.get(String(modelId || "").trim()) || null;
}

export function resetModelEndpointCacheForTests() {
  modelEndpointCache.clear();
}
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
  return (data && data.endpoints && typeof data.endpoints.api === "string" && data.endpoints.api)
    ? data.endpoints.api
    : DEFAULT_API_BASE;
}

export function getApiBase() {
  return apiBase;
}

export function responsesEndpointPath() {
  return "/responses";
}
const GITHUB_API = "https://api.github.com";
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

export function isRetryableUpstreamError(err, { signal } = {}) {
  if (isAbortError(err, signal)) return false;
  return RETRYABLE_UPSTREAM_ERROR_CODES.has(upstreamErrorCode(err));
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
        await resp.arrayBuffer?.().catch(() => {});
        const delay = upstreamRetryDelay(attempt, baseDelay);
        console.warn(status("warn", `upstream ${target} returned ${resp.status}; retry ${attempt + 1}/${retryCount} in ${delay}ms`));
        await sleep(delay, { signal });
        continue;
      }
      return resp;
    } catch (e) {
      debugLog(`upstream ${method} ${target} error=${describeUpstreamError(e)} attempt=${attempt + 1}/${retryCount + 1} attempt_ms=${Date.now() - attemptStart} total_ms=${Date.now() - totalStart}`);
      if (attempt >= retryCount || !isRetryableUpstreamError(e, { signal })) throw e;
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

let copilotToken = null;
let copilotTokenExpiry = 0;
let copilotTokenRefresh = null;

function getGithubToken({ home = os.homedir() } = {}) {
  const GITHUB_TOKEN_PATH = githubTokenPath(home);
  if (!fs.existsSync(GITHUB_TOKEN_PATH)) {
    throw new Error("GitHub token not found. Run codex-copilot-dx again to log in.");
  }
  const token = fs.readFileSync(GITHUB_TOKEN_PATH, "utf-8").trim();
  if (!token) throw new Error(githubReauthMessage("GitHub token file is empty."));
  return token;
}

function requestCopilotToken(ghToken, { fetchImpl = fetch, signal } = {}) {
  return fetchImpl(`${GITHUB_API}/copilot_internal/v2/token`, {
    headers: { Authorization: `token ${ghToken}`, Accept: "application/json" },
    signal,
  });
}

function cacheCopilotTokenData(data) {
  if (!data.token) throw new Error("Copilot token response missing token field");
  copilotToken = data.token;
  apiBase = parseApiBase(data);
  copilotTokenExpiry = typeof data.expires_at === "number"
    ? data.expires_at * 1000
    : Date.now() + 25 * 60 * 1000; // fallback if expires_at absent: refresh in ~25min
  console.log(status("ok", "Copilot token refreshed"));
  return copilotToken;
}

async function refreshCopilotToken({
  signal,
  home = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const ghToken = getGithubToken({ home });
  const resp = await requestCopilotToken(ghToken, { fetchImpl, signal });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      const imported = await importDiscoveredGithubToken({
        home,
        env,
        fetchImpl,
        signal,
        excludeTokens: [ghToken],
        validateSavedToken: true,
      });
      if (imported?.validation?.copilotTokenData?.token) {
        return cacheCopilotTokenData(imported.validation.copilotTokenData);
      }
      throw new Error(githubReauthMessage(`Failed to get Copilot token: ${resp.status}. The saved GitHub token may be expired, revoked, or missing Copilot access.`));
    }
    throw new Error(`Failed to get Copilot token: ${resp.status}`);
  }
  const data = await resp.json();
  await ensureGithubTokenMetadata(ghToken, { home, fetchImpl, signal });
  return cacheCopilotTokenData(data);
}

export async function getCopilotToken(options = {}) {
  if (copilotToken && Date.now() < copilotTokenExpiry - 60000) return copilotToken;
  const home = options.home || os.homedir();
  const refreshKey = githubTokenPath(home);
  if (copilotTokenRefresh?.key === refreshKey) return copilotTokenRefresh.promise;

  const promise = refreshCopilotToken(options).finally(() => {
    if (copilotTokenRefresh?.promise === promise) copilotTokenRefresh = null;
  });
  copilotTokenRefresh = { key: refreshKey, promise };
  return promise;
}

export function resetCopilotTokenForTests() {
  copilotToken = null;
  copilotTokenExpiry = 0;
  copilotTokenRefresh = null;
  apiBase = DEFAULT_API_BASE;
}

// chatReq is already converted by the adapter. The caller parses the raw Response.
export async function chatCompletions(chatReq, { signal, fetchImpl, retryOptions } = {}) {
  const token = await getCopilotToken({ signal });
  const messages = chatReq.messages || [];
  const headers = buildHeaders({
    token,
    version: getVSCodeVersion(),
    initiator: computeInitiator(messages),
    vision: computeVision(messages),
  });
  return fetchCopilotUpstream(`${getApiBase()}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatReq),
    signal,
  }, { fetchImpl, ...retryOptions });
}

export async function listModels({ signal, fetchImpl, retryOptions } = {}) {
  const token = await getCopilotToken({ signal });
  const headers = buildHeaders({
    token, version: getVSCodeVersion(), initiator: "user", vision: false,
  });
  const resp = await fetchCopilotUpstream(`${getApiBase()}/models`, { headers, signal }, { fetchImpl, ...retryOptions });
  const body = await resp.text();
  if (resp.ok) {
    try { cacheModelEndpoints(JSON.parse(body)); } catch {}
  }
  return { status: resp.status, body };
}

// Responses-only models go directly to Copilot's /responses endpoint.
export async function responses(reqBody, { signal, fetchImpl, retryOptions } = {}) {
  const token = await getCopilotToken({ signal });
  const { bodyText, bodyBytes, summary } = await prepareResponsesPayload(reqBody);
  console.log(status("info", `responses payload bytes=${bodyBytes} input_items=${summary.items} images=${summary.images}`));
  const headers = buildHeaders({
    token,
    version: getVSCodeVersion(),
    initiator: "user",
    vision: false,
  });
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Content-Length"] = String(bodyBytes);
  headers["Accept"] = reqBody.stream ? "text/event-stream" : "application/json";

  try {
    return await fetchCopilotUpstream(`${getApiBase()}${responsesEndpointPath()}`, {
      method: "POST",
      headers,
      body: bodyText,
      signal,
    }, { fetchImpl, ...retryOptions });
  } catch (e) {
    const cause = e?.cause;
    const causeText = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(": ")})` : "";
    throw new Error(`Copilot responses fetch failed: ${e.message}${causeText}`);
  }
}

export async function responsesCompact(reqBody, options = {}) {
  // GitHub Copilot accepts Codex compact payloads on the regular Responses endpoint.
  return responses(reqBody, options);
}
