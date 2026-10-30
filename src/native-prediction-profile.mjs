import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { userSettingsPath } from "./user-settings.mjs";
import { resolveNetworkRoute } from "./network-route.mjs";
import { codexPaths } from "./codex-paths.mjs";
import { assertWindowsCodexClosed, windowsPrivatePredictionPath } from "./native-prediction-windows.mjs";
import { windowsPredictionCertificate } from "./windows-prediction-certificate.mjs";
export { installedPredictionApp, predictionAppMatches } from "./native-prediction-app.mjs";

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
    const value = JSON.parse(readBoundedFileSync(settings, { encoding: "utf8" }));
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
    throw new Error("Prediction certificate needs renewal; quit Codex and run ccdx app codex prediction setup");
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
