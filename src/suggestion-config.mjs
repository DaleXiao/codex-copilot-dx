import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseCodexToml, codexTomlStatements, validateManagedConfigEdit } from "./config-toml.mjs";
import { userSettingsPath } from "./user-settings.mjs";

export const DEFAULT_SUGGESTION_MODEL = "gpt-6-luna";
export const SUGGESTION_SERVER = "ccdx_suggestion";
const sectionPath = ["mcp_servers", SUGGESTION_SERVER];

export function suggestionConfigPath({ env = process.env, home = os.homedir() } = {}) {
  return path.resolve(env.CCDX_SUGGESTION_CONFIG || path.join(path.dirname(userSettingsPath({ env, home })), "suggestion.json"));
}

export function readSuggestionConfig({ filePath = suggestionConfigPath(), strict = false } = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.enabled !== "boolean"
      || (value.automatic !== undefined && typeof value.automatic !== "boolean")
      || typeof value.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.model)) throw new Error();
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, model: DEFAULT_SUGGESTION_MODEL };
    if (strict) throw new Error("Invalid suggestion settings; no changes were written");
    return { enabled: false, model: DEFAULT_SUGGESTION_MODEL };
  }
}

export function suggestionMcpSection(filePath) {
  return {
    enabled: true,
    command: process.execPath,
    args: [fileURLToPath(new URL("./suggestion-mcp.mjs", import.meta.url))],
    env: { CCDX_SUGGESTION_CONFIG: filePath },
    tool_timeout_sec: 40n,
  };
}

export function computeSuggestionMcpConfig(content, { enabled, filePath }) {
  const parsed = parseCodexToml(content);
  if (Object.values(parsed.profiles || {}).some(profile => Object.hasOwn(profile?.mcp_servers || {}, SUGGESTION_SERVER))) {
    return { content, changed: false, skipped: true, reason: "Existing profile-specific suggestion MCP configuration was preserved" };
  }
  const existing = parsed.mcp_servers?.[SUGGESTION_SERVER];
  const expected = suggestionMcpSection(filePath);
  if (existing !== undefined) {
    if (typeof existing.enabled !== "boolean" || !isDeepStrictEqual({ ...existing, enabled: true }, expected)) {
      return { content, changed: false, skipped: true, reason: "Existing suggestion MCP configuration is user-managed; kept unchanged" };
    }
    if (existing.enabled === enabled) return { content, changed: false };
    const entry = codexTomlStatements(content).find(item => item.kind === "value"
      && isDeepStrictEqual(item.keys, [...sectionPath, "enabled"]));
    if (!entry) return { content, changed: false, skipped: true, reason: "Existing inline suggestion configuration was preserved" };
    const updated = content.slice(0, entry.valueStart) + String(enabled) + content.slice(entry.valueEnd);
    validateManagedConfigEdit(parsed, updated, [sectionPath]);
    return { content: updated, changed: true };
  }
  if (!enabled) return { content, changed: false };
  const block = `[mcp_servers.${SUGGESTION_SERVER}]\nenabled = true\ncommand = ${JSON.stringify(expected.command)}\nargs = ${JSON.stringify(expected.args)}\nenv = { CCDX_SUGGESTION_CONFIG = ${JSON.stringify(filePath)} }\ntool_timeout_sec = 40\n`;
  const updated = content + (content.endsWith("\n") ? "\n" : "\n\n") + block;
  validateManagedConfigEdit(parsed, updated, [sectionPath]);
  return { content: updated, changed: true };
}

export function computeSuggestionAutoHook(content, { enabled, filePath }) {
  const parsed=parseCodexToml(content);
  const quote=value=>`'${value.replaceAll("'", "'\\''")}'`;
  const command=`CCDX_SUGGESTION_CONFIG=${quote(filePath)} ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./suggestion-auto.mjs",import.meta.url)))}`;
  const start="# ccdx:suggestion-auto:start",end="# ccdx:suggestion-auto:end";
  const block=`${start}\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\nasync = true\ntimeout = 35\n${end}\n`;
  const owned=content.indexOf(start);
  if(owned>=0){
    if(!content.includes(block)||content.indexOf(start,owned+start.length)!==-1)return {content,changed:false,skipped:true};
    if(enabled)return {content,changed:false};
    const updated=content.replace(block,"");validateManagedConfigEdit(parsed,updated,[["hooks","Stop"]]);return {content:updated,changed:true};
  }
  if(!enabled)return {content,changed:false};
  if(process.platform==="win32")return {content,changed:false,skipped:true};
  const statements=codexTomlStatements(content);
  if(statements.some(item=>item.kind==="value"&&item.keys[0]==="hooks"&&(item.keys.length===1||item.keys.length===2&&item.keys[1]==="Stop")))return {content,changed:false,skipped:true};
  const updated=content+(content.endsWith("\n")?"\n":"\n\n")+block;
  validateManagedConfigEdit(parsed,updated,[["hooks","Stop"]]);return {content:updated,changed:true};
}

export function suggestionCodexConfigPath({ env = process.env, home = os.homedir() } = {}) {
  return path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
}

export function readSuggestionCodexConfig(filePath) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath)); }
  catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error("Cannot read Codex configuration; no changes were written");
  }
}
