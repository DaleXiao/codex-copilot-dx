import test from "node:test";
import assert from "node:assert/strict";
import { comparePerformancePairs, qualifyPerformanceControl, summarizePerformanceSamples, applyPerformanceRepeatability } from "../scripts/privacy-performance-analysis.mjs";

const pairs = (ratio, count = 20) => Array.from({ length: count }, (_, i) => ({ before_ms: 100 + i * 10, after_ms: (100 + i * 10) * ratio }));

test("paired median intervals detect real regressions and preserve the approved policy", () => {
  assert.equal(comparePerformancePairs(pairs(1.30), { tolerance: .10 }).decision, "regression");
  assert.equal(comparePerformancePairs(pairs(1.08), { tolerance: .10 }).decision, "pass");
  assert.equal(comparePerformancePairs(pairs(1.01), { tolerance: 0 }).decision, "regression");
  assert.equal(comparePerformancePairs(pairs(.80), { tolerance: 0 }).decision, "pass");
});

test("unresolved intervals and insufficient samples never become passing performance evidence", () => {
  const noisy = pairs(1).map((pair, i) => ({ ...pair, after_ms: pair.before_ms * (i % 2 ? 1.4 : .7) }));
  assert.equal(comparePerformancePairs(noisy, { tolerance: .10 }).decision, "inconclusive");
  assert.equal(qualifyPerformanceControl(noisy).qualified, false);
  assert.equal(comparePerformancePairs(pairs(1, 5), { tolerance: .10 }).interval.high, null);
  assert.equal(comparePerformancePairs(pairs(1, 5), { tolerance: .10 }).decision, "inconclusive");
});

test("A/A qualification requires finite bounds in both directions", () => {
  assert.equal(qualifyPerformanceControl(pairs(1)).qualified, true);
  assert.equal(qualifyPerformanceControl(pairs(.7)).qualified, false);
  assert.equal(qualifyPerformanceControl(pairs(1.2)).qualified, false);
});

test("invalid and missing measurements are rejected rather than treated as zero or no slowdown", () => {
  for (const value of [[], [{ before_ms: 0, after_ms: 0 }], [{ before_ms: 1, after_ms: NaN }]]) assert.throws(() => comparePerformancePairs(value, { tolerance: .1 }));
  assert.throws(() => summarizePerformanceSamples([{ workload: "one", variant: "baseline", trial: 0, timings: [] }]));
});

test("phase comparisons preserve matching trials despite speed drift", () => {
  const samples = pairs(.8).flatMap((pair, trial) => ["baseline", "candidate"].map(variant => ({
    workload: "synthetic", variant, trial, load_ms: variant === "baseline" ? 10 : 8,
    timings: ["cold", "append", "hot"].map(phase => ({ phase, ms: variant === "baseline" ? pair.before_ms : pair.after_ms })),
  })));
  const result = summarizePerformanceSamples(samples);
  assert.equal(result.decision, "pass");assert.equal(result.comparisons[0].phases.hot.tolerance, 0);
  assert.ok(result.comparisons[0].phases.cold.confidence_coverage >= .95);
});

test("repeatability equivalence is limited to the approved phases and measured A/A upper bound", () => {
  const phase = (low, high) => ({ interval: { low, high }, decision: "inconclusive" });
  const candidate = { decision: "inconclusive", comparisons: [{ workload: "one", phases: { cold: phase(.99, 1.11), append: phase(.99, 1.02), hot: phase(.98, 1.03) } }] };
  const control = { decision: "qualified", comparisons: [{ workload: "one", phases: { cold: phase(.98, 1.04), append: phase(.98, 1.025), hot: phase(.98, 1.02) } }] };
  const result = applyPerformanceRepeatability(candidate, control);
  assert.equal(result.comparisons[0].phases.cold.decision, "inconclusive");
  assert.equal(result.comparisons[0].phases.append.decision, "equivalent");
  assert.equal(result.comparisons[0].phases.hot.decision, "inconclusive");
  assert.equal(result.decision, "inconclusive");
  assert.throws(() => applyPerformanceRepeatability(candidate, { ...control, decision: "unqualified" }));
});
