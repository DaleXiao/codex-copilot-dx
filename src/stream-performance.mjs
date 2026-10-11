import { performance } from "node:perf_hooks";
import { currentRequestContext } from "./request-context.mjs";

const PERFORMANCE_ROUTES = Object.freeze(["responses", "responses_compact"]);
const PREPARATION_STAGES = Object.freeze(["admission", "body", "history", "images", "serialization"]);
const TERMINAL_OUTCOMES = Object.freeze(["completed", "incomplete", "failed", "cancelled", "unknown"]);
const INCOMPLETE_REASONS = new Set(["max_output_tokens", "max_messages", "content_filter", "steered"]);
const TERMINAL_ORIGINS = new Set([
  "upstream_response", "upstream_event", "chat_completion", "client_validation",
  "upstream_http", "transport", "client_disconnect", "unclassified",
]);
const MAX_MODEL_OUTCOME_LABELS = 32;
const MAX_RECENT_REQUESTS = 20;
const PREPARATION_EDGES_MS = Object.freeze([1, 2, 5, 10, 20, 50, 100, 250, 500, 1_000, 5_000, 30_000, 120_000]);
const TTFT_EDGES_MS = Object.freeze([
  100, 200, 300, 500, 700, 1_000, 1_400, 2_000, 2_800, 4_000,
  5_500, 8_000, 12_000, 16_000, 24_000, 36_000, 60_000, 120_000, 300_000,
]);
const TPOT_EDGES_US = Object.freeze([
  500, 1_000, 2_000, 3_333, 5_000, 6_667, 8_333, 10_000, 12_500, 14_286,
  16_667, 20_000, 25_000, 33_333, 40_000, 50_000, 66_667, 100_000,
  150_000, 250_000, 500_000, 1_000_000, 2_500_000, 10_000_000,
]);

const RESPONSES_OUTPUT_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "response.refusal.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function isResponsesOutputEvent(event, eventType = event?.type) {
  return RESPONSES_OUTPUT_EVENT_TYPES.has(eventType) && nonEmptyString(event?.delta);
}

// Timing evidence is separate from the output/compatibility-retry commitment.
export function responsesTimingSource(event, eventType = event?.type) {
  if (isResponsesOutputEvent(event, eventType)) return "delta";
  const itemSource = (item, announced = false) => {
    if (!item || typeof item !== "object") return null;
    if (["function_call_output", "custom_tool_call_output", "computer_call_output", "additional_tools", "compaction", "compaction_summary", "mcp_approval_response"].includes(item.type)) return null;
    if (["program_output", "shell_call_output", "tool_search_output"].includes(item.type)) return "runtime";
    if (item.caller?.type === "program") return "runtime";
    if (announced && ["reasoning", "function_call", "custom_tool_call", "web_search_call", "file_search_call", "computer_call", "tool_search_call", "mcp_call", "program", "multi_agent_call", "image_generation_call"].includes(item.type)) return "announcement";
    const content = item.content || item.summary;
    if (Array.isArray(content) && content.some(part => nonEmptyString(part?.text) || nonEmptyString(part?.refusal))) return "snapshot";
    if (nonEmptyString(item.arguments) || nonEmptyString(item.input)) return "snapshot";
    return null;
  };
  if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
    return itemSource(event.item, eventType === "response.output_item.added");
  }
  if (["response.content_part.added", "response.content_part.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done"].includes(eventType)
    && (nonEmptyString(event.part?.text) || nonEmptyString(event.part?.refusal))) return "snapshot";
  if (eventType === "response.shell_call_output_content.delta"
    && (nonEmptyString(event.delta?.stdout) || nonEmptyString(event.delta?.stderr))) return "runtime";
  if (["response.completed", "response.incomplete", "response.failed"].includes(eventType)) {
    let runtime = null;
    for (const item of Array.isArray(event.response?.output) ? event.response.output : []) {
      const source = itemSource(item);
      if (source && source !== "runtime") return source;
      runtime ||= source;
    }
    return runtime;
  }
  return null;
}

