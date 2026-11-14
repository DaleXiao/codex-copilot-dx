import { createHash, randomUUID } from "node:crypto";
import { planContextCompaction, compactionItems, compactionMessage, replaceCompactionItems } from "./context-compaction-plan.mjs";
import { CCDX_COMPACTION_PREFIX, CCDX_NATIVE_COMPACTION_PREFIX, sealContextCompaction, openContextCompaction, sealNativeCompaction, openNativeCompaction } from "./context-compaction-seal.mjs";
import { readSafeUpstreamReason } from "./safe-upstream-error.mjs";
import { currentRequestContext, runWithRequestContext } from "./request-context.mjs";
import { recordUsage } from "./usage-store.mjs";
import { boundedDiagnosticText } from "./diagnostic-text.mjs";

export const COMPACTION_USAGE_RECORDED = Symbol("ccdx-compaction-usage-recorded");
export const compactionScope = (provider, client, protocol) => JSON.stringify([client, provider.id, provider.profileId?.(protocol) || provider.id]);
const MAX_ACTIVE = 2, MAX_SUPPORT = 128, RECOVERY_MS = 5 * 60 * 1000;
const fail = (code, message, statusCode = 422) => Object.assign(new Error(message), { code, statusCode });
const cancel = response => { try { void response?.body?.cancel().catch(() => {}); } catch {} };
const inputFailure = reason => ["input_length_invalid", "context_length_exceeded", "context_window_exceeded"].includes(reason?.code);

export function isCompactionRequest(protocol, body, headers = {}) {
  return protocol === "messages" ? headers["x-claude-code-request-class"] === "compaction"
    : protocol === "gemini" && ["summarization", "checkpoint"].includes(body?.requestType);
}

export function resolveGatewayCompactionItem(item, { key, scope, onMappings = () => {} } = {}) {
  if (item?.type !== "compaction" || typeof item.encrypted_content !== "string") return item;
  const value = item.encrypted_content;
  if (value.startsWith(CCDX_COMPACTION_PREFIX)) return compactionMessage("responses", openContextCompaction(value, { key: typeof key === "function" ? key() : key, scope }));
  if (value.startsWith(CCDX_NATIVE_COMPACTION_PREFIX)) {
    const restored = openNativeCompaction(value, { key: typeof key === "function" ? key() : key, scope });onMappings(restored.mappings);
    return { ...item, encrypted_content: restored.encrypted_content };
  }
  return item;
}

export function expandGatewayCompaction(body, options) {
  let changed = false;
  const input = body.input?.map(item => { const next = resolveGatewayCompactionItem(item, options);changed ||= item !== next;return next; });
  return changed ? { ...body, input } : body;
}

export function protectNativeCompactionResult(response, { key, scope, mappings } = {}) {
  const index = response.output?.findIndex(item => item?.type === "compaction" && typeof item.encrypted_content === "string"
    && item.encrypted_content.length > 0
    && !item.encrypted_content.startsWith(CCDX_COMPACTION_PREFIX) && !item.encrypted_content.startsWith(CCDX_NATIVE_COMPACTION_PREFIX));
  if (index === undefined || index < 0) return response;
  const entries = typeof mappings === "function" ? mappings() : mappings;if (!entries?.length) return response;
  return { ...response, output: response.output.map((item, position) => position === index ? { ...item,
    encrypted_content: sealNativeCompaction(item.encrypted_content, entries, { key: typeof key === "function" ? key() : key, scope }) } : item) };
}

