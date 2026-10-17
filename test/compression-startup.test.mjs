import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const preload = fileURLToPath(new URL("../scripts/replay-fixtures/config-startup-preload.cjs", import.meta.url));

async function until(check, label) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const mode of ["pending", "default-on", "removed", "timeout", "write-failure", "opt-out"]) {
  test(`optional thread compression ${mode}: cold start and reuse preserve core/image-disabled behavior`, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-compression-startup-"));
    const runs = [];
    t.after(async () => {
      for (const run of runs) if (run.child.exitCode === null && !run.child.signalCode) {
        run.child.kill("SIGTERM");
        await run.done;
      }
      await fs.rm(home, { recursive: true, force: true });
    });
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const token = path.join(home, ".local", "share", "copilot-api", "github_token");
    const config = path.join(home, ".codex", "config.toml");
    await fs.mkdir(path.dirname(token), { recursive: true });
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(token, "synthetic-offline-github-token");
    const before = `openai_base_url = "http://127.0.0.1:${port}/v1"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n[features]\ncontext_management = true\n${mode === "opt-out" ? "local_thread_store_compression = false\n" : ""}`;
    await fs.writeFile(config, before);
    const env = { PATH: process.env.PATH, TMPDIR: home, CCDX_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
      ADAPTER_HOST: "127.0.0.1", ADAPTER_PORT: String(port), CCDX_AUTO_LAUNCH: "0",
      CCDX_MODEL_REFRESH_INTERVAL_MS: "0", CCDX_DISABLE_TOKEN_DISCOVERY: "1", CCDX_TEST_COMPRESSION_MODE: mode };
    const start = () => {
      const child = spawn(process.execPath, ["--require", preload, cli, "--verbose"], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const run = { child, output: () => output, done: once(child, "exit") };
      runs.push(run);
      return run;
    };
    const core = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "synthetic compression check", stream: false }), signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /startup fixture response/);
    };
    const cold = start();
    await until(() => cold.output().includes("Ready       Local service ready"), "cold Ready");
    await core();
    if (mode === "pending") {
      await until(() => cold.output().includes("Compression fixture probe received"), "probe");
      assert.equal(await fs.readFile(config, "utf8"), before);
      cold.child.send("release-compression-fixture");
      await until(() => cold.output().includes("Enabled Codex local history compression"), "compression setup");
    } else if (mode === "write-failure") await until(() => cold.output().includes("Optional Codex history compression setup was skipped"), "optional warning");
    const reuse = start();
    await until(() => reuse.output().includes("Ready       Using the running service"), "reuse Ready");
    if (mode === "timeout") {
      assert.equal(reuse.child.exitCode, null);
      await core();
    }
    await until(() => reuse.child.exitCode !== null, "reuse exit");
    assert.equal(reuse.child.exitCode, 0, reuse.output());
    const after = await fs.readFile(config, "utf8");
    if (mode === "pending") assert.equal(parse(after).features.local_thread_store_compression, true);
    else assert.equal(after, before);
    for (const run of runs) {
      assert.doesNotMatch(run.output(), /private fixture|Image guidance|Image MCP setup|Enabled Codex local history compression.*private/);
      if (mode === "opt-out" || (mode === "pending" && run === reuse)) assert.doesNotMatch(run.output(), /Compression fixture probe received/);
    }
    await assert.rejects(fs.stat(path.join(home, ".codex", "skills")));
    assert.equal((await fs.readdir(home)).filter(name => name.startsWith("ccdx-compression-probe-")).length, 0);
    await core();
  });
}