export function isChatOutputDelta(delta) {
  if (!delta || typeof delta !== "object") return false;
  return nonEmptyString(delta.content)
    || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
    || nonEmptyString(delta.refusal)
    || nonEmptyString(delta.reasoning)
    || nonEmptyString(delta.reasoning_content)
    || nonEmptyString(delta.reasoning_text);
}

function createHistogram(edges) {
  return {
    edges,
    counts: new Uint32Array(edges.length + 1),
    samples: 0,
    total: 0,
    max: 0,
  };
}

function observe(histogram, value) {
  if (!Number.isFinite(value) || value < 0) return;
  let index = 0;
  while (index < histogram.edges.length && value > histogram.edges[index]) index += 1;
  histogram.counts[index] += 1;
  histogram.samples += 1;
  histogram.total += value;
  histogram.max = Math.max(histogram.max, value);
}

function histogramSnapshot(histogram, unit) {
  let lower = 0;
  const buckets = histogram.edges.map((upper, index) => {
    const bucket = { lower, upper, count: histogram.counts[index] };
    lower = upper;
    return bucket;
  });
  buckets.push({ lower, upper: null, count: histogram.counts.at(-1) });
  return {
    unit,
    samples: histogram.samples,
    avg: histogram.samples > 0 ? Number((histogram.total / histogram.samples).toFixed(1)) : 0,
    max: histogram.max,
    buckets,
  };
}

function emptyOutcomes() {
  return Object.fromEntries(TERMINAL_OUTCOMES.map((outcome) => [outcome, 0]));
}

function modelLabel(value) {
  const model = String(value || "").trim();
  return model === "codex-auto-review" || /^gpt-[A-Za-z0-9._-]{1,72}$/.test(model)
    ? model : "other";
}

function createRoutePerformance() {
  return {
    ttft: createHistogram(TTFT_EDGES_MS),
    tpot: createHistogram(TPOT_EDGES_US),
    requestTtft: createHistogram(TTFT_EDGES_MS),
    outputSources: { delta: 0, announcement: 0, snapshot: 0, runtime: 0 },
    preparation: Object.fromEntries(PREPARATION_STAGES.map((stage) => [stage, createHistogram(PREPARATION_EDGES_MS)])),
    success_with_output: 0,
    errors_with_output: 0,
    zero_output_errors: 0,
    neutral: 0,
    terminalTotals: emptyOutcomes(),
    incompleteReasons: Object.create(null),
    terminalByModel: new Map(),
    terminalByOrigin: Object.create(null),
  };
}

function routeSnapshot(route) {
  return {
    success_with_output: route.success_with_output,
    errors_with_output: route.errors_with_output,
    zero_output_errors: route.zero_output_errors,
    neutral: route.neutral,
    terminal_outcomes: {
      totals: { ...route.terminalTotals },
      incomplete_reasons: { ...route.incompleteReasons },
      by_model: Object.fromEntries([...route.terminalByModel].map(([model, counts]) => [model, { ...counts }])),
      by_origin: Object.fromEntries(Object.entries(route.terminalByOrigin).map(([origin, counts]) => [origin, { ...counts }])),
    },
    ttft_ms: histogramSnapshot(route.ttft, "ms"),
    tpot_us: histogramSnapshot(route.tpot, "us"),
    request_ttft_ms: histogramSnapshot(route.requestTtft, "ms"),
    first_output_sources: { ...route.outputSources },
    timing_boundary: "gateway_observed",
    tpot_estimated: true,
    preparation_ms: Object.fromEntries(PREPARATION_STAGES.map((stage) => [stage, histogramSnapshot(route.preparation[stage], "ms")])),
  };
}

