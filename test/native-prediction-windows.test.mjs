import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import https from "node:https";
import { assertWindowsCodexClosed, installedWindowsPredictionApp, windowsPredictionProfile,
  windowsProxyText, windowsSystemProxy, windowsPrivatePredictionPath, windowsPowerShellEnvironment, windowsPredictionAppProcesses } from "../src/native-prediction-windows.mjs";
import { windowsPredictionCertificate } from "../src/windows-prediction-certificate.mjs";
import { resolveNetworkRoute, networkProxyFor } from "../src/network-route.mjs";
import { openCodex } from "../src/launcher.mjs";
import { runPredictionCommand, startNativePrediction } from "../src/native-prediction.mjs";
import { predictionPaths, readPredictionSettings, writePredictionSettings, readPredictionCertificate, createPredictionCertificate, updatePredictionTrust } from "../src/native-prediction-profile.mjs";

const registration = { root: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture", executable: "app/ChatGPT.exe", family: "OpenAI.Codex_2p2nqsd0c76g0" };
const executable = path.win32.join(registration.root, registration.executable);
const archive = path.win32.join(path.win32.dirname(executable), "resources", "app.asar");

test("Windows PowerShell children prefer bundled modules without changing the caller environment", () => {
  const env = Object.freeze({ SystemRoot: "C:\\Windows", PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules;C:\\custom", CODEX_HOME: "existing" });
  const child = windowsPowerShellEnvironment(env);
  assert.equal(child.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;" + env.PSModulePath);
  assert.equal(child.CODEX_HOME, "existing");assert.equal(env.PSModulePath.startsWith("C:\\Program Files"), true);
});

test("Windows discovery uses registered Store metadata, not guessed executables or a shell", t => {
  t.mock.method(fs, "existsSync", file => file === archive);
  let call;
  const app = installedWindowsPredictionApp({ env: { SystemRoot: "C:\\Windows" }, exec(command, args, options) {
    call = { command, args, options };return JSON.stringify(registration);
  } });
  assert.deepEqual(app, { app: executable, archive, family: registration.family });
  assert.match(call.args.at(-1), /Get-AppxPackage -Name OpenAI.Codex/);
  assert.match(call.args.at(-1), /SignatureKind -eq 3/);
  assert.match(call.args.at(-1), /Publisher -eq 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'/);
  assert.equal(call.args.includes("-NoProfile"), true);
  assert.equal(call.args.includes("-ExecutionPolicy"), false);
  assert.equal(call.options.windowsHide, true);
  for (const changed of [{ executable: "..\\Codex.exe" }, { executable: "C:\\outside\\Codex.exe" }, { executable: "cmd.exe" },
    { root: "\\\\remote\\share" }, { family: "unrelated_package" }]) {
    assert.throws(() => installedWindowsPredictionApp({ exec: () => JSON.stringify({ ...registration, ...changed }) }), /Unknown Windows/);
  }
});

test("Windows process checks fail closed and never stop an App", () => {
  assert.doesNotThrow(() => assertWindowsCodexClosed({ exec: () => "closed" }));
  for (const value of ["running", "unexpected", ""]) assert.throws(() => assertWindowsCodexClosed({ exec: () => value }), /Quit Codex/);
  assert.throws(() => assertWindowsCodexClosed({ exec() { throw new Error("fixture"); } }), /Could not check/);
});

test("Windows launch-route inspection is bounded and never outputs or interpolates full command lines", () => {
  let call;
  const result = windowsPredictionAppProcesses(executable, { exec(command, args, options) {
    call = { args, options };return '[{"pid":123,"route":"http://127.0.0.1:12345/proxy.pac","readable":true}]';
  } });
  assert.equal(result[0].pid, 123);assert.equal(call.options.env.CCDX_PREDICTION_APP_PATH, executable);
  assert.ok(!call.args.at(-1).includes(executable));assert.match(call.args.at(-1), /Get-CimInstance/);
  assert.doesNotMatch(call.args.at(-1), /Stop-Process|CommandLine\s*=|taskkill/);
  for (const raw of ['{}', '[{"pid":1,"readable":true,"route":"https://outside.test"}]']) {
    assert.throws(() => windowsPredictionAppProcesses(executable, { exec: () => raw }), /route/);
  }
});

test("Windows profile discovery handles MSIX virtualization and preserves ambiguous profiles", t => {
  const env = { APPDATA: "C:\\Users\\测试\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\测试\\AppData\\Local" };
  const packaged = path.win32.join(env.LOCALAPPDATA, "Packages", registration.family, "LocalCache", "Roaming", "Codex");
  let present = [path.win32.join(packaged, "Local State")];
  t.mock.method(fs, "existsSync", file => present.includes(file));
  assert.equal(windowsPredictionProfile({ env, app: registration }), packaged);
  present.push(path.win32.join(env.APPDATA, "Codex", "Local State"));
  assert.throws(() => windowsPredictionProfile({ env, app: registration }), /Multiple/);
  assert.equal(windowsPredictionProfile({ env, app: registration, preferredProfile: packaged }), packaged);
  assert.equal(windowsPredictionProfile({ env: { ...env, CODEX_ELECTRON_USER_DATA_PATH: " " }, app: registration, preferredProfile: packaged }), packaged);
  for (const preferredProfile of ["--bad-option", "C:\\missing", packaged + "\n"]) {
    assert.throws(() => windowsPredictionProfile({ env, app: registration, preferredProfile }), /Previously selected/);
  }
  present = [];assert.throws(() => windowsPredictionProfile({ env, app: registration }), /Open Codex App once/);
  const modern = path.win32.join(env.APPDATA, "ChatGPT");present = [path.win32.join(modern, "Local State")];
  assert.equal(windowsPredictionProfile({ env, app: { ...registration, app: executable } }), modern);
  present.push(path.win32.join(packaged, "Local State"));
  assert.throws(() => windowsPredictionProfile({ env, app: { ...registration, app: executable } }), /Multiple/);
  assert.equal(windowsPredictionProfile({ env: { CODEX_ELECTRON_USER_DATA_PATH: "/explicit-profile" } }), path.resolve("/explicit-profile"));
});

test("Windows nested web profiles select their own trust location without scanning unrelated directories", t => {
  const env = { APPDATA: "C:\\Users\\fixture\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" };
  const root = path.win32.join(env.LOCALAPPDATA, "Packages", registration.family, "LocalCache", "Roaming", "Codex");
  const profile = path.win32.join(root, "web", "Codex");
  let present = [root, path.win32.join(root, "web"), path.win32.join(profile, "Local State"),
    path.win32.join(profile, "Default", "Preferences"), path.win32.join(profile, "Default", "ServerCertificate")];
  t.mock.method(fs, "existsSync", file => present.includes(file));
  t.mock.method(fs, "readdirSync", () => assert.fail("profile discovery must not recursively scan App data"));
  assert.equal(windowsPredictionProfile({ env, app: { ...registration, app: executable } }), profile);
  present.push(path.win32.join(root, "Local State"));
  assert.throws(() => windowsPredictionProfile({ env, app: { ...registration, app: executable } }), /Multiple/);
  present = [root, path.win32.join(root, "web")];
  assert.throws(() => windowsPredictionProfile({ env, app: { ...registration, app: executable } }), /profile was not found/);
  const ordinary = path.win32.join(env.APPDATA, "Codex", "web", "Codex");
  present = [path.win32.join(ordinary, "Local State")];
  assert.equal(windowsPredictionProfile({ env, app: { ...registration, app: executable } }), ordinary);
});

test("Windows static proxy and bypass rules compose with existing environment priority", () => {
  const plan = resolveNetworkRoute({ env: { HTTPS_PROXY: "socks5://env.test:1080" }, systemProxy: windowsProxyText({
    proxy: "http=http.test:80;https=https.test:3128;socks=socks.test:1080", bypass: "*.internal.test;<local>" }) });
  assert.equal(plan.http.url.hostname, "http.test");assert.equal(plan.https.url.hostname, "env.test");
  for (const url of ["https://host.internal.test", "https://intranet"]) assert.equal(networkProxyFor(new URL(url), plan), null);
  assert.equal(networkProxyFor(new URL("https://chatgpt.com"), plan).source, "HTTPS_PROXY");
  assert.equal(resolveNetworkRoute({ env: {}, systemProxy: windowsProxyText({ proxy: "[::1]:7890" }) }).https.url.hostname, "[::1]");
  for (const settings of [{ autoDetect: true }, { pac: "https://private.example/rules.pac" }, { proxy: "https=bad/path" },
    { proxy: "ftp=host:80" }, { proxy: "https=a:80;https=b:80" }, { proxy: "alice:secret@proxy:80" }]) {
    assert.throws(() => windowsProxyText(settings), /preserved/);
  }
  let script;
  const raw = windowsSystemProxy({ exec(_command, args) { script = args.at(-1);return '{"proxy":"proxy.test:8080","autoDetect":false}'; } });
  assert.equal(resolveNetworkRoute({ env: {}, systemProxy: raw }).https.url.hostname, "proxy.test");
  assert.match(script, /WinHttpGetIEProxyConfigForCurrentUser/);assert.doesNotMatch(script, /Set-ItemProperty|WinHttpSet/);
  for (const value of ["[]", "null", '{"autoDetect":"false"}', '{"autoDetect":false,"proxy":{}}']) {
    assert.throws(() => windowsSystemProxy({ exec: () => value }), /Windows proxy settings/);
  }
});

test("Windows ACL checks never interpolate paths into scripts", () => {
  const privatePath = "C:\\Users\\测试'$\\private";
  let call;
  windowsPrivatePredictionPath(privatePath, { create: true, exec(command, args, options) { call = { command, args, options };return ""; } });
  assert.equal(call.options.env.CCDX_PREDICTION_PRIVATE_PATH, privatePath);
  assert.ok(!call.args.at(-1).includes(privatePath));
  assert.match(call.args.at(-1), /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(call.args.at(-1), /GetAccessRules/);assert.doesNotMatch(call.args.at(-1), /Cert:|LocalMachine|CurrentUser\\Root/);
});

test("Windows certificate issuance uses only one system child and keeps keys in its private pipe", () => {
  const env = Object.freeze({ SystemRoot: "C:\\Windows", PATH: "C:\\no-external-tools", PSModulePath: "C:\\custom" });
  let call;
  const result = windowsPredictionCertificate({ env, exec(command, args, options) {
    call = { command, args, options };return '{"ca":"AQID","cert":"BAUG"}';
  } });
  assert.equal(call.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(call.args.includes("-ExecutionPolicy"), false);assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 30_000);assert.equal(call.options.maxBuffer, 64 * 1024);
  const input = JSON.parse(call.options.input);
  assert.equal(createPrivateKey({ key: input.ca, format: "jwk" }).asymmetricKeyDetails.modulusLength, 2048);
  const leaf = createPrivateKey(result.key).export({ format: "jwk" });assert.equal(leaf.n, input.leaf.n);
  assert.notEqual(input.ca.n, input.leaf.n);
  for (const key of [input.ca, input.leaf]) {
    assert.ok(!JSON.stringify(call.args).includes(key.d));assert.ok(!JSON.stringify(call.options.env).includes(key.d));
  }
  assert.equal(result.ca, "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n");
  assert.equal(env.PSModulePath, "C:\\custom");
  const source = fs.readFileSync(call.options.env.CCDX_PREDICTION_CERTIFICATE_SOURCE, "utf8");
  assert.match(source, /IsEphemeral/);assert.match(source, /CertificateRequest/);
  assert.doesNotMatch(source, /X509Store|New-SelfSignedCertificate|File\.|Export\(|Process\./);
});

test("Windows certificate errors reject malformed replies without leaking private input or diagnostics", () => {
  for (const raw of ['null', '{}', '{"ca":"https://outside.test","cert":"AQID"}', '{"ca":"AQID","cert":1}']) {
    assert.throws(() => windowsPredictionCertificate({ exec: () => raw }), /\.NET Framework 4\.7\.2/);
  }
  assert.throws(() => windowsPredictionCertificate({ exec() { throw new Error("PRIVATE_CHILD_DIAGNOSTICS"); } }),
    error => !String(error).includes("PRIVATE_CHILD_DIAGNOSTICS") && !error.cause && !error.stdout && !error.stderr);
});

test("Windows prediction launch binds native and Chromium storage to the existing trusted profile", async t => {
  const calls = [];
  let running = [];
  const profile = "C:\\Users\\fixture name 测试\\AppData\\Local\\Packages\\OpenAI.Codex_fixture\\LocalCache\\Roaming\\Codex\\web\\Codex";
  t.mock.method(fs, "existsSync", file => file === path.win32.join(profile, "Local State"));
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });const child = new EventEmitter();child.unref = () => {};
    running = [{ pid: 1, readable: true, route: "http://127.0.0.1:12345/proxy.pac" }];
    queueMicrotask(() => child.emit("spawn"));return child;
  };
  const env = Object.freeze({ CODEX_HOME: "C:\\existing-codex-home" });
  const options = { env, platform: "win32", predictionApp: executable, predictionProfile: profile, predictionPacUrl: "http://127.0.0.1:12345/proxy.pac",
    resolveWindowsApp: () => ({ app: executable }), windowsAppProcesses: () => running, spawnImpl };
  assert.equal(await openCodex(options), true);
  assert.equal(calls[0].command, executable);assert.deepEqual(calls[0].args, [`--user-data-dir=${profile}`, "--proxy-pac-url=http://127.0.0.1:12345/proxy.pac"]);
  assert.equal(calls[0].options.env.CODEX_ELECTRON_USER_DATA_PATH, profile);
  assert.equal(calls[0].options.env.CODEX_HOME, env.CODEX_HOME);
  assert.deepEqual(env, { CODEX_HOME: "C:\\existing-codex-home" });
  assert.equal(calls[0].options.shell, false);assert.equal(calls[0].options.detached, true);
  calls.length = 0;
  assert.equal(await openCodex({ ...options, resolveWindowsApp: () => ({ app: "C:\\other\\Codex.exe" }) }), false);
  assert.equal(await openCodex({ ...options, env: { CCDX_AUTO_LAUNCH: "0" } }), false);
  assert.equal(await openCodex({ ...options, predictionPacUrl: "https://remote.test/proxy.pac" }), false);
  assert.equal(calls.length, 0);
  assert.equal(await openCodex({ ...options, predictionProfile: null }), false);
  assert.equal(await openCodex({ ...options, predictionProfile: "C:\\missing" }), false);
  assert.equal(await openCodex({ ...options, predictionProfile: profile + "\n" }), false);
  assert.equal(await openCodex({ ...options, env: { CODEX_ELECTRON_USER_DATA_PATH: "C:\\other-profile" } }), false);
  assert.equal(calls.length, 0);
  assert.equal(await openCodex({ ...options, env: { CODEX_ELECTRON_USER_DATA_PATH: profile.toLowerCase() } }), true);
  const before = calls.length;
  assert.equal(await openCodex({ ...options, windowsAppProcesses: () => [{ pid: 1, readable: true, route: options.predictionPacUrl }] }), true);
  assert.equal(await openCodex({ ...options, windowsAppProcesses: () => [{ pid: 1, readable: true, route: "http://127.0.0.1:54321/proxy.pac" }] }), false);
  assert.equal(await openCodex({ ...options, windowsAppProcesses: () => [{ pid: 1, readable: false, route: null }] }), false);
  assert.equal(calls.length, before, "must not spawn into a running instance or kill it");
  let inspections = 0;
  assert.equal(await openCodex({ ...options, windowsAppProcesses: () => ++inspections === 1 ? [] : [{ pid: 2, readable: true, route: null }] }), false,
    "a package activation that drops launch flags is not reported as connected");
});

test("Windows default-off startup and status make no platform probes or writes", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-win-disabled-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = { home, env: {}, platform: "win32", exec() { assert.fail("must not probe"); }, output() {} };
  assert.equal(await startNativePrediction(options), null);
  await runPredictionCommand({ ...options, action: "status" });
  assert.deepEqual(fs.readdirSync(home), []);
});

test("Windows on/off lifecycle preserves App trust and never changes Codex configuration", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-win-lifecycle-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, "app-profile");
  const fixtureArchive = path.join(home, "app.asar");fs.writeFileSync(fixtureArchive, "fixture program identity");
  const archiveStat = fs.statSync(fixtureArchive);
  const app = { app: executable, archive: fixtureArchive, family: registration.family, profile, size: archiveStat.size, mtimeMs: archiveStat.mtimeMs };
  // Reuse an already-valid PEM setup. On POSIX only Windows OS probes are
  // emulated; native Windows tests below cover first issuance and NTFS ACLs.
  const options = { env: { CODEX_ELECTRON_USER_DATA_PATH: profile }, home, platform: "win32", output() {}, resolveApp: () => app,
    exec(command, args, settings) {
      if (command.endsWith("powershell.exe")) {
        const script = args.at(-1);
        if (script.includes("Get-Process")) return "closed";
        if (script.includes("WinHttpGetIEProxyConfigForCurrentUser")) return '{"autoDetect":false}';
        assert.doesNotMatch(script, /CCDXPredictionCertificate|openssl/);
        return "";
      }
      assert.fail("valid PEM credentials must not invoke a certificate generator");
    } };
  const root = predictionPaths(options).directory;fs.mkdirSync(root, { recursive: true });
  const credentialsDirectory = fs.mkdtempSync(path.join(root, "credentials-"));
  createPredictionCertificate(credentialsDirectory);
  writePredictionSettings({ version: 1, enabled: false, credentialsDirectory }, options);
  await runPredictionCommand({ ...options, action: "on" });
  const settings = readPredictionSettings(options);
  assert.equal(settings.enabled, true);assert.equal(settings.store, predictionPaths({ ...options, app }).store);
  const native = await startNativePrediction(options);
  assert.equal(native.profile, profile);
  assert.deepEqual(native.args, [`--user-data-dir=${profile}`, `--proxy-pac-url=${native.pacUrl}`]);
  await native.close();
  const savedPort = readPredictionSettings(options).bridgePort;
  assert.ok(savedPort >= 1024);
  const reusedNative = await startNativePrediction(options);
  assert.equal(reusedNative.pacUrl, native.pacUrl, "service restarts retain the existing App route");
  await reusedNative.close();
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(savedPort, "127.0.0.1", resolve));
  try {
    await assert.rejects(startNativePrediction(options), error => error.code === "EADDRINUSE");
    assert.equal(readPredictionSettings(options).bridgePort, savedPort, "must not silently replace an owned route with a new port");
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  const db = new DatabaseSync(settings.store);db.prepare("INSERT INTO certificates VALUES(?,?,?)").run("UNRELATED", Buffer.from("user"), Buffer.from("trust"));db.close();
  await runPredictionCommand({ ...options, action: "off" });
  const disabled = readPredictionSettings(options);
  assert.equal(disabled.enabled, false);assert.deepEqual(disabled.app, app);
  assert.equal(disabled.store, undefined);assert.equal(disabled.certificateHash, undefined);
  const after = new DatabaseSync(settings.store);assert.equal(after.prepare("SELECT count(*) AS n FROM certificates").get().n, 1);after.close();
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  await runPredictionCommand({ ...options, action: "off", writeSettings() { assert.fail("repeated off must not rewrite the profile binding"); } });
  let preferredProfile;
  await runPredictionCommand({ ...options, action: "on", resolveApp(opts) { preferredProfile = opts.preferredProfile;return app; } });
  assert.equal(preferredProfile, profile);
  await runPredictionCommand({ ...options, action: "off" });
});

test("native Windows certificate generation works without Git/OpenSSL, enforces privacy and preserves exact extensions", { skip: process.platform !== "win32" }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-win-native-certificate-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, PATH: path.join(home, "no-external-tools"), ProgramFiles: home, LOCALAPPDATA: home };
  const directory = path.join(home, "private-keys"), certificate = createPredictionCertificate(directory, { env });
  assert.equal(readPredictionCertificate(directory).hash, certificate.hash);
  windowsPrivatePredictionPath(path.join(directory, "bridge.key"));
  assert.deepEqual(fs.readdirSync(directory).sort(), ["bridge.key", "bridge.pem", "ca.pem"]);
  const leaf = new X509Certificate(certificate.cert), ca = new X509Certificate(certificate.ca);
  assert.equal(ca.verify(ca.publicKey), true);assert.equal(leaf.verify(ca.publicKey), true);
  assert.equal(leaf.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(ca.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(leaf.subjectAltName, "DNS:chatgpt.com, DNS:ab.chatgpt.com");
  assert.equal(leaf.checkHost("other.chatgpt.com"), undefined);assert.equal(leaf.checkHost("example.com"), undefined);
  const days = (Date.parse(leaf.validTo) - Date.now()) / 86_400_000;assert.ok(days > 89.9 && days <= 90);
  const command = path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const extensions = JSON.parse(execFileSync(command, ["-NoProfile", "-NonInteractive", "-Command",
    "$c=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($env:CCDX_TEST_PUBLIC_CERT));$rows=@($c.Extensions | ForEach-Object {@{oid=$_.Oid.Value;critical=$_.Critical;raw=[Convert]::ToBase64String($_.RawData)}});ConvertTo-Json -InputObject $rows -Compress"],
  { encoding: "utf8", env: { ...env, CCDX_TEST_PUBLIC_CERT: ca.raw.toString("base64") }, windowsHide: true, timeout: 10_000 }));
  const extension = oid => extensions.find(value => value.oid === oid);
  assert.equal(extension("2.5.29.30").critical, true);
  assert.equal(Buffer.from(extension("2.5.29.30").raw, "base64").toString("hex"), "3011a00f300d820b636861746770742e636f6d");
  assert.equal(extension("2.5.29.19").critical, true);
  assert.equal(Buffer.from(extension("2.5.29.19").raw, "base64").toString("hex"), "30060101ff020100");
  assert.equal(extension("2.5.29.15").critical, true);
  assert.equal(Buffer.from(extension("2.5.29.15").raw, "base64").toString("hex"), "03020284");
  assert.equal(extension("2.5.29.37").critical, false);
  assert.equal(Buffer.from(extension("2.5.29.37").raw, "base64").toString("hex"), "300a06082b06010505070301");
  const store = path.join(home, "profile", "Default", "ServerCertificate");
  await updatePredictionTrust(store, certificate);assert.equal(await updatePredictionTrust(store, certificate, { remove: true }), true);
  const server = https.createServer(certificate, (_req, res) => res.end("certificate accepted"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const request = options => new Promise((resolve, reject) => {
    https.get({ hostname: "127.0.0.1", port: server.address().port, servername: "chatgpt.com", ca: certificate.ca, ...options }, res => {
      let body = "";res.setEncoding("utf8");res.on("data", chunk => body += chunk);res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  try {
    assert.equal(await request({}), "certificate accepted");
    await assert.rejects(request({ servername: "example.com" }), /Hostname\/IP does not match/);
    await assert.rejects(request({ ca: [] }), /certificate|issuer|self.signed/i);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("native Windows first activation and rollback do not need external certificate tools", { skip: process.platform !== "win32" }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-win-native-activation-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, "profile"), archive = path.join(home, "app.asar");fs.writeFileSync(archive, "fixture program identity");
  const stat = fs.statSync(archive);
  const app = { app: executable, archive, profile, size: stat.size, mtimeMs: stat.mtimeMs };
  const env = { ...process.env, PATH: path.join(home, "no-external-tools"), ProgramFiles: home, LOCALAPPDATA: home, CODEX_ELECTRON_USER_DATA_PATH: profile };
  const options = { home, env, resolveApp: () => app, output() {}, exec(command, args, settings) {
    assert.ok(command.endsWith("powershell.exe"));
    if (args.at(-1).includes("Get-Process")) return "closed";
    if (args.at(-1).includes("WinHttpGetIEProxyConfigForCurrentUser")) return '{"autoDetect":false}';
    return execFileSync(command, args, settings);
  } };
  await assert.rejects(runPredictionCommand({ ...options, action: "on", writeSettings() { throw new Error("fixture settings write failed"); } }), /fixture settings/);
  assert.equal(readPredictionSettings(options).enabled, false);
  const root = predictionPaths(options).directory;
  assert.equal(fs.readdirSync(root).some(name => name.startsWith("credentials-")), false);
  const db = new DatabaseSync(predictionPaths({ ...options, app }).store);
  assert.equal(db.prepare("SELECT count(*) AS count FROM certificates").get().count, 0);db.close();
  await runPredictionCommand({ ...options, action: "on" });
  const settings = readPredictionSettings(options), before = fs.readFileSync(path.join(settings.credentialsDirectory, "bridge.key"));
  await runPredictionCommand({ ...options, action: "on", exec(command, args, opts) {
    assert.doesNotMatch(args.at(-1), /CCDXPredictionCertificate/);return options.exec(command, args, opts);
  } });
  assert.deepEqual(fs.readFileSync(path.join(settings.credentialsDirectory, "bridge.key")), before);
  await runPredictionCommand({ ...options, action: "off" });assert.equal(readPredictionSettings(options).enabled, false);
});
