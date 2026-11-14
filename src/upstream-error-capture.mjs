import { boundedDiagnosticText } from "./diagnostic-text.mjs";

// Explicit, process-local consent for one failed Messages request. Only the
// bounded, redacted error message is retained; request bodies are never copied.
export function createUpstreamErrorCapture({ now = Date.now } = {}) {
  let state = { state: "off" };
  const expire = () => { if (state.state === "armed" && now() >= state.expires_at_ms) state = { ...state, state: "expired" }; };
  return {
    snapshot() { expire();return { ...state }; },
    arm(source, model) {
      expire();
      if (["armed", "reading"].includes(state.state)) throw Object.assign(new Error("An error capture is already pending; cancel it before arming another."), { statusCode: 409 });
      state = { state: "armed", source, model, expires_at_ms: now() + 10 * 60 * 1000 };
      return { ...state };
    },
    cancel() { state = { state: "off" };return { ...state }; },
    claim(source, model, protocol, status, requestId) {
      expire();
      if (state.state !== "armed" || source !== state.source || model !== state.model || protocol !== "messages" || ![400, 422].includes(status)) return null;
      const claimed = state = { ...state, state: "reading", request_id: requestId || null };
      return message => {
        if (state !== claimed) return false;
        state = { ...state, state: message ? "captured" : "unavailable",
          ...(message ? { diagnostic_message: boundedDiagnosticText(message, { maxChars: 512 }) } : {}) };
        return true;
      };
    },
  };
}
