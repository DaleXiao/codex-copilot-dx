import { CODEX_AUTO_REVIEW_MODEL } from "./models.mjs";
import { readBoundedResponseText } from "./upstream-body.mjs";
import { readClientGatewayKeys } from "./client-gateway-keys.mjs";
import { isLoopbackHost } from "./security.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

function localGatewayBaseUrl(host, port) {
  const normalized = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const address = normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
  return `http://${address}:${port}`;
}

function copilotModelData(models) {
  const data = Array.isArray(models) ? models : models?.data;
  return Array.isArray(data) ? data : [];
}

function modelEndpoints(model) {
  return Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
}

export function selectCompatibilityModels(models) {
  const candidates = copilotModelData(models)
    .filter((model) => model?.model_picker_enabled !== false)
    .filter((model) => {
      const endpoints = modelEndpoints(model);
      return endpoints.includes("/responses") || endpoints.includes("/v1/responses");
    });
  const responsesOnly = [...candidates].reverse()
    .find((model) => !modelEndpoints(model).includes("/chat/completions"));
  return { responsesModel: String((responsesOnly || candidates[0])?.id || "") };
}

async function fetchTextWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    return { resp, text: await readBoundedResponseText(resp, { maxBytes: 4 * 1024 * 1024, signal: controller.signal, label: "Doctor response" }) };
  } finally {
    clearTimeout(timer);
  }
}

function responseFailure(resp, text) {
  const detail = redactDiagnosticText(String(text || "")).replace(/\s+/g, " ").trim().slice(0, 240);
  return new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
}

async function compatibilityRequest(fetchImpl, url, body, timeoutMs, headers) {
  const { resp, text } = await fetchTextWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Accept: body.stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!resp.ok) throw responseFailure(resp, text);
  return text;
}

async function runCompatibilityCheck(checks, label, task) {
  const started = Date.now();
  try {
    const value = await task();
    checks.push({ kind: "ok", message: `${label} passed (${Date.now() - started}ms)` });
    return value;
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timed out" : error?.message || "unknown error";
    checks.push({ kind: "err", message: `${label} failed: ${reason}` });
    return null;
  }
}

function parseResponseObject(text) {
  const response = JSON.parse(text);
  if (!response?.id || !Array.isArray(response.output)) throw new Error("response body is missing id or output");
  if (response.object !== "response.compaction" && response.status !== "completed") {
    throw new Error("model response did not complete successfully");
  }
  return response;
}

function parseCompactionResponse(text) {
  const response = parseResponseObject(text);
  if (response.object !== "response.compaction"
    || !response.output.some((item) => item?.type === "compaction")) {
    throw new Error("response body is missing valid compaction state");
  }
  return response;
}

export async function inspectAdapterCompatibility({
  host = "127.0.0.1",
  port = 2026,
  fetchImpl = fetch,
  timeoutMs = 120000,
  home, env = process.env,
} = {}) {
  const baseUrl = localGatewayBaseUrl(host, port);
  let headers = {};
  if (isLoopbackHost(new URL(baseUrl).hostname)) {
    try { headers = { Authorization: `Bearer ${readClientGatewayKeys({ home, env, create: false }).codex}` }; } catch { /* Unconfigured credentials remain a normal access-check failure. */ }
  }
  const checks = [];
  const models = await runCompatibilityCheck(checks, "Compatibility model discovery", async () => {
    const { resp, text } = await fetchTextWithTimeout(fetchImpl, `${baseUrl}/v1/models`, { headers: { ...headers, Accept: "application/json" } }, timeoutMs);
    if (!resp.ok) throw responseFailure(resp, text);
    const parsed = JSON.parse(text);
    if (!copilotModelData(parsed).length) throw new Error("model list is empty");
    return parsed;
  });
  if (!models) return checks;

  const { responsesModel } = selectCompatibilityModels(models);
  if (!responsesModel) {
    checks.push({ kind: "err", message: "Compatibility Responses check failed: no selected model advertises /responses" });
    return checks;
  }

  await runCompatibilityCheck(checks, "Codex Auto-review", async () => {
    const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses`, {
      model: CODEX_AUTO_REVIEW_MODEL,
      stream: false,
      input: "Reply with OK only.",
    }, timeoutMs, headers);
    parseResponseObject(text);
  });

  const firstResponse = await runCompatibilityCheck(checks, `Native Responses (${responsesModel})`, async () => {
    const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses`, {
      model: responsesModel,
      stream: false,
      input: "Reply with OK only.",
    }, timeoutMs, headers);
    return parseResponseObject(text);
  });

  if (firstResponse) {
    await runCompatibilityCheck(checks, "Responses stream and history compatibility", async () => {
      const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses`, {
        model: responsesModel,
        stream: true,
        previous_response_id: firstResponse.id,
        input: "Reply with OK again.",
      }, timeoutMs, headers);
      const events = text.split(/\r?\n\r?\n/).map(block => {
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
        try { return JSON.parse(data); } catch { return null; }
      }).filter(Boolean);
      const terminals = events.filter(event => ["response.completed", "response.failed", "response.incomplete", "response.cancelled", "error"].includes(event.type));
      if (terminals.length !== 1 || terminals[0].type !== "response.completed"
        || terminals[0].response?.status !== "completed") throw new Error("stream did not finish with one valid response.completed");
      parseResponseObject(JSON.stringify(terminals[0].response));
    });
  }

  await runCompatibilityCheck(checks, "Responses compact", async () => {
    const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses/compact`, {
      model: responsesModel,
      stream: false,
      input: "Compact this short context.",
    }, timeoutMs, headers);
    parseCompactionResponse(text);
  });

  return checks;
}
