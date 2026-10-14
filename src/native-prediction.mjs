import fs from "node:fs";
import path from "node:path";
import { predictionPaths, readPredictionSettings, writePredictionSettings, assertPredictionProxyCompatible,
  assertCodexClosed, installedPredictionApp, predictionAppMatches, readPredictionCertificate,
  createPredictionCertificate, updatePredictionTrust } from "./native-prediction-profile.mjs";
import { retirePredictionIntegration } from "./prediction-retirement.mjs";
import { networkRouteSnapshot } from "./network-route.mjs";
import { withFileLock } from "./lock.mjs";
import { windowsProxyText, windowsPredictionAppProcesses } from "./native-prediction-windows.mjs";
import { updatePredictionRoute } from "./native-prediction-route.mjs";
import { inspectPredictionEnvironment } from "./native-prediction-environment.mjs";
import { formatPredictionEnvironment } from "./native-prediction-state.mjs";

function certificateDirectory(settings, paths) {
  if (!settings.credentialsDirectory) return paths.directory;
  const directory = path.resolve(settings.credentialsDirectory);
  if (path.dirname(directory) !== paths.directory || !/^credentials-[A-Za-z0-9]+$/.test(path.basename(directory))) {
    throw new Error("Unexpected prediction key directory; it was not changed");
  }
  return directory;
}

export async function runPredictionCommand(options = {}) {
  if (!options.action || ["status", "fix"].includes(options.action)) return runPredictionCommandUnlocked(options);
  if (!["darwin", "win32"].includes(options.platform || process.platform)) return runPredictionCommandUnlocked(options);
  const { settings } = predictionPaths(options);
  return withFileLock(`${settings}.lock`, () => runPredictionCommandUnlocked(options), { timeoutMs: 2000 });
}

