import { checkRunningAdapter, ADAPTER_PREDICTION_FIX_PATH, PREDICTION_FIX_CAPABILITY } from "./running-adapter.mjs";
import { readBoundedResponseText } from "./upstream-body.mjs";

// Management request only. An older running adapter cannot be hot-upgraded by
// a new CLI, and a successful HTTP response is not proof of a visible prediction.
export async function requestPredictionFix({ host = "127.0.0.1", port = 2026, fetchImpl = fetch,
  timeoutMs = 45_000, probeTimeoutMs = 5000 } = {}) {
  const probe = await checkRunningAdapter({ host, port, fetchImpl: (url, options) => fetchImpl(url, { ...options, redirect: "error" }), timeoutMs: probeTimeoutMs,
    requiredCapabilities: [PREDICTION_FIX_CAPABILITY] });
  if (!probe.ok) throw new Error(probe.incompatible
    ? "The running adapter lacks compatible prediction repair. Upgrade and restart the CCDX service once; the App was not restarted."
    : "Could not reach a running CCDX adapter. Start ccdx, then retry ccdx prediction fix.");
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(probe.baseUrl + ADAPTER_PREDICTION_FIX_PATH, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ action: "fix" }), redirect: "error", signal,
  });
  const text = await readBoundedResponseText(response, { maxBytes: 64 * 1024, label: "Prediction repair response", signal });
  if (!response.ok) throw new Error(`Prediction repair returned HTTP ${response.status}; no App was restarted`);
  let value;try { value = JSON.parse(text); } catch {}
  if (!["ready", "disabled", "failed", "needs_app_relaunch", "route_unverified", "needs_service_restart", "environment_preserved"].includes(value?.status)
    || !["running", "stopped", "unavailable", "recovering"].includes(value?.prediction?.bridge)
    || value.prediction.candidate !== "unknown"
    || (["ready", "needs_app_relaunch", "route_unverified"].includes(value.status) && value.prediction.bridge !== "running")
    || (value.status === "ready" && !["verified", "closed"].includes(value.app_route))) throw new Error("Adapter returned an invalid prediction repair result");
  return value;
}
