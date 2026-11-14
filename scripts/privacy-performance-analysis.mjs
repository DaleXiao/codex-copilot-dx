// Paired, distribution-free median intervals. No runtime dependency or
// historical-receipt-specific threshold is used by this development tool.
export const PRIVACY_PERFORMANCE_POLICY = Object.freeze({
  schema: 2, confidence: 0.95, pairs: 20, hot_repetitions: 1000, repeatability_equivalence: true,
  tolerances: Object.freeze({ cold: 0.10, startup_cold: 0.10, append: 0.05, hot: 0 }),
  absolute_tolerances_ms: Object.freeze({ append: 0.5 }),
});

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), at = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2;
};

export function comparePerformancePairs(pairs, { tolerance, confidence = 0.95, absoluteToleranceMs } = {}) {
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 128
    || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1
    || !Number.isFinite(confidence) || confidence <= 0 || confidence >= 1
    || absoluteToleranceMs !== undefined && (!Number.isFinite(absoluteToleranceMs) || absoluteToleranceMs < 0)) throw Error("Invalid paired performance inputs");
  for (const pair of pairs) if (!pair || !Number.isFinite(pair.before_ms) || !Number.isFinite(pair.after_ms)
    || pair.before_ms <= 0 || pair.after_ms <= 0) throw Error("Paired durations must have a positive measurement basis");
  const ratios = pairs.map(pair => pair.after_ms / pair.before_ms), sorted = [...ratios].sort((a, b) => a - b), n = sorted.length;
  let mass = 2 ** -n, tail = 0, selected = -1, selectedTail = 0;
  for (let j = 0; j < Math.floor(n / 2); j++) {
    tail += mass;
    if (tail <= (1 - confidence) / 2) { selected = j;selectedTail = tail; }
    mass *= (n - j) / (j + 1);
  }
  const low = selected >= 0 ? sorted[selected] : 0, high = selected >= 0 ? sorted[n - selected - 1] : null;
  const limit = 1 + tolerance;
  let absolute;
  if (absoluteToleranceMs !== undefined) {
    const differences = pairs.map(pair => pair.after_ms - pair.before_ms).sort((a, b) => a - b);
    absolute = { median_ms: median(differences), tolerance_ms: absoluteToleranceMs,
      interval: { low: selected >= 0 ? differences[selected] : null, high: selected >= 0 ? differences[n - selected - 1] : null } };
  }
  const absolutePassed = !absolute || absolute.interval.high !== null && absolute.interval.high <= absoluteToleranceMs;
  const decision = high !== null && high <= limit && absolutePassed ? "pass"
    : low > limit || absolute && absolute.interval.low !== null && absolute.interval.low > absoluteToleranceMs ? "regression" : "inconclusive";
  return {
    method: "paired-median-exact-binomial", n, ratios, ratio_median: median(ratios),
    before_median_ms: median(pairs.map(pair => pair.before_ms)), after_median_ms: median(pairs.map(pair => pair.after_ms)),
    confidence_requested: confidence, confidence_coverage: selected >= 0 ? 1 - 2 * selectedTail : 1,
    interval: { low, high }, tolerance, decision,
    ...(absolute ? { absolute } : {}),
  };
}

export function qualifyPerformanceControl(pairs, tolerance = 0.10) {
  const result = comparePerformancePairs(pairs, { tolerance });
  // A/A must resolve both directions around unity. A point estimate alone
  // cannot qualify a noisy runner, and absent finite bounds never qualify.
  const qualified = result.interval.high !== null && result.interval.low >= 1 / (1 + tolerance)
    && result.interval.high <= 1 + tolerance;
  return { ...result, control: "A/A", qualified };
}

export function summarizePerformanceSamples(samples, { control = false } = {}) {
  if (!Array.isArray(samples) || !samples.length) throw Error("Missing performance samples");
  const workloads = [...new Set(samples.map(sample => sample.workload))], comparisons = [];
  for (const workload of workloads) {
    const before = new Map(), after = new Map();
    for (const sample of samples.filter(sample => sample.workload === workload)) {
      const map = sample.variant.startsWith("baseline") ? before : sample.variant.startsWith("candidate") ? after : null;
      if (!map || !Number.isSafeInteger(sample.trial) || map.has(sample.trial)) throw Error("Invalid or duplicate paired sample");
      map.set(sample.trial, sample);
    }
    if (!before.size || before.size !== after.size || [...before.keys()].some(key => !after.has(key))) throw Error("Unmatched paired samples");
    const phases = {};
    for (const [phase, tolerance] of Object.entries(PRIVACY_PERFORMANCE_POLICY.tolerances)) {
      const duration = sample => {
        const value = sample.timings?.find(timing => timing.phase === (phase === "startup_cold" ? "cold" : phase));
        if (!value) throw Error("Missing performance phase");
        return value.ms + (phase === "startup_cold" ? sample.load_ms : 0);
      };
      const pairs = [...before.keys()].sort((a, b) => a - b).map(trial => ({ before_ms: duration(before.get(trial)), after_ms: duration(after.get(trial)) }));
      phases[phase] = comparePerformancePairs(pairs, { tolerance, absoluteToleranceMs: PRIVACY_PERFORMANCE_POLICY.absolute_tolerances_ms[phase] });
    }
    const sequencePairs = [...before.keys()].map(trial => ({
      before_ms: before.get(trial).timings.reduce((sum, timing) => sum + timing.ms, 0),
      after_ms: after.get(trial).timings.reduce((sum, timing) => sum + timing.ms, 0),
    }));
    const sequence = comparePerformancePairs(sequencePairs, { tolerance: 0 });
    const qualified = !control || ["cold", "startup_cold"].every(phase => {
      const interval = phases[phase].interval;
      return interval.high !== null && interval.low >= 1 / 1.10 && interval.high <= 1.10;
    });
    comparisons.push({ workload, phases, sequence, ...(control ? { control: "A/A", qualified } : {}) });
  }
  return { policy: PRIVACY_PERFORMANCE_POLICY, comparisons,
    decision: control ? comparisons.every(row => row.qualified) ? "qualified" : "unqualified"
      : comparisons.some(row => Object.values(row.phases).some(phase => phase.decision === "regression")) ? "regression"
        : comparisons.every(row => Object.values(row.phases).every(phase => phase.decision === "pass")) ? "pass" : "inconclusive" };
}

export function applyPerformanceRepeatability(result, control) {
  if (control.decision !== "qualified") throw Error("Performance repeatability requires qualified A/A evidence");
  const comparisons = result.comparisons.map(row => {
    const reference = control.comparisons.find(value => value.workload === row.workload);
    if (!reference) throw Error("Missing matching A/A workload");
    const phases = Object.fromEntries(Object.entries(row.phases).map(([phase, value]) => {
      if (phase !== "hot" || value.decision === "pass") return [phase, value];
      const band = reference.phases[phase].interval;
      const qualified = band.high !== null && band.low <= 1 && band.high >= 1 && band.high <= 1.10;
      const equivalent = qualified && value.interval.high !== null && value.interval.high <= band.high;
      return [phase, { ...value, repeatability_upper: band.high, repeatability_qualified: qualified,
        decision: equivalent ? "equivalent" : value.decision }];
    }));
    return { ...row, phases };
  });
  return { ...result, comparisons,
    decision: comparisons.every(row => Object.values(row.phases).every(value => ["pass", "equivalent"].includes(value.decision))) ? "pass"
      : comparisons.some(row => Object.values(row.phases).some(value => value.decision === "regression")) ? "regression" : "inconclusive" };
}
