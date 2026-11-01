import fs from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readPredictionSettings, writePredictionSettings, predictionPaths, assertCodexClosed, installedPredictionApp } from "./native-prediction-profile.mjs";
import { predictionDisplayPreference, writePredictionDisplayPreference } from "./prediction-preference.mjs";
import { servicePreferences } from "./user-settings.mjs";
import { inspectPredictionEnvironment } from "./native-prediction-environment.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

// Native OS discovery/crypto is bounded but can block Node. Keep it out of the
// gateway event loop. Environment results stay private to the bridge lifecycle.
export async function handlePredictionOperation(operation, options = {}) {
  if (operation === "command") {
    const { runPredictionCommand } = await import("./native-prediction.mjs");
    return runPredictionCommand({ ...options, output() {} });
  }
  if (operation === "display") {
    try { assertCodexClosed(options); }
    catch (error) { if (!options.requireClosed && error.code === "ccdx_prediction_app_open") return { pending: true };throw error; }
    writePredictionDisplayPreference(options.enabled, options);return { pending: false };
  }
  if (operation !== "startup") throw new Error("Unknown native prediction operation");
  let settings = readPredictionSettings(options);
  if (options.autoSetup === true && ["darwin", "win32"].includes(options.platform || process.platform)
    && !fs.existsSync(predictionPaths(options).settings) && servicePreferences(options).prediction_enabled && predictionDisplayPreference(options).enabled) {
    // Absence/incompatibility must fail before expensive trust and proxy checks.
    const app = await installedPredictionApp(options);
    const { runPredictionCommand } = await import("./native-prediction.mjs");
    await runPredictionCommand({ ...options, action: "on", resolveApp: () => app, output() {} });
    settings = readPredictionSettings(options);
  }
  if (settings.displayPending && options.autoSetup === true) {
    const display = await handlePredictionOperation("display", { ...options, enabled: servicePreferences(options).prediction_enabled });
    if (!display.pending) { settings = { ...settings, displayPending: false };writePredictionSettings(settings, options); }
  }
  return settings.enabled ? { configured: true, environment: inspectPredictionEnvironment(options) } : { configured: false };
}

export function runPredictionOperation(operation, options = {}) {
  const data = Object.fromEntries(["env", "home", "platform", "action", "enabled", "requireClosed", "autoSetup"].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: "prediction_operation", operation, options: data }, stdout: true, stderr: true });
    worker.stdout.resume();worker.stderr.resume();let settled = false;
    const finish = (error, result) => { if (settled) return;settled = true;clearTimeout(timer);error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { finish(new Error("Native prediction configuration deadline exceeded"));void worker.terminate(); }, 180000);
    worker.once("message", message => {
      if (message.error) finish(Object.assign(new Error(message.error.message), { code: message.error.code, predictionEnvironment: message.error.predictionEnvironment }));
      else {
        const plan = message.result?.environment?.network?.networkRoute;
        if (plan) for (const key of ["http", "https"]) if (plan[key]) plan[key].url = new URL(plan[key].url);
        finish(null, message.result);
      }
    });
    worker.once("error", error => finish(error));worker.once("exit", code => { if (!settled) finish(new Error(`Native prediction operation stopped (${code})`)); });
  });
}

if (!isMainThread && workerData?.kind === "prediction_operation") {
  try {
    const result = await handlePredictionOperation(workerData.operation, workerData.options);
    const plan = result?.environment?.network?.networkRoute;
    // URL objects are not structured-cloneable. Credentials remain private to
    // this IPC result, and bypass/trust data keeps its original representation.
    if (plan) for (const key of ["http", "https"]) if (plan[key]) plan[key] = { ...plan[key], url: plan[key].url.href };
    parentPort.postMessage({ result });
  }
  catch (error) { parentPort.postMessage({ error: { message: redactDiagnosticText(String(error.message)).slice(0, 600), code: error.code, predictionEnvironment: error.predictionEnvironment } }); }
  finally { parentPort.close(); }
}
