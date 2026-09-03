import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { status } from "./status.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const MODEL_CONTEXT_WINDOW = 1_000_000;
const MODEL_AUTO_COMPACT_TOKEN_LIMIT = 900_000;

function isTomlTableHeader(line) {
  const source = line.trimStart();
  const openingBrackets = source.startsWith("[[") ? 2 : source.startsWith("[") ? 1 : 0;
  if (!openingBrackets) return false;

  let quote = "";
  let escaped = false;
  for (let index = openingBrackets; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) quote = "";
      escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== "]" || (openingBrackets === 2 && source[index + 1] !== "]")) continue;

    if (!source.slice(openingBrackets, index).trim()) return false;
    const tail = source.slice(index + openingBrackets).trim();
    return tail === "" || tail.startsWith("#");
  }
  return false;
}

function setTopLevelTomlDefault(lines, key, value) {
  let end = lines.findIndex(isTomlTableHeader);
  if (end === -1) end = lines.length;

  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  if (lines.slice(0, end).some((line) => keyRe.test(line))) return false;

  while (end > 0 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, `${key} = ${value}`);
  return true;
}

function setTomlKey(lines, sectionName, key, value) {
  const sectionLine = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === sectionLine);
  if (start === -1) return false;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isTomlTableHeader(lines[i])) {
      end = i;
      break;
    }
  }

  const nextLine = `${key} = "${value}"`;
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = start + 1; i < end; i++) {
    if (keyRe.test(lines[i])) {
      const changed = lines[i] !== nextLine;
      lines[i] = nextLine;
      return changed;
    }
  }

  lines.splice(end, 0, nextLine);
  return true;
}

export function computeUpdatedCodexConfig(content, adapterPort = 2026, adapterHost = "127.0.0.1") {
  const baseUrl = `${adapterBaseUrl(adapterHost, adapterPort)}/v1`;
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();

  let changed = false;
  const openaiLine = `openai_base_url = "${baseUrl}"`;
  const firstSection = lines.findIndex(isTomlTableHeader);
  const topLevelEnd = firstSection === -1 ? lines.length : firstSection;
  const openaiIndex = lines.findIndex((line, index) => (
    index < topLevelEnd && /^\s*openai_base_url\s*=/.test(line)
  ));
  if (openaiIndex === -1) {
    lines.unshift(openaiLine);
    changed = true;
  } else if (lines[openaiIndex] !== openaiLine) {
    lines[openaiIndex] = openaiLine;
    changed = true;
  }

  changed = setTopLevelTomlDefault(lines, "model_context_window", MODEL_CONTEXT_WINDOW) || changed;
  changed = setTopLevelTomlDefault(lines, "model_auto_compact_token_limit", MODEL_AUTO_COMPACT_TOKEN_LIMIT) || changed;
  changed = setTomlKey(lines, "shell_environment_policy.set", "OPENAI_BASE_URL", baseUrl) || changed;
  changed = setTomlKey(lines, "shell_environment_policy.set", "OPENAI_API_KEY", "dummy") || changed;

  return { content: lines.join("\n") + (hadTrailingNewline ? "\n" : ""), changed };
}

function initialCodexConfig(adapterPort, adapterHost) {
  const baseUrl = `${adapterBaseUrl(adapterHost, adapterPort)}/v1`;
  return `openai_base_url = "${baseUrl}"
model_context_window = ${MODEL_CONTEXT_WINDOW}
model_auto_compact_token_limit = ${MODEL_AUTO_COMPACT_TOKEN_LIMIT}

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
OPENAI_BASE_URL = "${baseUrl}"
OPENAI_API_KEY = "dummy"
`;
}

export function ensureCodexConfig(adapterPort = 2026, { filePath = CONFIG_PATH, host = "127.0.0.1" } = {}) {
  const baseUrl = `${adapterBaseUrl(host, adapterPort)}/v1`;

  if (!fs.existsSync(filePath)) {
    // Codex config does not exist yet; create the local proxy defaults.
    atomicWriteFileIfChangedSync(filePath, initialCodexConfig(adapterPort, host));
    console.log(status("ok", "Created ~/.codex/config.toml"));
    return;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const updated = computeUpdatedCodexConfig(content, adapterPort, host);

  if (!updated.changed) {
    console.log(status("ok", `Codex already points to ${baseUrl}`));
    return;
  }
  atomicWriteFileIfChangedSync(filePath, updated.content);
  console.log(status("ok", `Configured Codex base URL: ${baseUrl}`));
}
