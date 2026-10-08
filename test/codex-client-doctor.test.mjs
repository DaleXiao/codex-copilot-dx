import assert from "node:assert/strict";
import test from "node:test";
import { inspectCodexClient, parseRunningCodexApps } from "../src/codex-client-doctor.mjs";

test("client diagnosis groups only App executable identities, not CLI arguments or credentials", () => {
  assert.deepEqual(parseRunningCodexApps([
    " 10 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    " 11 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    " 12 /Applications/Codex.app/Contents/MacOS/Codex",
    " 13 /usr/bin/node", " 14 /usr/local/bin/codex",
  ].join("\n")), [{ name: "ChatGPT.app", pids: [10, 11] }, { name: "Codex.app", pids: [12] }]);
});

test("client diagnosis is bounded/read-only and distinguishes App version, observed catalog and unknown cache", async () => {
  const commands = [];
  let statusCalls = 0;
  const checks = await inspectCodexClient({
    platform: "darwin", home: "/fixture", running: { ok: true },
    readFileFn: (file) => { if (!file.startsWith("/Applications/ChatGPT.app/")) throw Error("missing"); return '<key>CFBundleShortVersionString</key><string>0.162.0</string>'; },
    execFileFn: async (...args) => { commands.push(args); return { stdout: "10 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }; },
    readStatus: async () => { statusCalls += 1; return { data: { version: "0.9.14", models: { source: "cache", client_catalog: { last_request: {
      client_version: "0.161.0", application: "ChatGPT.app", source: "bundled", matched: true,
    } } } } }; },
  });
  assert.equal(statusCalls, 1);
  assert.deepEqual(commands[0].slice(0, 2), ["ps", ["-axo", "pid=,comm="]]);
  assert.equal(commands[0][2].timeout, 1500);
  const text = checks.map(c => c.message).join("\n");
  assert.match(text, /App version 0.162.0/);
  assert.match(text, /Command-Q/);
  assert.match(text, /client 0.161.0/);
  assert.match(text, /directory source: cache/);
  assert.match(text, /not externally verified/);
  assert.doesNotMatch(text, /stale catalog confirmed|\/Applications\//);
});

test("client diagnosis failures and unsupported platforms do not require subprocesses or inference", async () => {
  const checks = await inspectCodexClient({ platform: "linux", running: { ok: true },
    execFileFn: () => { throw Error("must not run"); }, readStatus: async () => { throw Error("offline"); } });
  assert.equal(checks.length, 2);
  assert.equal(checks.every(c => c.kind === "info"), true);
});

test("older adapters without catalog diagnostics are not labelled as having no client requests", async () => {
  const checks = await inspectCodexClient({ platform: "linux", running: { incompatible: true },
    readStatus: async () => ({ data: { version: "0.9.11", models: { source: "live" } } }) });
  const text = checks.map(check => check.message).join("\n");
  assert.match(text, /upgrade and restart CCDX/);
  assert.doesNotMatch(text, /No client model-catalog request observed/);
});
