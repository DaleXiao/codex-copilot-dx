import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { userSettingsPath } from "./user-settings.mjs";
import { resolveNetworkRoute } from "./network-route.mjs";
import { codexPaths } from "./codex-paths.mjs";
import { assertWindowsCodexClosed, installedWindowsPredictionApp, windowsPredictionProfile,
  windowsPrivatePredictionPath } from "./native-prediction-windows.mjs";
import { windowsPredictionCertificate } from "./windows-prediction-certificate.mjs";

export function predictionPaths({ env = process.env, home = os.homedir(), platform = process.platform, app } = {}) {
  const directory = path.join(path.dirname(userSettingsPath({ env, home })), "native-prediction");
  let { profile, certificateStore } = codexPaths({ env, home });
  if (platform === "win32") {
    const override = String(env.CODEX_ELECTRON_USER_DATA_PATH || "").trim();
    profile = override ? path.resolve(override)
      : app?.profile || path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Codex");
    certificateStore = path.join(profile, "Default", "ServerCertificate");
  }
  return { directory, settings: path.join(directory, "settings.json"), profile,
    store: certificateStore };
}

export function readPredictionSettings(options = {}) {
  const { settings } = predictionPaths(options);
  try {
    const value = JSON.parse(fs.readFileSync(settings, "utf8"));
    if (value?.version !== 1 || typeof value.enabled !== "boolean") throw new Error();
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, enabled: false };
    throw new Error("Native prediction settings are invalid; no settings were changed");
  }
}

export function writePredictionSettings(value, options = {}) {
  atomicWriteFileSync(predictionPaths(options).settings, JSON.stringify(value, null, 2) + "\n", { preserveMode: false });
}

export function assertPredictionProxyCompatible({ env = process.env, systemProxy = "" } = {}) {
  return resolveNetworkRoute({ env, systemProxy });
}

export function assertCodexClosed({ exec = execFileSync, platform = process.platform, ...options } = {}) {
  if (platform === "win32") return assertWindowsCodexClosed({ ...options, exec });
  for (const name of ["ChatGPT", "Codex"]) {
    try {
      exec("/usr/bin/pgrep", ["-x", name], { stdio: "pipe", timeout: 2000 });
    } catch (error) {
      if (error.status === 1) continue;
      throw new Error("Could not check whether Codex is closed; prediction setup was skipped");
    }
    throw new Error("Quit Codex App before changing native prediction setup; no running App will be stopped");
  }
}

export function installedPredictionApp({ exec = execFileSync, platform = process.platform, ...options } = {}) {
  const candidates = platform === "win32" ? [installedWindowsPredictionApp({ ...options, exec })]
    : ["/Applications/ChatGPT.app", "/Applications/Codex.app"].map(app => ({ app, archive: path.join(app, "Contents", "Resources", "app.asar") }));
  for (const candidate of candidates) {
    const { app, archive } = candidate;
    if (!fs.existsSync(archive)) continue;
    // Check only during explicit setup; startup uses the cheap identity check.
    const fd = fs.openSync(archive, "r");
    try {
      const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
      const headerSize = prefix.readUInt32LE(12);
      if (headerSize > 32 * 1024 * 1024) continue;
      const header = Buffer.alloc(headerSize); fs.readSync(fd, header, 0, header.length, 16);
      const files = JSON.parse(header).files?.[".vite"]?.files?.build?.files;
      const entry = Object.entries(files || {}).find(([name]) => /^main-[\w-]+\.js$/.test(name))?.[1];
      if (!entry || entry.size > 32 * 1024 * 1024 || entry.unpacked) continue;
      const bytes = Buffer.alloc(entry.size);
      fs.readSync(fd, bytes, 0, bytes.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
      const source = bytes.toString();
      if (!["/wham/predictions/config", "experimentalPredictionMode"].every((value) => source.includes(value))) continue;
      const renderer = Object.entries(JSON.parse(header).files?.webview?.files?.assets?.files || {})
        .find(([name]) => /^general-settings-[\w-]+\.js$/.test(name))?.[1];
      if (!renderer || renderer.unpacked || renderer.size > 4 * 1024 * 1024) continue;
      const rendererBytes = Buffer.alloc(renderer.size);
      fs.readSync(fd, rendererBytes, 0, rendererBytes.length, 8 + prefix.readUInt32LE(4) + Number(renderer.offset));
      if (!rendererBytes.includes(Buffer.from("4290031608"))) continue;
      if (platform !== "win32") exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe", timeout: 15_000 });
      const stat = fs.statSync(archive);
      if (platform === "win32") {
        const executable = fs.statSync(app);
        return { ...candidate, profile: windowsPredictionProfile({ app: candidate, env: options.env, preferredProfile: options.preferredProfile }),
          size: stat.size, mtimeMs: stat.mtimeMs, executableSize: executable.size, executableMtimeMs: executable.mtimeMs };
      }
      return { app, archive, size: stat.size, mtimeMs: stat.mtimeMs };
    } finally { fs.closeSync(fd); }
  }
  throw new Error("This Codex App does not expose the verified native prediction protocol; setup was skipped");
}

export function predictionAppMatches(app) {
  try {
    const stat = fs.statSync(app.archive);
    if (app.executableSize !== undefined) {
      const executable = fs.statSync(app.app);
      if (executable.size !== app.executableSize || executable.mtimeMs !== app.executableMtimeMs) return false;
    }
    return stat.size === app.size && stat.mtimeMs === app.mtimeMs;
  }
  catch { return false; }
}

function privateDirectory(directory, { platform = process.platform, ...options } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (platform !== "win32" && (stat.mode & 0o077))) {
    throw new Error("Prediction key directory must be private and must not be a symlink");
  }
  if (platform === "win32") windowsPrivatePredictionPath(directory, { ...options, create: fs.readdirSync(directory).length === 0 });
}

