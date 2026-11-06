import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { adapterBaseUrl, ADAPTER_PROTOCOL_VERSION } from "./running-adapter.mjs";
import { imageHostLauncherPath, prepareImageHostLaunch } from "./codex-image-host-launch.mjs";
import { imageSetupSummary } from "./image-setup.mjs";
import { openCodex, macPredictionAppProcesses } from "./launcher.mjs";
import { readBoundedResponseText } from "./upstream-body.mjs";

export async function checkImageConnection({ host = "127.0.0.1", port = 2026, fetchImpl = fetch } = {}) {
  const nonce = randomUUID();
  try {
    const response = await fetchImpl(adapterBaseUrl(host, port) + "/_ccdx/health?nonce=" + nonce,
      { redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2000) });
    const value = JSON.parse(await readBoundedResponseText(response, { maxBytes: 8192, label: "Local image check" }));
    return { state: response.ok && value.name === "codex-copilot-dx" && value.ok === true && value.nonce === nonce
      && value.protocol_version === ADAPTER_PROTOCOL_VERSION ? "verified" : "identity_mismatch", scope: "node_loopback", app_path: "unconfirmed" };
  } catch { return { state: "unreachable", scope: "node_loopback", app_path: "unconfirmed" }; }
}

export async function controlImage(operation, { integration, state, host, port, models = [], prepare = prepareImageHostLaunch,
  launch = openCodex, appProcesses = macPredictionAppProcesses, connection = checkImageConnection, ...options } = {}) {
  if (!["check", "repair", "open"].includes(operation)) throw new Error("Unknown image control");
  const summary = imageSetupSummary({ ...options, models });
  if (operation === "check") return { status: "checked", connection: await connection({ host, port }),
    launcher_present: fs.existsSync(imageHostLauncherPath(options)), runtime: state?.snapshot(), ...summary };
  if (!summary.enabled) throw new Error("Enable images before repairing image access");
  if (!integration) throw new Error("Start CCDX before repairing image access");
  const env = { ...(options.env || process.env), CCDX_AUTO_LAUNCH: "1" };
  await integration.configure();
  const imageHost = await prepare({ ...options, env, host, port });
  if (!imageHost) return { status: "unsupported", prepared: false };
  const running = appProcesses(imageHost.app).length > 0;
  if (running) return { status: "needs_app_relaunch", prepared: true, runtime: state?.snapshot() };
  if (operation === "repair") return { status: "prepared", prepared: true, runtime: state?.snapshot() };
  // Share the established prediction launch route; never strip it during repair.
  const native = await integration.start();
  await native?.prepareRoute?.();
  const opened = await launch({ env, imageHost, predictionPacUrl: native?.pacUrl, predictionApp: native?.app,
    predictionProfile: native?.profile, preparePredictionRoute: () => native?.prepareRoute?.(),
    onPredictionRoute: value => integration.launched?.(value) });
  return { status: opened ? "opened_new_chat_required" : "open_failed", prepared: true, runtime: state?.snapshot() };
}
