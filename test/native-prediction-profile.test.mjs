import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { predictionPaths, readPredictionSettings, writePredictionSettings, assertPredictionProxyCompatible,
  createPredictionCertificate, readPredictionCertificate, updatePredictionTrust, predictionTrustMetadata,
  assertCodexClosed } from "../src/native-prediction-profile.mjs";
import { runPredictionCommand, startNativePrediction } from "../src/native-prediction.mjs";
import { parseCliArgs, cliHelp } from "../src/cli-options.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-native-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home: root, env: { CODEX_ELECTRON_USER_DATA_PATH: path.join(root, "app-profile") }, root };
}
function noRunningApp(command, args, opts) {
  if (command.endsWith("pgrep")) throw Object.assign(new Error("not running"), { status: 1 });
  if (command.endsWith("scutil")) return "<dictionary> {}";
  return execFileSync(command, args, opts);
}
const app = { app: "/Applications/ChatGPT.app", archive: "/not-an-installed-fixture", size: 1, mtimeMs: 1 };

test("prediction CLI has explicit on/off/status, off by default, without model rewriting", () => {
  for (const action of ["on", "off", "status"]) assert.equal(parseCliArgs(["prediction", action]).action, action);
  assert.equal(parseCliArgs(["prediction"]).action, "status");
  assert.throws(() => parseCliArgs(["prediction", "model"]));
  assert.throws(() => parseCliArgs(["prediction", "on", "extra"]));
  assert.match(cliHelp("ccdx", "prediction"), /off by default/);
  assert.match(cliHelp("ccdx", "prediction"), /decrypted locally/);
});

test("default and status do not create files, probe an App, or start a bridge", async (t) => {
  const opts = fixture(t);
  const before = fs.readdirSync(opts.root);
  assert.equal(readPredictionSettings(opts).enabled, false);
  assert.equal(await startNativePrediction({ ...opts, platform: "linux", exec() { throw new Error("must not probe"); } }), null);
  await runPredictionCommand({ ...opts, action: "status", output() {} });
  assert.deepEqual(fs.readdirSync(opts.root), before);
});

test("prediction status reports runtime evidence without modifying the saved preference", async t => {
  const opts = fixture(t), before = fs.readdirSync(opts.root), lines = [];
  await runPredictionCommand({ ...opts, action: "status", output: text => lines.push(text),
    runtimeSnapshot: async () => ({ client_integrations: { prediction: {
      bridge: "running", client_route: "observed", candidate: "unknown",
      configuration: { bootstrap: { status: 200, modified: true } },
    } } }) });
  assert.match(lines.join("\n"), /Bridge: running; client route: observed; visible candidate: unknown/);
  assert.match(lines.join("\n"), /bootstrap: HTTP 200 \(local compatibility\)/);
  assert.deepEqual(fs.readdirSync(opts.root), before);
});

test("static proxies are accepted; invalid and dynamic routes preserve existing settings", () => {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY"]) {
    assert.doesNotThrow(() => assertPredictionProxyCompatible({ env: { [key]: "https://proxy.example.test" } }));
  }
  assert.throws(() => assertPredictionProxyCompatible({ env: { CODEX_API_BASE_URL: "https://custom.test" } }), /CODEX_API_BASE_URL/);
  for (const name of ["ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]) {
    assert.throws(() => assertPredictionProxyCompatible({ env: {}, systemProxy: `${name} : 1` }));
  }
  assert.doesNotThrow(() => assertPredictionProxyCompatible({ env: {}, systemProxy: "HTTPEnable : 0" }));
  assert.throws(() => assertCodexClosed({ exec() { return "42"; } }), /Quit Codex/);
  assert.doesNotThrow(() => assertCodexClosed({ exec: noRunningApp }));
});

test("unsupported systems and running Apps cause no setup writes", async (t) => {
  const opts = fixture(t);
  await assert.rejects(runPredictionCommand({ ...opts, action: "on", platform: "linux" }), /macOS only/);
  await assert.rejects(runPredictionCommand({ ...opts, action: "on", platform: "darwin", exec() { return "42"; } }), /Quit Codex/);
  assert.equal(fs.existsSync(predictionPaths(opts).settings), false);
});

