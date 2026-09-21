import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { atomicWriteFileIfChangedSync, atomicWriteFilePairSync } from "./atomic-file.mjs";
import { terminalCell } from "./cli-table.mjs";
import { computeImageMcpCodexConfig } from "./config.mjs";
import { probeImageTool } from "./image-readiness.mjs";
import { updateImageSkill } from "./image-skill.mjs";
import {
  imageProviderConfigPath,
  inspectImageProvider,
  normalizeImageEndpoint,
  readImageProviderConfig,
  validateImageProviderConfig,
} from "./image-provider-config.mjs";

function defaultCodexConfigPath(home) {
  return path.join(home, ".codex", "config.toml");
}

async function visibleQuestion(input, output, question) {
  const prompt = createInterface({ input, output });
  try { return await prompt.question(question); }
  finally { prompt.close(); }
}

export function hiddenQuestion(input, output, question) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Hidden API key input requires an interactive terminal"));
  }
  output.write(question);
  const wasRaw = Boolean(input.isRaw);
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      output.write("\n");
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Image provider setup cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && typeof text === "string" && text >= " " && text !== "\x7f") value += text;
    };
    input.on("keypress", onKeypress);
  });
}

function fileContent(filePath) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(filePath)); }
  catch (error) {
    if (error?.code === "ENOENT") return "";
    if (error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
      throw new Error("Codex configuration is not valid UTF-8 TOML; no configuration changes were written");
    }
    throw error;
  }
}

function chooseModelLines(modelIds, selected) {
  return modelIds.map((model, index) => `  ${index + 1}. ${terminalCell(model)}${model === selected ? " [current]" : ""}`);
}

async function chooseModel(modelIds, current, ask, output) {
  if (modelIds.length === 1) return modelIds[0];
  const currentIndex = Math.max(0, modelIds.indexOf(current));
  output.write("Available image models:\n");
  output.write(`${chooseModelLines(modelIds, current).join("\n")}\n`);
  while (true) {
    const answer = String(await ask(`Select [${currentIndex + 1}]: `) || "").trim();
    if (!answer) return modelIds[currentIndex];
    const selected = Number(answer) - 1;
    if (Number.isInteger(selected) && selected >= 0 && selected < modelIds.length) return modelIds[selected];
    output.write(`Enter a number from 1 to ${modelIds.length}.\n`);
  }
}

function configSummary(config) {
  const endpoint = new URL(config.endpoint);
  return {
    endpoint: `${endpoint.origin}${endpoint.pathname}`,
    model: config.model,
    protocol: config.protocol,
  };
}

function enableImageProvider({ providerConfig, providerPath, codexPath, codexContent, adapterPort, adapterHost }) {
  const codex = computeImageMcpCodexConfig(codexContent, {
    enabled: true,
    adapterPort,
    adapterHost,
  });
  const normalized = validateImageProviderConfig(providerConfig, { filePath: providerPath });
  const skill = updateImageSkill({ enabled: true, codexPath, adapterPort, adapterHost });
  try {
    if (fileContent(codexPath) !== codexContent) {
      throw new Error("Codex configuration changed during image setup; retry to preserve the newer settings");
    }
    atomicWriteFilePairSync(
      codexPath,
      codex.content,
      providerPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      { mode: 0o600, writeFile: atomicWriteFileIfChangedSync },
    );
  } catch (error) {
    skill.rollback();
    throw error;
  }
  return { codexChanged: codex.changed, config: normalized };
}

function disableImageProvider({ providerPath, codexPath, codexContent, adapterPort, adapterHost }) {
  const codex = computeImageMcpCodexConfig(codexContent, {
    enabled: false,
    adapterPort,
    adapterHost,
  });
  const providerExists = fs.existsSync(providerPath);
  const skill = updateImageSkill({ enabled: false, codexPath, adapterPort, adapterHost });
  try {
    if (fs.existsSync(codexPath)) {
      if (fileContent(codexPath) !== codexContent) {
        throw new Error("Codex configuration changed during image cleanup; retry to preserve the newer settings");
      }
      atomicWriteFilePairSync(codexPath, codex.content, providerPath, null, {
        mode: 0o600, writeFile: atomicWriteFileIfChangedSync,
      });
    } else if (providerExists) {
      fs.unlinkSync(providerPath);
    }
  } catch (error) {
    skill.rollback();
    throw error;
  }
  return { changed: providerExists || codex.changed || skill.changed, preservedGuidance: Boolean(skill.preserved) };
}

