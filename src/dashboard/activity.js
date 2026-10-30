(() => {
  const node = document.getElementById("model-activity"), label = document.getElementById("model-activity-label");
  let signature, expiry = null, deadline = 0;
  function show(active) {
    const state = Number.isSafeInteger(active) && active >= 0 ? active > 0 ? "active" : "idle" : "unknown";
    const next = `${state}:${active}`;
    if (next === signature) return;
    signature = next;node.dataset.state = state;
    const key = state === "active" ? "model_activity_active" : state === "idle" ? "model_activity_idle" : "model_activity_unknown";
    globalThis.ccdxLanguage.set(node, key, { count: active }, "aria-label");
    label.hidden = state === "idle";
    globalThis.ccdxLanguage.set(label, key, { count: active });
  }
  function pause() {
    if (deadline && Date.now() >= deadline) unavailable();
    node.dataset.paused = String(document.visibilityState !== "visible" || Boolean(node.closest("[hidden]")));
  }
  document.addEventListener("visibilitychange", pause);
  globalThis.addEventListener("pagehide", () => { node.dataset.paused = "true"; });
  globalThis.addEventListener("pageshow", pause);
  function unavailable() { clearTimeout(expiry);expiry = null;deadline = 0;show(null); }
  globalThis.ccdxDashboardActivity = {
    update(data, { live = false } = {}) { clearTimeout(expiry);show(data?.active);deadline = live ? 0 : Date.now() + 6000;expiry = live ? null : setTimeout(unavailable, 6000); },
    unavailable, visibilityChanged: pause,
  };
  pause();
})();