test("private certificate and profile trust preserve unrelated records and can be removed", async (t) => {
  const opts = fixture(t), paths = predictionPaths(opts);
  const cert = createPredictionCertificate(paths.directory);
  assert.equal(fs.statSync(path.join(paths.directory, "bridge.key")).mode & 0o077, 0);
  assert.deepEqual(fs.readdirSync(paths.directory).sort(), ["bridge.key", "bridge.pem", "ca.pem"]);
  assert.equal(readPredictionCertificate(paths.directory).hash, cert.hash);
  assert.equal(await updatePredictionTrust(paths.store, cert), true);
  const db = new DatabaseSync(paths.store);
  db.prepare("INSERT INTO certificates VALUES(?,?,?)").run("UNRELATED", Buffer.from("opaque"), Buffer.from("user trust"));
  db.close();
  assert.equal(await updatePredictionTrust(paths.store, cert), false);
  assert.equal(await updatePredictionTrust(paths.store, cert, { remove: true }), true);
  const final = new DatabaseSync(paths.store, { readOnly: true });
  assert.deepEqual(final.prepare("SELECT sha256hash_hex FROM certificates").all().map((r) => r.sha256hash_hex), ["UNRELATED"]);
  final.close();
  assert.equal(await updatePredictionTrust(paths.store, cert, { remove: true }), false);
});

test("modified trust and unknown DB schemas are preserved", async (t) => {
  const opts = fixture(t), paths = predictionPaths(opts), cert = createPredictionCertificate(paths.directory);
  await updatePredictionTrust(paths.store, cert);
  const db = new DatabaseSync(paths.store);
  db.prepare("UPDATE certificates SET trust_settings=? WHERE sha256hash_hex=?").run(Buffer.from("user edit"), cert.hash);
  db.close();
  await assert.rejects(updatePredictionTrust(paths.store, cert, { remove: true }), /preserved/);
  const second = new DatabaseSync(paths.store);
  assert.equal(Buffer.from(second.prepare("SELECT trust_settings FROM certificates").get().trust_settings).toString(), "user edit");
  second.prepare("UPDATE certificates SET trust_settings=?").run(predictionTrustMetadata());
  second.prepare("UPDATE meta SET value='999' WHERE key='version'").run(); second.close();
  await assert.rejects(updatePredictionTrust(paths.store, cert), /Unknown certificate-store/);
});

