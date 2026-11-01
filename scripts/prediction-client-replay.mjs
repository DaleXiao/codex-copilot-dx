// Native config/account verification in a fresh profile. No App UI or model call.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writePredictionDisplayPreference } from "../src/prediction-preference.mjs";

const args = new Map();for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const binary = args.get("--binary");assert.ok(path.isAbsolute(binary || ""));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-native-prediction-")), profile = path.join(root, "codex");
fs.mkdirSync(profile);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "none" })}.${encode({ email: "synthetic@example.test", exp: 4102444800,
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account", chatgpt_plan_type: "pro" } })}.synthetic`;
const auth = path.join(profile, "auth.json"), config = path.join(profile, "config.toml");
fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { id_token: token, access_token: "synthetic-access", refresh_token: "synthetic-refresh", account_id: "synthetic-account" }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
fs.writeFileSync(config, 'cli_auth_credentials_store = "file"\nmodel = "gpt-6.1-sol"\n');
const digest = () => createHash("sha256").update(fs.readFileSync(auth)).digest("hex"), before = digest();
let routingReads = 0, child;const otherRequests = [];
const server = http.createServer((req, res) => {
  if (req.url === "/api/codex/accounts/check" && req.headers.authorization === "Bearer synthetic-access") {
    routingReads++;res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accounts: [{ id: "synthetic-account", name: "Synthetic", plan_type: "pro",
      workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" }] }));return;
  }
  otherRequests.push({ method: req.method, path: new URL(req.url, "http://localhost").pathname });res.writeHead(404);res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG"].includes(key)));
Object.assign(env, { CODEX_HOME: profile, CCDX_DISABLE_USAGE: "1", HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" });

async function probe() {
  const overrides = { chatgpt_base_url: `http://127.0.0.1:${port}`, "features.plugins": false, "features.remote_plugin": false,
    "features.apps": false, "features.shell_snapshot": false, "analytics.enabled": false, "feedback.enabled": false, check_for_update_on_startup: false };
  const commandArgs = [...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]), "app-server"];
  const sandbox = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote tcp "localhost:${port}"))(deny file-write*)(allow file-write* (subpath ${JSON.stringify(fs.realpathSync(root))}) (literal "/dev/null"))`;
  child = spawn(args.get("--sandbox") === "true" ? "/usr/bin/sandbox-exec" : binary,
    args.get("--sandbox") === "true" ? ["-p", sandbox, binary, ...commandArgs] : commandArgs,
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0, stderr = "";const pending = new Map();child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });child.stdin.on("error", () => {});
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    let value;try { value = JSON.parse(line); } catch { return; }
    const waiter = pending.get(value.id);if (!waiter) return;pending.delete(value.id);
    value.error ? waiter.reject(new Error(`Native RPC failed (${value.error.code})`)) : waiter.resolve(value.result);
  });
  const failed = () => {
    const detail = stderr.match(/sandbox-exec:[^\n]+|error:[^\n]+|Operation not permitted/)?.[0] || "";
    for (const waiter of pending.values()) waiter.reject(new Error("Native client stopped. " + detail.slice(0,300)));pending.clear();
  };
  child.on("error", failed);child.on("exit", failed);
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id);reject(new Error("Native RPC deadline exceeded")); }, 12000);
    pending.set(id, { resolve: value => { clearTimeout(timer);resolve(value); }, reject: error => { clearTimeout(timer);reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await call("initialize", { clientInfo: { name: "ccdx_native_validation", version: "1.3.8" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const cfg = await call("config/read", { includeLayers: false }), account = await call("account/read", { refreshToken: false });
    const status = await call("getAuthStatus", { includeToken: false, refreshToken: false });
    assert.equal(account.account?.type, "chatgpt");assert.equal(status.authMethod, "chatgpt");assert.equal(account.requiresOpenaiAuth, true);
    assert.equal(cfg.config.model, "gpt-6.1-sol");assert.equal(digest(), before);
    return { display: cfg.config.desktop?.["composer-predictions-enabled"] ?? true, model: cfg.config.model, account_type: account.account.type, auth_method: status.authMethod };
  } finally {
    lines.close();child.kill("SIGTERM");
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));child = null;
  }
}

try {
  const results = [{ stage: "before", ...await probe() }];
  for (const enabled of [true, false, true]) {
    // The owned app-server has exited. The separate OS App-close guard is unit-tested.
    writePredictionDisplayPreference(enabled, { home: root, env, platform: "darwin", exec() { throw Object.assign(new Error("isolated profile closed"), { status: 1 }); } });
    const value = await probe();assert.equal(value.display, enabled);results.push({ stage: enabled ? "on" : "off", ...value });
  }
  assert.ok(otherRequests.every(req => req.method === "GET"), "config verification must not start model requests");assert.ok(routingReads > 0);
  console.log(JSON.stringify({ results, synthetic_chatgpt_signin_preserved: true, auth_bytes_unchanged: true,
    routing_reads: routingReads, metadata_requests_refused: otherRequests, model_requests: 0, scope: "native config/account reads; visible App predictions not claimed" }));
} finally {
  child?.kill("SIGTERM");server.closeAllConnections();await new Promise(resolve => server.close(resolve));fs.rmSync(root, { recursive: true, force: true });
}