export function createStreamPerformanceMetrics({ now = () => performance.now(), wallNow = () => new Date().toISOString() } = {}) {
  const routes = Object.fromEntries(PERFORMANCE_ROUTES.map((name) => [name, createRoutePerformance()]));
  const recentRequests = [];

  return {
    begin(routeName, { requestId } = {}) {
      const route = routes[routeName];
      if (!route) return null;
      const requestStartedAt = now();
      let upstreamStartedAt = null;
      let firstOutputAt = null;
      let firstOutputSource = null;
      let outputTokens = null;
      let failed = false;
      let finished = false;
      let model = "other";
      let terminalOutcome = null;
      let terminalOrigin = null;
      let incompleteReason = null;
      let errorOrigin = null;
      const at = wallNow();
      const preparationMs = Object.fromEntries(PREPARATION_STAGES.map((stage) => [stage, 0]));
      let phase = "received";
      let attempts = 0;
      let firstAttemptAt = null;
      let headersAt = null;
      let lastActivityAt = null;
      let terminalAt = null;
      const context = { payload_bytes: null, images: null, input_tokens: null, context_window_tokens: null };
      const elapsed = (time) => time === null ? null : Number(Math.max(0, time - requestStartedAt).toFixed(1));

      return {
        beginStage(stage) {
          const histogram = route.preparation[stage];
          if (!histogram || finished) return null;
          phase = stage;
          const startedAt = now();
          let ended = false;
          return () => {
            if (ended) return;
            ended = true;
            const duration = Math.max(0, now() - startedAt);
            preparationMs[stage] += duration;
            observe(histogram, duration);
          };
        },
        upstreamStarted(streaming = true) {
          if (finished) return;
          const time = now();
          attempts += 1;
          firstAttemptAt ??= time;
          phase = "upstream_connection";
          if (streaming && upstreamStartedAt === null) upstreamStartedAt = time;
        },
        upstreamHeaders() {
          if (finished) return;
          headersAt = now();
          lastActivityAt = headersAt;
          phase = "upstream_response";
        },
        upstreamActivity() {
          if (finished) return;
          lastActivityAt = now();
          phase = "upstream_stream";
        },
        firstOutput(source = "delta") {
          if (firstOutputAt === null) {
            firstOutputAt = now();
            firstOutputSource = Object.hasOwn(route.outputSources, source) ? source : "delta";
          }
        },
        setOutputTokens(value) {
          const tokens = Number(value);
          if (Number.isFinite(tokens) && tokens >= 0) outputTokens = tokens;
        },
        setModel(value) {
          model = modelLabel(value);
        },
        observeContext(values) {
          if (finished || !values || typeof values !== "object") return;
          for (const key of Object.keys(context)) {
            const value = values[key];
            if (Number.isSafeInteger(value) && value >= 0 && (key !== "context_window_tokens" || value > 0)) context[key] = value;
          }
        },
        setErrorOrigin(value) {
          if (TERMINAL_ORIGINS.has(value)) errorOrigin = value;
        },
        terminal(outcome, { model: terminalModel, origin, reason } = {}) {
          if (finished || terminalOutcome || !TERMINAL_OUTCOMES.includes(outcome)) return;
          terminalOutcome = outcome;
          terminalAt = now();
          if (terminalModel !== undefined) model = modelLabel(terminalModel);
          if (TERMINAL_ORIGINS.has(origin)) terminalOrigin = origin;
          if (outcome === "incomplete") incompleteReason = INCOMPLETE_REASONS.has(reason) ? reason : "other";
          if (outcome !== "completed") failed = true;
        },
        fail() {
          failed = true;
        },
        finish({ failed: finishFailed = false, aborted = false, statusCode = 0 } = {}) {
          if (finished) return;
          finished = true;
          failed ||= finishFailed;
          const outcome = terminalOutcome || (aborted ? "cancelled" : "unknown");
          const origin = terminalOrigin || errorOrigin || (aborted ? "client_disconnect" : "unclassified");
          route.terminalTotals[outcome] += 1;
          if (incompleteReason) route.incompleteReasons[incompleteReason] = (route.incompleteReasons[incompleteReason] || 0) + 1;
          const label = route.terminalByModel.has(model) || route.terminalByModel.size < MAX_MODEL_OUTCOME_LABELS
            ? model : "other";
          if (!route.terminalByModel.has(label)) route.terminalByModel.set(label, emptyOutcomes());
          route.terminalByModel.get(label)[outcome] += 1;
          route.terminalByOrigin[origin] ||= emptyOutcomes();
          route.terminalByOrigin[origin][outcome] += 1;
          const finishedAt = now();
          // Only scalar, allowlisted metadata survives the request; never retain payloads.
          recentRequests.push({
            request_id: typeof requestId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(requestId) ? requestId : null,
            at, route: routeName, model, outcome, origin, phase,
            failed: failed || aborted || (terminalOutcome !== null && terminalOutcome !== "completed"),
            http_status: Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : null,
            upstream_attempts: attempts,
            first_output_source: firstOutputSource,
            context: { ...context },
            timings_ms: {
              ...Object.fromEntries(PREPARATION_STAGES.map((stage) => [stage, Number(preparationMs[stage].toFixed(1))])),
              upstream_start: elapsed(firstAttemptAt), upstream_headers: elapsed(headersAt),
              first_output: elapsed(firstOutputAt), last_activity: elapsed(lastActivityAt),
              terminal: elapsed(terminalAt), finished: elapsed(finishedAt),
            },
          });
          if (recentRequests.length > MAX_RECENT_REQUESTS) recentRequests.shift();
          if (firstOutputAt !== null) observe(route.requestTtft, Math.max(0, firstOutputAt - requestStartedAt));
          if (firstOutputSource) route.outputSources[firstOutputSource] += 1;
          if (upstreamStartedAt === null) {
            route.neutral += 1;
            return;
          }
          if (firstOutputAt === null) {
            if (failed) route.zero_output_errors += 1;
            else route.neutral += 1;
            return;
          }
          observe(route.ttft, Math.max(0, firstOutputAt - upstreamStartedAt));
          if (outputTokens !== null && outputTokens >= 2) {
            observe(route.tpot, Math.max(0, ((finishedAt - firstOutputAt) * 1_000) / (outputTokens - 1)));
          }
          if (failed) route.errors_with_output += 1;
          else route.success_with_output += 1;
        },
      };
    },
    snapshot() {
      return {
        by_route: Object.fromEntries(PERFORMANCE_ROUTES.map((name) => [name, routeSnapshot(routes[name])])),
        recent_requests: recentRequests.map((entry) => ({ ...entry, context: { ...entry.context }, timings_ms: { ...entry.timings_ms } })),
      };
    },
  };
}

