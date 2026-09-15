import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { status } from "./status.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";
import { codexTomlStatements, configValue, parseCodexToml, validateManagedConfigEdit } from "./config-toml.mjs";

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const MODEL_CONTEXT_WINDOW = 1_000_000;
const MODEL_AUTO_COMPACT_TOKEN_LIMIT = 900_000;
const IMAGE_MCP_START = "# ccdx:image-mcp:start";
const IMAGE_MCP_END = "# ccdx:image-mcp:end";
const IMAGE_MCP_SECTION = "mcp_servers.ccdx_image";
const STARTUP_MANAGED_PATHS = [
  "openai_base_url",
  "model_context_window",
  "model_auto_compact_token_limit",
  "shell_environment_policy.set.OPENAI_BASE_URL",
  "shell_environment_policy.set.OPENAI_API_KEY",
  "features.context_management",
].map((key) => key.split("."));
const IMAGE_MANAGED_PATH = ["mcp_servers", "ccdx_image"];

function sameKeys(left, right) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function setExistingTomlValue(lines, keys, value) {
  const content = lines.join("\n");
  if (configValue(parseCodexToml(content), keys) === value) return false;
  const entry = codexTomlStatements(content).find((item) => item.kind === "value" && sameKeys(item.keys, keys));
  if (!entry) return false;
  const updated = content.slice(0, entry.valueStart) + JSON.stringify(value) + content.slice(entry.valueEnd);
  lines.splice(0, lines.length, ...updated.split("\n"));
  return true;
}

function setTopLevelTomlDefault(lines, key, value) {
  const content = lines.join("\n");
  if (Object.hasOwn(parseCodexToml(content), key)) return false;
  let end = codexTomlStatements(content).find((item) => item.kind === "table")?.line ?? lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, `${key} = ${value}`);
  return true;
}

function setTomlKey(lines, sectionName, key, value) {
  const keys = [...sectionName.split("."), key];
  const content = lines.join("\n");
  if (configValue(parseCodexToml(content), keys) !== undefined) {
    return setExistingTomlValue(lines, keys, value);
  }
  const statements = codexTomlStatements(content);
  const parent = keys.slice(0, -1);
  const table = statements.find((item) => item.kind === "table" && sameKeys(item.keys, parent));
  const dotted = statements.find((item) => item.kind === "value"
    && item.keys.length > parent.length && sameKeys(item.keys.slice(0, parent.length), parent));
  const anchor = table || dotted;
  // Preserve absent and inline environment tables; only edit declarations whose
  // exact value or insertion scope can be identified without rewriting them.
  if (!anchor) return false;
  const scope = table ? table.keys : dotted.section;
  const nextKey = keys.slice(scope.length).join(".");
  const end = statements.find((item) => item.kind === "table" && item.start > anchor.start)?.line ?? lines.length;
  lines.splice(end, 0, `${nextKey} = ${JSON.stringify(value)}`);
  return true;
}

function ensureContextManagementDefault(lines) {
  const content = lines.join("\n");
  const config = parseCodexToml(content);
  if (configValue(config, ["features", "context_management"]) !== undefined) return false;
  const statements = codexTomlStatements(content);
  const table = statements.find((item) => item.kind === "table" && sameKeys(item.keys, ["features"]));
  if (!table) {
    if (Object.hasOwn(config, "features")) return false;
    if (lines.length && lines.at(-1).trim() !== "") lines.push("");
    lines.push("[features]", "context_management = true");
    return true;
  }
  let end = statements.find((item) => item.kind === "table" && item.start > table.start)?.line ?? lines.length;
  while (end > table.line + 1 && lines[end - 1].trim() === "") end -= 1;
  lines.splice(end, 0, "context_management = true");
  return true;
}

function imageMcpHost(adapterHost) {
  const host = String(adapterHost || "127.0.0.1").trim();
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host;
}

function removeManagedImageMcp(lines) {
  const comments = codexTomlStatements(lines.join("\n")).filter((item) => item.kind === "comment");
  const starts = comments.filter((item) => lines[item.line] === IMAGE_MCP_START).map((item) => item.line);
  const ends = comments.filter((item) => lines[item.line] === IMAGE_MCP_END).map((item) => item.line);
  let start = starts[0] ?? -1;
  const end = ends[0] ?? -1;
  if (start === -1 && end === -1) return false;
  if (starts.length !== 1 || ends.length !== 1 || end < start) {
    throw new Error("Invalid managed CCDX image MCP block in Codex config");
  }
  lines.splice(start, end - start + 1);
  while (start > 0 && start >= lines.length && lines[start - 1].trim() === "") {
    lines.splice(start - 1, 1);
    start -= 1;
  }
  while (start < lines.length && lines[start].trim() === "" && start > 0 && lines[start - 1].trim() === "") {
    lines.splice(start, 1);
  }
  return true;
}

function hasUnmanagedImageMcp(lines) {
  return configValue(parseCodexToml(lines.join("\n")), IMAGE_MANAGED_PATH) !== undefined;
}

