import { adapterBaseUrl, checkRunningAdapter } from "./running-adapter.mjs";
import { isLoopbackHost } from "./security.mjs";
import { readBoundedResponseText } from "./upstream-body.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { writeServicePreference } from "./user-settings.mjs";

export async function dashboardToolRequest({ host = "127.0.0.1", port = 2026, path = "account", body, fetchImpl = fetch, timeoutMs = 5000, detailedErrors = false } = {}) {
  const baseUrl = adapterBaseUrl(isLoopbackHost(host) ? host : "127.0.0.1", port);
  const running = await checkRunningAdapter({ host, port, fetchImpl, timeoutMs });
  if (!running.ok) throw new Error("Start or restart CCDX to use this tool.");
  const response = await fetchImpl(`${baseUrl}/_ccdx/ui/${path}`, { method: body ? "POST" : "GET", redirect: "error",
    headers: { "X-CCDX-Dashboard": "1", Origin: baseUrl, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  const data = JSON.parse(await readBoundedResponseText(response, { maxBytes: 1024 * 1024, label: "Local tool response" }));
  if (!response.ok) throw Object.assign(new Error(detailedErrors && typeof data.error === "string" ? redactDiagnosticText(data.error.slice(0, 300)) : "Local tool is unavailable. Restart the updated CCDX service."), { statusCode: response.status, code: /^(?:ccdx|m365|auth)_[a-z0-9_]+$/.test(data.code || data.error || "") ? data.code || data.error : "ccdx_tool_unavailable" });
  return data;
}

export async function pauseServiceFeature({ feature, action, home, env = process.env, host, port, request = dashboardToolRequest } = {}) {
  const key = `${feature}_enabled`, value = action === "resume";
  if (!["image", "prediction"].includes(feature) || !["pause", "resume"].includes(action)) throw new Error("Choose pause or resume for images or predictions.");
  writeServicePreference(key, value, { home, env });
  let applied = false;
  try { await request({ host, port, path: "settings", body: { action: "preference", key, value } });applied = true; } catch {}
  return `${feature === "image" ? "Image requests" : "Prediction adaptation"}: ${value ? "resumed" : "paused"}. Setup and credentials kept.${applied ? "" : " Start or restart CCDX to apply."}`;
}
