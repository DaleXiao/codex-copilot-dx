import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { adapterBaseUrl, ADAPTER_PROTOCOL_VERSION } from "./running-adapter.mjs";
import { imageHostLauncherPath } from "./codex-image-host-launch.mjs";
import { imageSetupSummary } from "./image-setup.mjs";
import { readBoundedResponseText } from "./upstream-body.mjs";
import { controlCodexLaunch } from "./codex-launch-control.mjs";

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

export async function controlImage(operation, { connection = checkImageConnection, readSummary = imageSetupSummary, ...options } = {}) {
  if (!["check", "repair", "open", "focus", "restart"].includes(operation)) throw new Error("Unknown image control");
  if (operation === "check") {
    const checked = await controlCodexLaunch("check", { ...options, readSummary, intent: "image" });
    const summary = readSummary({ ...options, models: options.models || [] });
    return { status: "checked", connection: await connection({ host: options.host, port: options.port }),
      launcher_present: fs.existsSync(imageHostLauncherPath(options)), runtime: options.state?.snapshot(), app: checked.app, ...summary };
  }
  return controlCodexLaunch(operation, { ...options, readSummary, intent: "image" });
}