function ensureImageMcp(lines, enabled, adapterPort, adapterHost) {
  const previous = lines.join("\n");
  removeManagedImageMcp(lines);
  if (enabled) {
    if (hasUnmanagedImageMcp(lines)) {
      throw new Error(`Codex config already defines [${IMAGE_MCP_SECTION}] outside the CCDX-managed block`);
    }
    while (lines.length && lines.at(-1).trim() === "") lines.pop();
    if (lines.length) lines.push("");
    const url = `${adapterBaseUrl(imageMcpHost(adapterHost), adapterPort)}/mcp/image`;
    lines.push(
      IMAGE_MCP_START,
      `[${IMAGE_MCP_SECTION}]`,
      `url = ${JSON.stringify(url)}`,
      "enabled = true",
      "tool_timeout_sec = 210",
      IMAGE_MCP_END,
    );
  }
  return lines.join("\n") !== previous;
}

export function computeUpdatedCodexConfig(
  content,
  adapterPort = 2026,
  adapterHost = "127.0.0.1",
  { imageProviderEnabled } = {},
) {
  const config = parseCodexToml(content);
  const baseUrl = `${adapterBaseUrl(adapterHost, adapterPort)}/v1`;
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();

  let changed = false;
  const openaiLine = `openai_base_url = "${baseUrl}"`;
  if (!Object.hasOwn(config, "openai_base_url")) {
    lines.unshift(openaiLine);
    changed = true;
  } else {
    changed = setExistingTomlValue(lines, ["openai_base_url"], baseUrl);
  }

  changed = setTopLevelTomlDefault(lines, "model_context_window", MODEL_CONTEXT_WINDOW) || changed;
  changed = setTopLevelTomlDefault(lines, "model_auto_compact_token_limit", MODEL_AUTO_COMPACT_TOKEN_LIMIT) || changed;
  changed = setTomlKey(lines, "shell_environment_policy.set", "OPENAI_BASE_URL", baseUrl) || changed;
  changed = setTomlKey(lines, "shell_environment_policy.set", "OPENAI_API_KEY", "dummy") || changed;
  changed = ensureContextManagementDefault(lines) || changed;
  if (typeof imageProviderEnabled === "boolean") {
    changed = ensureImageMcp(lines, imageProviderEnabled, adapterPort, adapterHost) || changed;
  }

  const updated = lines.join("\n") + (hadTrailingNewline ? "\n" : "");
  validateManagedConfigEdit(config, updated, typeof imageProviderEnabled === "boolean"
    ? [...STARTUP_MANAGED_PATHS, IMAGE_MANAGED_PATH] : STARTUP_MANAGED_PATHS);
  return { content: updated, changed };
}

export function initialCodexConfig(adapterPort, adapterHost, { imageProviderEnabled = false } = {}) {
  const baseUrl = `${adapterBaseUrl(adapterHost, adapterPort)}/v1`;
  const base = `openai_base_url = "${baseUrl}"
model_context_window = ${MODEL_CONTEXT_WINDOW}
model_auto_compact_token_limit = ${MODEL_AUTO_COMPACT_TOKEN_LIMIT}

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
OPENAI_BASE_URL = "${baseUrl}"
OPENAI_API_KEY = "dummy"

[features]
context_management = true
`;
  return imageProviderEnabled
    ? computeUpdatedCodexConfig(base, adapterPort, adapterHost, { imageProviderEnabled }).content
    : base;
}

export function computeImageMcpCodexConfig(
  content,
  { enabled, adapterPort = 2026, adapterHost = "127.0.0.1" } = {},
) {
  const config = parseCodexToml(content);
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();
  const changed = ensureImageMcp(lines, Boolean(enabled), adapterPort, adapterHost);
  const updated = lines.join("\n") + (hadTrailingNewline || lines.length ? "\n" : "");
  validateManagedConfigEdit(config, updated, [IMAGE_MANAGED_PATH]);
  return { content: updated, changed };
}

export function ensureCodexConfig(adapterPort = 2026, {
  filePath = CONFIG_PATH,
  host = "127.0.0.1",
  imageProviderEnabled = false,
} = {}) {
  const baseUrl = `${adapterBaseUrl(host, adapterPort)}/v1`;

  if (!fs.existsSync(filePath)) {
    // Codex config does not exist yet; create the local proxy defaults.
    atomicWriteFileIfChangedSync(filePath, initialCodexConfig(adapterPort, host, { imageProviderEnabled }));
    console.log(status("ok", "Created ~/.codex/config.toml"));
    return;
  }

  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(filePath));
  } catch (error) {
    if (error?.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
    throw new Error("Codex configuration is not valid UTF-8 TOML; no configuration changes were written");
  }
  const updated = computeUpdatedCodexConfig(content, adapterPort, host, { imageProviderEnabled });

  if (!updated.changed) {
    console.log(status("ok", `Codex already points to ${baseUrl}`));
    return;
  }
  atomicWriteFileIfChangedSync(filePath, updated.content);
  console.log(status("ok", `Configured Codex base URL: ${baseUrl}`));
}
