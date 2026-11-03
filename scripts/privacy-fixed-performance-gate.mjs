import fs from "node:fs";
import path from "node:path";
import { summarizePerformanceSamples, applyPerformanceRepeatability, PRIVACY_PERFORMANCE_POLICY } from "./privacy-performance-analysis.mjs";
import { privacyRuntimeFingerprint, privacyMeasurementFingerprint } from "./privacy-performance-source.mjs";

export function validateFixedPerformanceEvidence({ hosted, control, candidate }, expected) {
  for (const evidence of [hosted, control, candidate]) {
    if (!evidence || evidence.version !== expected.version || evidence.runtime_fingerprint !== expected.runtime
      || evidence.measurement_fingerprint !== expected.measurement) throw Error("Performance evidence does not match the verified runtime and measurement source");
    if (!Array.isArray(evidence.samples) || evidence.samples.some(sample => !Number.isSafeInteger(sample.trial))) throw Error("Invalid performance samples");
    if (evidence.samples.some(sample => sample.timings?.find(value => value.phase === "hot")?.repetitions !== PRIVACY_PERFORMANCE_POLICY.hot_repetitions)) throw Error("Performance evidence has a different hot-path measurement basis");
    const trials = new Set(evidence.samples.map(sample => sample.trial));
    if (trials.size !== PRIVACY_PERFORMANCE_POLICY.pairs) throw Error("Performance evidence does not contain the pre-registered paired trial count");
  }
  if (hosted.mode !== "aa" || control.mode !== "aa" || candidate.mode !== "compare"
    || control.machine !== "current-mac" || candidate.machine !== control.machine
    || candidate.platform !== "darwin" || candidate.arch !== "arm64"
    || JSON.stringify(candidate.machine_configuration) !== JSON.stringify(control.machine_configuration)) throw Error("Fixed performance evidence was not measured on the approved matching Mac");
  const calibration = summarizePerformanceSamples(hosted.samples, { control: true });
  if (calibration.decision !== "unqualified") throw Error("Hosted timing cannot be migrated without failed A/A qualification");
  const fixedControl = summarizePerformanceSamples(control.samples, { control: true });
  if (fixedControl.decision !== "qualified") throw Error("The approved fixed machine has not qualified");
  const result = applyPerformanceRepeatability(summarizePerformanceSamples(candidate.samples), fixedControl);
  if (result.decision !== "pass") throw Error("Fixed-machine performance remains " + result.decision);
  return { machine: "current-mac", runtime: expected.runtime, measurement: expected.measurement, result };
}

export function verifyFixedPerformanceRelease(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
  const directory = path.join(root, "docs", "performance"), read = name => JSON.parse(fs.readFileSync(path.join(directory, `${version}-${name}.json`)));
  return validateFixedPerformanceEvidence({ hosted: read("hosted-aa"), control: read("fixed-aa"), candidate: read("fixed-ab") },
    { version, runtime: privacyRuntimeFingerprint(root), measurement: privacyMeasurementFingerprint(root) });
}