function tracker() {
  return currentRequestContext()?.streamPerformance || null;
}

export function measureRequestStage(stage, operation) {
  const finish = tracker()?.beginStage?.(stage);
  try {
    return operation();
  } finally {
    finish?.();
  }
}

export async function measureRequestStageAsync(stage, operation) {
  const finish = tracker()?.beginStage?.(stage);
  try {
    return await operation();
  } finally {
    finish?.();
  }
}

export function markUpstreamStarted(streaming = true) {
  tracker()?.upstreamStarted(streaming);
}

export function markUpstreamHeaders() {
  tracker()?.upstreamHeaders?.();
}

export function markUpstreamActivity() {
  tracker()?.upstreamActivity?.();
}

export function markFirstOutput(source) {
  tracker()?.firstOutput(source);
}

export function markOutputTokens(value) {
  tracker()?.setOutputTokens(value);
}

export function markRequestObservation(values) {
  tracker()?.observeContext?.(values);
}

export function markStreamFailure() {
  tracker()?.fail();
}

export function markResponseModel(model) {
  tracker()?.setModel?.(model);
}

export function markResponseErrorOrigin(origin) {
  tracker()?.setErrorOrigin?.(origin);
}

export function markResponseTerminal(outcome, options) {
  tracker()?.terminal?.(outcome, options);
}
