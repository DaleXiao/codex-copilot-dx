import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createServiceControl } from "../src/service-control.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { deploymentModelId } from "../src/model-capabilities.mjs";

test("actual CLI processes use the protected loopback API without starting apps or changing native Codex sign-in", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-http-")), env = { CCDX_M365: "0" };
  fs.mkdirSync(path.join(home, ".codex"));
  const config = path.join(home, ".codex/config.toml"), auth = path.join(home, ".codex/auth.json");
  fs.writeFileSync(config, 'model = "native-test"\n');fs.writeFileSync(auth, '{"auth_mode":"chatgpt","tokens":{"access_token":"FAKE-CHATGPT-NO-REAL-ACCESS"}}');
  const authBytes = fs.readFileSync(auth), credentials = new Map(), upstream = [];
  let handler;const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));const port = server.address().port;
  const githubRegistry = { source: "cache", models: { data: [{ id: "native-test", supported_endpoints: ["/responses"] }] } };
  const githubClient = { runtimeStatus: () => ({}), getCachedModelEndpoints: () => ["/responses"] };
  const runtime = createProviderRuntime({ home, env, platform: "linux", corePort: port, githubClient, githubRegistry, inspectDesktop: async () => false,
    secretStore: { get: async ref => credentials.get(ref), set: async (ref, key) => credentials.set(ref, key), remove: async ref => credentials.delete(ref), close() {} },
    createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, fetch: async (url, init) => {
      upstream.push({ url, method: init?.method || "GET" });assert.equal(init?.method || "GET", "GET", "Management must not call inference");return Response.json({ data: [{ id: "api-test", supported_endpoints: ["/responses", "/v1/messages"] }] });
    } }) }), configureClaude: () => ({ app: "configured", code: "configured" }), restoreClaude: () => ({ preserved: 0 }) });
  const serviceControl = createServiceControl({ home, env, providerRuntime: runtime, readImages: () => null, readPrediction: () => ({ enabled: false }) });
  handler = createAdapterHandler({ codexClient: githubClient, codexModelRegistry: githubRegistry, providerRuntime: runtime, log() {}, dashboardOptions: { home, env, serviceControl } });
  t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); });
  const run = (args, stdin = "") => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/cli.mjs", import.meta.url)), ...args], { env: { ...process.env,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
      CCDX_M365: "0", CCDX_AUTO_LAUNCH: "0", CCDX_DISABLE_TOKEN_DISCOVERY: "1", CCDX_DISABLE_USAGE: "1", CCDX_LOG_PATH: "", ADAPTER_HOST: "127.0.0.1", ADAPTER_PORT: String(port),
    }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";const timer = setTimeout(() => { child.kill();reject(Error(`CLI timed out: ${args.join(" ")}`)); }, 15000);
    child.stdout.on("data", bytes => { stdout += bytes; });child.stderr.on("data", bytes => { stderr += bytes; });child.on("error", error => { clearTimeout(timer);reject(error); });
    child.on("close", code => { clearTimeout(timer);resolve({ code, stdout, stderr }); });child.stdin.end(stdin);
  });
  for (const args of [["source", "list", "--format", "json"], ["source", "github", "models", "--format", "json"], ["app", "list", "--format", "json"], ["status", "--format", "json"], ["requests", "--format", "json"]]) {
    const result = await run(args);assert.equal(result.code, 0, result.stderr);assert.doesNotThrow(() => JSON.parse(result.stdout));assert.doesNotMatch(result.stdout, /Ready|FAKE-CHATGPT|\x1b/);
  }
  assert.deepEqual(fs.readFileSync(auth), authBytes);assert.equal(fs.readFileSync(config, "utf8"), 'model = "native-test"\n');
  const legacySource = runtime.connections().clients.find(client => client.id === "codex").source;
  assert.equal((await run(["app", "codex", "disable", "--yes"])).code, 0);
  assert.equal((await run(["app", "codex", "enable", "--yes"])).code, 0);
  const legacyAfter = runtime.connections().clients.find(client => client.id === "codex");
  assert.equal(legacyAfter.source, legacySource);assert.equal(legacyAfter.deployments, undefined);
  assert.doesNotMatch(fs.readFileSync(config, "utf8"), /^model_provider\s*=/m);assert.deepEqual(fs.readFileSync(auth), authBytes);
  const apiFile = path.join(home, "api.json");fs.writeFileSync(apiFile, JSON.stringify({ config: { name: "CLI test API", base_url: "https://synthetic.example/v1",
    endpoints: { responses: "https://synthetic.example/v1/responses", messages: "https://synthetic.example/v1/messages" }, auth_header: "bearer", models: [{ id: "api-test", protocols: ["responses", "messages"] }] }, allowed: ["claude_app"] }));
  const saved = await run(["source", "add", "--file", apiFile, "--key-stdin", "--yes"], "SYNTHETIC-PRIVATE-KEY\n");
  assert.equal(saved.code, 0, saved.stderr);assert.doesNotMatch(saved.stdout + saved.stderr, /SYNTHETIC-PRIVATE-KEY/);
  const graph = runtime.connections(), api = graph.providers.find(source => !source.builtin).id;
  const modelFile = path.join(home, "models.json");fs.writeFileSync(modelFile, JSON.stringify({ deployments: [{ source: "github", model: "native-test" }], default_model: deploymentModelId("github", "native-test"), auto_sync: false }));
  const selected = await run(["app", "codex", "models", "--edit", "--file", modelFile, "--yes"]);assert.equal(selected.code, 0, selected.stderr);
  const before = fs.readFileSync(config), preview = await run(["app", "codex", "sync", "--preview"]);assert.equal(preview.code, 0, preview.stderr);assert.deepEqual(fs.readFileSync(config), before);
  const sync = await run(["app", "codex", "sync", "--yes"]);assert.equal(sync.code, 0, sync.stderr);
  assert.doesNotMatch(fs.readFileSync(config, "utf8"), /^model_provider\s*=/m);assert.match(fs.readFileSync(config, "utf8"), /openai_base_url/);assert.match(fs.readFileSync(config, "utf8"), /^model = "native-test"/m);assert.deepEqual(fs.readFileSync(auth), authBytes);
  const disabled = await run(["app", "codex", "disable", "--yes"]);assert.equal(disabled.code, 0, disabled.stderr);
  const paused = await fetch(`http://127.0.0.1:${port}/v1/models`);assert.equal(paused.status, 503);assert.match(await paused.text(), /ccdx_client_source_disabled/);
  const enabled = await run(["app", "codex", "enable", "--yes"]);assert.equal(enabled.code, 0, enabled.stderr);
  const failure = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", originator: "Codex Desktop" }, body: JSON.stringify({ model: "not-selected", input: "synthetic", stream: false }) });
  assert.equal(failure.status, 400);
  const requests = await run(["requests", "--failed", "--format", "json"]);assert.equal(requests.code, 0, requests.stderr);assert.ok(JSON.parse(requests.stdout).length > 0);
  const bindings = runtime.connections().clients.map(client => ({ source: client.source, deployments: client.deployments }));
  for (const args of [["config", "set", "terminal_color_theme", "pink", "--yes"], ["config", "reset", "--yes"], ["config", "restore", "--yes"]]) {
    const result = await run(args);assert.equal(result.code, 0, result.stderr);
  }
  const settingsResult = await run(["config", "show", "--effective", "--format", "json"]);assert.equal(settingsResult.code, 0, settingsResult.stderr);
  const effective = JSON.parse(settingsResult.stdout).effective;assert.equal(Object.hasOwn(effective, "image_enabled"), false);assert.equal(Object.hasOwn(effective, "prediction_enabled"), false);
  assert.deepEqual(runtime.connections().clients.map(client => ({ source: client.source, deployments: client.deployments })), bindings);
  assert.equal(credentials.size, 1);assert.deepEqual(fs.readFileSync(auth), authBytes);
  const off = await run(["source", api, "disable", "--yes"]);assert.equal(off.code, 0, off.stderr);
  const removed = await run(["source", api, "remove", "--yes"]);assert.equal(removed.code, 0, removed.stderr);
  assert.equal(runtime.connections().providers.some(source => source.id === api), false);assert.equal(credentials.size, 0);assert.deepEqual(fs.readFileSync(auth), authBytes);
  assert.ok(upstream.every(call => call.method === "GET"));
});
