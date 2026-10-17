// Only the optional bridge is supervised. Model/image traffic, App processes,
// global proxy settings and certificate trust are never changed here.
export function supervisePrediction({ native, restart, state, warning = () => {},
  intervalMs = 30_000, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  let current = native, closed = false, flight = null, attempts = 0, retryAt = 0;
  const delays = [30_000, 60_000, 120_000];
  async function check() {
    if (closed || flight || !current || current.enabled?.() === false || attempts >= delays.length || now() < retryAt) return;
    if (current.healthy()) { state?.checked();return; }
    const attempt = ++attempts;
    retryAt = now() + delays[attempt - 1];
    state?.recovering(attempt);
    flight = (async () => {
      try {
        await current.close();
        if (closed) return;
        const resumed = await restart();
        if (closed) { await resumed?.close();return; }
        if (!resumed || resumed.pacUrl !== native.pacUrl) {
          await resumed?.close();throw new Error("Prediction recovery did not retain the original route");
        }
        current = resumed;state?.recovered();
        warning("Prediction bridge recovered on its original port; App restart was not requested");
      } catch (error) {
        state?.unavailable(error);
        warning(`Prediction bridge recovery ${attempt}/${delays.length} failed: ${error.message}. Core service remains available`);
      }
    })();
    try { await flight; } finally { flight = null; }
  }
  const timer = setIntervalImpl(() => { void check().catch(error => state?.unavailable(error)); }, intervalMs);
  timer.unref?.();
  return {
    ...native,
    check,
    healthy() { return !closed && current.healthy(); },
    enabled() { return !closed && current.enabled?.() !== false; },
    setActive(value) { return !closed && (current.setActive?.(value) ?? false); },
    appCurrent() { return current.appCurrent?.() !== false; },
    inspectEnvironment() { return current.inspectEnvironment?.(); },
    routeProcessId() { return current.routeProcessId?.(); },
    inspectRoute() { return current.inspectRoute?.(); },
    prepareRoute() { return current.prepareRoute?.(); },
    async close() { closed = true;clearIntervalImpl(timer);await flight;await current?.close(); },
  };
}
