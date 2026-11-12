import { abortErrorStatusCode, createRequestAbort, httpError, MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES,
  MAX_UPSTREAM_ERROR_BODY_BYTES, readBoundedResponseText, readJsonBody, sendJsonError, sendUpstreamError } from "./http-transport.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";

export function createCarbonSearchHandler({ acquireRequest, privacy, resolveProvider, searchFn,
  requestBodyTimeoutMs, upstreamTimeoutMs } = {}) {
  return async (req, res) => {
    const abort = createRequestAbort(req, res);
    let release = () => {};
    try {
      release = await acquireRequest(req, { signal: abort.signal });
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      const body = await readJsonBody(req, { admission: release, signal: abort.signal });
      if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError("Invalid search request", 400);
      const provider = resolveProvider?.(body, req);
      if (body.model !== "gemini-4-carbon" || provider && provider.id !== "github") {
        throw httpError("This search route is only available to GitHub Carbon", 400);
      }
      if (!searchFn) throw httpError("Carbon search is unavailable", 503);
      const search = privacy?.wrap(searchFn, { res, protocol: "search", client: "codex" }) || searchFn;
      abort.setTimeout(upstreamTimeoutMs, "upstream_timeout");
      const { input, ...searchBody } = body;
      const upstream = await search(searchBody, { signal: abort.signal, providerProfile: provider?.profileId?.() });
      const text = await readBoundedResponseText(upstream, { maxBytes: upstream.ok ? MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES : MAX_UPSTREAM_ERROR_BODY_BYTES,
        signal: abort.signal, label: "Carbon search" });
      if (!upstream.ok) { sendUpstreamError(res, upstream, text);return; }
      res.writeHead(upstream.status, safeUpstreamResponseHeaders(upstream.headers, { contentType: "application/json" }));
      res.end(text);
    } catch (error) {
      if (error?.retryAfter && typeof res.setHeader === "function") res.setHeader("Retry-After", error.retryAfter);
      else if (error?.retryAfter && res.headers) res.headers["Retry-After"] = error.retryAfter;
      sendJsonError(res, error, abort.signal.aborted ? abortErrorStatusCode(abort.reason) : 502);
    } finally {
      release();abort.cleanup();
    }
  };
}