export function syncEnabledImageSkill({ home = os.homedir(), codexPath = defaultCodexConfigPath(home), ...options } = {}) {
  return updateImageSkill({ ...options, enabled: true, codexPath });
}

function printImageReadiness(readiness, output, commandName) {
  if (readiness.ready) output.write("Local image service: ready (generation tool verified; no image generated).\n");
  else output.write(`Local image service: unavailable (${readiness.reason}). Start or restart ${commandName} to use images.\n`);
}

export async function runImageCommand({
  action,
  commandName = "ccdx",
  env = process.env,
  home = os.homedir(),
  input = process.stdin,
  output = process.stdout,
  prompt,
  promptSecret,
  fetchImpl = fetch,
  probeFetchImpl = fetch,
  adapterPort = 2026,
  adapterHost = "127.0.0.1",
  codexPath = defaultCodexConfigPath(home),
} = {}) {
  const providerPath = imageProviderConfigPath({ env, home });
  if (action === "status") {
    const config = readImageProviderConfig({ env, home, strict: true });
    if (!config) {
      output.write("Image generation: disabled\n");
      return { enabled: false };
    }
    const summary = configSummary(config);
    output.write(`Image generation: enabled\nEndpoint: ${terminalCell(summary.endpoint)}\nModel: ${terminalCell(summary.model)}\nProtocol: ${terminalCell(summary.protocol)}\n`);
    const readiness = await probeImageTool(fileContent(codexPath), { fetchImpl: probeFetchImpl });
    printImageReadiness(readiness, output, commandName);
    return { enabled: true, ...summary, readiness };
  }

  const codexContent = fileContent(codexPath);
  if (action === "disable") {
    const result = disableImageProvider({ providerPath, codexPath, codexContent, adapterPort, adapterHost });
    output.write(`${result.changed ? "Disabled" : "Kept disabled"} image generation.\n`);
    output.write(result.preservedGuidance
      ? "Kept user-modified image guidance. Existing image tool calls are now disabled.\n"
      : "Removed CCDX image guidance. Existing image tool calls are now disabled.\n");
    return { enabled: false, ...result };
  }
  if (action !== "enable") throw new Error(`Unknown image command action: ${action}`);
  if (!prompt && (!input.isTTY || !output.isTTY)) {
    throw new Error(`${commandName} enable-image requires an interactive terminal`);
  }

  const current = readImageProviderConfig({ env, home });
  const ask = prompt || ((question) => visibleQuestion(input, output, question));
  const askSecret = promptSecret || ((question) => hiddenQuestion(input, output, question));
  output.write(`${commandName} enable-image\n`);
  output.write("Enter an HTTPS base URL (for example, https://api.example/v1) or a full /images/generations endpoint.\n");
  const endpointAnswer = String(await ask(`API base URL or endpoint${current ? ` [${current.endpoint}]` : ""}: `) || "").trim();
  if (!endpointAnswer && !current?.endpoint) throw new Error("Image API base URL or endpoint is required");
  const endpoint = normalizeImageEndpoint(endpointAnswer || current.endpoint);
  const sameOrigin = current && new URL(endpoint).origin === new URL(current.endpoint).origin;
  const keyAnswer = String(await askSecret(`API key${sameOrigin ? " [Enter to keep current]" : current ? " [new origin; enter a key]" : ""}: `) || "").trim();
  const apiKey = keyAnswer || (sameOrigin ? current.api_key : undefined);
  if (!apiKey) throw new Error("Image API key is required");

  output.write("Checking image API...\n");
  let model;
  const inspected = await inspectImageProvider({
    endpoint, apiKey, fetchImpl,
    selectModel: async (modelIds) => {
      model = await chooseModel(modelIds, current?.model, ask, output);
      return model;
    },
  });
  const result = enableImageProvider({
    providerConfig: {
      endpoint: inspected.endpoint,
      api_key: apiKey,
      model,
      protocol: inspected.protocol,
    },
    providerPath,
    codexPath,
    // Prompts and provider validation may take minutes. Merge into the latest
    // shared file rather than replacing edits made while we were waiting.
    codexContent: fileContent(codexPath),
    adapterPort,
    adapterHost,
  });
  output.write(`Enabled image generation with ${terminalCell(model)}.\n`);
  const readiness = await probeImageTool(fileContent(codexPath), { fetchImpl: probeFetchImpl });
  printImageReadiness(readiness, output, commandName);
  output.write("Installed CCDX image guidance for new and existing tasks. Ask Codex to draw an image.\n");
  output.write("If the open task has not refreshed its skills, restart Codex App once.\n");
  return { enabled: true, ...configSummary(result.config), codexChanged: result.codexChanged, readiness };
}