export function readPredictionCertificate(directory, { allowExpired = false, platform = process.platform, ...options } = {}) {
  const cert = fs.readFileSync(path.join(directory, "bridge.pem"));
  const ca = new X509Certificate(fs.readFileSync(path.join(directory, "ca.pem")));
  const keyFile = path.join(directory, "bridge.key");
  const info = fs.lstatSync(keyFile);
  if (!info.isFile() || info.isSymbolicLink() || (platform !== "win32" && (info.mode & 0o077))) throw new Error("Prediction key is not private");
  if (platform === "win32") windowsPrivatePredictionPath(keyFile, options);
  const key = fs.readFileSync(keyFile);
  const x509 = new X509Certificate(cert);
  const publicKey = createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "der" });
  if (!x509.publicKey.export({ type: "spki", format: "der" }).equals(publicKey)
    || (!allowExpired && Date.parse(x509.validTo) <= Date.now()) || !x509.checkHost("chatgpt.com") || !x509.checkHost("ab.chatgpt.com")
    || !x509.verify(ca.publicKey) || !ca.ca || x509.ca) {
    throw new Error("Prediction certificate needs renewal; quit Codex and run ccdx prediction on");
  }
  return { cert, key, ca: ca.toString(), hash: createHash("sha256").update(ca.raw).digest("hex").toUpperCase(), der: ca.raw };
}

