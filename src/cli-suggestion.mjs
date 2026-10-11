import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteFileIfChangedSync, atomicWriteFilePairSync } from "./atomic-file.mjs";
import { loadAutoReviewModelCatalog } from "./auto-review-model.mjs";
import { parseAdapterAddressOptions } from "./cli-options.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";
import { terminalCell } from "./cli-table.mjs";
import { resolveSuggestionCodexBinary } from "./suggestion-context.mjs";
import { suggestionAdapterUrl } from "./suggestion-provider.mjs";
import { computeSuggestionAutoHook, computeSuggestionMcpConfig, readSuggestionCodexConfig, readSuggestionConfig, suggestionCodexConfigPath, suggestionConfigPath } from "./suggestion-config.mjs";

export async function supportsSuggestionHooks(binary) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ccdx-hook-probe-"));
  try {
    const {stdout}=await promisify(execFile)(binary,["features","list"],{cwd:directory,env:{CODEX_HOME:directory,PATH:process.env.PATH||""},timeout:1500,maxBuffer:128*1024,encoding:"utf8"});
    return /^hooks\s+(?:stable|beta|experimental|under development)\s+true\s*$/m.test(stdout);
  } catch {return false;} finally {fs.rmSync(directory,{recursive:true,force:true});}
}

export async function runSuggestionCommand({
  action = "status", model, commandName = "ccdx", env = process.env, home = os.homedir(),
  input = process.stdin, output = process.stdout, prompt,
  loadCatalog = loadAutoReviewModelCatalog, resolveBinary = resolveSuggestionCodexBinary, probeHooks = supportsSuggestionHooks,
} = {}) {
  const filePath = suggestionConfigPath({ env, home });
  const codexPath = suggestionCodexConfigPath({ env, home });
  const current = readSuggestionConfig({ filePath, strict: true });
  const original = readSuggestionCodexConfig(codexPath);
  const preview = computeSuggestionMcpConfig(original, { filePath, enabled: action === "on" ? true : current.enabled });
  if (action === "status") {
    output.write(`Next-message suggestions: ${current.enabled ? "enabled" : "disabled"}\nModel: ${terminalCell(current.model)}\n`);
    if (preview.skipped) output.write(`${preview.reason}\n`);
    else if (current.enabled && preview.changed) output.write(`MCP registration is missing or disabled. Run ${commandName} suggestion on to repair it.\n`);
    output.write(`Automatic generation: ${current.enabled && current.automatic ? "configured; Codex hook review is required before it can run" : "unavailable or not configured"}\nAutomatic draft insertion: unavailable; choose Add to draft.\n`);
    return { ...current, configured: !preview.changed && !preview.skipped };
  }
  if (!["on", "off", "model"].includes(action)) throw new Error("Suggestion action must be on, off, model, or status");
  if (preview.skipped && action !== "off") {
    output.write(`${preview.reason}. No changes made.\n`);
    return { changed: false, skipped: true };
  }
  const hookPreview=computeSuggestionAutoHook(original,{filePath,enabled:current.enabled&&current.automatic===true});
  if (action === "on" && current.enabled && current.automatic !== undefined && !preview.changed && !hookPreview.changed) {
    output.write("Suggestions are already configured; kept unchanged.\n");
    return { changed: false, ...current };
  }
  if (action === "off" && !current.enabled && !fs.existsSync(filePath) && !preview.changed) {
    output.write("Suggestions remain disabled; nothing installed.\n");
    return { changed: false, ...current };
  }
  let selected = current.model, reasoning = current.reasoning_effort, catalog;
  if (action !== "off") {
    catalog = await loadCatalog({ env, home });
    const choices = catalog.modelIds.filter(id => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id));
    if (!choices.length) throw new Error("No selectable suggestion models are available");
    if (action === "model" && !model) {
      if (!prompt && (!input.isTTY || !output.isTTY)) throw new Error(`${commandName} suggestion model needs an interactive terminal or a model ID`);
      output.write("Choose the suggestion model:\n");
      choices.forEach((id, index) => output.write(`  ${index + 1}. ${terminalCell(id)}${id === current.model ? " [current]" : ""}\n`));
      const rl = prompt ? null : createInterface({ input, output });
      try {
        const defaultIndex = Math.max(0, choices.indexOf(current.model));
        while (true) {
          const answer = String(await (prompt || (text => rl.question(text)))(`Select [${defaultIndex + 1}], or q to cancel: `)).trim();
          if (answer.toLowerCase() === "q") return { changed: false, cancelled: true };
          const index = answer ? Number(answer) - 1 : defaultIndex;
          if (Number.isInteger(index) && index >= 0 && index < choices.length) { selected = choices[index]; break; }
          output.write("Enter a listed number, or q to cancel.\n");
        }
      } finally { rl?.close(); }
    } else if (action === "model") selected = model;
    if (!choices.includes(selected)) throw new Error(`Model ${terminalCell(selected)} is not available. Use ${commandName} suggestion model to select an available model`);
    reasoning = catalog.reasoningEfforts?.[selected]?.includes("low") ? "low" : null;
  }
  // Re-read both files after asynchronous model lookup/prompts; never overwrite
  // concurrent user edits or unrelated shared settings.
  let binary,hookSupported=false;
  if(action==="on" || action==="model" && current.enabled){
    binary=resolveBinary(env);
    hookSupported=process.platform!=="win32"&&await probeHooks(binary);
  }
  const latest = readSuggestionConfig({ filePath, strict: true });
  if (action !== "model") {
    selected = latest.model;
    if (action === "on" && !catalog.modelIds.includes(selected)) throw new Error("Suggestion model changed during setup; retry with the current selection");
    reasoning = action === "off" ? latest.reasoning_effort : catalog.reasoningEfforts?.[selected]?.includes("low") ? "low" : null;
  }
  const before = readSuggestionCodexConfig(codexPath);
  const enabled = action === "on" ? true : action === "off" ? false : latest.enabled;
  const codex = computeSuggestionMcpConfig(before, { filePath, enabled });
  if (codex.skipped && action !== "off") {
    output.write(`${codex.reason}. No changes made.\n`);
    return { changed: false, skipped: true };
  }
  const hook=computeSuggestionAutoHook(codex.content,{filePath,enabled:enabled&&hookSupported});
  const next = { ...latest, enabled, model: selected, reasoning_effort: reasoning ?? null, automatic:enabled&&hookSupported&&!hook.skipped };
  if (enabled) {
    const address = parseAdapterAddressOptions(env);
    const host = ["0.0.0.0", "localhost"].includes(address.adapterHost) ? "127.0.0.1" : address.adapterHost === "::" ? "::1" : address.adapterHost;
    next.adapter_url = suggestionAdapterUrl(`${adapterBaseUrl(host, address.adapterPort)}/v1`);
    next.codex_binary = binary;
    next.codex_home = path.dirname(codexPath);
  }
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  let changed;
  if ((codex.changed || hook.changed) && !codex.skipped) {
    atomicWriteFilePairSync(codexPath, hook.content, filePath, serialized, { writeFile: atomicWriteFileIfChangedSync });
    changed = true;
  } else changed = atomicWriteFileIfChangedSync(filePath, serialized);
  output.write(`Suggestions: ${next.enabled ? "enabled" : "disabled"}\nModel: ${terminalCell(next.model)}\n`);
  output.write(`Automatic generation: ${next.automatic?"configured; review this CCDX Stop hook in Codex before it can run":"unavailable or disabled"}\nDraft insertion: choose Add to draft; never sends automatically.\n`);
  if(next.automatic)output.write("Use Codex's hook review screen (or /hooks in Codex CLI). Trust only the CCDX suggestion-auto.mjs command. CCDX never grants hook trust.\n");
  if (codex.skipped) output.write(`${codex.reason}. CCDX suggestion requests are disabled.\n`);
  if (enabled) output.write("Open Next message in the conversation panel, or ask Codex for a next-message suggestion. Add to draft never sends.\nIf the tool is not visible, restart Codex App once. Official prediction settings are not modified.\n");
  return { ...next, changed };
}
