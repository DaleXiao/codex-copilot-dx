import { performance } from "node:perf_hooks";
import { currentRequestContext } from "./request-context.mjs";

const PERFORMANCE_ROUTES = Object.freeze(["responses", "responses_compact"]);
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

function createRoutePerformance() {
  return {
    ttft: createHistogram(TTFT_EDGES_MS),
    tpot: createHistogram(TPOT_EDGES_US),
    success_with_output: 0,
    errors_with_output: 0,
    zero_output_errors: 0,
    neutral: 0,
  };
}

function routeSnapshot(route) {
  return {
    success_with_output: route.success_with_output,
    errors_with_output: route.errors_with_output,
    zero_output_errors: route.zero_output_errors,
    neutral: route.neutral,
    ttft_ms: histogramSnapshot(route.ttft, "ms"),
    tpot_us: histogramSnapshot(route.tpot, "us"),
  };
}

export function createStreamPerformanceMetrics({ now = () => performance.now() } = {}) {
  const routes = Object.fromEntries(PERFORMANCE_ROUTES.map((name) => [name, createRoutePerformance()]));

  return {
    begin(routeName) {
      const route = routes[routeName];
      if (!route) return null;
      let upstreamStartedAt = null;
      let firstOutputAt = null;
      let outputTokens = null;
      let failed = false;
      let finished = false;

      return {
        upstreamStarted() {
          if (upstreamStartedAt === null) upstreamStartedAt = now();
        },
        firstOutput() {
          if (firstOutputAt === null) firstOutputAt = now();
        },
        setOutputTokens(value) {
          const tokens = Number(value);
          if (Number.isFinite(tokens) && tokens >= 0) outputTokens = tokens;
        },
        fail() {
          failed = true;
        },
        finish({ failed: finishFailed = false } = {}) {
          if (finished) return;
          finished = true;
          failed ||= finishFailed;
          const finishedAt = now();
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
      };
    },
  };
}

function tracker() {
  return currentRequestContext()?.streamPerformance || null;
}

export function markUpstreamStarted() {
  tracker()?.upstreamStarted();
}

export function markFirstOutput() {
  tracker()?.firstOutput();
}

export function markOutputTokens(value) {
  tracker()?.setOutputTokens(value);
}

export function markStreamFailure() {
  tracker()?.fail();
}
