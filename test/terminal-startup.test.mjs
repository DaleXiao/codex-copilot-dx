import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

test("interactive CLI startup retains auth instructions and replaces duplicate checks with scoped live evidence", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-terminal-startup-")), reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const token = path.join(home, ".local/share/copilot-api/github_token");await fs.mkdir(path.dirname(token), { recursive: true });await fs.writeFile(token, "synthetic-offline-github-token");
  const child = spawn(process.execPath, ["--require", fileURLToPath(new URL("../scripts/replay-fixtures/config-startup-preload.cjs", import.meta.url)), fileURLToPath(new URL("../bin/cli.mjs", import.meta.url)), "--no-browser"], {
    env: { PATH: process.env.PATH, TMPDIR: home, CCDX_TEST_HOME: home, CCDX_TEST_TTY: "1", CI: "0", TERM: "xterm-256color", XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
      ADAPTER_PORT: String(port), ADAPTER_HOST: "127.0.0.1", CCDX_AUTO_LAUNCH: "0", CCDX_M365: "0", CCDX_MODEL_REFRESH_INTERVAL_MS: "0", CCDX_DISABLE_TOKEN_DISCOVERY: "1", CCDX_DISABLE_USAGE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const done = once(child, "exit");let output = "";child.stdout.on("data", bytes => { output += bytes; });child.stderr.on("data", bytes => { output += bytes; });
  t.after(async () => { if (child.exitCode === null && !child.signalCode) child.send("shutdown-service-fixture");await done;await fs.rm(home, { recursive: true, force: true }); });
  const deadline = Date.now() + 15000;let state;
  while (Date.now() < deadline) {
    try { state = await fetch(`http://127.0.0.1:${port}/_ccdx/ui/settings`, { headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(1000) }).then(response => response.json()); } catch {}
    if (state?.terminal?.data_state === "current") break;
    if (child.exitCode !== null) throw Error(`Synthetic CLI exited: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(state?.terminal?.data_state, "current", output);
  await new Promise(resolve => setTimeout(resolve, 50));
  const text = stripVTControlCharacters(output).replaceAll("\r", "");
  assert.match(output, /\x1b\[2KStarting/);assert.match(text, /Enabled sources: 1\nGitHub Copilot/);
  assert.match(text, /Codex\s+Configured/);assert.doesNotMatch(text, /Ready\s+Local service ready|\[OK\]\s+Sign-in\s+GitHub token found/);
  const snapshot = await fetch(`http://127.0.0.1:${port}/_ccdx/status`).then(response => response.json());
  assert.equal(snapshot.client_integrations.codex.setup, "configured");assert.equal(snapshot.model_activity.active, 0);
  assert.equal(snapshot.providers.connections, undefined, "Rendering keeps the legacy runtime snapshot contract");
  await assert.rejects(fs.stat(path.join(home, ".config/codex-copilot-dx/connections.json")), { code: "ENOENT" });
  child.send("shutdown-service-fixture");assert.equal((await done)[0], 0);
});
