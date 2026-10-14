import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { operationErrorDetails } from "./operation-error.mjs";

export function createPredictionState({ now = () => new Date().toISOString() } = {}) {
  let state = { configured: false, bridge: "stopped", client_route: "unknown", candidate: "unknown", reason: null,
    launch_route: "unknown", persistence: "unknown", recovery: { attempts: 0, recovered: 0, last_check_at: null },
    configuration: {}, counters: { configuration_responses: 0, modified: 0, tls_errors: 0, upstream_errors: 0 }, last_event_at: null };
  return {
    configure(enabled) { state.configured = enabled === true; },
    environment(value, { resetTraffic = false } = {}) {
      state.environment = structuredClone(value);
      if (resetTraffic) { state.client_route = "unknown";state.configuration = {}; }
    },
    running(proxy) { state.bridge = "running"; state.reason = null; state.proxy = proxy;delete state.error; },
    stopped() { state.bridge = "stopped"; },
    launch(route) { state.launch_route = ["verified", "persisted"].includes(route) ? route : "unverified"; },
    persistence(value) { state.persistence = value.status; },
    checked() { state.recovery.last_check_at = now(); },
    supervising() { state.recovery.attempts = 0;state.recovery.last_check_at = null; },
    recovering(attempt) { state.bridge = "recovering";state.recovery.attempts = attempt;state.recovery.last_check_at = now(); },
    recovered() { state.bridge = "running";state.reason = null;delete state.error;state.recovery.recovered++; },
    unavailable(error) {
      state.bridge = "unavailable";
      state.reason = redactDiagnosticText(String(error?.message || "Prediction setup failed")).slice(0, 400);
      state.error = operationErrorDetails(error);
      if (error?.predictionEnvironment) state.environment = structuredClone(error.predictionEnvironment);
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

export function formatPredictionEnvironment(environment) {
  if (!environment) return "";
  const statuses = ["adapted", "preserved", "unavailable", "needs_service_restart", "needs_app_relaunch"];
  const state = statuses.includes(environment.status) ? environment.status : "unknown";
  const network = environment.network;
  const type = ["http", "https", "socks5", "socks5h", "direct", "auto"].includes(network?.type) ? network.type : "unknown";
  const source = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "system HTTPS", "system SOCKS", "system", "direct"].includes(network?.source) ? network.source : "unknown";
  const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : "unknown";
  const ca = ["not_set", "configured", "unreadable_or_invalid"].includes(environment.tls?.extra_ca) ? environment.tls.extra_ca : "unknown";
  return `Prediction environment: ${state}; proxy ${source}/${type}; bypass ${count(network?.bypass_rules)} (${count(network?.cidr_rules)} CIDR); extra CA ${ca}; TLS verification required`;
}
