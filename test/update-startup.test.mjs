import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { localPackageVersion } from "../src/version.mjs";

const preload = fileURLToPath(new URL("../scripts/replay-fixtures/config-startup-preload.cjs", import.meta.url));
const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const legacy = fileURLToPath(new URL("../bin/codex-copilot-dx.mjs", import.meta.url));

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Update startup fixture timed out")), 10000); })]); }
  finally { clearTimeout(timer); }
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

function start(env, executable) {
  const child = spawn(process.execPath, ["--require", preload, executable], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout.on("data", value => { output += value; });
  child.stderr.on("data", value => { output += value; });
  return { child, done: once(child, "exit"), output: () => output };
}

async function marker(run, text) {
  await bounded((async () => {
    while (!run.output().includes(text)) {
      if (run.child.exitCode !== null || run.child.signalCode) throw new Error(`Exited before ${text}: ${run.output()}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })());
}

for (const [mode, executable] of [["new", cli], ["new", legacy], ["current", cli], ["offline", cli], ["malformed", cli], ["timeout", cli]]) {
  test(`startup update check: ${mode} / ${path.basename(executable)} remains optional on cold start and reuse`, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-update-startup-"));
    const runs = [];
    t.after(async () => {
      for (const run of runs) if (run.child.exitCode === null && !run.child.signalCode) {
        run.child.kill("SIGTERM");
        await bounded(run.done);
      }
      await fs.rm(home, { recursive: true, force: true });
    });
    const token = path.join(home, ".local", "share", "copilot-api", "github_token");
    await fs.mkdir(path.dirname(token), { recursive: true });
    await fs.writeFile(token, "synthetic-offline-github-token", { mode: 0o600 });
    const adapterPort = await port();
    const origin = `http://127.0.0.1:${adapterPort}`;
    const env = { PATH: process.env.PATH, TMPDIR: home, CCDX_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
      CCDX_TEST_UPDATE_MODE: mode, ADAPTER_PORT: String(adapterPort), ADAPTER_HOST: "127.0.0.1",
      CCDX_AUTO_LAUNCH: "0", CCDX_MODEL_REFRESH_INTERVAL_MS: "0", CCDX_DISABLE_TOKEN_DISCOVERY: "1" };
    const cold = start(env, executable);
    runs.push(cold);
    await marker(cold, "Ready, Codex App is ready to use");
    const health = await fetch(`${origin}/_ccdx/health`, { signal: AbortSignal.timeout(3000) }).then(response => response.json());
    assert.equal(health.version, localPackageVersion());
    assert.equal(health.ok, true);
    if (mode === "new") {
      assert.doesNotMatch(cold.output(), /Update available:/);
      const pendingCore = await fetch(`${origin}/v1/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "core while update check is pending", stream: false }), signal: AbortSignal.timeout(3000) });
      assert.equal(pendingCore.status, 200);
      assert.match(await pendingCore.text(), /startup fixture response/);
      assert.doesNotMatch(cold.output(), /Update available:/);
      cold.child.send("release-update-fixture");
      await marker(cold, "update github to update");
    } else if (mode === "timeout") {
      await marker(cold, "Update fixture cancelled");
      assert.ok(cold.output().indexOf("Ready,") < cold.output().indexOf("Update fixture cancelled"));
    }
    const config = path.join(home, ".codex", "config.toml");
    const before = await fs.readFile(config, "utf8");
    const stamp = (await fs.stat(config)).mtimeMs;
    const reuse = start(env, executable);
    runs.push(reuse);
    await marker(reuse, "Ready, using the existing ccdx adapter");
    if (mode === "new") {
      assert.equal(reuse.child.exitCode, null, "Reuse must not exit with a pending notice");
      assert.doesNotMatch(reuse.output(), /Update available:/);
      reuse.child.send("release-update-fixture");
    }
    assert.equal((await bounded(reuse.done))[0], 0, reuse.output());
    for (const run of [cold, reuse]) {
      assert.equal(run.output().split("Update fixture request received").length - 1, 1);
      assert.doesNotMatch(run.output(), /Registry fixture|npm install -g|synthetic-offline-github-token|synthetic release timeout/);
      assert.equal(run.output().includes("Update available:"), mode === "new");
      if (mode === "new") {
        assert.equal(run.output().split("Update available:").length - 1, 1);
        assert.match(run.output(), /-> 99\.0\.0/);
        assert.ok(run.output().indexOf("Ready,") < run.output().indexOf("Update available:"));
      }
    }
    assert.equal(await fs.readFile(config, "utf8"), before);
    assert.equal((await fs.stat(config)).mtimeMs, stamp);
    const response = await fetch(`${origin}/v1/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "offline update check", stream: false }), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /startup fixture response/);
  });
}
