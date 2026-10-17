(() => {
  const el = id => document.getElementById(id);
  const label = (node, key, values = {}) => globalThis.ccdxLanguage.set(node, key, values);
  const titles = { overview: "Overview", codex: "Codex", claude: "Claude", models: "Model services", usage: "Usage and diagnostics", system: "System and settings" };
  let current = "overview", settings = null, settingsPending = false, stopped = false, timer = null, ticks = 0;
  let sourceDirty = false, sourceGeneration = 0;
  let settingsReadAt = null;
  function navigate() {
    const route = location.hash.slice(1), next = Object.hasOwn(titles, route) ? route : "overview";
    current = next;
    for (const view of document.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== next;
    for (const item of document.querySelectorAll("[data-route]")) {
      if (item.dataset.route === next) item.setAttribute("aria-current", "page");else item.removeAttribute("aria-current");
    }
    label(el("page-title"), titles[next]);
    if (["codex", "models", "system"].includes(next)) void loadSettings();
    if (next === "models") { void dashboardRefresh.refresh("models");void dashboardRefresh.refresh("auth"); }
    if (next === "usage") void dashboardRefresh.refresh("usage");
    if (next === "system") void dashboardRefresh.refresh("animation");
    syncAnimationPreview();
  }
  async function api(body) {
    const response = await fetch("/_ccdx/ui/settings", { method: body ? "POST" : "GET", cache: "no-store",
      headers: { "X-CCDX-Dashboard": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await response.json();if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);return data;
  }
  const states = { immediate: "Effective now", terminal_unavailable: "Terminal animation unavailable in this output mode", next_start: "Next CCDX start", next_call: "Applies to new calls", needs_setup: "Setup required",
    next_config_request: "Next configuration request; cached suggestions may remain", needs_app_relaunch: "Reopen the client to finish", needs_service_restart: "Restart CCDX to finish" };
  function applySettings(data) {
    settings = data;
    for (const key of ["terminal_animation_enabled", "open_webui", "image_enabled", "prediction_enabled"]) {
      const input = el(`setting-${key}`), effective = data.effective[key];
      input.checked = data.saved[key];input.disabled = Boolean(effective.locked);
      label(el(`effect-${key}`), "Saved {saved} / effective {effective} / {state}", {
        saved: { key: data.saved[key] ? "On" : "Off" }, effective: { key: effective.value ? "On" : "Off" },
        state: { key: effective.locked ? "Controlled by environment" : states[effective.state] || effective.state } });
    }
    if (document.activeElement !== el("history-limit")) el("history-limit").value = data.history.maxBytes / 1048576;
    el("history-limit").disabled = data.history.source === "environment";
    el("save-history").disabled = data.history.source === "environment";
    label(el("effect-history"), data.history.source === "environment" ? "Controlled by environment" : "Applies to new calls");
    label(el("settings-note"), "Settings read from the running service.");
    el("page-settings-note").textContent = "";
    const state = data.providers;
    if (state && !sourceDirty && el("source-provider").value !== state.codex_provider) {
      el("source-provider").value = state.codex_provider;void loadSourceModels();
    }
    el("source-control-note").textContent = state ? `Codex → ${state.codex_provider} / Microsoft 365: ${state.m365.state}${state.m365.reason ? ` / ${state.m365.reason}` : ""}` : "—";
    el("process-notice").textContent = data.terminal?.last_notice || "";
  }
  async function loadSettings() {
    if (settingsPending) return;
    settingsPending = true;
    try { applySettings(await api());settingsReadAt = new Date().toLocaleTimeString(); }
    catch (error) {
      const detail = `${error.message}${settingsReadAt ? ` / ${settingsReadAt}` : ""}`;
      el("settings-note").textContent = detail;el("page-settings-note").textContent = detail;
    }
    finally { settingsPending = false; }
  }
  async function change(body, button) {
    if (settingsPending) return;
    settingsPending = true;
    const controls = [...document.querySelectorAll("[role=switch], #save-history, #clean-history, #fix-prediction, #apply-source, #m365-on, #m365-off")];
    controls.forEach(input => { input.disabled = true; });
    label(el("settings-note"), "Applying…");
    if (button) button.setAttribute("aria-busy", "true");
    try {
      const data = await api(body);if (body.action === "provider" && body.operation === "switch") sourceDirty = false;
      applySettings(data);await dashboardRefresh.refresh("status", { force: true });await dashboardRefresh.refresh("auth", { force: true });
    }
    catch (error) {
      if (settings) applySettings(settings);
      el("settings-note").textContent = error.message;el("source-control-note").textContent = error.message;el("effect-history").textContent = error.message;
      if (body.key) el(`effect-${body.key}`).textContent = error.message;
    } finally {
      settingsPending = false;controls.forEach(input => { input.disabled = false; });
      if (settings) for (const [key, value] of Object.entries(settings.effective)) if (value.locked) el(`setting-${key}`).disabled = true;
      if (settings?.history.source === "environment") el("save-history").disabled = true;
      if (el("source-provider").value === "m365") el("apply-source").disabled = !el("source-model").value || !el("source-review").value;
      button?.removeAttribute("aria-busy");
    }
  }
  for (const input of document.querySelectorAll("[role=switch]")) input.addEventListener("change", () => {
    void change({ action: "preference", key: input.id.slice("setting-".length), value: input.checked }, input);
  });
  el("save-history").addEventListener("click", () => void change({ action: "history_limit", mib: Number(el("history-limit").value) }, el("save-history")));
  el("clean-history").addEventListener("click", () => {
    if (window.confirm(globalThis.ccdxLanguage.format("Clear inactive Codex conversation data? Older continuation IDs may stop working."))) void change({ action: "history_clean" }, el("clean-history"));
  });
  el("fix-prediction").addEventListener("click", () => void change({ action: "prediction_fix" }, el("fix-prediction")));
  for (const operation of ["on", "off"]) el(`m365-${operation}`).addEventListener("click", () => void change({ action: "provider", operation }, el(`m365-${operation}`)));
  async function loadSourceModels() {
    const generation = ++sourceGeneration;
    const m365 = el("source-provider").value === "m365";
    el("source-model").disabled = el("source-review").disabled = !m365;
    if (!m365) { el("apply-source").disabled = settingsPending;return; }
    el("apply-source").disabled = true;
    el("source-model").replaceChildren();el("source-review").replaceChildren();
    try {
      const response = await fetch("/_ccdx/ui/models/live?provider=m365", { headers: { "X-CCDX-Dashboard": "1" }, cache: "no-store", signal: AbortSignal.timeout(15000) });
      const data = await response.json();if (!response.ok) throw new Error(data.error);
      if (generation !== sourceGeneration) return;
      const models = data.models.filter(model => model.selectable && model.clients.includes("codex"));
      for (const [id, list] of [["source-model", models], ["source-review", models.filter(model => model.reasoning_efforts?.includes("low"))]]) {
        el(id).replaceChildren(...list.map(model => { const option = document.createElement("option");option.value = model.id;option.textContent = model.id;return option; }));
        const saved = settings?.providers?.m365?.preference?.[id === "source-model" ? "model" : "auto_review_model"];
        if (!sourceDirty && saved && list.some(model => model.id === saved)) el(id).value = saved;
      }
      el("apply-source").disabled = !el("source-model").value || !el("source-review").value;
    } catch (error) { if (generation === sourceGeneration) el("source-control-note").textContent = error.message; }
  }
  el("source-provider").addEventListener("change", () => { sourceDirty = true;void loadSourceModels(); });
  for (const id of ["source-model", "source-review"]) el(id).addEventListener("change", () => { sourceDirty = true; });
  el("apply-source").addEventListener("click", () => {
    const provider = el("source-provider").value;
    void change({ action: "provider", operation: "switch", provider, ...(provider === "m365" ? { model: el("source-model").value, auto_review_model: el("source-review").value } : {}) }, el("apply-source"));
  });
  // Only the small in-memory status snapshot is read at this cadence. Catalogs
  // and retained usage keep their existing on-demand, bounded refresh policy.
  function schedule() {
    clearTimeout(timer);if (stopped) return;
    timer = setTimeout(async () => {
      if (document.visibilityState === "visible" && dashboardRefresh.automatic) {
        await dashboardRefresh.refresh("status", { force: true });
        if (++ticks % 8 === 0) {
          await dashboardRefresh.refresh("auth", { force: true });
          if (["codex", "models", "system"].includes(current)) await loadSettings();
        }
      }
      schedule();
    }, 2000);
  }
  window.addEventListener("hashchange", navigate);
  el("refresh").addEventListener("click", () => { if (["codex", "models", "system"].includes(current)) void loadSettings(); });
  window.addEventListener("pagehide", () => { stopped = true;clearTimeout(timer); });
  window.addEventListener("pageshow", () => { stopped = false;schedule(); });
  el("open-animation").addEventListener("click", () => { location.hash = "system";navigate(); });
  navigate();schedule();
})();
