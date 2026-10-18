(() => {
  const el = id => document.getElementById(id);
  const label = (node, key, values = {}) => globalThis.ccdxLanguage.set(node, key, values);
  const titles = { overview: "overview", codex: "Codex", claude: "Claude", models: "model_services", usage: "usage_and_diagnostics", requests: "request_records", system: "system_and_settings" };
  let current = "overview", settings = null, settingsPending = false, stopped = false, timer = null, ticks = 0;
  let sourceDirty = false, reviewDirty = false, sourceModels = [], modelsPreference = null, sourceGeneration = 0, modelsSource = null;
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
  const states = { immediate: "effective_now", terminal_unavailable: "terminal_animation_unavailable_in_this_output_mode", next_start: "next_ccdx_start", next_call: "applies_to_new_calls", needs_setup: "setup_required",
    next_config_request: "next_configuration_request_cached_suggestions_may_remain", needs_app_relaunch: "reopen_the_client_to_finish", needs_service_restart: "restart_ccdx_to_finish" };
  const selectedSource = () => providerEntries.find(source => source.id === el("source-provider").value);
  const sourceReady = () => Boolean(selectedSource()) && (!selectedSource().selection.models_required || Boolean(modelsSource === selectedSource().id && el("source-model").value && el("source-review").value));
  const reviewLocked = () => selectedSource()?.id === "github" && settings?.providers?.github?.preference?.source === "environment";
  function syncReviewButton() {
    const sameSource = selectedSource()?.id === settings?.providers?.codex_provider;
    el("save-review").disabled = settingsPending || !sameSource || reviewLocked() || modelsSource !== selectedSource()?.id || !el("source-review").value;
    el("source-review").disabled = settingsPending || reviewLocked() || !sourceModels.length;
    el("source-review-effort").disabled = el("source-review").disabled;
    if (reviewLocked()) label(el("review-control-note"), "review_environment_override");
    else if (!sameSource) label(el("review-control-note"), "review_save_source_first");
  }
  function syncEfforts(chosen) {
    const model = sourceModels.find(model => model.id === el("source-review").value);
    const efforts = model?.auto_review_efforts || model?.reasoning_efforts || [];
    const follow = document.createElement("option");follow.value = "";label(follow, "follow_client");
    el("source-review-effort").replaceChildren(follow, ...efforts.map(effort => { const option = document.createElement("option");option.value = effort;option.textContent = effort;return option; }));
    el("source-review-effort").value = efforts.includes(chosen) ? chosen : "";
    syncReviewButton();
  }
  function syncSources() {
    const selector = el("source-provider"), selected = sourceDirty ? selector.value : settings?.providers?.codex_provider || selector.value;
    const entries = providerEntries.filter(source => source.selection?.codex);
    const signature = JSON.stringify(entries.map(source => [source.id, source.name]));
    if (selector.dataset.sources !== signature) {
      selector.replaceChildren(...entries.map(source => {
        const option = document.createElement("option");option.value = source.id;option.textContent = source.name;return option;
      }));selector.dataset.sources = signature;
    }
    if (entries.some(source => source.id === selected)) selector.value = selected;
    el("apply-source").disabled = settingsPending || !sourceReady();
    syncReviewButton();
  }
  window.addEventListener("ccdx:providers", () => { syncSources();if (current === "codex") void loadSourceModels(); });
  function applySettings(data) {
    settings = data;
    el("terminal-color-theme").value = data.color_theme || "green";
    el("terminal-color-theme").disabled = settingsPending;
    el("terminal-color-sample").dataset.terminalPalette = data.color_theme || "green";
    el("animation-settings").dataset.terminalPalette = data.color_theme || "green";
    label(el("terminal-color-note"), data.terminal?.mode !== "status"
      ? "terminal_theme_unavailable" : "terminal_theme_applied");
    for (const key of ["terminal_animation_enabled", "open_webui", "image_enabled", "prediction_enabled"]) {
      const input = el(`setting-${key}`), effective = data.effective[key];
      input.checked = data.saved[key];input.disabled = Boolean(effective.locked);
      label(el(`effect-${key}`), effective.state === "next_start" ? "saved_saved_state" : "saved_saved_effective_effective_state", {
        saved: { key: data.saved[key] ? "on" : "off" }, effective: { key: effective.value ? "on" : "off" },
        state: { key: effective.locked ? "controlled_by_environment" : states[effective.state] || effective.state } });
    }
    if (document.activeElement !== el("history-limit")) el("history-limit").value = data.history.maxBytes / 1048576;
    el("history-limit").disabled = data.history.source === "environment";
    el("save-history").disabled = data.history.source === "environment";
    label(el("effect-history"), data.history.source === "environment" ? "controlled_by_environment" : "applies_to_new_calls");
    label(el("settings-note"), "settings_read_from_the_running_service");
    el("page-settings-note").textContent = "";
    const state = data.providers;
    syncSources();
    if (current === "codex" && state && (modelsSource !== el("source-provider").value || !sourceDirty && !reviewDirty && modelsPreference !== JSON.stringify(state[el("source-provider").value]?.preference))) void loadSourceModels();
    el("m365-control-note").replaceChildren();
    if (state) {
      const source = document.createElement("span"), m365 = document.createElement("span");
      label(source, "codex_source_source", { source: providerEntries.find(entry => entry.id === state.codex_provider)?.name || state.codex_provider });
      const status = { ready: "ready", checking: "checking", disabled: "disabled", unsupported: "unsupported", idle: "unknown", unavailable: "unavailable" }[state.m365?.state] || "unknown";
      label(m365, "microsoft_365_state", { state: { key: status } });
      el("source-control-note").replaceChildren(source);el("m365-control-note").append(m365);
      if (state.m365?.reason) {
        const detail = document.createElement("details"), summary = document.createElement("summary"), code = document.createElement("code");
        label(summary, "message");code.textContent = state.m365.reason;detail.append(summary, code);el("m365-control-note").append(detail);
      }
    }
    el("process-notice").textContent = data.terminal?.last_notice || "";
  }
  async function loadSettings() {
    if (settingsPending) return;
    settingsPending = true;
    el("terminal-color-theme").disabled = true;
    try { applySettings(await api());settingsReadAt = new Date().toLocaleTimeString(); }
    catch (error) {
      for (const id of ["settings-note", "page-settings-note"]) {
        label(el(id), settingsReadAt ? "showing_previous_data_updated_time" : "could_not_read_settings", { time: settingsReadAt });
        el(id).title = error.message;
      }
    }
    finally { settingsPending = false;el("terminal-color-theme").disabled = !settings;el("apply-source").disabled = !sourceReady();syncReviewButton(); }
  }
  async function change(body, button) {
    if (settingsPending) return;
    settingsPending = true;
    const controls = [...document.querySelectorAll("[role=switch], #save-history, #clean-history, #fix-prediction, #apply-source, #save-review, #source-provider, #source-model, #source-review, #source-review-effort, #terminal-color-theme, #m365-on, #m365-off")];
    controls.forEach(input => { input.disabled = true; });
    label(el("settings-note"), "applying");
    if (button) button.setAttribute("aria-busy", "true");
    try {
      const data = await api(body);
      if (body.action === "provider" && body.operation === "switch") sourceDirty = false;
      if (body.action === "provider" && body.operation === "auto-review") reviewDirty = false;
      if (body.action === "provider" && body.operation === "off") { sourceDirty = false;reviewDirty = false; }
      el("review-control-note").textContent = "";
      applySettings(data);
      if (body.action !== "color_theme") { await dashboardRefresh.refresh("status", { force: true });await dashboardRefresh.refresh("auth", { force: true }); }
    }
    catch (error) {
      if (settings) applySettings(settings);
      if (body.action === "color_theme") { label(el("terminal-color-note"), "not_saved_error", { error: error.message });return; }
      el("settings-note").textContent = error.message;el("source-control-note").textContent = error.message;el("m365-control-note").textContent = error.message;el("review-control-note").textContent = error.message;el("effect-history").textContent = error.message;
      if (body.key) el(`effect-${body.key}`).textContent = error.message;
    } finally {
      settingsPending = false;controls.forEach(input => { input.disabled = false; });
      if (settings) for (const [key, value] of Object.entries(settings.effective)) if (value.locked) el(`setting-${key}`).disabled = true;
      if (settings?.history.source === "environment") el("save-history").disabled = true;
      el("apply-source").disabled = !sourceReady();el("source-model").disabled = !selectedSource()?.selection.models_required;syncReviewButton();
      button?.removeAttribute("aria-busy");
    }
  }
  for (const input of document.querySelectorAll("[role=switch]")) input.addEventListener("change", () => {
    void change({ action: "preference", key: input.id.slice("setting-".length), value: input.checked }, input);
  });
  el("terminal-color-theme").addEventListener("change", () => void change({ action: "color_theme", theme: el("terminal-color-theme").value }, el("terminal-color-theme")));
  el("save-history").addEventListener("click", () => void change({ action: "history_limit", mib: Number(el("history-limit").value) }, el("save-history")));
  el("clean-history").addEventListener("click", () => {
    if (window.confirm(globalThis.ccdxLanguage.format("clear_inactive_codex_conversation_data_older_continuation_ids_ma"))) void change({ action: "history_clean" }, el("clean-history"));
  });
  el("fix-prediction").addEventListener("click", () => void change({ action: "prediction_fix" }, el("fix-prediction")));
  for (const operation of ["on", "off"]) el(`m365-${operation}`).addEventListener("click", () => {
    if (operation === "off" && !window.confirm(globalThis.ccdxLanguage.format("confirm_disable_m365"))) return;
    void change({ action: "provider", operation }, el(`m365-${operation}`));
  });
  async function loadSourceModels() {
    const generation = ++sourceGeneration;
    const source = selectedSource(), needsModels = source?.selection.models_required;
    el("source-model-field").hidden = !needsModels;el("source-model-note").hidden = Boolean(needsModels);
    el("source-model").disabled = !needsModels;
    if (!source) { sourceModels = [];syncReviewButton();return; }
    const unsaved = (sourceDirty || reviewDirty) && modelsSource === source.id ? {
      model: el("source-model").value, auto_review_model: el("source-review").value, auto_review_effort: el("source-review-effort").value } : null;
    el("save-review").disabled = true;el("source-review").disabled = true;el("source-review-effort").disabled = true;
    el("apply-source").disabled = settingsPending || Boolean(needsModels);
    label(el("review-control-note"), "model_choices_loading");
    try {
      const response = await fetch(`/_ccdx/ui/models/live?provider=${encodeURIComponent(source.id)}`, { headers: { "X-CCDX-Dashboard": "1" }, cache: "no-store", signal: AbortSignal.timeout(15000) });
      const data = await response.json();if (!response.ok || !Array.isArray(data.models)) throw new Error(data.error || "Invalid model list");
      if (generation !== sourceGeneration) return;
      const models = data.models.filter(model => model.selectable && model.clients.includes("codex"));
      sourceModels = models;
      const preference = settings?.providers?.[source.id]?.preference;
      for (const [id, key] of [["source-model", "model"], ["source-review", "auto_review_model"]]) {
        el(id).replaceChildren(...models.map(model => { const option = document.createElement("option");option.value = model.id;option.textContent = model.id;return option; }));
        const saved = key === "auto_review_model" && source.id === "github" ? preference?.model : preference?.[key];
        const chosen = unsaved?.[key] || saved;
        if (chosen && models.some(model => model.id === chosen)) el(id).value = chosen;
      }
      modelsSource = source.id;modelsPreference = JSON.stringify(preference);
      const savedEffort = source.id === "github" ? preference?.reasoningEffort : preference?.auto_review_effort === undefined ? "low" : preference.auto_review_effort;
      el("review-control-note").textContent = "";
      syncEfforts(unsaved ? unsaved.auto_review_effort : savedEffort);
      el("apply-source").disabled = settingsPending || !sourceReady();
    } catch (error) {
      if (generation === sourceGeneration) {
        modelsSource = null;sourceModels = [];el("source-review").replaceChildren();el("source-review-effort").replaceChildren();
        el("review-control-note").textContent = error.message;el("apply-source").disabled = settingsPending || !sourceReady();
      }
    }
  }
  el("source-provider").addEventListener("change", () => { sourceDirty = true;reviewDirty = false;void loadSourceModels(); });
  el("source-model").addEventListener("change", () => { sourceDirty = true; });
  el("source-review").addEventListener("change", () => { reviewDirty = true;syncEfforts("low"); });
  el("source-review-effort").addEventListener("change", () => { reviewDirty = true; });
  el("apply-source").addEventListener("click", () => {
    const provider = el("source-provider").value;
    void change({ action: "provider", operation: "switch", provider, ...(selectedSource()?.selection.models_required ? {
      model: el("source-model").value, ...(settings?.providers?.codex_provider === provider ? {} : {
        auto_review_model: el("source-review").value, auto_review_effort: el("source-review-effort").value || null }) } : {}) }, el("apply-source"));
  });
  el("save-review").addEventListener("click", () => void change({ action: "provider", operation: "auto-review", provider: el("source-provider").value,
    model: el("source-review").value, auto_review_effort: el("source-review-effort").value || null }, el("save-review")));
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
