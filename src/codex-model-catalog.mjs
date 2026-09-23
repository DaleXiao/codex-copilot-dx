import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_GPT6_MODEL } from "./models.mjs";

// Compatibility metadata is derived from OpenAI Codex's public models catalog
// at commit 0a2eb4696c26ac33204bcd255721ab30220a4774. The installed client's
// GPT-6 Astra entry supplies its own schema and instructions; these overrides
// describe only the two new model identities and capability differences.
const GPT6_COMPATIBILITY_SPECS = new Map([
  ["gpt-6-sol", Object.freeze({
    display_name: "GPT-6-Sol",
    description: "Workhorse model for coding and everyday work.",
    default_reasoning_level: "medium",
    shell_type: "shell_command",
    priority: 2,
    node_repl_auto_review_required: true,
  })],
  ["gpt-6-luna", Object.freeze({
    display_name: "GPT-6-Luna",
    description: "Fast and affordable model for easier tasks.",
    default_reasoning_level: "medium",
    shell_type: "shell_command",
    priority: 3,
    node_repl_auto_review_required: false,
  })],
]);
const MANAGED_GPT6_MODELS = new Set([CODEX_GPT6_MODEL, ...GPT6_COMPATIBILITY_SPECS.keys()]);

export { CODEX_GPT6_MODEL };

export const CODEX_APP_BINARY_PATHS = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
  path.join(os.homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
];
export const CODEX_MODEL_CATALOG_TIMEOUT_MS = 5_000;
export const CODEX_MODEL_CATALOG_MAX_BUFFER = 8 * 1024 * 1024;
export const CODEX_MODEL_CATALOG_FAILURE_BACKOFF_MS = 5_000;

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codexCatalogIsValid(catalog) {
  if (!objectRecord(catalog) || !Array.isArray(catalog.models) || catalog.models.length === 0) return false;
  const slugs = new Set();
  for (const model of catalog.models) {
    const slug = String(model?.slug || "").trim();
    if (!objectRecord(model) || !slug || slugs.has(slug)) return false;
    slugs.add(slug);
  }
  return true;
}

function copilotModelData(models) {
  if (!objectRecord(models) || !Array.isArray(models.data) || models.data.length === 0) return null;
  return models.data;
}

function supportsResponses(model) {
  const endpoints = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
  return endpoints.includes("/responses") || endpoints.includes("/v1/responses");
}

function isEligibleOpenAIModel(model, id) {
  const vendor = String(model?.vendor || model?.owned_by || "").trim().toLowerCase();
  return String(model?.id || "").trim() === id
    && vendor === "openai"
    && String(model?.policy?.state || "").trim().toLowerCase() === "enabled"
    && model?.model_picker_enabled === true
    && supportsResponses(model);
}

export function isEligibleCopilotGpt6(copilotModels, id = CODEX_GPT6_MODEL) {
  const data = copilotModelData(copilotModels);
  if (!data) return false;
  const matches = data.filter((model) => String(model?.id || "").trim() === id);
  return matches.length === 1 && isEligibleOpenAIModel(matches[0], id);
}

function copilotModel(copilotModels, id) {
  return copilotModelData(copilotModels)?.find((model) => String(model?.id || "").trim() === id);
}

function advertisedReasoningEfforts(model) {
  const values = model?.capabilities?.supports?.reasoning_effort;
  return new Set(Array.isArray(values) ? values.map((value) => String(value)) : []);
}

function catalogModelForCopilot(model, copilotModels, { filterReasoning = false } = {}) {
  const upstream = copilotModel(copilotModels, model.slug);
  const reasoning = advertisedReasoningEfforts(upstream);
  const patched = {
    ...structuredClone(model),
    visibility: "list",
    supported_reasoning_levels: filterReasoning && reasoning.size
      ? model.supported_reasoning_levels.filter(({ effort }) => reasoning.has(effort))
      : model.supported_reasoning_levels,
  };
  // The Codex catalog describes ChatGPT service tiers. Copilot must advertise
  // an exact fast model before CCDX exposes the corresponding selector.
  if (!isEligibleCopilotGpt6(copilotModels, `${model.slug}-fast`)) {
    patched.additional_speed_tiers = [];
    patched.service_tiers = [];
    delete patched.default_service_tier;
  }
  return patched;
}

