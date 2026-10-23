(() => {
  const el = id => document.getElementById(id);
  const label = (node, key, values = {}) => globalThis.ccdxLanguage.set(node, key, values);
  const titles = { overview: "overview", codex: "Codex", claude: "Claude", models: "model_services", usage: "usage_and_diagnostics", requests: "request_records", checks: "tools_checks_title", system: "system_and_settings" };
  const settingsViews = ["codex", "models", "system", "checks"];
  let current = "overview", settings = null, settingsPending = false, stopped = false, timer = null, ticks = 0;
  let sourceDirty = false, reviewDirty = false, sourceModels = [], modelsPreference = null, sourceGeneration = 0, modelsSource = null;
  let settingsReadAt = null;
  let accountsPending = false;
  const accountReasons = new Set(["m365_account_ambiguous", "m365_account_unavailable", "m365_account_conflict", "m365_interaction_required", "m365_llm_permission_unavailable", "m365_account_busy", "m365_account_selection_stale"]);
  function syncAccountControls() {
    el("m365-accounts-refresh").disabled = accountsPending || settingsPending;
    el("m365-account-choice").disabled = accountsPending || settingsPending;
    el("m365-account-apply").disabled = accountsPending || settingsPending || !el("m365-account-choice").value || !settings?.providers?.m365?.enabled;
  }
  async function loadAccounts() {
    if (accountsPending || settingsPending) return;
    accountsPending = true;syncAccountControls();label(el("m365-account-note"), "checking");
    try {
      const response = await fetch("/_ccdx/ui/m365/accounts", { headers: { "X-CCDX-Dashboard": "1" }, cache: "no-store", signal: AbortSignal.timeout(30000) });
      const data = await response.json();if (!response.ok || !Array.isArray(data.accounts)) throw Object.assign(new Error("Account discovery failed"), { code: data.code });
      const previous = el("m365-account-choice").value;
      const placeholder = document.createElement("option");placeholder.value = "";label(placeholder, "choose_company_account");
      el("m365-account-choice").replaceChildren(placeholder, ...data.accounts.map(account => {
        const option = document.createElement("option");option.value = account.id;
        option.textContent = `${account.login} / ${account.tenant}`;return option;
      }));
      const selected = data.accounts.find(account => account.id === previous) || data.accounts.find(account => account.selected) || data.accounts.find(account => account.current_windows);
      el("m365-account-choice").value = selected?.id || "";
      el("m365-account-form").hidden = !data.accounts.length;
      label(el("m365-account-note"), data.accounts.length ? "company_account_choose" : "company_account_empty");
    } catch (error) { el("m365-account-form").hidden = true;label(el("m365-account-note"), accountReasons.has(error.code) ? error.code : "company_account_check_failed"); }
    finally { accountsPending = false;syncAccountControls(); }
  }
  el("m365-accounts-refresh").addEventListener("click", () => void loadAccounts());
  el("m365-account-choice").addEventListener("change", syncAccountControls);
  el("m365-account-apply").addEventListener("click", () => {
    if (settings?.providers?.m365?.account && !window.confirm(globalThis.ccdxLanguage.format("company_account_confirm"))) return;
    void change({ action: "provider", operation: "account", account_id: el("m365-account-choice").value }, el("m365-account-apply"));
  });
  function navigate() {
    const route = location.hash.slice(1), next = Object.hasOwn(titles, route) ? route : "overview";
    current = next;
    if (next !== "codex") sourceGeneration++;
    if (!["codex", "models"].includes(next) && dashboardRefresh.state("models").pending) dashboardRefresh.invalidate("models");
    for (const view of document.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== next;
    globalThis.ccdxDashboardActivity?.visibilityChanged();
    globalThis.ccdxDashboardFlow?.visibilityChanged();
    for (const item of document.querySelectorAll("[data-route]")) {
      if (item.dataset.route === next) item.setAttribute("aria-current", "page");else item.removeAttribute("aria-current");
    }
    label(el("page-title"), titles[next]);
    el("page-settings-note").textContent = "";
    window.scrollTo(0, 0);
    el("main-content").focus({ preventScroll: true });
    if (settingsViews.includes(next)) void loadSettings();
    if (next === "models") { void refreshCatalog();void dashboardRefresh.refresh("auth"); }
    if (next === "usage") { void dashboardRefresh.refresh("usage");usageView.revealChart(); } else usageView.stopMotion();
    if (next === "requests") renderContext();
    if (next === "system") { void dashboardRefresh.refresh("animation");void dashboardRefresh.refresh("updates"); }
    syncAnimationPreview();
  }
  async function api(body) {
    const response = await fetch("/_ccdx/ui/settings", { method: body ? "POST" : "GET", cache: "no-store",
      headers: { "X-CCDX-Dashboard": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body?.operation === "account" ? 65000 : 15000) });
    const data = await response.json();if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { code: data.code });return data;
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
      label(el(`effect-${key}`), data.saved[key] === effective.value && !effective.locked ? "preference_effect" : "saved_saved_effective_effective_state", {
        saved: { key: data.saved[key] ? "on" : "off" }, effective: { key: effective.value ? "on" : "off" },
        state: { key: effective.locked ? "controlled_by_environment" : states[effective.state] || effective.state } });
    }
    if (document.activeElement !== el("history-limit")) el("history-limit").value = data.history.maxBytes / 1048576;
    el("history-limit").disabled = data.history.source === "environment";
    el("save-history").disabled = data.history.source === "environment";
    label(el("effect-history"), data.history.source === "environment" ? "controlled_by_environment" : "applies_to_new_calls");
    el("settings-note").textContent = "";
    el("page-settings-note").textContent = "";
    const state = data.providers;
    el("m365-enabled").checked = state?.m365?.enabled === true;
    el("m365-enabled").disabled = settingsPending;
    label(el("m365-source-effect"), state?.m365?.enabled ? "enabled" : "disabled");
    const account = state?.m365?.account;
    el("m365-account-name").textContent = account?.login || "—";
    const sourceState = state?.m365;
    globalThis.ccdxIcons.set(el("m365-signin-state"), sourceState?.token_cached ? "authorized" : !sourceState?.enabled ? "disabled" : "tools_not_checked",
      sourceState?.token_cached ? "ok" : "unknown");
    const catalogFailed = Boolean(sourceState?.catalog_diagnostic) || sourceState?.state === "unavailable";
    globalThis.ccdxIcons.set(el("m365-catalog-state"), catalogFailed ? "live_lookup_failed" : sourceState?.models?.refreshed_at ? sourceState.models.source === "cache" ? "catalog_snapshot" : "live_snapshot" : "tools_not_checked",
      catalogFailed ? "warning" : sourceState?.models?.refreshed_at ? "ok" : "unknown");
    const last = Object.values(sourceState?.claude?.observed_clients || {}).filter(value => typeof value === "string").sort().at(-1);
    el("m365-last-request").textContent = last ? time(last) : "—";
    if (account) label(el("m365-account-current"), "company_account_current", { login: account.login, tenant: account.tenant || "—", source: { key: `account_source_${account.selection_source || "legacy"}` } });
    else label(el("m365-account-current"), "company_account_none");
    if (accountReasons.has(state?.m365?.reason)) label(el("m365-account-note"), state.m365.reason);
    syncAccountControls();
    syncSources();
    if (current === "codex" && state && (modelsSource !== el("source-provider").value || !sourceDirty && !reviewDirty && modelsPreference !== JSON.stringify(state[el("source-provider").value]?.preference))) void loadSourceModels();
    el("m365-control-note").replaceChildren();
    if (state) {
      const source = document.createElement("span"), m365 = document.createElement("span");
      label(source, "codex_source_source", { source: providerEntries.find(entry => entry.id === state.codex_provider)?.name || state.codex_provider });
      const status = { ready: "ready", checking: "checking", disabled: "disabled", unsupported: "unsupported", idle: "unknown", unavailable: "unavailable" }[state.m365?.state] || "unknown";
      label(m365, "microsoft_365_state", { state: { key: status } });
      el("source-control-note").replaceChildren(source);el("m365-control-note").append(m365);
      if (state.m365?.catalog_diagnostic) {
        const cause = document.createElement("p");label(cause, `catalog_cause_${state.m365.catalog_diagnostic.cause_code}`);el("m365-control-note").append(cause);
      }
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
    syncAccountControls();
    try { applySettings(await api());settingsReadAt = time(Date.now()); }
    catch (error) {
      for (const id of ["settings-note", ...(settingsViews.includes(current) ? ["page-settings-note"] : [])]) {
        label(el(id), settingsReadAt ? "showing_previous_data_updated_time" : "could_not_read_settings", { time: settingsReadAt });
        el(id).title = error.message;
      }
    }
    finally { settingsPending = false;el("m365-enabled").disabled = !settings;el("terminal-color-theme").disabled = !settings;el("apply-source").disabled = !sourceReady();syncReviewButton();syncAccountControls(); }
  }
  async function change(body, button) {
    if (settingsPending) return;
    settingsPending = true;
    syncAccountControls();
    const controls = [...document.querySelectorAll("[role=switch], #save-history, #clean-history, #fix-prediction, #apply-source, #save-review, #source-provider, #source-model, #source-review, #source-review-effort, #terminal-color-theme, #m365-enabled")];
    controls.forEach(input => { input.disabled = true; });
    const note = el(body.key ? `effect-${body.key}` : body.action === "color_theme" ? "terminal-color-note"
      : body.action.startsWith("history_") ? "effect-history" : body.action === "prediction_fix" ? "prediction-note"
        : body.operation === "switch" ? "source-control-note" : body.operation === "auto-review" ? "review-control-note"
          : body.operation === "account" ? "m365-account-note" : "m365-control-note");
    const initialSourceSave = body.operation === "switch" && Boolean(body.auto_review_model);
    label(note, "applying");
    if (button) button.setAttribute("aria-busy", "true");
    try {
      const data = await api(body);
      if (body.action === "provider" && body.operation === "switch") sourceDirty = false;
      if (body.action === "provider" && body.operation === "auto-review") reviewDirty = false;
      if (body.action === "provider" && body.operation === "off") { sourceDirty = false;reviewDirty = false; }
      el("review-control-note").textContent = "";
      applySettings(data);
      if (initialSourceSave) label(el("source-control-note"), "source_initial_review_saved");
      if (body.operation === "account") {
        sourceDirty = false;reviewDirty = false;sourceGeneration++;
        modelsPreference = null;modelsSource = null;
        dashboardRefresh.invalidate("models", { clear: true });
        label(el("m365-account-note"), "company_account_checked");
      }
      if (body.action !== "color_theme") { await dashboardRefresh.refresh("status", { force: true });await dashboardRefresh.refresh("auth", { force: true }); }
    }
    catch (error) {
      if (settings) applySettings(settings);
      if (body.operation === "account") { label(el("m365-account-note"), "company_account_not_saved", { reason: { key: accountReasons.has(error.code) ? error.code : error.message } });return; }
      if (body.action === "color_theme") { label(el("terminal-color-note"), "not_saved_error", { error: error.message });return; }
      note.textContent = error.message;
    } finally {
      settingsPending = false;controls.forEach(input => { input.disabled = false; });
      syncAccountControls();
      if (settings) for (const [key, value] of Object.entries(settings.effective)) if (value.locked) el(`setting-${key}`).disabled = true;
      if (settings?.history.source === "environment") el("save-history").disabled = true;
      el("apply-source").disabled = !sourceReady();el("source-model").disabled = !selectedSource()?.selection.models_required;syncReviewButton();
      button?.removeAttribute("aria-busy");
    }
  }
  for (const input of document.querySelectorAll('[role=switch][id^="setting-"]')) input.addEventListener("change", () => {
    void change({ action: "preference", key: input.id.slice("setting-".length), value: input.checked }, input);
  });
  el("terminal-color-theme").addEventListener("change", () => void change({ action: "color_theme", theme: el("terminal-color-theme").value }, el("terminal-color-theme")));
  el("save-history").addEventListener("click", () => void change({ action: "history_limit", mib: Number(el("history-limit").value) }, el("save-history")));
  el("clean-history").addEventListener("click", () => {
    if (window.confirm(globalThis.ccdxLanguage.format("clear_inactive_codex_conversation_data_older_continuation_ids_ma"))) void change({ action: "history_clean" }, el("clean-history"));
  });
  el("fix-prediction").addEventListener("click", () => void change({ action: "prediction_fix" }, el("fix-prediction")));
  el("m365-enabled").addEventListener("change", () => {
    const operation = el("m365-enabled").checked ? "on" : "off";
    if (operation === "off" && !window.confirm(globalThis.ccdxLanguage.format("confirm_disable_m365"))) {
      el("m365-enabled").checked = settings?.providers?.m365?.enabled === true;return;
    }
    void change({ action: "provider", operation }, el("m365-enabled"));
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
      const data = await readModelCatalog(source.id);
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
          if (settingsViews.includes(current)) await loadSettings();
        }
      }
      schedule();
    }, 2000);
  }
  window.addEventListener("hashchange", navigate);
  el("refresh").addEventListener("click", () => { if (settingsViews.includes(current)) void loadSettings(); });
  window.addEventListener("pagehide", () => { stopped = true;clearTimeout(timer); });
  window.addEventListener("pageshow", () => { stopped = false;schedule(); });
  navigate();schedule();
})();