export function createContextCompactionService({ enabled = () => true, now = Date.now, recordUsageFn = recordUsage } = {}) {
  const support = new Map(), stats = { native: 0, gateway: 0, failed: 0, active: 0, summary_calls: 0 };let last = null;
  const remember = (scope, value) => {
    support.delete(scope);support.set(scope, value);while (support.size > MAX_SUPPORT) support.delete(support.keys().next().value);
  };
  return {
    snapshot() { return { enabled: enabled() === true, native_attempts: stats.native, gateway_attempts: stats.gateway, failed_operations: stats.failed,
      active_recoveries: stats.active, summary_calls: stats.summary_calls, last: last ? { ...last } : null, sources: [...support.values()].map(value => ({ ...value })) }; },
    async run({ body, protocol, scope, source, model = body.model, client, key, native, summarize, options = {}, inputLimit,
      outputAllowance = 0, restoreText = value => value, onActivity = () => {}, nativeCompaction, nativeKind = "compact" } = {}) {
      const started = now(), owner = createHash("sha256").update(JSON.stringify([scope, model, protocol, nativeKind])).digest("hex"), cached = support.get(owner);
      const modelLabel = boundedDiagnosticText(model, { maxChars: 160, overflow: "unknown" });
      const allowFallback = enabled() === true;
      let nativeResponse, deferredError, calls = 0, usage = {}, failedUsage = false, missingCached = false, recovering = false;
      const deferredOptions = { ...options, onUpstreamErrorHeaders(status) { deferredError = status; } };
      const forwardError = () => { if (deferredError !== undefined) try { options.onUpstreamErrorHeaders?.(deferredError); } catch {} };
      try {
        const skipNative = protocol === "responses" && allowFallback && (nativeCompaction === false || !native || cached?.native === "unavailable" && now() >= cached.at && now() - cached.at < 60000);
        if (!skipNative) {
          if (!native) throw fail("ccdx_compaction_native_unavailable", "This connection has no native compression operation.");
          stats.native++;nativeResponse = await native(body, allowFallback ? deferredOptions : options);
          if (nativeResponse.ok) { remember(owner, { source, model: modelLabel, protocol, native: "http_accepted", at: now() });return nativeResponse; }
        }
        if (!allowFallback) { forwardError();return nativeResponse; }
        let unsupported = protocol === "responses" && (skipNative || [404, 405, 501].includes(nativeResponse.status));
        const reason = !unsupported && [400, 413, 422].includes(nativeResponse?.status) ? await readSafeUpstreamReason(nativeResponse.clone(), { signal: options.signal }) : null;
        unsupported ||= protocol === "responses" && reason?.code === "compaction_unavailable";
        if (!unsupported && !inputFailure(reason)) { stats.failed++;forwardError();return nativeResponse; }
        if (unsupported) remember(owner, { source, model: modelLabel, protocol, native: "unavailable", at: now() });
        if (stats.active >= MAX_ACTIVE) throw fail("ccdx_compaction_busy", "Compression is busy; the original conversation was kept.", 429);
        const limits = [inputLimit, reason?.maximum].filter(value => Number.isSafeInteger(value) && value > 0);
        const knownLimit = limits.length ? Math.min(...limits) : undefined;
        if (inputFailure(reason) && reason.maximum) remember(owner, { source, model: modelLabel, protocol, native: "input_limited", input_limit: reason.maximum, at: now() });
        const plan = planContextCompaction(body, { protocol, inputLimit: knownLimit, outputAllowance });
        const sealKey = protocol === "responses" ? typeof key === "function" ? key() : key : null;
        if (protocol === "responses" && (typeof sealKey !== "string" || sealKey.length < 32)) throw fail("ccdx_compaction_key_unavailable", "A saved local client identity is required for resumable compression.");
        cancel(nativeResponse);stats.active++;stats.gateway++;recovering = true;
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(fail("ccdx_compaction_timeout", "Compression exceeded its bounded recovery time; the original conversation was kept.")), RECOVERY_MS);
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        const parent = currentRequestContext();
        const summary = async text => {
          signal.throwIfAborted();calls++;stats.summary_calls++;
          const requestId = randomUUID(), context = { ...parent, requestId, purpose: "compaction", provider: source };
          return runWithRequestContext(context, async () => {
            let counts;
            try {
              const result = await summarize(text, { ...deferredOptions, signal, requestId, onActivity, onUsage: value => { counts = value; } });
              counts = result?.usage || counts || {};signal.throwIfAborted();
              if (!result?.text?.trim() || Buffer.byteLength(result.text) > 512 * 1024) throw fail("ccdx_compaction_result_invalid", "The source returned no usable compression summary.");
              failedUsage ||= !Number.isSafeInteger(counts.input_tokens) || !Number.isSafeInteger(counts.output_tokens);
              for (const field of ["input_tokens", "output_tokens"]) if (Number.isSafeInteger(counts[field]) && counts[field] >= 0) usage[field] = (usage[field] || 0) + counts[field];
              const cachedTokens = counts.input_tokens_details?.cached_tokens;missingCached ||= !Number.isSafeInteger(cachedTokens);
              if (Number.isSafeInteger(cachedTokens) && cachedTokens >= 0) usage.cached_input_tokens = (usage.cached_input_tokens || 0) + cachedTokens;
              return result.text;
            } finally {
              if (counts) {
                const cachedTokens = counts.input_tokens_details?.cached_tokens;
                const record = { ts: new Date(now()).toISOString(), surface: "context_compaction", mode: "internal", provider: source, model,
                  client, request_id: requestId, ...(parent?.requestId ? { parent_request_id: parent.requestId } : {}), purpose: "compaction", usage: {
                    ...(counts.input_tokens === undefined ? {} : { input_tokens: counts.input_tokens }), ...(counts.output_tokens === undefined ? {} : { output_tokens: counts.output_tokens }),
                    ...(cachedTokens === undefined ? {} : { cached_input_tokens: cachedTokens }),
                    ...(counts.output_tokens_details?.reasoning_tokens === undefined ? {} : { reasoning_output_tokens: counts.output_tokens_details.reasoning_tokens }),
                  } };
                try { void Promise.resolve(recordUsageFn(record)).catch(() => {}); } catch {}
              }
            }
          });
        };
        try {
          const summaries = [];
          for (const [index, chunk] of plan.chunks.entries()) summaries.push(await summary(`Historical records, segment ${index + 1} of ${plan.chunks.length}:\n${chunk}`));
          let text = summaries[0];
          if (summaries.length > 1) text = await summary("Combine these continuation summaries. Preserve all distinct facts, constraints, failures and unresolved work:\n" + summaries.map((value, index) => `[Segment ${index + 1}]\n${value}`).join("\n\n"));
          signal.throwIfAborted();let result;
          if (protocol === "responses") {
            const encrypted_content = sealContextCompaction(restoreText(text), { key: sealKey, scope }), rewritten = plan.rewriteItem({ type: "compaction", id: "cmp_ccdx_" + randomUUID(), encrypted_content });
            const returnedUsage = failedUsage ? undefined : { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens,
              ...(missingCached ? {} : { input_tokens_details: { cached_tokens: usage.cached_input_tokens } }) };
            const output = compactionItems(rewritten, protocol).map(item => item && (item.type === "message" || item.type === undefined && item.role)
              ? { ...item, type: "message", content: typeof item.content === "string" ? [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.content }] : item.content } : item);
            const response = { id: "resp_ccdx_" + randomUUID(), object: body.stream === true ? "response" : "response.compaction", status: "completed", created_at: Math.floor(now() / 1000), model,
              output, ...(returnedUsage ? { usage: returnedUsage } : {}) };
            if (body.stream === true) {
              const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }];
              for (const [output_index, item] of output.entries()) events.push({ type: "response.output_item.added", output_index, item }, { type: "response.output_item.done", output_index, item });
              events.push({ type: "response.completed", response });
              const encoded = events.map((event, sequence_number) => "event: " + event.type + "\ndata: " + JSON.stringify({ ...event, sequence_number }) + "\n\n");
              if (encoded.some(frame => Buffer.byteLength(frame) > 8 * 1024 * 1024)) throw fail("ccdx_compaction_output_limit", "The preserved compression window exceeds the stream budget; the original conversation was kept.");
              result = new Response(encoded.join(""), { headers: { "content-type": "text/event-stream" } });
            } else result = Response.json(response);
            Object.defineProperty(result, COMPACTION_USAGE_RECORDED, { value: true });
          } else {
            signal.throwIfAborted();result = await native(plan.rewrite(text), { ...deferredOptions, signal });
            if (!result.ok) {
              if ([400, 413, 422].includes(result.status) && inputFailure(await readSafeUpstreamReason(result.clone(), { signal }))) {
                cancel(result);throw fail("ccdx_compaction_still_rejected", "The source still rejected the compressed request. The original conversation was kept.");
              }
              stats.failed++;forwardError();
            }
          }
          last = { source, model: modelLabel, protocol, client, result: result.ok ? protocol === "responses" ? "completed" : "response_started" : "source_rejected", summary_calls: calls,
            compressed_items: plan.selected_items, preserved_items: plan.preserved_items, historical_bytes: plan.bytes, elapsed_ms: now() - started, usage_state: failedUsage || missingCached ? "partial" : "reported" };
          return result;
        } finally { clearTimeout(timer);stats.active--; }
      } catch (error) {
        stats.failed++;cancel(nativeResponse);forwardError();last = { source, model: modelLabel, protocol, client, result: options.signal?.aborted ? "cancelled" : "failed", summary_calls: calls, elapsed_ms: now() - started,
          error: /^ccdx_compaction_[a-z_]+$/.test(error.code || "") ? error.code : "ccdx_compaction_failed" };
        if (options.signal?.aborted) throw options.signal.reason;
        if (!recovering) throw error;
        throw typeof error.code === "string" && error.code.startsWith("ccdx_compaction_") ? error : fail("ccdx_compaction_failed", "Compression could not complete; the original conversation was kept.");
      }
    },
  };
}
