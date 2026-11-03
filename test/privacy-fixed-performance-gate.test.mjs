import test from "node:test";
import assert from "node:assert/strict";
import { validateFixedPerformanceEvidence } from "../scripts/privacy-fixed-performance-gate.mjs";

const evidence = (mode, ratio, noisy = false) => ({
  version: "1.3.12", runtime_fingerprint: "runtime", measurement_fingerprint: "measurement", mode,
  machine: "current-mac", platform: "darwin", arch: "arm64", machine_configuration: { available_parallelism: 10 },
  samples: Array.from({ length: 20 }, (_, trial) => ["baseline", "candidate"].map(variant => ({
    workload: "independent-synthetic", variant, trial, load_ms: 100,
    timings: ["cold", "append", "hot"].map(phase => ({ phase, repetitions: phase === "hot" ? 1000 : 1, ms: variant === "baseline" ? 100 : 100 * (noisy ? trial % 2 ? 1.4 : .7 : ratio) })),
  }))).flat(),
});
const expected = { version: "1.3.12", runtime: "runtime", measurement: "measurement" };
const fixture = () => ({ hosted: evidence("aa", 1, true), control: evidence("aa", 1), candidate: evidence("compare", .8) });

test("release verifies raw fixed-machine evidence rather than a precomputed pass flag", () => {
  const value = fixture();value.candidate.decision = "regression";
  assert.equal(validateFixedPerformanceEvidence(value, expected).machine, "current-mac");
  value.candidate.samples[1].timings[2].ms = 10000;
  // One outlier is retained by the robust statistic; a systematic slowdown cannot pass.
  for (const sample of value.candidate.samples.filter(sample => sample.variant === "candidate")) sample.timings[2].ms = 130;
  value.candidate.decision = "pass";assert.throws(() => validateFixedPerformanceEvidence(value, expected), /performance remains regression/);
});

test("mismatched source, machine, trial count or absent calibration prevents release", () => {
  let value = fixture();value.candidate.runtime_fingerprint = "other";assert.throws(() => validateFixedPerformanceEvidence(value, expected), /does not match/);
  value = fixture();value.candidate.machine_configuration = { available_parallelism: 4 };assert.throws(() => validateFixedPerformanceEvidence(value, expected), /matching Mac/);
  value = fixture();value.candidate.samples = value.candidate.samples.slice(2);assert.throws(() => validateFixedPerformanceEvidence(value, expected), /trial count/);
  value = fixture();value.hosted = evidence("aa", 1);assert.throws(() => validateFixedPerformanceEvidence(value, expected), /failed A\/A/);
});

test("inconclusive hot performance is not changed into success by faster cold and append work", () => {
  const value = fixture();
  for (const sample of value.candidate.samples.filter(sample => sample.variant === "candidate")) sample.timings[2].ms = sample.trial % 2 ? 103 : 98;
  assert.throws(() => validateFixedPerformanceEvidence(value, expected), /performance remains inconclusive/);
});
