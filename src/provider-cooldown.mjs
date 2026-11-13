import { accessError } from "./access-settings.mjs";

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
export function confirmedNetworkFailure(error) {
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) if (NETWORK_CODES.has(error.code)) return true;
  return false;
}

// One deployment/interface, two confirmed failures, one real recovery request.
// No paid probes, model switching or retry after output has started.
export function createProviderCooldown({ now = Date.now, delayMs = 5000 } = {}) {
  let failures = 0, until = 0, recovering = false;
  const snapshot = () => ({ state: until > now() ? "cooling" : recovering ? "recovering" : "ready", retry_after_ms: Math.max(0, until - now()), failures });
  function enter() {
    if (failures < 2) return false;
    if (until > now() || recovering) {
      const error = accessError("ccdx_api_cooling_down", 503);
      error.message = error.jsonBody.error.message = "This source interface is temporarily cooling down after repeated connection failures. Retry shortly.";
      error.retryAfterMs = Math.max(1000, until - now());throw error;
    }
    recovering = true;return true;
  }
  function complete(recovery, failed = false, cancelled = false, retryAfterMs = 0) {
    if (recovery) recovering = false;
    if (cancelled) return;
    if (!failed) { if (failures) { failures = 0;until = 0; }return; }
    failures = Math.min(2, failures + 1);
    if (failures >= 2) until = now() + Math.min(30000, Math.max(delayMs, retryAfterMs));
  }
  return {
    snapshot, enter, complete,
    acquire() {
      const recovery = enter();
      let finished = false;
      return {
        finish({ failed = false, cancelled = false, retryAfterMs = 0 } = {}) {
          if (finished) return;finished = true;
          complete(recovery, failed, cancelled, retryAfterMs);
        },
      };
    },
  };
}
