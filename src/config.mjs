import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { status } from "./status.mjs";

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");

function setTomlKey(lines, sectionName, key, value) {
  const sectionLine = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === sectionLine);
  if (start === -1) return false;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
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

export function computeUpdatedCodexConfig(content, adapterPort = 2026) {
  const baseUrl = `http://127.0.0.1:${adapterPort}/v1`;
  const anthropicBaseUrl = `http://127.0.0.1:${adapterPort}`;
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();

  let changed = false;
  const openaiLine = `openai_base_url = "${baseUrl}"`;
  const openaiIndex = lines.findIndex((line) => /^openai_base_url\s*=/.test(line));
  if (openaiIndex === -1) {
    lines.unshift(openaiLine);
    changed = true;
  } else if (lines[openaiIndex] !== openaiLine) {
    lines[openaiIndex] = openaiLine;
    changed = true;
  }

  changed = setTomlKey(lines, "shell_environment_policy.set", "ANTHROPIC_AUTH_TOKEN", "dummy") || changed;
  changed = setTomlKey(lines, "shell_environment_policy.set", "ANTHROPIC_BASE_URL", anthropicBaseUrl) || changed;
  changed = setTomlKey(lines, "shell_environment_policy.set", "OPENAI_BASE_URL", baseUrl) || changed;
  changed = setTomlKey(lines, "shell_environment_policy.set", "OPENAI_API_KEY", "dummy") || changed;

  return { content: lines.join("\n") + (hadTrailingNewline ? "\n" : ""), changed };
}

function initialCodexConfig(adapterPort) {
  const baseUrl = `http://127.0.0.1:${adapterPort}/v1`;
  const anthropicBaseUrl = `http://127.0.0.1:${adapterPort}`;
  return `openai_base_url = "${baseUrl}"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "dummy"
ANTHROPIC_BASE_URL = "${anthropicBaseUrl}"
OPENAI_BASE_URL = "${baseUrl}"
OPENAI_API_KEY = "dummy"
`;
}

export function ensureCodexConfig(adapterPort = 2026) {
  const baseUrl = `http://127.0.0.1:${adapterPort}/v1`;

  if (!fs.existsSync(CONFIG_PATH)) {
    // Codex config does not exist yet; create the local proxy defaults.
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, initialCodexConfig(adapterPort));
    console.log(status("ok", "Created ~/.codex/config.toml"));
    return;
  }

  let content = fs.readFileSync(CONFIG_PATH, "utf-8");
  const updated = computeUpdatedCodexConfig(content, adapterPort);

  fs.writeFileSync(CONFIG_PATH, updated.content);
  console.log(status("ok", `Configured Codex base URL: ${baseUrl}`));
}
