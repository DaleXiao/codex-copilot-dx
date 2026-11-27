(() => {
  function create({ element: el, change, localize, isBusy = () => false, isMutating = isBusy }) {
    let data, pending = false, sequence = 0, confirmation = null, claudeApp = true, note = null, autoError = false, antigravityCatalogPending = false;
    const route = () => ({ codex: "codex", claude: claudeApp ? "claude_app" : null, gemini: "antigravity" })[location.hash.slice(1)] || null;
    const label = (id, key) => localize(el(id), key);
    const needsReload = state => state?.needs_reload || route() === "antigravity" && antigravityCatalogPending;
    const buttonKey = state => state?.status === "running" ? needsReload(state) ? "application_reopen" : "application_focus"
      : state?.status === "starting" ? "application_opening" : state?.status === "stopped" ? "application_open" : "application_check";
    function render() {
      const id = route(), state = data?.applications?.[id];
      el("application-launch").hidden = !id;
      el("application-launch-options").hidden = id !== "antigravity";
      for (const option of ["antigravity-open-google", "antigravity-open-gateway"]) el(option).disabled = pending || isBusy();
      el("page-title").closest(".intro").classList.toggle("has-application-launch", Boolean(id));
      el("application-reopen-confirm").hidden = !confirmation || confirmation.id !== id;
      el("application-reopen-apply").disabled = pending || isBusy();
      if (!id) return;
      label("application-open-label", buttonKey(state));
      el("application-open").disabled = pending || isBusy() || ["starting", "unsupported", "not_installed", "multiple"].includes(state?.status);
      el("application-open").setAttribute("aria-busy", String(pending || isBusy() || state?.status === "starting"));
      label("application-state", note || (state?.status === "running" ? needsReload(state) ? id === "antigravity" ? "gemini_settings_saved" : "application_reload_pending" :
        state.launch_mode === "gateway" ? state.connection === "observed" ? "antigravity_gateway_connected" : "antigravity_gateway_pending" :
        state.connection === "observed" ? "application_connected" : "application_pending"
        : state?.status === "stopped" ? "application_stopped" : state?.status === "starting" ? "application_opening" : "application_" + (state?.status || "unknown")));
      if (!pending) {
        el("codex-auto-launch").checked = data?.effective?.codex_auto_launch?.value === true;
        el("codex-auto-launch").disabled = isBusy() || data?.effective?.codex_auto_launch?.locked === true || !data;
        label("codex-auto-launch-note", autoError ? "application_preference_failed" : data?.effective?.codex_auto_launch?.locked ? "controlled_by_environment" : "next_ccdx_start");
      }
      window.dispatchEvent(new CustomEvent("ccdx:application-state", { detail: { id, application: state, pending: pending || isMutating() } }));
    }
    function sync(next) {
      const applications = { ...next.applications };
      for (const [id, state] of Object.entries(data?.applications || {})) if ((state.inspection || 0) > (applications[id]?.inspection || 0)) applications[id] = state;
      data = { ...next, applications };render();
    }
    async function check(fresh = false) {
      const id = route();if (!id || pending) return;
      const version = ++sequence;
      try {
        const response = await fetch(`/_ccdx/ui/settings?application=${id}${fresh ? "&fresh=1" : ""}`, { cache: "no-store", headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(15000) });
        const next = await response.json();if (!response.ok) throw Error("check failed");
        if (version !== sequence || route() !== id) return;
        note = null;sync({ ...data, applications: next.applications });
      } catch { if (version === sequence) { note = "application_unknown";render(); } }
    }
    async function act(operation, expected, mode) {
      const id = route();if (!id || pending) return;
      pending = true;confirmation = null;note = null;sequence++;render();
      try {
        const restart = operation === "restart" ? { confirmed: true, expected_pid: expected.pid, expected_started: expected.started } : {};
        let result;
        if (id === "antigravity" && (operation === "open" || operation === "restart")) {
          const response = await fetch("/_ccdx/ui/gemini", { method: "POST", headers: { "Content-Type": "application/json", "X-CCDX-Dashboard": "1" },
            body: JSON.stringify({ action: "web-" + operation, ...(mode ? { launch_mode: mode } : {}), ...restart }), signal: AbortSignal.timeout(55000) });
          if (!response.ok) throw Error("Antigravity launch failed");
          result = (await response.json()).last_operation;
          if (result?.app) data = { ...data, applications: { ...data?.applications, antigravity: result.app } };
          if (result?.status === "launch_choice_required") el("application-launch-options").open = true;
          else if (["opened", "focused"].includes(result?.status)) el("application-launch-options").open = false;
        } else {
          const next = await change({ action: "application", id, operation, ...restart }, el("application-open"), { quiet: true });
          if (!next) { note = "application_action_failed";return; }
          data = next;
          result = next.last_operation?.feature === "application" ? next.last_operation.result : null;
        }
        if (["opened", "opening"].includes(result?.status)) for (const delay of [1000, 10500]) setTimeout(() => { if (route() === id && document.visibilityState === "visible") {
          void check(true);if (id === "antigravity") void globalThis.ccdxAntigravity?.refreshStatus();
        } }, delay);
        if (result && !["opened", "opening", "focused", "checked"].includes(result.status)) {
          const direct = { unknown: "application_unknown", app_check_failed: "application_unknown", not_installed: "application_not_installed", multiple: "application_multiple", multiple_apps: "application_multiple", unsupported: "application_unsupported", app_not_running: "application_stopped", app_route_conflict: "application_action_route_conflict",
            launch_choice_required: "antigravity_launch_choice", gateway_models_required: "antigravity_gateway_models_required" };
          note = direct[result.status] || (["open_failed", "focus_unavailable", "quit_refused", "quit_timeout", "app_changed", "needs_app_relaunch", "route_conflict", "unverified_build"].includes(result.status) ? "application_action_" + result.status : "application_action_failed");
        }
      } catch { note = "application_action_failed"; }
      finally { pending = false;render(); }
    }
    function openCurrent() {
      const id = route(), state = data?.applications?.[id];
      if (state?.status === "running" && needsReload(state)) { confirmation = { id, pid: state.pid, started: state.started };render(); }
      else if (state?.status === "running") void act("focus");
      else if (state?.status === "stopped") void act("open");
      else void check(true);
    }
    el("application-open").addEventListener("click", openCurrent);
    el("application-reopen-cancel").addEventListener("click", () => { confirmation = null;render();el("application-open").focus(); });
    el("application-reopen-apply").addEventListener("click", () => { if (confirmation?.id === route()) void act("restart", confirmation, confirmation.mode); });
    for (const mode of ["google", "gateway"]) el("antigravity-open-" + mode).addEventListener("click", () => {
      if (route() !== "antigravity") return;
      const state = data?.applications?.antigravity;
      if (state?.status === "running" && state.launch_mode !== mode) {
        confirmation = { id: "antigravity", pid: state.pid, started: state.started, mode };render();
      } else void act(state?.status === "running" ? "focus" : "open", null, mode);
    });
    el("codex-auto-launch").addEventListener("change", async event => {
      const value = event.target.checked;if (pending) return;
      pending = true;sequence++;event.target.disabled = true;
      try { const next = await change({ action: "preference", key: "codex_auto_launch", value }, event.target, { quiet: true });autoError = !next;if (next) data = next; }
      finally { pending = false;render(); }
    });
    for (const button of document.querySelectorAll("[data-claude-client]")) button.addEventListener("click", () => {
      claudeApp = button.dataset.claudeClient === "claude_app";confirmation = null;note = null;render();if (claudeApp) void check();
    });
    window.addEventListener("focus", () => { if (document.visibilityState === "visible") void check(); });
    window.addEventListener("ccdx-gemini-state", event => {
      antigravityCatalogPending = event.detail?.needsCatalogReload === true;
      const state = event.detail?.application;if (state) sync({ ...data, applications: { ...data?.applications, antigravity: state } });
    });
    return { sync, render, open(id) { if (route() === id && !pending && !isBusy()) openCurrent(); }, routeChanged() { confirmation = null;note = null;sequence++;render();void check(); }, refresh: () => check(true) };
  }
  globalThis.ccdxApplications = { create };
})();
