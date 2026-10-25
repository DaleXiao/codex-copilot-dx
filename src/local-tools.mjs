import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { collectDoctorChecks } from "./doctor.mjs";
import { inspectCodexConfig, repairCodexConfig } from "./codex-config-doctor.mjs";
import { codexPaths } from "./codex-paths.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { inspectPredictionEnvironment } from "./native-prediction-environment.mjs";
import { formatPredictionEnvironment } from "./native-prediction-state.mjs";
import { localPackageVersion } from "./version.mjs";

export function createLocalTools({ home = os.homedir(), env = process.env, host = "127.0.0.1", port = 2026,
  platform = process.platform, collect = collectDoctorChecks, inspectConfig = inspectCodexConfig, repairConfig = repairCodexConfig,
  inspectNetwork = inspectPredictionEnvironment } = {}) {
  const options = { home, env, host, port, platform };
  let last = null, flight = null;
  const safe = text => redactDiagnosticText(String(text || "")).split(home).join("~")
    .replace(/[\w.+-]+@[\w.-]+/g, "[account]").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 600);
  const project = checks => checks.slice(0, 80).map(check => ({ id: /^[a-z-]{1,60}$/.test(check.id || "") ? check.id : "local",
    kind: ["ok", "info", "warn", "err"].includes(check.kind) ? check.kind : "info", message: safe(check.message) }));
  function snapshot() { return { source: "local_tools", ...last }; }
  async function check() {
    if (flight) return flight;
    flight = Promise.resolve().then(async () => {
      last = { checked_at: new Date().toISOString(), checks: project(await collect({ ...options, checkAdapter: false })) };
      return snapshot();
    }).finally(() => { flight = null; });
    return flight;
  }
  function revision() {
    try { return createHash("sha256").update(fs.readFileSync(codexPaths(options).config)).digest("hex"); }
    catch (error) { if (error.code === "ENOENT") return "missing";throw error; }
  }
  function preview() {
    return { source: "config_repair_preview", revision: revision(), checks: project(inspectConfig(options)),
      managed_keys: ["openai_base_url", "model_context_window", "model_auto_compact_token_limit", "shell_environment_policy", "features.context_management"],
      backup: "config.toml.ccdx-doctor.bak" };
  }
  function repair(input) {
    if (typeof input.revision !== "string" || input.revision !== revision()) throw Object.assign(new Error("config_preview_changed"), { code: "config_preview_changed", statusCode: 409 });
    const result = repairConfig({ ...options, expectedRevision: input.revision });
    const checks = project(inspectConfig(options).map(check => ({ ...check, id: "codex-config" })));
    if (last) last = { checked_at: new Date().toISOString(), checks: [...last.checks.filter(check => check.id !== "codex-config"), ...checks] };
    return { source: "config_repair_result", status: result.status, changed: result.changed === true,
      checks, local: snapshot() };
  }
  function network() {
    const value = inspectNetwork({ env, platform });
    return { source: "network_check", checked_at: new Date().toISOString(), summary: safe(formatPredictionEnvironment(value.summary)) };
  }
  return { snapshot, check, preview, repair, network, busy: () => Boolean(flight), report: () => ({ version: localPackageVersion(),
    exported_at: new Date().toISOString(), scope: "local checks only; accounts and credentials omitted", ...snapshot() }) };
}