function compatibilityModel(codexCatalog, slug) {
  const astra = codexCatalog.models.find((model) => model.slug === CODEX_GPT6_MODEL);
  const spec = GPT6_COMPATIBILITY_SPECS.get(slug);
  if (!astra || !spec) return null;
  return {
    ...structuredClone(astra),
    ...spec,
    slug,
    supports_parallel_tool_calls: true,
    multi_agent_reasoning_effort: null,
    supports_experimental_context: false,
    minimal_client_version: "0.155.0",
  };
}

function insertByPriority(models, model) {
  const priority = Number(model.priority);
  const index = models.findIndex((candidate) => Number.isFinite(priority)
    && Number.isFinite(Number(candidate.priority))
    && Number(candidate.priority) > priority);
  if (index < 0) models.push(model);
  else models.splice(index, 0, model);
}

export function buildCodexModelResponse({ copilotModels, codexCatalog } = {}) {
  if (!copilotModelData(copilotModels) || !codexCatalogIsValid(codexCatalog)) return null;

  const bundledSlugs = new Set(codexCatalog.models.map(({ slug }) => slug));
  const models = codexCatalog.models.map((model) => {
    if (!MANAGED_GPT6_MODELS.has(model.slug)) return model;
    if (!isEligibleCopilotGpt6(copilotModels, model.slug)) return { ...model, visibility: "hide" };
    return catalogModelForCopilot(model, copilotModels);
  });
  for (const slug of GPT6_COMPATIBILITY_SPECS.keys()) {
    if (bundledSlugs.has(slug) || !isEligibleCopilotGpt6(copilotModels, slug)) continue;
    const model = compatibilityModel(codexCatalog, slug);
    if (!model) continue;
    insertByPriority(models, catalogModelForCopilot(model, copilotModels, { filterReasoning: true }));
  }

  return { ...copilotModels, object: copilotModels.object || "list", models };
}

function binaryCacheKey(binaryPath, stats) {
  return [
    binaryPath,
    stats.dev,
    stats.ino,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
  ].map((part) => String(part ?? "")).join(":");
}

async function installedCodexBinaries(binaryPaths, statFn) {
  const installed = [];
  for (const binaryPath of binaryPaths) {
    let stats;
    try {
      stats = await statFn(binaryPath);
    } catch {
      continue;
    }
    if (stats && typeof stats.isFile === "function" && stats.isFile()) {
      installed.push({ binaryPath, key: binaryCacheKey(binaryPath, stats) });
    }
  }
  return installed;
}

