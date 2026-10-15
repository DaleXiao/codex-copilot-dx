import { inspectWindowsCommand } from "./windows-command.mjs";
import { inspectCodexConfig, repairCodexConfig } from "./codex-config-doctor.mjs";
import { readSavedGithubToken } from "./auth-credentials.mjs";
import { importDiscoveredGithubToken } from "./auth.mjs";
import { readPredictionSettings } from "./native-prediction-profile.mjs";
import { requestPredictionFix } from "./native-prediction-fix.mjs";

// Explicit invocation only. One repair and one affected recheck per operation.
export async function repairDoctor({ home, env = process.env, host, port, platform = process.platform, fetchImpl = fetch,
  command = inspectWindowsCommand, config = repairCodexConfig, inspectConfig = inspectCodexConfig,
  savedToken = readSavedGithubToken, importToken = importDiscoveredGithubToken,
  predictionSettings = readPredictionSettings, fixPrediction = requestPredictionFix } = {}) {
  const checks = [];
  const run = async (id, task) => {
    try { checks.push({ id, ...await task() }); }
    catch { checks.push({ id, kind: "warn", result: "needs_review", message: `${id}: repair could not be verified; no retry or forced restart was performed` }); }
  };
  await run("windows-command", () => {
    const result = command({ platform, repair: true });
    if (["not_applicable", "checkout"].includes(result.status)) return { kind: "info", result: "not_applicable", message: "Command launcher: no repair required on this installation" };
    const verified = command({ platform }).status === "ready";
    return { kind: verified ? "ok" : "warn", result: verified ? result.changed ? "fixed_verified" : "unchanged" : "preserved",
      message: verified ? "Command launcher verified; PowerShell policy unchanged" : "Custom or unavailable command launchers preserved; use ccdx.cmd and review PATH" };
  });
  await run("codex-config", () => {
    const result = config({ home, env, host, port });
    const verified = ["verified", "unchanged"].includes(result.status)
      && !inspectConfig({ home, env, host, port }).some(check => check.kind === "err");
    return { kind: verified ? "ok" : "warn", result: verified ? result.changed ? "fixed_verified" : "unchanged" : "preserved",
      message: verified ? `Codex configuration ${result.changed ? "repaired and verified; previous file saved as config.toml.ccdx-doctor.bak when present" : "unchanged and verified"}`
        : "Codex configuration preserved; review invalid or custom settings manually" };
  });
  await run("github-auth", async () => {
    if (savedToken(home)) return { kind: "info", result: "preserved_existing", message: "Saved GitHub credential retained; use doctor --online to verify access" };
    const imported = await importToken({ home, env, fetchImpl, log: () => {} });
    const verified = imported?.ok && Boolean(savedToken(home));
    return { kind: verified ? "ok" : "warn", result: verified ? "fixed_verified" : "needs_login",
      message: verified ? "Existing GitHub Copilot credential imported and verified" : "No usable existing credential found; run ccdx to log in" };
  });
  await run("prediction", async () => {
    if (!predictionSettings({ home, env }).enabled) return { kind: "info", result: "disabled", message: "Predictions are off; no optional feature was enabled" };
    const result = await fixPrediction({ host, port, fetchImpl });
    return { kind: ["ready", "disabled"].includes(result.status) ? "ok" : "warn", result: result.status,
      message: `Prediction repair: ${result.status}; suggestion visibility is not verified; no App was restarted` };
  });
  return checks;
}
