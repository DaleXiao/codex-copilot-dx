import { createAccountTools } from "./account-tools.mjs";
import { createLocalTools } from "./local-tools.mjs";
import { createRequestAbort, readJsonBody } from "./http-transport.mjs";

export const TOOL_PATHS = new Set(["/_ccdx/ui/account", "/_ccdx/ui/checks"]);
export function createDashboardTools(options = {}) {
  const accounts = options.accountTools || createAccountTools({ ...options, onChanged: options.credentialsChanged });
  const local = options.localTools || createLocalTools(options);
  return {
    busy: () => accounts.busy?.() === true || local.busy?.() === true,
    dispose() { accounts.dispose(); },
    async handle(req, res, pathname, sendJson, sameOrigin) {
      const account = pathname === "/_ccdx/ui/account";
      if (req.method === "GET") {
        try { sendJson(res, 200, account ? accounts.snapshot() : local.snapshot()); }
        catch { sendJson(res, 409, { error: "tools_read_failed", code: "tools_read_failed" }); }
        return;
      }
      if (req.method !== "POST") { sendJson(res, 405, { error: "Use GET or POST" });return; }
      if (!sameOrigin(req)) { sendJson(res, 403, { error: "Tools require the same-origin dashboard" });return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { sendJson(res, 415, { error: "Expected application/json" });return; }
      const abort = createRequestAbort(req, res);abort.setTimeout(5000, "request_body_timeout");
      try {
        const input = await readJsonBody(req, { maxBodyBytes: 4096, maxDecodedBodyBytes: 4096, signal: abort.signal });
        abort.clearTimeout();
        const fields = account ? { check: ["action"], start: ["action", "reauth"], cancel: ["action", "id"], logout: ["action", "confirmed"], reload: ["action"] }
          : { check: ["action"], preview: ["action"], repair: ["action", "revision"], network: ["action"], report: ["action"] };
        const allowed = input && typeof input === "object" && !Array.isArray(input) && fields[input.action];
        if (!allowed || Object.keys(input).some(key => !allowed.includes(key)) || (input.action === "start" && input.reauth !== undefined && typeof input.reauth !== "boolean")) {
          sendJson(res, 400, { error: "tools_invalid_action", code: "tools_invalid_action" });return;
        }
        const target = account ? accounts : local;
        if (!account && input.action === "report" && !local.snapshot().checked_at) await local.check();
        const value = await (input.action === "start" ? target.start({ reauth: input.reauth })
          : input.action === "cancel" ? target.cancel(input.id) : input.action === "logout" ? target.logout(input)
            : input.action === "repair" ? target.repair(input) : target[input.action]());
        if (!res.destroyed && !res.writableEnded) sendJson(res, 200, value);
      } catch (error) {
        const code = /^(auth|copilot|config|tools)_[a-z_]+$/.test(error.code || "") ? error.code : "tools_action_failed";
        sendJson(res, error.statusCode || 409, { error: code, code });
      } finally { abort.cleanup(); }
    },
  };
}
