import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { status } from "./status.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

// Return an updated settings object without mutating the input.
export function computeUpdatedSettings(settings, port) {
  const target = `http://127.0.0.1:${port}`;
  const current = settings?.env?.ANTHROPIC_BASE_URL;
  const currentToken = settings?.env?.ANTHROPIC_AUTH_TOKEN;
  const changed = current !== target || currentToken !== "dummy";
  const json = {
    ...settings,
    env: {
      ...(settings?.env || {}),
      ANTHROPIC_BASE_URL: target,
      ANTHROPIC_AUTH_TOKEN: "dummy",
    },
  };
  return { json, changed };
}

// Point Claude Code at the adapter by updating ~/.claude/settings.json.
export function ensureClaudeConfig(port = 2026, { filePath = SETTINGS_PATH } = {}) {
  const target = `http://127.0.0.1:${port}`;

  if (!fs.existsSync(filePath)) {
    const { json } = computeUpdatedSettings({}, port);
    atomicWriteFileIfChangedSync(filePath, JSON.stringify(json, null, 2) + "\n");
    console.log(status("ok", `Created ~/.claude/settings.json for Claude Code at ${target}`));
    return;
  }

  let raw, settings;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
    settings = JSON.parse(raw);
  } catch (e) {
    console.log(status("warn", `Could not parse ~/.claude/settings.json: ${e.message}`));
    console.log(status("info", "Fix the JSON file and rerun codex-copilot-dx to configure Claude Code automatically."));
    return;
  }

  const { json, changed } = computeUpdatedSettings(settings, port);
  if (!changed) {
    console.log(status("ok", `Claude Code already points to ${target}`));
    return;
  }

  atomicWriteFileIfChangedSync(`${filePath}.bak`, raw);
  atomicWriteFileIfChangedSync(filePath, JSON.stringify(json, null, 2) + "\n");
  console.log(status("ok", `Configured Claude Code ANTHROPIC_BASE_URL="${target}" and backed up settings.json.bak`));
}
