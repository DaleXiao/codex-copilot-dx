// Optional real CLI replay. Uses isolated profiles, fake credentials, and only
// loopback sockets. Does not read live user configuration or call any provider.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { localPackageVersion } from "../src/version.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-config-startup-"));
const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./replay-fixtures/config-startup-preload.cjs", import.meta.url));
const summaries = [];

async function bounded(promise, label, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function start(env) {
  const child = spawn(process.execPath, ["--require", preload, cli], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  return { child, output: () => output, done: once(child, "exit") };
}

async function ready(run, marker = "Ready, Codex App is ready to use") {
  await bounded((async () => {
    while (!run.output().includes(marker)) {
      if (run.child.exitCode !== null || run.child.signalCode) throw new Error(`CLI exited before ready: ${run.output()}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })(), "CLI readiness");
}

async function checkCore(origin) {
  const health = await fetch(`${origin}/_ccdx/health`, { signal: AbortSignal.timeout(3000) }).then(response => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.version, localPackageVersion());
  const response = await fetch(`${origin}/v1/responses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "offline startup check", stream: false }), signal: AbortSignal.timeout(3000) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /startup fixture response/);
}

try {
  for (const mode of ["markerless", "conflict", "image-write-failure", "skill-conflict", "provider-invalid", "runtime-image-failure", "disabled", "disabled-dirty", "invalid"]) {
    const home = path.join(root, mode);
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const codexPath = path.join(home, ".codex", "config.toml");
    const tokenPath = path.join(home, ".local", "share", "copilot-api", "github_token");
    const providerPath = path.join(home, ".config", "codex-copilot-dx", "image-provider.json");
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    await fs.writeFile(tokenPath, "synthetic-offline-github-token", { mode: 0o600 });
    const disabled = ["disabled", "disabled-dirty", "provider-invalid"].includes(mode);
    if (!["disabled", "disabled-dirty"].includes(mode)) {
      await fs.mkdir(path.dirname(providerPath), { recursive: true });
      await fs.writeFile(providerPath, JSON.stringify({ enabled: true, endpoint: "https://images.example/v1/images/generations", api_key: "synthetic-image-key", model: "qwen-image-3.0-pro", protocol: "qwen-messages" }), { mode: 0o600 });
      if (mode === "provider-invalid") await fs.writeFile(providerPath, '{"api_key":"private-fixture"');
    }
    const image = mode === "conflict"
      ? '# ccdx:image-mcp:start\n[mcp_servers.ccdx_image]\nurl = "https://user.example/mcp?key=private-fixture"\nenabled = true\n'
      : ["markerless", "skill-conflict", "provider-invalid", "runtime-image-failure", "disabled-dirty"].includes(mode)
        ? `[mcp_servers.ccdx_image]\nurl = "${origin}/mcp/image"\nenabled = true\ntool_timeout_sec = 210\n` : "";
    const before = mode === "invalid" ? 'secret = "private-fixture\n' : `openai_base_url = "${origin}/v1"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n${image}[features]\ncontext_management = true\n`;
    await fs.writeFile(codexPath, before);
    if (mode === "skill-conflict") {
      await fs.mkdir(path.join(home, ".codex", "skills", "ccdx-image"), { recursive: true });
      await fs.writeFile(path.join(home, ".codex", "skills", "ccdx-image", "SKILL.md"), "user-owned guidance");
    }
    if (mode === "disabled-dirty") await fs.writeFile(path.join(home, ".codex", "skills"), "must remain untouched");
    const env = { PATH: process.env.PATH, TMPDIR: root, LANG: "en_US.UTF-8", CCDX_TEST_HOME: home, CODEX_HOME: path.dirname(codexPath), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), ADAPTER_HOST: "127.0.0.1", ADAPTER_PORT: String(port), CCDX_AUTO_LAUNCH: "0", CCDX_MODEL_REFRESH_INTERVAL_MS: "0", CCDX_DISABLE_TOKEN_DISCOVERY: "1" };
    if (mode === "image-write-failure") env.CCDX_TEST_IMAGE_WRITE_FAILURE = "1";
    if (mode === "runtime-image-failure") env.CCDX_TEST_PENDING_IMAGE = "1";
    const cold = start(env);
    let reused;
    try {
      if (mode === "invalid") {
        const [code] = await bounded(cold.done, "invalid-config exit");
        assert.equal(code, 1);
        assert.match(cold.output(), /not valid TOML/);
        assert.doesNotMatch(cold.output(), /private-fixture/);
        assert.equal(await fs.readFile(codexPath, "utf8"), before);
        await assert.rejects(fetch(`${origin}/_ccdx/health`, { signal: AbortSignal.timeout(1000) }));
        summaries.push({ mode, fatalConfigPreserved: true, adapterClosed: true });
        continue;
      }
      await ready(cold);
      await checkCore(origin);
      assert.equal(await fs.readFile(codexPath, "utf8"), before);
      assert.equal(cold.output().includes("Image MCP setup was skipped"), ["conflict", "image-write-failure"].includes(mode));
      assert.equal(cold.output().includes("Image guidance could not be updated"), mode === "skill-conflict");
      assert.doesNotMatch(cold.output(), /private-fixture|synthetic-image-key|synthetic-offline-github-token/);
      const skillExists = await fs.stat(path.join(home, ".codex", "skills", "ccdx-image")).then(() => true, error => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; });
      assert.equal(skillExists, ["markerless", "skill-conflict", "runtime-image-failure"].includes(mode));
      if (disabled) assert.doesNotMatch(cold.output(), /Image MCP setup|Image guidance/);
      if (mode === "skill-conflict") assert.equal(await fs.readFile(path.join(home, ".codex", "skills", "ccdx-image", "SKILL.md"), "utf8"), "user-owned guidance");
      if (mode === "disabled-dirty") assert.equal(await fs.readFile(path.join(home, ".codex", "skills"), "utf8"), "must remain untouched");
      if (mode === "runtime-image-failure") {
        let settled = false;
        const pending = fetch(`${origin}/mcp/image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "synthetic pending image" } } }), signal: AbortSignal.timeout(8000) })
          .then(response => response.json()).finally(() => { settled = true; });
        await ready(cold, "Image fixture request pending");
        await checkCore(origin);
        assert.equal(settled, false, "GPT must respond while the image provider is pending");
        cold.child.send("release-image-fixture");
        assert.equal((await pending).result.isError, true);
        await checkCore(origin);
        assert.equal(cold.output().split("Image fixture request pending").length - 1, 1);
      }
      if (mode === "disabled") assert.equal(parse(before).mcp_servers?.ccdx_image, undefined);
      const stat = await fs.stat(codexPath);
      reused = start(env);
      const [code] = await bounded(reused.done, "existing-adapter reuse");
      assert.equal(code, 0, reused.output());
      assert.match(reused.output(), /Using existing adapter/);
      assert.equal(await fs.readFile(codexPath, "utf8"), before);
      assert.equal((await fs.stat(codexPath)).mtimeMs, stat.mtimeMs);
      await checkCore(origin);
      const combinedOutput = cold.output() + reused.output();
      const imageMcpRequests = combinedOutput.split("Image fixture MCP request received").length - 1;
      const imageUpstreamRequests = combinedOutput.split("Image fixture outbound request").length - 1;
      assert.equal(imageMcpRequests, mode === "runtime-image-failure" ? 1 : 0);
      assert.equal(imageUpstreamRequests, mode === "runtime-image-failure" ? 1 : 0);
      summaries.push({ mode, coldStart: true, reuse: true, coreResponses: true, configUnchanged: true, imageSkillPresent: skillExists, imageMcpRequests, imageUpstreamRequests, ...(mode === "runtime-image-failure" ? { coreDuringPendingImage: true, coreAfterImageFailure: true, imageDispatches: 1 } : {}) });
    } finally {
      for (const run of [reused, cold]) {
        if (!run || run.child.exitCode !== null || run.child.signalCode) continue;
        run.child.kill("SIGTERM");
        try { await bounded(run.done, "shutdown", 3000); } catch { run.child.kill("SIGKILL"); await bounded(run.done, "forced shutdown", 3000); }
      }
    }
  }
  console.log(JSON.stringify({ realProviderCalls: 0, summaries }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
