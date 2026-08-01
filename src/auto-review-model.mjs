import os from "node:os";
import { createInterface } from "node:readline/promises";
import { loadModelCache } from "./model-cache.mjs";
import {
  DEFAULT_CODEX_AUTO_REVIEW_MODEL,
  responsesModelIdsFromCopilotModels,
} from "./models.mjs";
import { parseAdapterProbeOptions } from "./cli-options.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";
import {
  autoReviewModelPreference,
  readUserSettings,
  writeAutoReviewModel,
} from "./user-settings.mjs";

const DEFAULT_MODEL_FETCH_TIMEOUT_MS = 5000;

function modelFetchTimeout(env) {
  const value = Number(env.CCDX_MODEL_REFRESH_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MODEL_FETCH_TIMEOUT_MS;
}

function sortedModelIds(modelIds, currentModel) {
  return [...modelIds].sort((left, right) => {
    const leftRank = left === currentModel ? 0 : left === DEFAULT_CODEX_AUTO_REVIEW_MODEL ? 1 : 2;
    const rightRank = right === currentModel ? 0 : right === DEFAULT_CODEX_AUTO_REVIEW_MODEL ? 1 : 2;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

export async function loadAutoReviewModelCatalog({
  env = process.env,
  fetchImpl = fetch,
  home = os.homedir(),
  loadModelCacheFn = loadModelCache,
} = {}) {
  const { adapterHost, adapterPort } = parseAdapterProbeOptions(env);
  const url = `${adapterBaseUrl(adapterHost, adapterPort)}/v1/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), modelFetchTimeout(env));
  let liveError = "adapter is not running";
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!response.ok) {
      liveError = `adapter returned HTTP ${response.status}`;
    } else {
      const models = await response.json();
      const modelIds = responsesModelIdsFromCopilotModels(models);
      if (modelIds.length) {
        const fallback = response.headers.get("X-CCDX-Model-Source") === "last-known-good";
        return { modelIds, source: fallback ? "running adapter cache" : "running adapter" };
      }
      liveError = "adapter returned no selectable Responses models";
    }
  } catch (error) {
    liveError = ctrl.signal.aborted
      ? `adapter model lookup timed out after ${modelFetchTimeout(env)}ms`
      : error?.message || String(error);
  } finally {
    clearTimeout(timer);
  }

  const cached = loadModelCacheFn({ home });
  const modelIds = responsesModelIdsFromCopilotModels(cached);
  if (modelIds.length) return { modelIds, source: "local model cache" };
  throw new Error(`No selectable Responses models are available (${liveError}). Start ccdx once to refresh the model list.`);
}

export async function runAutoReviewModelCommand({
  commandName = "ccdx",
  env = process.env,
  fetchImpl = fetch,
  home = os.homedir(),
  input = process.stdin,
  loadCatalog = loadAutoReviewModelCatalog,
  output = process.stdout,
  prompt,
} = {}) {
  if (!prompt && (!input.isTTY || !output.isTTY)) {
    throw new Error(`${commandName} auto-review-model requires an interactive terminal`);
  }

  readUserSettings({ env, home, strict: true });
  const current = autoReviewModelPreference({ env, home });
  const catalog = await loadCatalog({ env, fetchImpl, home });
  const modelIds = sortedModelIds(catalog.modelIds, current.model);
  if (!modelIds.length) throw new Error("No selectable Responses models are available");

  output.write(`${commandName} auto-review-model\n`);
  output.write(`Current: ${current.model} (${current.source})\n`);
  output.write(`Responses models from ${catalog.source}:\n`);
  modelIds.forEach((model, index) => {
    const markers = [];
    if (model === current.model) markers.push("current");
    if (model === DEFAULT_CODEX_AUTO_REVIEW_MODEL) markers.push("default");
    output.write(`  ${index + 1}. ${model}${markers.length ? ` [${markers.join(", ")}]` : ""}\n`);
  });

  let defaultIndex = modelIds.indexOf(current.model);
  if (defaultIndex < 0) defaultIndex = modelIds.indexOf(DEFAULT_CODEX_AUTO_REVIEW_MODEL);
  if (defaultIndex < 0) defaultIndex = 0;

  let readline;
  const ask = prompt || (async (question) => {
    readline ||= createInterface({ input, output });
    return readline.question(question);
  });

  let selectedModel;
  try {
    while (!selectedModel) {
      const answer = String(await ask(`Select a model [${defaultIndex + 1}], or q to cancel: `) || "").trim();
      if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
        output.write("No changes made.\n");
        return { changed: false, cancelled: true, model: current.model };
      }
      const selectedIndex = answer === "" ? defaultIndex : Number(answer) - 1;
      if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < modelIds.length) {
        selectedModel = modelIds[selectedIndex];
      } else {
        output.write(`Enter a number from 1 to ${modelIds.length}, or q to cancel.\n`);
      }
    }
  } finally {
    readline?.close();
  }

  const savedModel = selectedModel === DEFAULT_CODEX_AUTO_REVIEW_MODEL ? "" : selectedModel;
  const result = writeAutoReviewModel(savedModel, { env, home });
  output.write(`${result.changed ? "Saved" : "Kept"} Auto Review model: ${selectedModel}\n`);
  if (String(env.CCDX_AUTO_REVIEW_MODEL || "").trim()) {
    output.write(`CCDX_AUTO_REVIEW_MODEL=${current.model} remains the effective override until it is unset.\n`);
  } else {
    output.write("The running 0.5.1+ adapter will use this model on the next Auto Review request.\n");
  }
  return { ...result, cancelled: false, model: selectedModel };
}
