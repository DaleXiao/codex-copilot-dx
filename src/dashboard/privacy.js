(() => {
  const el = id => document.getElementById(id), root = el("privacy-settings");if (!root) return;
  const words = (id, key, values) => globalThis.ccdxLanguage.set(el(id), key, values);
  let state = null, pending = false, timer, pushed = 0;
  const visible = () => !root.closest("[hidden]") && document.visibilityState === "visible";
  function apply(value) {
    const previous = state?.revision;state = value;render();
    if (value.preferences || previous && previous !== state.revision) document.dispatchEvent(new CustomEvent("ccdx:privacy-preferences", { detail: value.preferences ? { preferences: value.preferences } : null }));
  }
  async function request(input) {
    const response = await fetch("/_ccdx/ui/privacy", { method: input ? "POST" : "GET", headers: { "X-CCDX-Dashboard": "1", ...(input ? { "Content-Type": "application/json" } : {}) }, body: input ? JSON.stringify(input) : undefined, signal: AbortSignal.timeout(20000) });
    const data = await response.json();if (!response.ok) throw Object.assign(Error(), { code: data.code });return data;
  }
  function render() {
    if (!state) return;
    const busy = pending || state.action_pending || ["downloading", "loading"].includes(state.state);
    el("privacy-enabled").checked = state.enabled;el("privacy-enabled").disabled = pending || busy && !state.enabled;
    el("privacy-personal").checked = state.personal;el("privacy-personal").disabled = busy;
    el("privacy-options").hidden = !state.enabled || state.state !== "ready";
    el("privacy-cancel").hidden = !busy;el("privacy-cancel").disabled = pending;
    el("privacy-retry").hidden = state.state !== "error" && !state.error;el("privacy-retry").disabled = pending;
    el("privacy-remove").hidden = busy || state.state === "not_downloaded";el("privacy-remove").disabled = pending;
    const status = ["downloading", "loading", "error"].includes(state.state) ? state.state : state.enabled ? state.state === "ready" ? state.pending_checks ? "checking" : "ready" : "error" : state.state === "installed" || state.state === "ready" ? "installed" : "off";
    words("privacy-status", `privacy_state_${status}`, { percent: Math.min(100, Math.round((state.downloaded_bytes || 0) * 100 / Math.max(1, state.download_bytes))) });
    el("privacy-device").textContent = state.backend || "";
    if (state.error) words("privacy-error", state.error.includes("download") ? "privacy_download_error" : "privacy_error");
    else { el("privacy-error").textContent = "";el("privacy-error").removeAttribute("data-i18n"); }
    clearTimeout(timer);
    if (busy && visible()) timer = setTimeout(() => { if (Date.now() - pushed > 2500) void load();else render(); }, 3000);
  }
  async function load() {
    if (!visible() || pending) return;
    try { apply(await request()); } catch { words("privacy-error", "privacy_error"); }
  }
  async function act(action, extra = {}) {
    if (!state || pending) return;
    pending = true;render();
    try { apply(await request({ action, revision: state.revision, ...extra })); }
    catch (error) { words("privacy-error", error.code === "ccdx_privacy_settings_changed" ? "privacy_changed" : "privacy_error");await load(); }
    finally { pending = false;render(); }
  }
  function enable() { el("privacy-dialog").showModal(); }
  el("privacy-enabled").addEventListener("change", () => {
    if (el("privacy-enabled").checked) { el("privacy-enabled").checked = false;enable(); }
    else void act("disable");
  });
  el("privacy-personal").addEventListener("change", () => void act("personal", { personal: el("privacy-personal").checked }));
  el("privacy-dialog-cancel").addEventListener("click", () => el("privacy-dialog").close());
  el("privacy-dialog-confirm").addEventListener("click", () => { el("privacy-dialog").close();void act("enable"); });
  el("privacy-cancel").addEventListener("click", () => void act("disable"));
  el("privacy-retry").addEventListener("click", () => void act("enable"));
  el("privacy-remove").addEventListener("click", () => void act("remove"));
  el("privacy-preview").addEventListener("click", async () => {
    const trigger = el("privacy-preview");trigger.disabled = true;el("privacy-result").hidden = true;
    try {
      const result = await request({ action: "try", text: el("privacy-text").value });
      el("privacy-result").textContent = result.text;el("privacy-result").hidden = false;
      words("privacy-preview-count", "privacy_result", { count: result.count, ms: result.elapsed_ms });
    } catch { words("privacy-preview-count", "privacy_preview_error"); }
    finally { trigger.disabled = false; }
  });
  document.addEventListener("visibilitychange", () => { clearTimeout(timer);if (visible()) void load(); });
  window.addEventListener("hashchange", () => { clearTimeout(timer);if (visible()) void load(); });
  el("refresh").addEventListener("click", () => void load());
  globalThis.ccdxPrivacy = { sync(value) { if (!value || !visible()) return;pushed = Date.now();apply(value); } };
  void load();
})();
