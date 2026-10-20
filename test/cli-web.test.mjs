import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWebCommand } from "../src/cli-web.mjs";
import { closeHttpServer } from "../src/shutdown.mjs";

test("web starts account tools without auth, app configuration or a provider request", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-web-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const beforeSignals = new Set([...process.listeners("SIGINT"), ...process.listeners("SIGTERM")]);
  const server = await runWebCommand({ home, env: { CI: "1", CCDX_M365: "0" }, port: 0, output: () => {} });
  t.after(async () => {
    await closeHttpServer(server);
    for (const signal of ["SIGINT", "SIGTERM"]) for (const listener of process.listeners(signal)) if (!beforeSignals.has(listener)) process.removeListener(signal, listener);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const account = await fetch(`${base}/_ccdx/ui/account`, { headers: { "X-CCDX-Dashboard": "1" } }).then(r => r.json());
  assert.equal(account.saved, false);assert.equal(account.operation, null);
  const providers = await fetch(`${base}/_ccdx/ui/providers`, { headers: { "X-CCDX-Dashboard": "1" } }).then(r => r.json());
  assert.equal(providers.providers[0].clients[0].state, "unknown", "Management startup does not claim app configuration was verified");
  const html = await fetch(base).then(r => r.text());assert.match(html, /id="github-signin"/);assert.match(html, /data-view="checks"/);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, ".local", "share", "ccdx", "github_token")), false);
  assert.equal(server.ccdxSnapshot().providers?.m365?.token_cached, undefined);
});
