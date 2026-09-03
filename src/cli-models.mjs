import os from "node:os";
import { validateGithubToken } from "./auth.mjs";
import {
  AUTH_PROFILE_CODEX,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { buildHeaders, FALLBACK_VSCODE_VERSION, parseApiBase } from "./copilot.mjs";
import { status } from "./status.mjs";
import {
  cliOutputFormat,
  cliOutputWidth,
  formatResponsiveCliTable,
  terminalCell,
} from "./cli-table.mjs";

const DEFAULT_MODELS_TIMEOUT_MS = 10000;
const SUPPORTED_ENDPOINTS = [
  ["responses", new Set(["/responses", "/v1/responses"])],
  ["chat", new Set(["/chat/completions"])],
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
    if (!id.startsWith("gpt-") || id === "codex-auto-review" || !endpoints.length || seen.has(id)) continue;
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

function readModelCredentials(home) {
  let credentials;
  try {
    credentials = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  } catch (error) {
    throw new Error(`Could not read the GitHub token: ${error.message}`);
  }
  if (credentials.valid) return credentials;
  if (!credentials.configured) throw new Error("GitHub token not found. Start ccdx once to log in.");
  if (credentials.reason === "empty_token") throw new Error("GitHub token file is empty. Start ccdx again to log in.");
  throw new Error(`GitHub token is unavailable (${credentials.reason || "unknown"}). Start ccdx again to log in.`);
}

export async function fetchLiveCopilotModels({
  home = os.homedir(),
  fetchImpl = fetch,
  timeoutMs = DEFAULT_MODELS_TIMEOUT_MS,
  vscodeVersion = FALLBACK_VSCODE_VERSION,
} = {}) {
  const credentials = readModelCredentials(home);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const validation = await validateGithubToken(credentials.token, {
      fetchImpl,
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new Error(`Live model lookup timed out after ${timeoutMs}ms`);
    if (!validation.ok) throw new Error(validationFailure(validation));

    const tokenData = validation.copilotTokenData;
    const apiBase = parseApiBase(tokenData);
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
    return { ...catalog, profile: AUTH_PROFILE_CODEX, upstreamHost: safeText(upstreamHost, "GitHub Copilot") };
  } catch (error) {
    if (controller.signal.aborted && !/timed out/.test(error?.message || "")) {
      throw new Error(`Live model lookup timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function liveCatalogHeader(catalog, { commandName, models }) {
  const responses = models.filter((model) => model.endpoints.includes("responses")).length;
  const chat = models.filter((model) => model.endpoints.includes("chat")).length;
  return [
    `${commandName} models`,
    status("ok", `Live catalog from ${safeText(catalog?.upstreamHost, "GitHub Copilot")}: ${models.length} selectable GPT models of ${Number(catalog?.advertised) || 0} advertised`),
    status("info", `Responses: ${responses}; Chat: ${chat}`),
  ];
}

function formatLiveCopilotModelsPlain(catalog, { commandName, models }, { sanitize = false } = {}) {
  const lines = liveCatalogHeader(catalog, { commandName, models });
  if (!models.length) {
    lines.push(status("warn", "No selectable GPT models were advertised for this account"));
    return (sanitize ? lines.map((line) => terminalCell(line, { fallback: "" })) : lines).join("\n");
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
  return (sanitize ? lines.map((line) => terminalCell(line, { fallback: "" })) : lines).join("\n");
}

export function formatLiveCopilotModels(catalog, {
  commandName = "ccdx",
  format = "plain",
  output = process.stdout,
  width = cliOutputWidth(output),
} = {}) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const context = { commandName, models };
  if (cliOutputFormat(format, output) === "plain") {
    return formatLiveCopilotModelsPlain(catalog, context);
  }

  const lines = liveCatalogHeader(catalog, context);
  if (!models.length) {
    lines.push(status("warn", "No selectable GPT models were advertised for this account"));
    return lines.join("\n");
  }

  const rows = models.map((model) => ({
    vendor: model.vendor,
    model: model.id,
    vendorModel: `${model.vendor}/${model.id}`,
    apis: model.endpoints.join(", "),
    preview: model.preview ? "yes" : "no",
  }));
  const table = formatResponsiveCliTable({
    columns: [
      { key: "vendor", label: "VENDOR" },
      { key: "model", label: "MODEL" },
      { key: "apis", label: "APIS" },
      { key: "preview", label: "PREVIEW" },
    ],
    compactColumns: [
      { key: "vendorModel", label: "VENDOR/MODEL" },
      { key: "apis", label: "APIS" },
      { key: "preview", label: "PREVIEW" },
    ],
    rows,
    width,
  });
  if (format === "auto" && table.overflow) {
    return formatLiveCopilotModelsPlain(catalog, context, { sanitize: true });
  }
  lines.push("", table.output);
  return lines.join("\n");
}
