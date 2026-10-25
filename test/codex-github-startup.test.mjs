import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { updateAccessSettings } from "../src/access-settings.mjs";
import { configureCodexApi } from "../src/codex-api-config.mjs";
import { deploymentModelId } from "../src/model-capabilities.mjs";

test("full managed GitHub startup reconciles the native default after directory initialization", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-github-startup-")), env = { XDG_CONFIG_HOME: path.join(home, ".config") };
  const reservation = http.createServer();await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;await new Promise(resolve => reservation.close(resolve));
  const token = path.join(home, ".local/share/copilot-api/github_token");await fs.mkdir(path.dirname(token), { recursive: true });await fs.writeFile(token, "synthetic-offline-github-token");
  const route = deploymentModelId("github", "gpt-5.5");
  updateAccessSettings(settings => { Object.assign(settings.clients.codex, { source: "github", deployments: [{ source: "github", model: "gpt-5.5" }], default_model: route, model: "gpt-5.5" });return settings; }, { home, env });
  configureCodexApi({ home, env, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "d".repeat(64), model: route });
  const child = spawn(process.execPath, ["--require", fileURLToPath(new URL("../scripts/replay-fixtures/config-startup-preload.cjs", import.meta.url)),
    fileURLToPath(new URL("../bin/cli.mjs", import.meta.url)), "--no-browser"], { env: { PATH: process.env.PATH, TMPDIR: home, ...env,
      CCDX_TEST_HOME: home, XDG_CACHE_HOME: path.join(home, ".cache"), ADAPTER_PORT: String(port), ADAPTER_HOST: "127.0.0.1", CCDX_AUTO_LAUNCH: "0", CCDX_M365: "0",
      CCDX_MODEL_REFRESH_INTERVAL_MS: "0", CCDX_DISABLE_TOKEN_DISCOVERY: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const done = once(child, "exit");let output = "";child.stdout.on("data", data => { output += data; });child.stderr.on("data", data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) child.send("shutdown-service-fixture");
    let timeout;try { await Promise.race([done, new Promise(resolve => { timeout = setTimeout(() => { child.kill();resolve(); }, 5000); })]); }
    finally { clearTimeout(timeout);await fs.rm(home, { recursive: true, force: true }); }
  });
  const deadline = Date.now() + 10000;
  while (!output.includes("Ready       Local service ready")) {
    if (Date.now() > deadline || child.exitCode !== null) throw Error("Isolated managed startup did not become ready");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const config = parse(await fs.readFile(path.join(home, ".codex/config.toml"), "utf8"));
  assert.equal(config.model_provider ?? "openai", "openai");assert.equal(config.model, "gpt-5.5");
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`);assert.equal(response.status, 200);assert.deepEqual((await response.json()).data.map(model => model.id), ["gpt-5.5"]);
});
