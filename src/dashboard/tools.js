(() => {
  const el = id => document.getElementById(id), language = globalThis.ccdxLanguage;
  const label = (node, key, values) => language.set(node, key, values);
  const text = (id, key, values) => label(el(id), key, values);
  let account = null, pending = false, pollTimer = null, stopped = false, repairPreview = null;
  const activeFlow = () => ["starting", "authorizing", "verifying"].includes(account?.operation?.state);
  async function api(path, body) {
    const response = await fetch(`/_ccdx/ui/${path}`, { method: body ? "POST" : "GET", cache: "no-store",
      headers: { "X-CCDX-Dashboard": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error("tools_action_failed"), { code: data.code || "tools_action_failed" });
    return data;
  }
  function status(id, key, kind, values) { globalThis.ccdxIcons.set(el(id), key, kind, values); }
  function field(list, key, value, kind) {
    const term = document.createElement("dt"), detail = document.createElement("dd");label(term, key);
    if (kind) globalThis.ccdxIcons.set(detail, value, kind);else detail.textContent = value;
    if (list.classList.contains("account-summary")) { const pair = document.createElement("div");pair.append(term, detail);list.append(pair); }else list.append(term, detail);
  }
  function syncSource() {
    const github = selectedProvider === "github";
    el("github-account").hidden = !github;
    el("m365-source-access").hidden = selectedProvider !== "m365";
    el("source-account-panel").setAttribute("aria-labelledby", `model-provider-${selectedProvider}`);
  }
  function renderAccount(data) {
    account = data;
    const online = data.online, op = data.operation;
    const invalid = online?.reason === "github_token_invalid", failed = online?.checked && !online.ok;
    text("github-account-name", data.login || (data.saved ? "tools_saved_account" : "tools_not_signed_in"));
    status("github-account-state", invalid ? "tools_signin_invalid" : online?.ok ? "tools_verified" : data.saved ? "saved_locally" : "tools_not_signed_in",
      invalid ? "warning" : online?.ok ? "ok" : data.saved ? "unknown" : "unavailable");
    text("github-account-hint", !data.saved ? "tools_login_hint" : invalid ? "tools_saved_not_valid" : failed ? "tools_access_hint" : "tools_account_hint");
    const fields = el("github-account-fields");fields.replaceChildren();
    field(fields, "tools_saved_signin", data.saved ? "saved_locally" : "tools_not_signed_in", data.saved ? "ok" : "unavailable");
    for (const [id, key] of [["access", "tools_copilot_access"], ["models", "tools_catalog_read"]]) {
      const result = online?.stages?.[id] || "not_checked";
      field(fields, key, result === "passed" ? "tools_verified" : result === "invalid" ? "tools_signin_invalid" : result === "unavailable" ? "tools_unavailable" : "tools_not_checked",
        result === "passed" ? "ok" : result === "invalid" ? "warning" : result === "unavailable" ? "unavailable" : "unknown");
    }
    status("github-identity-detail", online?.stages?.identity === "passed" ? "tools_verified" : invalid ? "tools_signin_invalid" : "tools_not_checked",
      online?.stages?.identity === "passed" ? "ok" : invalid ? "warning" : "unknown");
    el("github-checked-at").textContent = data.checked_at ? time(data.checked_at, { date: true }) : "—";
    label(el("github-signin"), data.saved ? "tools_reauth" : "tools_login");
    el("github-signin").hidden = data.saved && !invalid;
    el("github-force-reauth").hidden = !data.saved || invalid;
    if (data.saved && !invalid && !failed) el("github-account-hint").textContent = "";
    el("github-signin").disabled = pending || activeFlow();el("github-check").disabled = pending || activeFlow() || !data.saved;
    el("github-logout").disabled = pending || activeFlow() || !data.saved;
    el("github-force-reauth").disabled = pending || activeFlow();
    el("github-login-flow").hidden = !activeFlow();
    text("github-flow-state", op?.state === "verifying" ? "tools_verifying" : "tools_waiting");
    el("github-user-code").textContent = op?.user_code || "—";
    el("github-authorize").hidden = op?.state !== "authorizing";
    el("github-authorize").href = op?.verification_uri === "https://github.com/login/device" ? op.verification_uri : "https://github.com/login/device";
    el("github-cancel").disabled = pending;
    el("github-check-code").textContent = online?.reason || "—";
    el("github-check-http").textContent = online?.http_status || "—";
    text("github-store", data.store === "ccdx" ? "tools_ccdx_store" : "tools_legacy_store");
    if (op?.state === "complete") text("github-account-note", op.reason === "auth_restart_required" ? "auth_restart_required" : "tools_signin_complete");
    else if (["failed", "cancelled"].includes(op?.state)) text("github-account-note", op.reason || "tools_action_failed");
    else if (failed) text("github-account-note", online.reason === "github_token_invalid" ? "tools_reauth_hint" : online.reason === "copilot_access_denied" ? "tools_access_denied" : "tools_network_hint");
    else if (online?.ok) text("github-account-note", "tools_check_complete");
    else if (!activeFlow()) el("github-account-note").textContent = "";
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);pollTimer = null;
    if (stopped || !activeFlow() || document.visibilityState !== "visible") return;
    pollTimer = setTimeout(async () => {
      try {
        const before = account.operation.state, data = await api("account");renderAccount(data);
        if (before !== data.operation?.state && data.operation?.state === "complete") {
          dashboardRefresh.invalidate("auth");dashboardRefresh.invalidate("models", { clear: true });
          void dashboardRefresh.refreshVisible({ force: true });
        }
      } catch { text("github-account-note", "tools_read_failed");schedulePoll(); }
    }, 1500);
  }
  async function accountAction(action) {
    if (pending) return;
    pending = true;if (account) renderAccount(account);text("github-account-note", "checking");
    let failureCode = null;
    try { renderAccount(await api("account", action)); }
    catch (error) { failureCode = error.code; }
    finally { pending = false;if (account) renderAccount(account);if (failureCode) text("github-account-note", failureCode); }
  }
  el("github-signin").addEventListener("click", () => void accountAction({ action: "start", reauth: account?.saved === true }));
  el("github-force-reauth").addEventListener("click", () => void accountAction({ action: "start", reauth: true }));
  el("github-check").addEventListener("click", () => void accountAction({ action: "check" }));
  el("github-cancel").addEventListener("click", () => { if (account?.operation) void accountAction({ action: "cancel", id: account.operation.id }); });
  el("github-logout").addEventListener("click", () => { if (window.confirm(language.format("tools_logout_confirm"))) void accountAction({ action: "logout", confirmed: true }); });
  async function loadAccount() { try { renderAccount(await api("account")); } catch { text("github-account-note", "tools_read_failed"); } }
  function renderChecks(data) {
    const body = el("checks-body");body.replaceChildren();
    const groups = new Map();
    for (const check of data.checks || []) { if (!groups.has(check.id)) groups.set(check.id, []);groups.get(check.id).push(check); }
    for (const [id, checks] of groups) {
      const row = document.createElement("tr"), name = document.createElement("td"), result = document.createElement("td"), details = document.createElement("td");
      const kind = checks.some(check => check.kind === "err" || check.kind === "warn") ? "warning" : checks.some(check => check.kind === "ok") ? "ok" : "unknown";
      label(name, ({ "github-auth": "tools_github_signin", "codex-config": "tools_codex_settings", "windows-command": "tools_windows_command", provider: "source" })[id] || "tools_environment");
      globalThis.ccdxIcons.set(result, kind === "warning" ? "tools_needs_attention" : kind === "ok" ? "tools_verified" : "tools_observed", kind);
      const disclosure = document.createElement("details"), summary = document.createElement("summary");label(summary, "tools_details");disclosure.append(summary);
      for (const check of checks) { const p = document.createElement("p");p.className = "hint";p.textContent = check.message;disclosure.append(p); }
      details.append(disclosure);row.append(name, result, details);body.append(row);
    }
    if (!groups.size) text("checks-note", "tools_checks_empty");
    else text("checks-note", "tools_checks_completed", { time: time(data.checked_at) });
  }
  async function localAction(action, button) {
    button.disabled = true;text("checks-note", "checking");
    try {
      const data = await api("checks", action);
      if (action.action === "check") renderChecks(data);
      else if (action.action === "preview") {
        repairPreview = data;el("config-repair-preview").hidden = false;
        const fields = el("config-repair-fields");fields.replaceChildren();
        field(fields, "tools_managed_fields", data.managed_keys.join(", "));
        field(fields, "tools_backup", data.backup);
        el("config-preview-details").textContent = data.checks.map(check => check.message).join("\n");
        text("checks-note", "tools_review_repair");
      } else if (action.action === "repair") {
        el("config-repair-preview").hidden = true;repairPreview = null;
        if (data.local?.checked_at) renderChecks(data.local);
        text("checks-note", ["verified", "unchanged"].includes(data.status) ? "tools_repair_complete" : "tools_repair_preserved");
      } else if (action.action === "network") { el("network-check-result").textContent = data.summary;text("checks-note", "tools_network_read_only"); }
      else if (action.action === "report") {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");link.href = url;link.download = "ccdx-diagnostic-report.json";link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);text("checks-note", "tools_report_saved");
      }
    } catch (error) { text("checks-note", error.code); }
    finally { button.disabled = false; }
  }
  for (const [id, action] of [["check-local", "check"], ["check-network", "network"], ["export-report", "report"], ["preview-config-repair", "preview"]]) {
    el(id).addEventListener("click", () => void localAction({ action }, el(id)));
  }
  el("apply-config-repair").addEventListener("click", () => { if (repairPreview) void localAction({ action: "repair", revision: repairPreview.revision }, el("apply-config-repair")); });
  el("cancel-config-repair").addEventListener("click", () => { repairPreview = null;el("config-repair-preview").hidden = true; });
  el("check-account-link").addEventListener("click", () => { chooseProvider("github");location.hash = "models"; });
  async function navigate() {
    syncSource();
    if (location.hash === "#models") await loadAccount();
    if (location.hash === "#checks") { try { const data = await api("checks");if (data.checked_at) renderChecks(data); } catch { text("checks-note", "tools_read_failed"); } }
  }
  window.addEventListener("ccdx:source-view", syncSource);
  window.addEventListener("ccdx:providers", () => { queueMicrotask(() => { syncSource();if (location.hash === "#models" && !pending) void loadAccount(); }); });
  el("refresh").addEventListener("click", () => { if (location.hash === "#models" && !pending) void loadAccount(); });
  window.addEventListener("hashchange", () => void navigate());
  window.addEventListener("pagehide", () => { stopped = true;clearTimeout(pollTimer); });
  window.addEventListener("pageshow", () => { stopped = false;schedulePoll(); });
  document.addEventListener("visibilitychange", schedulePoll);
  void navigate();
})();
