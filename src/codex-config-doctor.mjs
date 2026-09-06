import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { computeUpdatedCodexConfig, initialCodexConfig } from "./config.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";

const MANAGED_KEYS = [
  "openai_base_url",
  "model_context_window",
  "model_auto_compact_token_limit",
  "shell_environment_policy.inherit",
  "shell_environment_policy.set.OPENAI_BASE_URL",
  "shell_environment_policy.set.OPENAI_API_KEY",
  "features.context_management",
];

function field(config, key) {
  return key.split(".").reduce((value, part) => (
    value && Object.hasOwn(value, part) ? value[part] : undefined
  ), config);
}

function table(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function parseConfig(text) {
  // Keep integer and floating-point TOML values distinct, including large ints.
  return parse(text, { integersAsBigInt: true });
}

function unmanagedSettings(config) {
  const remaining = structuredClone(config);
  for (const key of MANAGED_KEYS) {
    const parts = key.split(".");
    const leaf = parts.pop();
    const parent = parts.length ? field(remaining, parts.join(".")) : remaining;
    if (table(parent)) delete parent[leaf];
  }
  for (const key of ["shell_environment_policy.set", "shell_environment_policy", "features"]) {
    const value = field(remaining, key);
    if (!table(value) || Object.keys(value).length) continue;
    const parts = key.split(".");
    const leaf = parts.pop();
    const parent = parts.length ? field(remaining, parts.join(".")) : remaining;
    delete parent[leaf];
  }
  return remaining;
}

function startupPreview(content, config, host, port) {
  const updated = content === null
    ? { content: initialCodexConfig(port, host), changed: true }
    : computeUpdatedCodexConfig(content, port, host);
  if (!updated.changed) return { kind: "ok", message: "No startup configuration changes required" };
  let next;
  try {
    next = parseConfig(updated.content);
  } catch {
    return { kind: "err", message: "Startup configuration preview is not valid TOML; review the file before starting ccdx" };
  }
  if (!isDeepStrictEqual(unmanagedSettings(config), unmanagedSettings(next))) {
    return { kind: "err", message: "Startup preview would change settings outside CCDX's managed keys; review the file before starting ccdx" };
  }
  const changed = MANAGED_KEYS.filter((key) => !isDeepStrictEqual(field(config, key), field(next, key)));
  return {
    kind: "warn",
    message: changed.length
      ? `Next startup would ${content === null ? "create the file and set" : "set"}: ${changed.join(", ")}`
      : "Next startup would rewrite the file; managed key values are unchanged",
  };
}

function checkUrl(value, expected, label) {
  if (value === undefined) return { kind: "warn", message: `${label} is missing` };
  if (typeof value !== "string") return { kind: "err", message: `${label} must be a string` };
  // Do not echo configured URLs: userinfo and query strings can contain secrets.
  return value === expected
    ? { kind: "ok", message: `${label} points to ${expected}` }
    : { kind: "warn", message: `${label} differs from the CCDX address ${expected}` };
}

export function inspectCodexConfig({ home = os.homedir(), host = "127.0.0.1", port = 2026 } = {}) {
  const filePath = path.join(home, ".codex", "config.toml");
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(filePath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [
        { kind: "warn", message: `Codex config not found at ${filePath}` },
        startupPreview(null, {}, host, port),
      ];
    }
    return [{ kind: "err", message: `Cannot read UTF-8 Codex config at ${filePath}` }];
  }

  let config;
  try {
    config = parseConfig(content);
  } catch (error) {
    const location = Number.isInteger(error?.line) && Number.isInteger(error?.column)
      ? ` at line ${error.line}, column ${error.column}`
      : "";
    // Parser messages include source snippets. Report only numeric locations.
    return [{ kind: "err", message: `Invalid TOML in ${filePath}${location}` }];
  }

  const expectedBaseUrl = `${adapterBaseUrl(host, port)}/v1`;
  const checks = [
    { kind: "ok", message: `Codex config is readable TOML: ${filePath}` },
    checkUrl(config.openai_base_url, expectedBaseUrl, "Codex base URL"),
  ];
  for (const key of ["model_context_window", "model_auto_compact_token_limit"]) {
    const value = field(config, key);
    checks.push(value === undefined
      ? { kind: "warn", message: `${key} is missing` }
      : typeof value === "bigint" && value > 0n
        ? { kind: "ok", message: `${key} = ${value} (existing value retained)` }
        : { kind: "err", message: `${key} must be a positive TOML integer` });
  }
  if (typeof config.model_context_window === "bigint" && config.model_context_window > 0n
    && typeof config.model_auto_compact_token_limit === "bigint" && config.model_auto_compact_token_limit > 0n
    && config.model_auto_compact_token_limit >= config.model_context_window) {
    checks.push({ kind: "warn", message: "model_auto_compact_token_limit is not below model_context_window; review the custom limits" });
  }

  const policy = field(config, "shell_environment_policy");
  const env = field(config, "shell_environment_policy.set");
  if ((policy !== undefined && !table(policy)) || (env !== undefined && !table(env))) {
    checks.push({ kind: "err", message: "shell_environment_policy and its set value must be TOML tables" });
  } else if (env === undefined) {
    checks.push({ kind: "ok", message: "Optional shell_environment_policy.set table is absent; existing files do not require it" });
  } else {
    checks.push(checkUrl(env.OPENAI_BASE_URL, expectedBaseUrl, "Codex shell OPENAI_BASE_URL"));
    checks.push(env.OPENAI_API_KEY === undefined
      ? { kind: "warn", message: "Codex shell OPENAI_API_KEY placeholder is missing" }
      : typeof env.OPENAI_API_KEY !== "string"
        ? { kind: "err", message: "Codex shell OPENAI_API_KEY must be a string (value hidden)" }
        : env.OPENAI_API_KEY === "dummy"
          ? { kind: "ok", message: "Codex shell OPENAI_API_KEY uses the dummy placeholder" }
          : { kind: "warn", message: "Codex shell OPENAI_API_KEY differs from the dummy placeholder (value hidden)" });
  }

  const features = field(config, "features");
  const management = field(config, "features.context_management");
  if (features !== undefined && !table(features)) {
    checks.push({ kind: "err", message: "features must be a TOML table" });
  } else if (management === undefined) {
    checks.push({ kind: "warn", message: "features.context_management is missing; see the startup preview for whether it will be added" });
  } else if (typeof management === "boolean") {
    checks.push({ kind: "ok", message: `features.context_management = ${management} (${management ? "enabled" : "explicitly disabled"}; retained)` });
  } else if (table(management)) {
    checks.push({ kind: "warn", message: "Structured context-management settings are retained; installed Codex support is not verified" });
  } else {
    checks.push({ kind: "err", message: "features.context_management must be a boolean for the basic feature flag" });
  }
  checks.push(startupPreview(content, config, host, port));
  return checks;
}
