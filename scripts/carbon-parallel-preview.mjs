#!/usr/bin/env node

// Local, opt-in trial. It starts a separate loopback listener and applies Codex
// overrides only to the child process; the running CCDX service is untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startAdapter } from "../src/adapter.mjs";
import { createCopilotClient } from "../src/copilot.mjs";
import { createProfileRuntime } from "../src/profile-runtime.mjs";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { codexPaths } from "../src/codex-paths.mjs";
import { parseCodexToml } from "../src/config-toml.mjs";
import { loadModelCacheEntry } from "../src/model-cache.mjs";
import { closeHttpServer } from "../src/shutdown.mjs";
import { flushUsageWrites } from "../src/usage.mjs";

const MODEL = "gemini-4-carbon";

export function previewCatalog(cachedModels, codexCatalog) {
  const data = Array.isArray(cachedModels) ? cachedModels : cachedModels?.data;
  const model = data?.find(item => item?.id === MODEL);
  const codexModel = codexCatalog?.models?.find(item => item?.slug === MODEL);
  if (!model?.supported_endpoints?.some(endpoint => ["/chat/completions", "/v1/chat/completions"].includes(endpoint)) || !codexModel) {
    throw new Error("Carbon is missing from the saved model catalogs; refresh the installed CCDX catalog first");
  }
  return { models: [{ ...structuredClone(codexModel), use_responses_lite: true }] };
}

export function previewArguments({ port, catalogFile, prompt = "", live = false, once = false }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.isAbsolute(catalogFile) || typeof prompt !== "string" || once && !prompt.trim()) {
    throw new Error("The preview needs a local port and catalog; --once also needs a prompt");
  }
  return ["--no-daemon", ...(once ? ["exec", "--ephemeral", "--skip-git-repo-check"] : []),
    "-m", MODEL, "-c", "openai_base_url=" + JSON.stringify("http://127.0.0.1:" + port + "/v1"),
    "-c", "model_catalog_json=" + JSON.stringify(catalogFile),
    ...(live ? ["-c", 'web_search="live"'] : []), ...(prompt ? [prompt] : [])];
}

async function main() {
  const args = process.argv.slice(2);let live = false, once = false;
  while (["--live", "--once"].includes(args[0])) {
    if (args.shift() === "--live") live = true;else once = true;
  }
  const prompt = args.join(" ").trim();
  if (once && !prompt) throw new Error('Provide a prompt after --once');
  const paths = codexPaths(), config = parseCodexToml(fs.readFileSync(paths.config, "utf8"));
  if (config.model_provider && config.model_provider !== "openai") {
    throw new Error("The parallel preview requires the current Codex openai provider; the existing configuration was not changed");
  }
  const client = createCopilotClient({ profile: "codex", allowTokenDiscovery: false, writeGithubIdentity() {} });
  const profile = createProfileRuntime({ codexClient: client });
  if (!profile.codexProfile.valid) throw new Error("The existing Copilot sign-in is unavailable; the preview did not change it");
  const saved = loadModelCacheEntry({ credentialFingerprint: profile.codexCredentialFingerprint }), cachedModels = saved?.models;
  const codexCatalog = JSON.parse(fs.readFileSync(path.join(paths.directory, "models_cache.json"), "utf8"));
  const catalog = previewCatalog(cachedModels, codexCatalog);
  const tempRoot = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(tempRoot, "ccdx-carbon-parallel-"));
  const catalogFile = path.join(directory, "models.json");
  let server, runtime, child, interrupted = false;
  // Interactive Ctrl-C already reaches the child through the terminal.
  const interrupt = () => { if (!process.stdin.isTTY) { interrupted = true;child?.kill("SIGINT"); } };
  const terminate = () => { interrupted = true;child?.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);process.on("SIGTERM", terminate);
  try {
    fs.writeFileSync(catalogFile, JSON.stringify(catalog), { mode: 0o600 });
    client.cacheModelEndpoints(cachedModels);
    runtime = createProviderRuntime({ githubClient: client, githubRegistry: { models: cachedModels }, corePort: 0,
      githubCredentialFingerprint: () => profile.codexCredentialFingerprint, preserveClientConfiguration: () => true });
    const target = runtime.resolveCodex({ model: MODEL }, { headers: {} }) || runtime.current({ method: "POST", headers: {} });
    if (target?.id !== "github") throw new Error("Carbon is not enabled for the existing GitHub Codex source");
    server = await startAdapter(0, "127.0.0.1", {
      codexClient: client, codexModelRegistry: { models: cachedModels }, providerRuntime: runtime, terminalActivity: null,
      codexModelCatalog: { load: async () => catalog },
      listModelsFn: async () => ({ status: 200, body: JSON.stringify(cachedModels) }),
    });
    const port = server.address().port;
    console.log("Carbon preview is running on an isolated local port. The existing CCDX service was not changed.");
    console.log("This preview uses the existing privacy setting and may start another local detector.");
    child = spawn("codex", previewArguments({ port, catalogFile, prompt, live, once }), { stdio: "inherit", env: process.env });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);child.once("exit", value => resolve(value ?? (interrupted ? 130 : 1)));
    });
    process.exitCode = code;
  } finally {
    process.off("SIGINT", interrupt);process.off("SIGTERM", terminate);
    if (server) { await closeHttpServer(server, { timeoutMs: 5000 });await flushUsageWrites(); }
    if (runtime) await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error("Carbon preview: " + error.message);
    process.exitCode = 1;
  }
}
