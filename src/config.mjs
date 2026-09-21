import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { status } from "./status.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";
import { isLoopbackHost } from "./security.mjs";
import { codexTomlStatements, configValue, parseCodexToml, validateManagedConfigEdit } from "./config-toml.mjs";

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const MODEL_CONTEXT_WINDOW = 1_000_000;
const MODEL_AUTO_COMPACT_TOKEN_LIMIT = 900_000;
const IMAGE_MCP_START = "# ccdx:image-mcp:start";
const IMAGE_MCP_END = "# ccdx:image-mcp:end";
const IMAGE_MCP_SECTION = "mcp_servers.ccdx_image";
const IMAGE_MCP_KEYS = ["enabled", "tool_timeout_sec", "url"];

// Only optional image-configuration conflicts may degrade to core-only startup.
export class ImageMcpConfigError extends Error {}
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

function imageMcpUrl(value) {
  if (typeof value !== "string" || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.pathname === "/mcp/image"
      && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

function isImageDeclaration(item) {
  return ["table", "value"].includes(item.kind)
    && sameKeys(item.keys.slice(0, IMAGE_MANAGED_PATH.length), IMAGE_MANAGED_PATH);
}

function imageMcpMarkers(content, statements) {
  return statements.filter((item) => item.kind === "comment"
    && [IMAGE_MCP_START, IMAGE_MCP_END].includes(item.source.trim())
    && !content.slice(content.lastIndexOf("\n", item.start - 1) + 1, item.start).trim());
}

function knownImageMcp(section, expectedUrl, previousBaseUrl, statements, markers) {
  if (!section || Object.keys(section).sort().join(",") !== IMAGE_MCP_KEYS.join(",")
    || section.enabled !== true || section.tool_timeout_sec !== 210n) return false;
  const url = imageMcpUrl(section.url);
  if (!url) return false;
  if (url.href === new URL(expectedUrl).href) return true;
  // The core and image URLs were configured together. This survives comment
  // stripping and allows an adapter address change without guessing a new owner.
  try {
    const previous = new URL(previousBaseUrl);
    if (previous.protocol === "http:" && previous.pathname === "/v1"
      && !previous.username && !previous.password && !previous.search && !previous.hash
      && previous.origin === url.origin
      && (isLoopbackHost(url.hostname) || url.hostname === new URL(expectedUrl).hostname)) return true;
  } catch {}
  // Legacy markers are an additional ownership hint, never deletion boundaries.
  const starts = markers.filter((item) => item.source.trim() === IMAGE_MCP_START);
  const ends = markers.filter((item) => item.source.trim() === IMAGE_MCP_END);
  if (starts.length !== 1 || ends.length !== 1 || starts[0].start >= ends[0].start
    || !(isLoopbackHost(url.hostname) || url.hostname === new URL(expectedUrl).hostname)) return false;
  const declarations = statements.filter((item) => ["table", "value"].includes(item.kind));
  return declarations.some(isImageDeclaration)
    && declarations.filter(isImageDeclaration).every((item) => item.start > starts[0].start && item.end < ends[0].start)
    && declarations.filter((item) => item.start > starts[0].start && item.start < ends[0].start).every(isImageDeclaration);
}

function removeImageMcpDeclarations(content, statements, markers) {
  const declarations = statements.filter(isImageDeclaration);
  // A shared inline parent is not a surgical edit target. Reuse it unchanged or
  // leave it for the user; never serialize away sibling settings or credentials.
  if (!declarations.length) return null;
  const ranges = [...declarations, ...markers].map((item) => {
    const start = content.lastIndexOf("\n", item.start - 1) + 1;
    const newline = content.indexOf("\n", item.end);
    return [start, newline < 0 ? content.length : newline + 1];
  }).sort((left, right) => right[0] - left[0]);
  for (const [start, end] of ranges) content = content.slice(0, start) + content.slice(end);
  return content;
}

function ensureImageMcp(lines, enabled, adapterPort, adapterHost, previousBaseUrl) {
  const previous = lines.join("\n");
  const config = parseCodexToml(previous);
  const section = configValue(config, IMAGE_MANAGED_PATH);
  const url = `${adapterBaseUrl(imageMcpHost(adapterHost), adapterPort)}/mcp/image`;
  if (section !== undefined) {
    // Reuse compatible registrations without rewriting comments, formatting,
    // user tool policies, or timeouts. An explicit disabled flag is preserved.
    if (enabled && imageMcpUrl(section?.url)?.href === new URL(url).href
      && [undefined, true].includes(section?.enabled)) return false;
    const statements = codexTomlStatements(previous);
    const markers = imageMcpMarkers(previous, statements);
    if (!knownImageMcp(section, url, previousBaseUrl, statements, markers)) {
      if (!enabled) return false;
      throw new ImageMcpConfigError(`Codex config already defines [${IMAGE_MCP_SECTION}] outside the CCDX-managed block; its settings were preserved`);
    }
    const removed = removeImageMcpDeclarations(previous, statements, markers);
    if (removed === null) {
      if (!enabled) return false;
      throw new ImageMcpConfigError(`Cannot safely update [${IMAGE_MCP_SECTION}] inside a shared inline table; its settings were preserved`);
    }
    lines.splice(0, lines.length, ...removed.split("\n"));
    while (lines.length && !lines.at(-1).trim()) lines.pop();
  }
  if (enabled) {
    const parent = config.mcp_servers;
    if (parent !== undefined && (typeof parent !== "object" || parent === null || Array.isArray(parent)
      || codexTomlStatements(previous).some((item) => item.kind === "value" && sameKeys(item.keys, ["mcp_servers"])))) {
      throw new ImageMcpConfigError("Cannot append the image MCP to an inline or non-table mcp_servers setting; its settings were preserved");
    }
    while (lines.length && lines.at(-1).trim() === "") lines.pop();
    if (lines.length) lines.push("");
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
    changed = ensureImageMcp(lines, imageProviderEnabled, adapterPort, adapterHost, config.openai_base_url) || changed;
  }

  const joined = lines.join("\n");
  const updated = joined + (hadTrailingNewline && !joined.endsWith("\n") ? "\n" : "");
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

function computeImageConfig(
  content,
  { enabled, adapterPort = 2026, adapterHost = "127.0.0.1" } = {},
  previousBaseUrl,
) {
  const config = parseCodexToml(content);
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const changed = ensureImageMcp(lines, Boolean(enabled), adapterPort, adapterHost, previousBaseUrl ?? config.openai_base_url);
  if (!changed) return { content, changed: false };
  const joined = lines.join("\n");
  const updated = joined + ((hadTrailingNewline || lines.length) && !joined.endsWith("\n") ? "\n" : "");
  validateManagedConfigEdit(config, updated, [IMAGE_MANAGED_PATH]);
  return { content: updated, changed };
}

export function computeImageMcpCodexConfig(content, options = {}) {
  return computeImageConfig(content, options);
}

export function ensureCodexConfig(adapterPort = 2026, {
  filePath = CONFIG_PATH,
  host = "127.0.0.1",
  imageProviderEnabled = false,
} = {}) {
  const baseUrl = `${adapterBaseUrl(host, adapterPort)}/v1`;

  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(filePath));
  } catch (error) {
    if (error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
      throw new Error("Codex configuration is not valid UTF-8 TOML; no configuration changes were written");
    }
    if (error?.code !== "ENOENT") throw error;
  }
  // Commit essential configuration independently. Image-only parse/edit/write
  // failures must not roll it back or close an otherwise usable GPT adapter.
  const core = content === undefined
    ? { content: initialCodexConfig(adapterPort, host), changed: true }
    : computeUpdatedCodexConfig(content, adapterPort, host);
  if (!core.changed) {
    console.log(status("ok", `Codex already points to ${baseUrl}`));
  } else {
    atomicWriteFileIfChangedSync(filePath, core.content);
    console.log(status("ok", content === undefined ? "Created ~/.codex/config.toml" : `Configured Codex base URL: ${baseUrl}`));
  }
  // Disabled means no image maintenance, including no implicit removal of old
  // or user-owned entries. Explicit disable-image owns the cleanup operation.
  if (!imageProviderEnabled) return { imageMcpSkipped: false };
  try {
    const previousBaseUrl = content === undefined ? undefined : parseCodexToml(content).openai_base_url;
    const image = computeImageConfig(core.content, { enabled: true, adapterPort, adapterHost: host }, previousBaseUrl);
    if (image.changed) {
      if (fs.readFileSync(filePath, "utf8") !== core.content) {
        throw new ImageMcpConfigError("Codex config changed during image setup; the newer configuration was preserved");
      }
      atomicWriteFileIfChangedSync(filePath, image.content);
    }
    return { imageMcpSkipped: false };
  } catch (error) {
    console.warn(status("warn", `Image MCP setup was skipped: ${error.message}. Core proxy startup will continue.`));
    return { imageMcpSkipped: true };
  }
}
