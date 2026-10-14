import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { operationErrorDetails } from "./operation-error.mjs";

export function createPredictionState({ now = () => new Date().toISOString() } = {}) {
  let state = { configured: false, bridge: "stopped", client_route: "unknown", candidate: "unknown", reason: null,
    launch_route: "unknown", persistence: "unknown", recovery: { attempts: 0, recovered: 0, last_check_at: null },
    configuration: {}, counters: { configuration_responses: 0, modified: 0, tls_errors: 0, upstream_errors: 0 }, last_event_at: null };
  return {
    configure(enabled) { state.configured = enabled === true; },
    running(proxy) { state.bridge = "running"; state.reason = null; state.proxy = proxy;delete state.error; },
    stopped() { state.bridge = "stopped"; },
    launch(route) { state.launch_route = ["verified", "persisted"].includes(route) ? route : "unverified"; },
    persistence(value) { state.persistence = value.status; },
    checked() { state.recovery.last_check_at = now(); },
    recovering(attempt) { state.bridge = "recovering";state.recovery.attempts = attempt;state.recovery.last_check_at = now(); },
    recovered() { state.bridge = "running";state.reason = null;delete state.error;state.recovery.recovered++; },
    unavailable(error) {
      state.bridge = "unavailable";
      state.reason = redactDiagnosticText(String(error?.message || "Prediction setup failed")).slice(0, 400);
      state.error = operationErrorDetails(error);
    },
    event(event) {
      state.last_event_at = now();
      if (event.type === "configuration") {
        state.client_route = "observed";
        state.counters.configuration_responses++;
        if (event.changed) state.counters.modified++;
        state.configuration[event.route] = { status: event.status, modified: event.changed === true, official: event.official === true };
      } else if (event.type === "tls_error") state.counters.tls_errors++;
      else if (event.type === "upstream_error") state.counters.upstream_errors++;
      if (event.error) state.last_error = { code: event.error.code, source: event.error.source, message: event.error.message, status: event.error.status };
    },
    snapshot() { return structuredClone(state); },
  };
}
