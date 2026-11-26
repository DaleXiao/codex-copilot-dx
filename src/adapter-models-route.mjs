import { buildCodexModelResponse } from "./codex-model-catalog.mjs";
import { isValidModelList } from "./model-cache.mjs";
import { normalizeModelList } from "./model-catalog.mjs";
import { createRequestAbort, logRequestFailure, sendJsonError } from "./http-transport.mjs";
import { httpError } from "./http-errors.mjs";
import { parsePositiveInteger } from "./runtime-config.mjs";

const inFlightCatalogs = new WeakMap();

function modelListCanUseLastKnownGood(statusCode) {
  return [408, 425, 429].includes(statusCode) || statusCode >= 500;
}

function modelClientVersion(reqUrl) {
  try {
    return String(new URL(reqUrl || "/", "http://localhost").searchParams.get("client_version") || "").trim();
  } catch {
    return "";
  }
}

async function sendModelList(res, models, {
  codexModelCatalog,
  clientVersion = "",
  headers = {},
  rawBody,
  statusCode = 200,
  restrictToUpstream = false,
  providerCatalog,
} = {}) {
  let body = rawBody || JSON.stringify(models);
  if (clientVersion && typeof providerCatalog === "function") {
    const catalog = providerCatalog.needsNativeCatalog && codexModelCatalog?.load ? await codexModelCatalog.load({ clientVersion }) : null;
    body = JSON.stringify(providerCatalog(models, catalog));
  }
  else if (clientVersion && typeof codexModelCatalog?.load === "function") {
    let response = null;
    try {
      const codexCatalog = await codexModelCatalog.load({ clientVersion });
      response = buildCodexModelResponse({ copilotModels: models, codexCatalog, restrictToUpstream });
    } catch {}
    if (!response) {
      if (res.destroyed || res.writableEnded) return false;
      res.writeHead(503, {
        "Content-Type": "application/json",
        "Retry-After": "5",
        ...headers,
      });
      res.end(JSON.stringify({
        error: {
          message: "The Codex App model catalog is temporarily unavailable",
          type: "server_error",
          code: "ccdx_codex_model_catalog_unavailable",
        },
      }));
      return true;
    }
    body = JSON.stringify(response);
  }
  if (res.destroyed || res.writableEnded) return false;
  res.writeHead(statusCode, { "Content-Type": "application/json", ...headers });
  res.end(body);
  return true;
}

async function sendLastKnownGoodModels(res, modelRegistry, options = {}) {
  if (!isValidModelList(modelRegistry?.models) || res.destroyed || res.writableEnded) return false;
  await sendModelList(res, normalizeModelList(modelRegistry.models), {
    ...options,
    headers: { "X-CCDX-Model-Source": "last-known-good" },
  });
  return true;
}

export function serveAdapterModels(req, res, { target, codexModelRegistry, codexModelCatalog, managedBindings,
  listModelsFn, upstreamTimeoutMs, cachedModelsTimeoutMs } = {}) {
  const clientVersion = modelClientVersion(req.url);
  const selectedRegistry = target?.registry || codexModelRegistry;
  const selectedListModels = target && (target.id !== "github" || managedBindings) ? target.client.listModels : listModelsFn;
  const modelOptions = { codexModelCatalog, clientVersion, providerCatalog: target?.codexCatalog, restrictToUpstream: Boolean(target && target.id !== "github") };
  const abort = createRequestAbort(req, res);
  const currentRead = selectedRegistry && {};
  if (currentRead) inFlightCatalogs.set(selectedRegistry, currentRead);
  // Keep live discovery and explicit auth failures authoritative, but do
  // not make a usable cached picker wait the full inference timeout.
  const modelTimeoutMs = isValidModelList(selectedRegistry?.models)
    ? Math.min(upstreamTimeoutMs, parsePositiveInteger(cachedModelsTimeoutMs, 1500))
    : upstreamTimeoutMs;
  abort.setTimeout(modelTimeoutMs);
  selectedListModels({ signal: abort.signal })
    .then(async ({ status, body }) => {
      abort.clearTimeout();
      if (status >= 200 && status < 300) {
        let models;
        try {
          const parsed = JSON.parse(body);models = normalizeModelList(parsed);
          if (models !== parsed) body = JSON.stringify(models);
        } catch {}
        if (isValidModelList(models)) {
          if (currentRead && inFlightCatalogs.get(selectedRegistry) === currentRead && !abort.signal.aborted) {
            selectedRegistry.models = models;
          }
          await sendModelList(res, models, {
            ...modelOptions,
            rawBody: body,
            statusCode: status,
          });
          return;
        }
        if (await sendLastKnownGoodModels(res, selectedRegistry, modelOptions)) return;
        sendJsonError(res, httpError("Copilot models response contained no valid models", 502), 502);
        return;
      }
      if (modelListCanUseLastKnownGood(status)
        && await sendLastKnownGoodModels(res, selectedRegistry, modelOptions)) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    })
    .catch(async (e) => {
      logRequestFailure("Models", e, abort);
      if (await sendLastKnownGoodModels(res, selectedRegistry, modelOptions)) return;
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) res.writeHead(e?.statusCode || 502);
        res.end(JSON.stringify({ error: e.message }));
      }
    })
    .finally(() => abort.cleanup());
  return;
}