function runCodexCommand(execFileFn, binaryPath, args, options) {
  return new Promise((resolve, reject) => {
    try {
      execFileFn(binaryPath, args, options, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function parsedCodexVersion(stdout) {
  const match = /^(?:codex-cli|codex)\s+(\S+)$/.exec(String(stdout).trim());
  return match?.[1] || null;
}

function wholeSemver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(value || "").trim());
  if (!match) return null;
  if (match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    return null;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function normalizedBackoff(value) {
  return Number.isFinite(value) && value >= 0 ? value : CODEX_MODEL_CATALOG_FAILURE_BACKOFF_MS;
}

export function createCodexModelCatalog({
  binaryPath,
  execFileFn = execFile,
  statFn = fs.promises.stat,
  timeoutMs = CODEX_MODEL_CATALOG_TIMEOUT_MS,
  maxBuffer = CODEX_MODEL_CATALOG_MAX_BUFFER,
  failureBackoffMs = CODEX_MODEL_CATALOG_FAILURE_BACKOFF_MS,
  now = Date.now,
} = {}) {
  const binaryPaths = binaryPath === undefined
    ? CODEX_APP_BINARY_PATHS
    : [binaryPath].filter((candidate) => typeof candidate === "string" && path.isAbsolute(candidate));
  const commandOptions = {
    encoding: "utf8",
    maxBuffer,
    timeout: timeoutMs,
    windowsHide: true,
  };
  const backoffMs = normalizedBackoff(failureBackoffMs);
  const versionCache = new Map();
  const versionFailures = new Map();
  const versionPending = new Map();
  const catalogCache = new Map();
  const catalogFailures = new Map();
  const catalogPending = new Map();
  let activeBinaryKeys = new Set();

  function retainCurrentEntries(map) {
    for (const key of map.keys()) {
      if (!activeBinaryKeys.has(key)) map.delete(key);
    }
  }

  async function probeVersion(candidate) {
    if (versionCache.has(candidate.key)) return versionCache.get(candidate.key);
    const failure = versionFailures.get(candidate.key);
    if (failure && now() < failure.retryAt) return null;
    if (versionPending.has(candidate.key)) return versionPending.get(candidate.key);

    const promise = (async () => {
      try {
        const stdout = await runCodexCommand(execFileFn, candidate.binaryPath, ["--version"], commandOptions);
        const version = wholeSemver(parsedCodexVersion(stdout));
        if (!version) throw new Error("Invalid Codex version output");
        if (activeBinaryKeys.has(candidate.key)) {
          versionCache.set(candidate.key, version);
          versionFailures.delete(candidate.key);
        }
        return version;
      } catch {
        if (activeBinaryKeys.has(candidate.key)) {
          versionFailures.set(candidate.key, { retryAt: now() + backoffMs });
        }
        return null;
      }
    })();
    versionPending.set(candidate.key, promise);
    try {
      return await promise;
    } finally {
      if (versionPending.get(candidate.key) === promise) versionPending.delete(candidate.key);
    }
  }

  async function selectBinary(clientVersion) {
    const installed = await installedCodexBinaries(binaryPaths, statFn);
    activeBinaryKeys = new Set(installed.map((candidate) => candidate.key));
    for (const map of [versionCache, versionFailures, catalogCache, catalogFailures]) {
      retainCurrentEntries(map);
    }
    if (installed.length === 0) return null;
    const rawVersion = String(clientVersion || "").trim();
    if (!rawVersion) return installed[0];
    const expectedVersion = wholeSemver(rawVersion);
    if (!expectedVersion) return null;
    for (const candidate of installed) {
      if (await probeVersion(candidate) === expectedVersion) return candidate;
    }
    return null;
  }

  async function loadCatalog(candidate) {
    if (catalogCache.has(candidate.key)) return catalogCache.get(candidate.key);
    const failure = catalogFailures.get(candidate.key);
    if (failure && now() < failure.retryAt) return null;
    if (catalogPending.has(candidate.key)) return catalogPending.get(candidate.key);

    const promise = (async () => {
      try {
        const stdout = await runCodexCommand(
          execFileFn,
          candidate.binaryPath,
          ["debug", "models", "--bundled"],
          commandOptions,
        );
        const catalog = JSON.parse(String(stdout));
        if (!codexCatalogIsValid(catalog)) throw new Error("Invalid Codex model catalog");
        if (activeBinaryKeys.has(candidate.key)) {
          catalogCache.set(candidate.key, catalog);
          catalogFailures.delete(candidate.key);
        }
        return catalog;
      } catch {
        if (activeBinaryKeys.has(candidate.key)) {
          catalogFailures.set(candidate.key, { retryAt: now() + backoffMs });
        }
        return null;
      }
    })();
    catalogPending.set(candidate.key, promise);
    try {
      return await promise;
    } finally {
      if (catalogPending.get(candidate.key) === promise) catalogPending.delete(candidate.key);
    }
  }

  async function load({ clientVersion = "" } = {}) {
    const candidate = await selectBinary(clientVersion);
    return candidate ? loadCatalog(candidate) : null;
  }

  return { load };
}