export function createPredictionCertificate(directory, { exec = execFileSync, platform = process.platform, ...options } = {}) {
  privateDirectory(directory, { ...options, exec, platform });
  if (platform === "win32") {
    const { cert, key, ca } = windowsPredictionCertificate({ ...options, exec });
    atomicWriteFileSync(path.join(directory, "bridge.key"), key, { preserveMode: false });
    atomicWriteFileSync(path.join(directory, "bridge.pem"), cert, { preserveMode: false });
    atomicWriteFileSync(path.join(directory, "ca.pem"), ca, { preserveMode: false });
    return readPredictionCertificate(directory, { ...options, exec, platform });
  }
  const openssl = "/usr/bin/openssl";
  const temporary = fs.mkdtempSync(path.join(directory, "certificate-"));
  try {
    const config = `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=CCDX native prediction local bridge\n[ext]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:chatgpt.com,DNS:ab.chatgpt.com\nnameConstraints=critical,permitted;DNS:chatgpt.com\n`;
    const configFile = path.join(temporary, "openssl.cnf");
    atomicWriteFileSync(configFile, config);
    const certFile = path.join(temporary, "cert.pem"), keyFile = path.join(temporary, "key.pem");
    const caFile = path.join(temporary, "ca.pem"), caKey = path.join(temporary, "ca.key");
    const run = (args) => exec(openssl, args, { stdio: "pipe", timeout: 15_000, windowsHide: true });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "90", "-config", configFile, "-out", caFile, "-keyout", caKey]);
    const csr = path.join(temporary, "leaf.csr"), extensions = path.join(temporary, "leaf.cnf");
    atomicWriteFileSync(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:chatgpt.com,DNS:ab.chatgpt.com\n");
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", csr, "-subj", "/CN=CCDX local prediction bridge"]);
    run(["x509", "-req", "-in", csr, "-CA", caFile, "-CAkey", caKey, "-CAcreateserial", "-days", "90", "-extfile", extensions, "-out", certFile]);
    atomicWriteFileSync(path.join(directory, "bridge.key"), fs.readFileSync(keyFile), { preserveMode: false });
    atomicWriteFileSync(path.join(directory, "bridge.pem"), fs.readFileSync(certFile), { preserveMode: false });
    atomicWriteFileSync(path.join(directory, "ca.pem"), fs.readFileSync(caFile), { preserveMode: false });
    return readPredictionCertificate(directory, { ...options, exec, platform });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

// Chromium certificate metadata: trusted anchor, exact DNS constraints. This
// private record is scoped to one App profile; no system keychain is changed.
export function predictionTrustMetadata() {
  const names = ["chatgpt.com", "ab.chatgpt.com"].map((name) => Buffer.concat([Buffer.from([10, Buffer.byteLength(name)]), Buffer.from(name)]));
  const constraints = Buffer.concat(names);
  return Buffer.concat([Buffer.from([10, 2, 8, 3, 18, constraints.length]), constraints]);
}

export async function updatePredictionTrust(store, certificate, { remove = false, priorHash = null } = {}) {
  if (remove && !fs.existsSync(store)) return false;
  if (fs.existsSync(store) && !fs.lstatSync(store).isFile()) throw new Error("Unexpected certificate-store file; skipped");
  fs.mkdirSync(path.dirname(store), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(store);
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((item) => item.name);
    if (!tables.length && !remove) {
      db.exec("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY,value LONGVARCHAR); CREATE TABLE certificates(sha256hash_hex TEXT PRIMARY KEY,der_cert BLOB NOT NULL,trust_settings BLOB NOT NULL)");
      db.prepare("INSERT INTO meta VALUES(?,?)").run("version", "1");
      db.prepare("INSERT INTO meta VALUES(?,?)").run("last_compatible_version", "1");
    }
    const meta = db.prepare("SELECT value FROM meta WHERE key='version'").get();
    const columns = db.prepare("PRAGMA table_info(certificates)").all().map((item) => item.name);
    if (String(meta?.value) !== "1" || columns.join(",") !== "sha256hash_hex,der_cert,trust_settings") throw new Error("Unknown certificate-store schema; skipped");
    const metadata = predictionTrustMetadata();
    const existing = db.prepare("SELECT der_cert,trust_settings FROM certificates WHERE sha256hash_hex=?").get(certificate.hash);
    if (existing && (!Buffer.from(existing.der_cert).equals(certificate.der) || !Buffer.from(existing.trust_settings).equals(metadata))) throw new Error("Prediction trust was modified; it was preserved");
    if (remove) {
      if (existing) db.prepare("DELETE FROM certificates WHERE sha256hash_hex=?").run(certificate.hash);
    } else {
      if (priorHash && priorHash !== certificate.hash) {
        const previous = db.prepare("SELECT trust_settings FROM certificates WHERE sha256hash_hex=?").get(priorHash);
        if (previous && !Buffer.from(previous.trust_settings).equals(metadata)) throw new Error("Previous prediction trust was modified; it was preserved");
        db.prepare("DELETE FROM certificates WHERE sha256hash_hex=?").run(priorHash);
      }
      if (!existing) db.prepare("INSERT INTO certificates VALUES(?,?,?)").run(certificate.hash, certificate.der, metadata);
    }
    db.exec("COMMIT");
    return remove ? Boolean(existing) : !existing;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.close(); }
}
