import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { atomicWriteFilePairSync } from "./atomic-file.mjs";
import { terminalCell } from "./cli-table.mjs";
import { computeImageMcpCodexConfig } from "./config.mjs";
import {
  imageProviderConfigPath,
  inspectImageProvider,
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
  try { return fs.readFileSync(filePath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return "";
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
  atomicWriteFilePairSync(
    codexPath,
    codex.content,
    providerPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { codexChanged: codex.changed, config: normalized };
}

function disableImageProvider({ providerPath, codexPath, codexContent, adapterPort, adapterHost }) {
  const codex = computeImageMcpCodexConfig(codexContent, {
    enabled: false,
    adapterPort,
    adapterHost,
  });
  const providerExists = fs.existsSync(providerPath);
  if (fs.existsSync(codexPath)) {
    atomicWriteFilePairSync(codexPath, codex.content, providerPath, null, { mode: 0o600 });
  } else if (providerExists) {
    fs.unlinkSync(providerPath);
  }
  return { changed: providerExists || codex.changed };
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
    return { enabled: true, ...summary };
  }

  const codexContent = fileContent(codexPath);
  if (action === "disable") {
    const result = disableImageProvider({ providerPath, codexPath, codexContent, adapterPort, adapterHost });
    output.write(`${result.changed ? "Disabled" : "Kept disabled"} image generation.\n`);
    output.write("Restart Codex App to remove the image tool from active tasks.\n");
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
  const endpointAnswer = String(await ask(`API endpoint${current ? ` [${current.endpoint}]` : ""}: `) || "").trim();
  const endpoint = endpointAnswer || current?.endpoint;
  if (!endpoint) throw new Error("Image API endpoint is required");
  const keyAnswer = String(await askSecret(`API key${current ? " [Enter to keep current]" : ""}: `) || "").trim();
  const apiKey = keyAnswer || current?.api_key;
  if (!apiKey) throw new Error("Image API key is required");

  output.write("Checking image API...\n");
  const inspected = await inspectImageProvider({ endpoint, apiKey, fetchImpl });
  const model = await chooseModel(inspected.modelIds, current?.model, ask, output);
  const result = enableImageProvider({
    providerConfig: {
      endpoint: inspected.endpoint,
      api_key: apiKey,
      model,
      protocol: inspected.protocol,
    },
    providerPath,
    codexPath,
    codexContent,
    adapterPort,
    adapterHost,
  });
  output.write(`Enabled image generation with ${terminalCell(model)}.\n`);
  output.write("Restart Codex App to load the image tool. A running ccdx adapter can remain running.\n");
  return { enabled: true, ...configSummary(result.config), codexChanged: result.codexChanged };
}
