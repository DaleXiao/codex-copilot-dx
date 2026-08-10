import os from "node:os";
import { validateGithubToken } from "./auth.mjs";
import {
  AUTH_PROFILE_CLAUDE,
  AUTH_PROFILE_CODEX,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { buildHeaders, DEFAULT_API_BASE, FALLBACK_VSCODE_VERSION } from "./copilot.mjs";
import {
  isClaudeCopilotCatalogEntry,
  isClaudeCopilotModel,
} from "./models.mjs";
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
    if (isClaudeCopilotCatalogEntry(model)) {
      if (!isClaudeCopilotModel(model)) continue;
    } else {
      if (model?.model_picker_enabled !== true) continue;
      const policyState = safeText(model?.policy?.state).toLowerCase();
      if (policyState && policyState !== "enabled") continue;
      const capabilityType = safeText(model?.capabilities?.type).toLowerCase();
      if (capabilityType && capabilityType !== "chat") continue;
    }

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

function readModelProfile(profile, home) {
  const requested = String(profile || AUTH_PROFILE_CODEX).trim().toLowerCase();
  if (requested !== AUTH_PROFILE_CODEX && requested !== AUTH_PROFILE_CLAUDE) {
    throw new Error(`Unsupported models profile: ${profile}`);
  }

  let credentials;
  try {
    credentials = readAuthProfileCredentials(requested, { home });
  } catch (error) {
    const label = requested === AUTH_PROFILE_CLAUDE ? "Claude GitHub profile" : "GitHub token";
    throw new Error(`Could not read the ${label}: ${error.message}`);
  }
  if (credentials.valid) return credentials;

  if (requested === AUTH_PROFILE_CLAUDE) {
    if (!credentials.configured) {
      throw new Error("Claude GitHub profile is not configured. Run ccdx auth login claude.");
    }
    throw new Error(`Claude GitHub profile is invalid (${credentials.reason || "unknown"}). Run ccdx auth login claude --reauth.`);
  }
  if (!credentials.configured) throw new Error("GitHub token not found. Start ccdx once to log in.");
  if (credentials.reason === "empty_token") throw new Error("GitHub token file is empty. Start ccdx again to log in.");
  throw new Error(`GitHub token is unavailable (${credentials.reason || "unknown"}). Start ccdx again to log in.`);
}

export async function fetchLiveCopilotModels({
  home = os.homedir(),
  profile = AUTH_PROFILE_CODEX,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_MODELS_TIMEOUT_MS,
  vscodeVersion = FALLBACK_VSCODE_VERSION,
} = {}) {
  const credentials = readModelProfile(profile, home);
  const githubToken = credentials.token;

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
    return { ...catalog, profile: credentials.profile, upstreamHost: safeText(upstreamHost, "GitHub Copilot") };
  } catch (error) {
    if (controller.signal.aborted && !/timed out/.test(error?.message || "")) {
      throw new Error(`Live model lookup timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function liveCatalogHeader(catalog, { commandName, profile, models }) {
  const responses = models.filter((model) => model.endpoints.includes("responses")).length;
  const chat = models.filter((model) => model.endpoints.includes("chat")).length;
  const claude = models.filter(isClaudeCopilotCatalogEntry).length;
  return [
    `${commandName} models${profile === AUTH_PROFILE_CLAUDE ? " --profile claude" : ""}`,
    status("ok", `Live catalog from ${safeText(catalog?.upstreamHost, "GitHub Copilot")}: ${models.length} selectable of ${Number(catalog?.advertised) || 0} advertised`),
    status("info", `Responses: ${responses}; Chat: ${chat}; Claude/Anthropic: ${claude}`),
  ];
}

function formatLiveCopilotModelsPlain(catalog, { commandName, profile, models }, { sanitize = false } = {}) {
  const lines = liveCatalogHeader(catalog, { commandName, profile, models });
  if (!models.length) {
    lines.push(status("warn", "No selectable models were advertised for this account"));
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
  const profile = catalog?.profile === AUTH_PROFILE_CLAUDE ? AUTH_PROFILE_CLAUDE : AUTH_PROFILE_CODEX;
  const context = { commandName, profile, models };
  if (cliOutputFormat(format, output) === "plain") {
    return formatLiveCopilotModelsPlain(catalog, context);
  }

  const lines = liveCatalogHeader(catalog, context);
  if (!models.length) {
    lines.push(status("warn", "No selectable models were advertised for this account"));
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
