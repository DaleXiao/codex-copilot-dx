import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("default startup keeps request details out of the terminal while opt-in file diagnostics remain usable", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-quiet-startup-"));
  const reservation = http.createServer();await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;await new Promise(resolve => reservation.close(resolve));
  const token = path.join(home, ".local/share/copilot-api/github_token"), log = path.join(home, "debug.log");
  await fs.mkdir(path.dirname(token), { recursive: true });await fs.writeFile(token, "synthetic-offline-github-token");
  const child = spawn(process.execPath, ["--require", fileURLToPath(new URL("../scripts/replay-fixtures/config-startup-preload.cjs", import.meta.url)),
    fileURLToPath(new URL("../bin/cli.mjs", import.meta.url)), "--no-browser"], { env: { PATH: process.env.PATH, TMPDIR: home,
      CCDX_TEST_HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
      ADAPTER_PORT: String(port), ADAPTER_HOST: "127.0.0.1", CCDX_AUTO_LAUNCH: "0", CCDX_M365: "0",
      CCDX_MODEL_REFRESH_INTERVAL_MS: "0", CCDX_DISABLE_TOKEN_DISCOVERY: "1", CCDX_LOG_PATH: log }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const done = once(child, "exit");let output = "";child.stdout.on("data", value => { output += value; });child.stderr.on("data", value => { output += value; });
  t.after(async () => { if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");await done;await fs.rm(home, { recursive: true, force: true }); });
  const deadline = Date.now() + 10000;
  while (!output.includes("Ready       Local service ready")) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Quiet startup failed: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "synthetic", stream: false }), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);assert.match(await response.text(), /startup fixture response/);
  }
  const status = await fetch(`http://127.0.0.1:${port}/_ccdx/status`).then(response => response.json());
  assert.equal(status.requests.by_route.responses.total, 2);
  // Windows terminateProcess does not deliver POSIX SIGTERM; exercise the same
  // production shutdown handler cooperatively through the isolated IPC fixture.
  child.send("shutdown-service-fixture");
  let shutdownTimer;
  try { assert.equal((await Promise.race([done, new Promise((_, reject) => { shutdownTimer = setTimeout(() => reject(new Error("Cooperative fixture shutdown timed out")), 10000); })]))[0], 0); }
  finally { clearTimeout(shutdownTimer); }
  assert.doesNotMatch(output, /responses model=|\x1b\[/);
  assert.match(output, /Sources.*1 source with model lists.*GitHub/);
  assert.match(output, /Claude.*Code: not checked.*App: not checked.*local service off \(off\)/);
  assert.match(await fs.readFile(log, "utf8"), /responses model=gpt-5.5/);
});
