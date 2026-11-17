(() => {
  function create({ element: el, change, localize, isBusy = () => false }) {
    let data, pending = false, sequence = 0, confirmation = null, claudeApp = true, note = null, autoError = false;
    const route = () => ({ codex: "codex", claude: claudeApp ? "claude_app" : null, gemini: "antigravity" })[location.hash.slice(1)] || null;
    const label = (id, key) => localize(el(id), key);
    const buttonKey = state => state?.status === "running" ? state.needs_reload ? "application_reopen" : "application_focus"
      : state?.status === "starting" ? "application_opening" : state?.status === "stopped" ? "application_open" : "application_check";
    function render() {
      const id = route(), state = data?.applications?.[id];
      el("application-launch").hidden = !id;
      el("page-title").closest(".intro").classList.toggle("has-application-launch", Boolean(id));
      el("application-reopen-confirm").hidden = !confirmation || confirmation.id !== id;
      el("application-reopen-apply").disabled = pending || isBusy();
      if (!id) return;
      label("application-open-label", buttonKey(state));
      el("application-open").disabled = pending || isBusy() || ["starting", "unsupported", "not_installed", "multiple"].includes(state?.status);
      el("application-open").setAttribute("aria-busy", String(pending || isBusy() || state?.status === "starting"));
      label("application-state", note || (state?.status === "running" ? state.needs_reload ? "application_reload_pending" : state.connection === "observed" ? "application_connected" : "application_pending"
        : state?.status === "stopped" ? "application_stopped" : state?.status === "starting" ? "application_opening" : "application_" + (state?.status || "unknown")));
      if (!pending) {
        el("codex-auto-launch").checked = data?.effective?.codex_auto_launch?.value === true;
        el("codex-auto-launch").disabled = isBusy() || data?.effective?.codex_auto_launch?.locked === true || !data;
        label("codex-auto-launch-note", autoError ? "application_preference_failed" : data?.effective?.codex_auto_launch?.locked ? "controlled_by_environment" : "next_ccdx_start");
      }
      window.dispatchEvent(new CustomEvent("ccdx:application-state", { detail: { id, application: state, pending: pending || isBusy() } }));
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
    async function act(operation, expected) {
      const id = route();if (!id || pending) return;
      pending = true;confirmation = null;note = null;sequence++;render();
      try {
        const next = await change({ action: "application", id, operation,
          ...(operation === "restart" ? { confirmed: true, expected_pid: expected.pid, expected_started: expected.started } : {}) }, el("application-open"), { quiet: true });
        if (!next) { note = "application_action_failed";return; }
        data = next;const result = next.last_operation?.feature === "application" ? next.last_operation.result : null;
        if (["opened", "opening"].includes(result?.status)) for (const delay of [1000, 10500]) setTimeout(() => { if (route() === id && document.visibilityState === "visible") void check(true); }, delay);
        if (result && !["opened", "opening", "focused", "checked"].includes(result.status)) {
          const direct = { unknown: "application_unknown", app_check_failed: "application_unknown", not_installed: "application_not_installed", multiple: "application_multiple", multiple_apps: "application_multiple", unsupported: "application_unsupported", app_not_running: "application_stopped", app_route_conflict: "application_action_route_conflict" };
          note = direct[result.status] || (["open_failed", "focus_unavailable", "quit_refused", "quit_timeout", "app_changed", "needs_app_relaunch", "route_conflict"].includes(result.status) ? "application_action_" + result.status : "application_action_failed");
        }
      } finally { pending = false;render(); }
    }
    function openCurrent() {
      const id = route(), state = data?.applications?.[id];
      if (state?.status === "running" && state.needs_reload) { confirmation = { id, pid: state.pid, started: state.started };render(); }
      else if (state?.status === "running") void act("focus");
      else if (state?.status === "stopped") void act("open");
      else void check(true);
    }
    el("application-open").addEventListener("click", openCurrent);
    el("application-reopen-cancel").addEventListener("click", () => { confirmation = null;render();el("application-open").focus(); });
    el("application-reopen-apply").addEventListener("click", () => { if (confirmation?.id === route()) void act("restart", confirmation); });
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
      const state = event.detail?.application;if (state) sync({ ...data, applications: { ...data?.applications, antigravity: state } });
    });
    return { sync, render, open(id) { if (route() === id && !pending && !isBusy()) openCurrent(); }, routeChanged() { confirmation = null;note = null;sequence++;render();void check(); }, refresh: () => check(true) };
  }
  globalThis.ccdxApplications = { create };
})();
