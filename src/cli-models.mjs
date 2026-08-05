import fs from "node:fs";
import os from "node:os";
import { githubTokenPath, validateGithubToken } from "./auth.mjs";
import { buildHeaders, DEFAULT_API_BASE, FALLBACK_VSCODE_VERSION } from "./copilot.mjs";
import { status } from "./status.mjs";

const DEFAULT_MODELS_TIMEOUT_MS = 10000;
const SUPPORTED_ENDPOINTS = [
  ["responses", new Set(["/responses", "/v1/responses"])],
  ["chat", new Set(["/chat/completions"])],
  ["messages", new Set(["/v1/messages"])],
];

function safeText(value, fallback = "") {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function endpointLabels(model) {
  const advertised = new Set(Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : []);
  return SUPPORTED_ENDPOINTS
    .filter(([, values]) => [...values].some((value) => advertised.has(value)))
    .map(([label]) => label);
}

export function selectableCopilotModels(payload) {
  const data = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(data)) throw new Error("Copilot models response contained no model list");

  const models = [];
  const seen = new Set();
  for (const model of data) {
    if (model?.model_picker_enabled !== true) continue;
    const policyState = safeText(model?.policy?.state).toLowerCase();
    if (policyState && policyState !== "enabled") continue;
    const capabilityType = safeText(model?.capabilities?.type).toLowerCase();
    if (capabilityType && capabilityType !== "chat") continue;

    const id = safeText(model?.id);
    const endpoints = endpointLabels(model);
    if (!id || id === "codex-auto-review" || !endpoints.length || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      vendor: safeText(model?.vendor || model?.owned_by, "Unknown"),
      endpoints,
      preview: model?.preview === true,
    });
  }

  models.sort((left, right) => left.vendor.localeCompare(right.vendor, "en")
    || left.id.localeCompare(right.id, "en"));
  return { advertised: data.length, models };
}

function validationFailure(validation) {
  const httpStatus = validation?.status ? ` (HTTP ${validation.status})` : "";
  return `GitHub Copilot authentication failed: ${validation?.reason || "unknown error"}${httpStatus}`;
}

async function responseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export async function fetchLiveCopilotModels({
  home = os.homedir(),
  fetchImpl = fetch,
  timeoutMs = DEFAULT_MODELS_TIMEOUT_MS,
  vscodeVersion = FALLBACK_VSCODE_VERSION,
} = {}) {
  const tokenPath = githubTokenPath(home);
  let githubToken;
  try {
    githubToken = fs.readFileSync(tokenPath, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("GitHub token not found. Start ccdx once to log in.");
    throw new Error(`Could not read the GitHub token: ${error.message}`);
  }
  if (!githubToken) throw new Error("GitHub token file is empty. Start ccdx again to log in.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const validation = await validateGithubToken(githubToken, {
      fetchImpl,
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new Error(`Live model lookup timed out after ${timeoutMs}ms`);
    if (!validation.ok) throw new Error(validationFailure(validation));

    const tokenData = validation.copilotTokenData;
    const apiBase = tokenData.endpoints?.api || DEFAULT_API_BASE;
    const headers = buildHeaders({
      token: tokenData.token,
      version: vscodeVersion,
      initiator: "user",
      vision: false,
    });
    const response = await fetchImpl(`${apiBase}/models`, {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const body = await responseText(response);
    if (!response.ok) {
      const detail = safeText(body).slice(0, 240);
      throw new Error(`Copilot models endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("Copilot models endpoint returned invalid JSON");
    }
    const catalog = selectableCopilotModels(payload);
    let upstreamHost = "GitHub Copilot";
    try { upstreamHost = new URL(apiBase).hostname; } catch {}
    return { ...catalog, upstreamHost: safeText(upstreamHost, "GitHub Copilot") };
  } catch (error) {
    if (controller.signal.aborted && !/timed out/.test(error?.message || "")) {
      throw new Error(`Live model lookup timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function formatLiveCopilotModels(catalog, { commandName = "ccdx" } = {}) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const responses = models.filter((model) => model.endpoints.includes("responses")).length;
  const chat = models.filter((model) => model.endpoints.includes("chat")).length;
  const claude = models.filter((model) => model.id.toLowerCase().startsWith("claude-")
    || model.vendor.toLowerCase() === "anthropic").length;
  const lines = [
    `${commandName} models`,
    status("ok", `Live catalog from ${safeText(catalog?.upstreamHost, "GitHub Copilot")}: ${models.length} selectable of ${Number(catalog?.advertised) || 0} advertised`),
    status("info", `Responses: ${responses}; Chat: ${chat}; Claude/Anthropic: ${claude}`),
  ];

  if (!models.length) {
    lines.push(status("warn", "No selectable models were advertised for this account"));
    return lines.join("\n");
  }

  let vendor = "";
  for (const model of models) {
    if (model.vendor !== vendor) {
      vendor = model.vendor;
      lines.push("", `${vendor}:`);
    }
    const flags = [...model.endpoints, ...(model.preview ? ["preview"] : [])];
    lines.push(`  ${model.id} [${flags.join(", ")}]`);
  }
  return lines.join("\n");
}
