import os from "node:os";
import { MIB } from "./cache-limits.mjs";
import { readAdapterStatus } from "./cli-status.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { decodedBodyLimitPreference, writeDecodedBodyLimitMib } from "./user-settings.mjs";

function mib(bytes) {
  const value = Number(bytes);
  return `${(value / MIB).toFixed(value % MIB === 0 ? 0 : 1)} MiB`;
}

export async function runLimitsCommand({
  action = "status",
  limitMib,
  resetLimit = false,
  env = process.env,
  home = os.homedir(),
  host = "127.0.0.1",
  port = 2026,
  output = process.stdout,
  fetchImpl = fetch,
  timeoutMs = 1000,
} = {}) {
  if (action === "set") {
    if (String(env.CCDX_MAX_DECODED_BODY_BYTES || "").trim()) {
      throw new Error("CCDX_MAX_DECODED_BODY_BYTES overrides saved limits; unset it before using ccdx limits --decoded");
    }
    writeDecodedBodyLimitMib(resetLimit ? null : limitMib, { env, home });
  } else if (action !== "status") {
    throw new Error(`Unknown limits action: ${action}`);
  }

  const preference = decodedBodyLimitPreference({ env, home });
  let runtime;
  try {
    runtime = await readAdapterStatus({ host, port, timeoutMs, fetchImpl });
  } catch {
    runtime = null;
  }
  const activeDecoded = Number(runtime?.data?.limits?.max_decoded_body_bytes);
  const activeRaw = Number(runtime?.data?.limits?.max_body_bytes);
  const lines = [
    "ccdx limits",
    `Configured decoded request body: ${mib(preference.bytes)} (${preference.source})`,
    runtime && Number.isFinite(activeDecoded) && activeDecoded > 0
      ? `Running decoded request body: ${mib(activeDecoded)}`
      : "Running decoded request body: unavailable",
    `Raw request body: ${mib(runtime && Number.isFinite(activeRaw) && activeRaw > 0 ? activeRaw : loadRuntimeConfig(env).maxBodyBytes)}${runtime ? " (running)" : " (configured)"}`,
  ];
  if (!runtime) lines.push("Running adapter status unavailable; restart ccdx to apply and verify this limit.");
  else if (activeDecoded !== preference.bytes) lines.push("Restart ccdx to apply the configured decoded-body limit.");
  if (action === "set") lines.push("Existing conversations and caches were not modified.");
  output.write(`${lines.join("\n")}\n`);
  return { preference, runtime };
}