test("explicit on/off supports profile changes and never writes config.toml", async (t) => {
  const opts = fixture(t), paths = predictionPaths(opts);
  const run = { ...opts, platform: "darwin", exec: noRunningApp, resolveApp: () => app, output() {} };
  await runPredictionCommand({ ...run, action: "on" });
  const settings = readPredictionSettings(opts);
  assert.equal(settings.enabled, true);
  assert.equal(fs.existsSync(path.join(opts.home, ".codex", "config.toml")), false);
  await runPredictionCommand({ ...run, action: "off" });
  const disabled = readPredictionSettings(opts);
  assert.equal(disabled.enabled, false); assert.equal(disabled.store, undefined); assert.equal(disabled.certificateHash, undefined);
  const other = { ...run, env: { CODEX_ELECTRON_USER_DATA_PATH: path.join(opts.root, "second-profile") } };
  await runPredictionCommand({ ...other, action: "on" });
  assert.equal(readPredictionSettings(other).store, predictionPaths(other).store);
  await runPredictionCommand({ ...other, action: "off" });
  const db = new DatabaseSync(paths.store, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS count FROM certificates").get().count, 0); db.close();
});

test("failed activation removes only newly added trust and generated keys", async (t) => {
  const opts = fixture(t), paths = predictionPaths(opts);
  await assert.rejects(runPredictionCommand({ ...opts, platform: "darwin", action: "on", exec: noRunningApp,
    resolveApp: () => app, output() {}, writeSettings() { throw new Error("fixture disk failure"); } }), /disk failure/);
  assert.equal(fs.existsSync(paths.settings), false);
  assert.deepEqual(fs.readdirSync(paths.directory), []);
  const db = new DatabaseSync(paths.store, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS count FROM certificates").get().count, 0); db.close();
});

test("off stops overlay even when App is open and defers trust cleanup", async (t) => {
  const opts = fixture(t);
  const run = { ...opts, platform: "darwin", exec: noRunningApp, resolveApp: () => app, output() {} };
  await runPredictionCommand({ ...run, action: "on" });
  const result = await runPredictionCommand({ ...run, action: "off", exec() { return "42"; } });
  assert.equal(result.cleanupPending, true); assert.equal(readPredictionSettings(opts).enabled, false);
  await runPredictionCommand({ ...run, action: "off" });
  assert.equal(readPredictionSettings(opts).store, undefined);
});

test("failed reactivation preserves an existing trust record and preference", async (t) => {
  const opts = fixture(t);
  const run = { ...opts, platform: "darwin", exec: noRunningApp, resolveApp: () => app, output() {} };
  await runPredictionCommand({ ...run, action: "on" });
  const before = readPredictionSettings(opts), bytes = fs.readFileSync(predictionPaths(opts).settings);
  await assert.rejects(runPredictionCommand({ ...run, action: "on", writeSettings() { throw new Error("commit failed"); } }), /commit failed/);
  assert.deepEqual(fs.readFileSync(predictionPaths(opts).settings), bytes);
  const db = new DatabaseSync(before.store, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS count FROM certificates WHERE sha256hash_hex=?").get(before.certificateHash).count, 1);db.close();
});

test("expired renewal commit failure retains old trust and off can still remove it", async (t) => {
  const opts = fixture(t), paths = predictionPaths(opts);
  const directory = path.join(paths.directory, "credentials-expired");
  const expireLeaf = (command, args, options) => {
    if (args[0] !== "x509") return execFileSync(command, args, options);
    // `x509 -days 0` is rejected by macOS LibreSSL. The CA command supports
    // explicit historical validity dates on both LibreSSL and OpenSSL.
    const value = (flag) => args[args.indexOf(flag) + 1];
    const temporary = path.dirname(value("-in"));
    const index = path.join(temporary, "index.txt"), serial = path.join(temporary, "serial");
    const config = path.join(temporary, "expired-ca.cnf");
    fs.writeFileSync(index, "");fs.writeFileSync(serial, "01\n");
    fs.writeFileSync(config, `[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=${index}\nserial=${serial}\nnew_certs_dir=${temporary}\ncertificate=${value("-CA")}\nprivate_key=${value("-CAkey")}\ndefault_md=sha256\npolicy=subject\n[subject]\ncommonName=supplied\n`);
    return execFileSync(command, ["ca", "-batch", "-config", config, "-in", value("-in"), "-out", value("-out"),
      "-startdate", "20200101000000Z", "-enddate", "20210101000000Z", "-extfile", value("-extfile"), "-notext"], options);
  };
  assert.throws(() => createPredictionCertificate(directory, { exec: expireLeaf }), /needs renewal/);
  const expired = readPredictionCertificate(directory, { allowExpired: true });
  await updatePredictionTrust(paths.store, expired);
  writePredictionSettings({ version: 1, enabled: true, app, store: paths.store,
    certificateHash: expired.hash, credentialsDirectory: directory }, opts);
  const before = fs.readFileSync(paths.settings);
  const run = { ...opts, platform: "darwin", exec: noRunningApp, resolveApp: () => app, output() {} };
  await assert.rejects(runPredictionCommand({ ...run, action: "on", writeSettings() { throw new Error("renewal commit failed"); } }), /renewal commit failed/);
  assert.deepEqual(fs.readFileSync(paths.settings), before);
  assert.deepEqual(fs.readdirSync(paths.directory).sort(), ["credentials-expired", "settings.json"]);
  const db = new DatabaseSync(paths.store, { readOnly: true });
  assert.deepEqual(db.prepare("SELECT sha256hash_hex FROM certificates").all().map(r => r.sha256hash_hex), [expired.hash]);db.close();
  await runPredictionCommand({ ...run, action: "off" });
  assert.equal(readPredictionSettings(opts).enabled, false);
  const after = new DatabaseSync(paths.store, { readOnly: true });
  assert.equal(after.prepare("SELECT count(*) AS count FROM certificates").get().count, 0);after.close();
});

test("malformed preferences cannot silently reenable or write settings", async (t) => {
  const opts = fixture(t), paths = predictionPaths(opts);
  fs.mkdirSync(paths.directory, { recursive: true }); fs.writeFileSync(paths.settings, "bad json");
  await assert.rejects(startNativePrediction(opts), /invalid/);
  await assert.rejects(runPredictionCommand({ ...opts, action: "status", output() {} }), /invalid/);
  assert.equal(fs.readFileSync(paths.settings, "utf8"), "bad json");
});
