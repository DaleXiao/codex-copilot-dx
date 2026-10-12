import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { predictionPaths, readPredictionSettings, writePredictionSettings, assertPredictionProxyCompatible,
  assertCodexClosed, installedPredictionApp, predictionAppMatches, readPredictionCertificate,
  createPredictionCertificate, updatePredictionTrust } from "./native-prediction-profile.mjs";
import { retirePredictionIntegration } from "./prediction-retirement.mjs";

function systemProxy(exec = execFileSync) {
  return exec("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 });
}

function certificateDirectory(settings, paths) {
  if (!settings.credentialsDirectory) return paths.directory;
  const directory = path.resolve(settings.credentialsDirectory);
  if (path.dirname(directory) !== paths.directory || !/^credentials-[A-Za-z0-9]+$/.test(path.basename(directory))) {
    throw new Error("Unexpected prediction key directory; it was not changed");
  }
  return directory;
}

export async function runPredictionCommand({ action = "status", env = process.env,
  platform = process.platform, output = console.log, resolveApp = installedPredictionApp,
  writeSettings = writePredictionSettings, ...options } = {}) {
  const opts = { ...options, env };
  const settings = readPredictionSettings(opts);
  if (action === "status") {
    output(`Native prediction preference: ${settings.enabled ? "on" : "off"} (default: off)`);
    output("Uses the conversation's model. No prediction MCP, Hook, or panel.");
    if (settings.enabled && !predictionAppMatches(settings.app)) output("Codex App changed; quit it and run ccdx prediction on to recheck compatibility.");
    return settings;
  }
  if (!["on", "off"].includes(action)) throw new Error("Prediction action must be on, off, or status");
  if (platform !== "darwin") throw new Error("Native prediction setup currently supports macOS only; no configuration changed");
  const paths = predictionPaths(opts);
  if (action === "off") {
    // Disable the response overlay first, even when App-owned trust is busy.
    if (settings.enabled) writeSettings({ ...settings, enabled: false }, opts);
    if (settings.certificateHash && settings.store) {
      try {
        assertCodexClosed(options);
        const certificate = readPredictionCertificate(certificateDirectory(settings, paths), { allowExpired: true });
        if (certificate.hash !== settings.certificateHash) throw new Error("Prediction certificate changed; trust cleanup was skipped");
        await updatePredictionTrust(settings.store, certificate, { remove: true });
      } catch (error) {
        output(`Predictions disabled. ${error.message}. Quit Codex and run ccdx prediction off again to finish cleanup.`);
        return { ...settings, enabled: false, cleanupPending: true };
      }
    }
    const { store, certificateHash, app, ...disabled } = settings;
    if (store || certificateHash || app) writeSettings({ ...disabled, enabled: false }, opts);
    try { retirePredictionIntegration(opts); }
    catch (error) { output(`Legacy prediction cleanup skipped: ${error.message}`); }
    output("Native predictions off. Restart Codex to clear cached predictions and its temporary route.");
    return { ...settings, enabled: false };
  }
  assertCodexClosed(options);
  assertPredictionProxyCompatible({ env, systemProxy: systemProxy(options.exec) });
  const app = resolveApp(options);
  if (settings.store && settings.store !== paths.store) throw new Error("Codex profile changed; disable the previous profile before enabling another");
  let certificate, previous, generated = false;
  let credentialsDirectory = certificateDirectory(settings, paths);
  try { certificate = readPredictionCertificate(credentialsDirectory); }
  catch (error) {
    if (error.code !== "ENOENT" && !error.message.includes("needs renewal")) throw error;
    if (settings.certificateHash) {
      previous = readPredictionCertificate(credentialsDirectory, { allowExpired: true });
      if (previous.hash !== settings.certificateHash) throw new Error("Existing prediction certificate changed; it was preserved");
    }
    fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    credentialsDirectory = fs.mkdtempSync(path.join(paths.directory, "credentials-"));
    generated = true;
    try { certificate = createPredictionCertificate(credentialsDirectory, options); }
    catch (failure) { fs.rmSync(credentialsDirectory, { recursive: true, force: true }); throw failure; }
  }
  const next = { version: 1, enabled: true, app, store: paths.store, certificateHash: certificate.hash, credentialsDirectory };
  let trustAdded = false;
  try {
    // Add the new trust before committing activation; retain the old record
    // until the commit succeeds so a failed write cannot break an existing setup.
    trustAdded = await updatePredictionTrust(paths.store, certificate);
    writeSettings(next, opts);
  }
  catch (error) {
    if (trustAdded) await updatePredictionTrust(paths.store, certificate, { remove: true }).catch(() => {});
    if (generated) fs.rmSync(credentialsDirectory, { recursive: true, force: true });
    throw error;
  }
  if (previous && previous.hash !== certificate.hash) {
    await updatePredictionTrust(paths.store, previous, { remove: true });
    const previousDirectory = certificateDirectory(settings, paths);
    if (previousDirectory !== paths.directory) fs.rmSync(previousDirectory, { recursive: true, force: true });
  }
  try { retirePredictionIntegration(opts); }
  catch (error) { output(`Legacy prediction cleanup skipped: ${error.message}`); }
  output("Native predictions on. Restart ccdx to launch Codex with the local bridge.");
  output("Only chatgpt.com and ab.chatgpt.com use the App-only route. Their HTTPS traffic is decrypted locally; only prediction configuration is changed. No credentials are stored, no system certificate is installed, and client program files are unchanged.");
  output("Existing official prediction configuration is preserved. The conversation's model generates predictions through your configured CCDX API.");
  return next;
}

export async function startNativePrediction({ env = process.env, platform = process.platform,
  warning = () => {}, ...options } = {}) {
  const opts = { ...options, env };
  const settings = readPredictionSettings(opts);
  if (!settings.enabled) return null;
  if (platform !== "darwin") throw new Error("Native predictions were skipped: unsupported platform");
  assertPredictionProxyCompatible({ env, systemProxy: systemProxy(options.exec) });
  if (!predictionAppMatches(settings.app)) throw new Error("Codex App changed; run ccdx prediction on after quitting it to recheck compatibility");
  const paths = predictionPaths(opts);
  if (settings.store !== paths.store || !fs.existsSync(paths.store)) throw new Error("Prediction profile trust is unavailable; run ccdx prediction on after quitting Codex");
  const certificate = readPredictionCertificate(certificateDirectory(settings, paths));
  if (certificate.hash !== settings.certificateHash) throw new Error("Prediction certificate changed; setup must be checked again");
  const [{ startPredictionTransport }, { applyNativePredictionOverlay, normalizeStatsigRequest }] = await Promise.all([
    import("./native-prediction-transport.mjs"), import("./native-prediction-overlay.mjs"),
  ]);
  // An in-memory switch is refreshed independently of request bodies and never
  // touches the model path. A failed read turns off this optional overlay.
  let enabled = true;
  const timer = setInterval(() => {
    try { enabled = readPredictionSettings(opts).enabled; }
    catch { enabled = false; }
  }, 1000);
  timer.unref();
  let transport;
  try {
    transport = await startPredictionTransport({ ...certificate, enabled: () => enabled,
      overlay: ({ host, pathname, status, body, enabled }) => {
        const result = applyNativePredictionOverlay({ hostname: host, pathname, statusCode: status, body, enabled });
        return result.changed ? { body: result.body, status: result.statusCode } : null;
      },
      normalizeRequest: (parsed) => {
        const result = normalizeStatsigRequest({ hostname: "ab.chatgpt.com", pathname: "/v1/initialize", body: JSON.stringify(parsed), enabled });
        return result.changed ? JSON.parse(result.body) : parsed;
      },
    });
  } catch (error) { clearInterval(timer); throw error; }
  warning("Native prediction bridge enabled; only the two configuration hosts use its App-only route.");
  warning("If Codex is already running, quit it and run ccdx again to apply the route.");
  return {
    app: settings.app.app,
    pacUrl: transport.pacUrl,
    args: [`--proxy-pac-url=${transport.pacUrl}`],
    async close() { clearInterval(timer); await transport.close(); },
  };
}