async function runPredictionCommandUnlocked({ action = "status", env = process.env,
  platform = process.platform, output = console.log, resolveApp = installedPredictionApp,
  writeSettings = writePredictionSettings, runtimeSnapshot, repairRuntime, ...options } = {}) {
  const opts = { ...options, env, platform };
  const settings = readPredictionSettings(opts);
  if (action === "fix") {
    if (!settings.enabled) {
      output("Native predictions are off; nothing was enabled or changed. Run ccdx prediction on to opt in.");
      return { status: "disabled", exitCode: 0 };
    }
    if (!repairRuntime) throw new Error("Prediction repair needs a running CCDX adapter with prediction-fix support");
    const result = await repairRuntime();
    const prediction = result.prediction;
    output(`Prediction repair: ${result.status}; bridge: ${prediction.bridge}; candidate: ${prediction.candidate}`);
    if (prediction.environment) output(formatPredictionEnvironment(prediction.environment));
    if (result.status === "disabled") output("The running adapter has predictions off; no feature was enabled.");
    else if (result.status === "needs_service_restart") output("Node trust settings changed. Restart the CCDX service to apply them; no certificate or App was changed.");
    else if (result.status === "environment_preserved") output(`Network recheck failed; the existing bridge and routes were preserved. ${result.environment_error?.message || "Check ccdx prediction status."}`);
    else if (prediction.bridge !== "running") output(prediction.reason || "Prediction bridge is unavailable; core service was not changed.");
    else if (prediction.environment?.status === "needs_app_relaunch") output("Network settings changed. The bridge uses the new snapshot, but the App may cache its earlier PAC. Fully quit Codex, then run ccdx; no App was restarted.");
    else if (result.app_route === "verified") output("App launch route verified. A visible suggestion still needs an App-side check.");
    else if (result.app_route === "closed") output("Bridge is ready. Run ccdx to open Codex with its prediction route.");
    else if (result.status === "route_unverified") output("Bridge is ready, but App route inspection was unavailable or ambiguous. Check ccdx prediction status; no App was restarted.");
    else output("Bridge is ready, but the running App route is not verified. No App was restarted. Fully quit Codex, then run ccdx to attach the route.");
    return { ...result, exitCode: ["ready", "disabled"].includes(result.status) ? 0 : 1 };
  }
  if (action === "status") {
    output(`Native prediction preference: ${settings.enabled ? "on" : "off"} (default: off)`);
    output("Uses the conversation's model. No prediction MCP, Hook, or panel.");
    if (settings.enabled && !predictionAppMatches(settings.app)) output("Codex App changed; bridge startup will recheck compatibility. Unsupported changes still require explicit setup.");
    if (runtimeSnapshot) {
      try {
        const runtime = (await runtimeSnapshot())?.client_integrations?.prediction;
        if (runtime) {
          output(`Bridge: ${runtime.bridge}; client route: ${runtime.client_route}; visible candidate: ${runtime.candidate}`);
          if (runtime.launch_route) output(`App launch route: ${runtime.launch_route}; persistent route: ${runtime.persistence || "unknown"}`);
          if (runtime.recovery) output(`Bridge recovery: ${runtime.recovery.recovered} recovered; ${runtime.recovery.attempts}/3 attempts used`);
          if (runtime.reason) output(runtime.reason);
          if (runtime.environment) output(formatPredictionEnvironment(runtime.environment));
          for (const [name, event] of Object.entries(runtime.configuration || {})) output(`${name}: HTTP ${event.status}${event.modified ? " (local compatibility)" : " (upstream)"}`);
        } else output("Runtime prediction state: unavailable; status is a saved preference, not proof of a visible suggestion.");
      } catch { output("Runtime prediction state: unavailable; start ccdx and check again."); }
    }
    return settings;
  }
  if (!["on", "off"].includes(action)) throw new Error("Prediction action must be on, off, status, or fix");
  if (!["darwin", "win32"].includes(platform)) throw new Error("Native prediction setup supports macOS and Windows only; no configuration changed");
  let paths = predictionPaths({ ...opts, app: settings.app });
  if (action === "off") {
    // Disable the response overlay first, even when App-owned trust is busy.
    if (settings.enabled) writeSettings({ ...settings, enabled: false }, opts);
    if (settings.certificateHash && settings.store) {
      try {
        assertCodexClosed(opts);
        await updatePredictionRoute({ ...paths, remove: true, assertClosed: () => assertCodexClosed(opts) });
        const certificate = readPredictionCertificate(certificateDirectory(settings, paths), { ...opts, allowExpired: true });
        if (certificate.hash !== settings.certificateHash) throw new Error("Prediction certificate changed; trust cleanup was skipped");
        await updatePredictionTrust(settings.store, certificate, { remove: true });
      } catch (error) {
        output(`Predictions disabled. ${error.message}. Quit Codex and run ccdx prediction off again to finish cleanup.`);
        return { ...settings, enabled: false, cleanupPending: true };
      }
    }
    const { store, certificateHash, app, ...disabled } = settings;
    // Retain the verified Windows profile binding, not its certificate trust.
    // An earlier direct launch can have created a second initialized profile.
    if (store || certificateHash || (app && platform !== "win32")) {
      writeSettings({ ...disabled, enabled: false, ...(platform === "win32" && app ? { app } : {}) }, opts);
    }
    try { retirePredictionIntegration(opts); }
    catch (error) { output(`Legacy prediction cleanup skipped: ${error.message}`); }
    output("Native predictions off. Restart Codex to clear cached predictions and its temporary route.");
    return { ...settings, enabled: false };
  }
  assertCodexClosed(opts);
  inspectPredictionEnvironment(opts);
  const app = resolveApp({ ...opts, ...(platform === "win32" && settings.app?.profile ? { preferredProfile: settings.app.profile } : {}) });
  paths = predictionPaths({ ...opts, app });
  if (settings.store && settings.store !== paths.store) throw new Error("Codex profile changed; disable the previous profile before enabling another");
  let certificate, previous, generated = false;
  let credentialsDirectory = certificateDirectory(settings, paths);
  try { certificate = readPredictionCertificate(credentialsDirectory, opts); }
  catch (error) {
    if (error.code !== "ENOENT" && !error.message.includes("needs renewal")) throw error;
    if (settings.certificateHash) {
      previous = readPredictionCertificate(credentialsDirectory, { ...opts, allowExpired: true });
      if (previous.hash !== settings.certificateHash) throw new Error("Existing prediction certificate changed; it was preserved");
    }
    fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    credentialsDirectory = fs.mkdtempSync(path.join(paths.directory, "credentials-"));
    generated = true;
    try { certificate = createPredictionCertificate(credentialsDirectory, opts); }
    catch (failure) { fs.rmSync(credentialsDirectory, { recursive: true, force: true }); throw failure; }
  }
  const next = { version: 1, enabled: true, app, store: paths.store, certificateHash: certificate.hash, credentialsDirectory,
    ...(Number.isInteger(settings.bridgePort) ? { bridgePort: settings.bridgePort } : {}) };
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
  warning = () => {}, state, ...options } = {}) {
  const opts = { ...options, env, platform };
  const settings = readPredictionSettings(opts);
  state?.configure(settings.enabled);
  if (!settings.enabled) return null;
  if (!["darwin", "win32"].includes(platform)) throw new Error("Native predictions were skipped: unsupported platform");
  const environment = options.environment || inspectPredictionEnvironment(opts);
  state?.environment(environment.summary);
  const network = environment.network;
  let networkRoute = network.networkRoute;
  if (settings.bridgePort !== undefined
    && (!Number.isInteger(settings.bridgePort) || settings.bridgePort < 1024 || settings.bridgePort > 65535)) {
    throw new Error("Saved prediction bridge port is invalid; no route was replaced");
  }
  if (options.expectedPort !== undefined && settings.bridgePort !== options.expectedPort) throw new Error("Prediction route changed; automatic recovery was skipped");
  if (!predictionAppMatches(settings.app)) {
    const current = (options.resolveApp || installedPredictionApp)({ ...opts,
      ...(platform === "win32" && settings.app?.profile ? { preferredProfile: settings.app.profile } : {}) });
    if (current.app !== settings.app?.app || (platform === "win32" && current.profile !== settings.app?.profile)) {
      throw new Error("Codex App identity/profile changed; run ccdx prediction on after quitting it to recheck compatibility");
    }
    const settingsFile = predictionPaths(opts).settings;
    await withFileLock(`${settingsFile}.lock`, () => {
      const latest = readPredictionSettings(opts);
      if (JSON.stringify(latest) !== JSON.stringify(settings)) throw new Error("Prediction setup changed during App compatibility recheck");
      writePredictionSettings({ ...latest, app: current }, opts);
    }, { timeoutMs: 2000 });
    settings.app = current;
    warning("Codex App compatibility rechecked; prediction port and trust were preserved");
  }
  const paths = predictionPaths({ ...opts, app: settings.app });
  if (settings.store !== paths.store || !fs.existsSync(paths.store)) throw new Error("Prediction profile trust is unavailable; run ccdx prediction on after quitting Codex");
  const certificate = readPredictionCertificate(certificateDirectory(settings, paths), opts);
  if (certificate.hash !== settings.certificateHash) throw new Error("Prediction certificate changed; setup must be checked again");
  const [{ startPredictionTransport }, { applyNativePredictionOverlay, normalizeStatsigRequest }, { createProxyAgent }] = await Promise.all([
    import("./native-prediction-transport.mjs"), import("./native-prediction-overlay.mjs"),
    import("./proxy-tunnel.mjs"),
  ]);
  // An in-memory switch is refreshed independently of request bodies and never
  // touches the model path. A failed read turns off this optional overlay.
  let enabled = true;
  const timer = setInterval(() => {
    try { enabled = readPredictionSettings(opts).enabled; state?.configure(enabled); }
    catch { enabled = false; }
  }, 1000);
  timer.unref();
  let transport;
  let windowsNetwork;
  try {
    if (network.settings) {
      const { startWindowsPredictionNetwork } = await import("./windows-prediction-network.mjs");
      windowsNetwork = await startWindowsPredictionNetwork({ settings: network.settings, env, onFailure(error) {
        clearInterval(timer);state?.unavailable(error);void transport?.close();
      } });
      // Automatic detection enabled does not prove a company PAC exists.
      // A native "not found" result retains the configured static/direct route.
      if (windowsNetwork.script === null) {
        windowsNetwork.close();windowsNetwork = null;
        networkRoute = assertPredictionProxyCompatible({ env, systemProxy: windowsProxyText({ ...network.settings, autoDetect: false, pac: null }) });
      }
    }
    transport = await startPredictionTransport({ ...certificate, enabled: () => enabled,
      listenPort: settings.bridgePort || 0,
      networkRoute, agent: networkRoute?.https ? createProxyAgent(networkRoute) : undefined,
      ...(windowsNetwork ? { requestImpl: windowsNetwork.requestImpl, pacImpl: windowsNetwork.pac } : {}),
      onEvent: (event) => state?.event(event),
      overlay: ({ host, pathname, status, body, enabled }) => {
        const result = applyNativePredictionOverlay({ hostname: host, pathname, statusCode: status, body, enabled });
        return result.changed ? { body: result.body, status: result.statusCode } : { official: result.official };
      },
      normalizeRequest: (parsed) => {
        const result = normalizeStatsigRequest({ hostname: "ab.chatgpt.com", pathname: "/v1/initialize", body: JSON.stringify(parsed), enabled });
        return result.changed ? JSON.parse(result.body) : parsed;
      },
    });
    if (settings.bridgePort === undefined) {
      await withFileLock(`${paths.settings}.lock`, () => {
        const current = readPredictionSettings(opts);
        if (!current.enabled || current.certificateHash !== settings.certificateHash || current.store !== settings.store
          || (current.bridgePort !== undefined && current.bridgePort !== transport.port)) {
          throw new Error("Prediction setup changed during startup; no saved route was replaced");
        }
        writePredictionSettings({ ...current, bridgePort: transport.port }, opts);
      }, { timeoutMs: 2000 });
    }
  } catch (error) {
    clearInterval(timer);await transport?.close();windowsNetwork?.close();
    if (error.code === "EADDRINUSE" && settings.bridgePort !== undefined) {
      error.message = `Saved prediction port ${settings.bridgePort} is already in use; it was not replaced. Native predictions are unavailable; the core adapter remains available`;
    }
    throw error;
  }
  state?.running(windowsNetwork ? { source: "system", type: "auto", bypass_rules: null, proxy_credentials: false } : networkRouteSnapshot(networkRoute));
  let routeProcessId = null;
  return {
    app: settings.app.app,
    ...(platform === "win32" ? { profile: paths.profile } : {}),
    pacUrl: transport.pacUrl,
    enabled() { return enabled; },
    appCurrent() { return predictionAppMatches(settings.app); },
    inspectEnvironment() {
      const next = inspectPredictionEnvironment(opts);
      return { changed: next.networkKey !== environment.networkKey, requiresServiceRestart: next.trustKey !== environment.trustKey, next };
    },
    routeProcessId() { return routeProcessId; },
    healthy() { return transport.healthy() && (!windowsNetwork || windowsNetwork.healthy()); },
    async inspectRoute() {
      const inspect = options.inspectAppProcesses || (platform === "win32" ? windowsPredictionAppProcesses
        : (await import("./launcher.mjs")).macPredictionAppProcesses);
      const rows = inspect(settings.app.app, opts);
      routeProcessId = rows.length === 1 && rows[0].readable ? rows[0].pid : null;
      const route = rows.length === 0 ? "closed" : rows.length !== 1 || !rows[0].readable ? "unverified"
        : rows[0].route === transport.pacUrl ? "verified" : "missing";
      state?.launch(route);
      return route;
    },
    async prepareRoute() {
      try {
        const direct = !windowsNetwork && !networkRoute?.http && !networkRoute?.https;
        if (!direct) {
          // A profile previously configured on a direct network must not pin
          // that local PAC after the environment switches to company routing.
          await updatePredictionRoute({ ...paths, remove: true, assertClosed: () => assertCodexClosed(opts) });
        }
        const result = await updatePredictionRoute({ ...paths, pacUrl: transport.pacUrl, direct,
          assertClosed: () => assertCodexClosed(opts) });
        state?.persistence(result);
        if (result.status === "preserved") warning(`Prediction route persistence skipped: ${result.reason}`);
        return result;
      } catch (error) {
        state?.persistence({ status: "pending" });
        if (!error.message.startsWith("Quit Codex App")) warning(`Prediction route persistence deferred: ${error.message}`);
        return { status: "pending" };
      }
    },
    args: [...(platform === "win32" ? [`--user-data-dir=${paths.profile}`] : []), `--proxy-pac-url=${transport.pacUrl}`],
    async close() { clearInterval(timer); await transport.close(); windowsNetwork?.close(); state?.stopped(); },
  };
}
