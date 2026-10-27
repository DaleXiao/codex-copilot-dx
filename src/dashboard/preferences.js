(() => {
  function create({ element: el, api, applied, refreshAnimation, selectAnimation, time }) {
    const label = (id, key, values) => globalThis.ccdxLanguage.set(el(id), key, values);
    const theme = () => globalThis.ccdxDashboardTheme;
    const backupKey = "ccdx.dashboard.preferences-backup";
    const fields = { terminal_color_theme: "terminal-color-theme", terminal_animation_enabled: "setting-terminal_animation_enabled",
      open_webui: "setting-open_webui", nightly_updates: "nightly-update" };
    let base, draft = {}, appearance, appearanceBase, pending, timer, error = null, conflict = false, version = 0, dialog, dialogRevision, resetting = false, retrying = false, locks = {}, terminalMode;
    const dirty = () => Object.keys(draft).length + (appearance ? 1 : 0);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const active = () => !el("settings-preferences").closest("[hidden]");
    function browserBackup() {
      const raw = localStorage.getItem(backupKey);if (raw === null) return { version: 1, entries: [] };
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 2 || value.entries.some(entry => typeof entry.id !== "string"
        || !["dark", "light"].includes(entry.values?.theme) || !["green", "klein", "pink"].includes(entry.values?.palette))) throw Error("preferences_browser_backup_invalid");
      return value;
    }
    function render() {
      el("preferences-status").hidden = !active();
      if (!base) return;
      const current = { ...base.values, ...draft }, count = dirty(), busy = Boolean(pending || retrying);
      el("preferences-auto").checked = current.auto_save_settings;el("preferences-auto").disabled = busy || conflict;
      for (const [key, id] of Object.entries(fields)) {
        const node = el(id);if (node.type === "checkbox") node.checked = current[key];else node.value = current[key];
        node.disabled = Boolean(locks[key] || resetting);
      }
      el("web-color-theme").disabled = resetting;
      for (const row of document.querySelectorAll("#animation-options [data-theme]")) row.disabled = resetting;
      el("terminal-color-sample").dataset.terminalPalette = current.terminal_color_theme;
      el("animation-settings").dataset.terminalPalette = current.terminal_color_theme;
      el("preferences-reset").disabled = busy;el("preferences-restore").disabled = busy;
      el("preferences-backup").hidden = !base.backup;
      el("preferences-backup-time").textContent = base.backup ? time(base.backup.created_at, { date: true }) : "";
      el("preferences-manual").hidden = current.auto_save_settings && !conflict;
      el("preferences-save").disabled = !count || busy || conflict;el("preferences-discard").disabled = (!count && !conflict) || busy;
      label("preferences-manual-note", conflict ? "preferences_conflict" : count ? "preferences_unsaved" : "preferences_manual", { count });
      globalThis.ccdxIcons.set(el("preferences-status"), busy ? "saving" : error ? "preferences_failed" : count ? "preferences_unsaved" : "preferences_saved",
        error ? "warning" : busy || count ? "unknown" : "ok", { count });
      el("preferences-retry").hidden = !error || conflict || busy;
      el("preferences-error").parentElement.hidden = !error;
      if (!error) el("preferences-error").textContent = "";
      else label("preferences-error", error);
      el("save-animation").hidden = true;
      if (appearance) theme()?.preview(appearance);
      if (appearance) label("web-color-note", "preferences_appearance_preview");
      else theme()?.sync();
      label("terminal-color-note", Object.hasOwn(draft, "terminal_color_theme") ? "preferences_terminal_preview"
        : terminalMode === "status" ? "terminal_theme_applied" : "terminal_theme_unavailable");
      if (draft.terminal_animation) {
        for (const row of document.querySelectorAll("#animation-options [data-theme]")) row.setAttribute("aria-pressed", String(row.dataset.theme === draft.terminal_animation));
      }
      selectAnimation(current.terminal_animation);
    }
    function sync(data, { readVersion } = {}) {
      if (!data.preferences) return;
      terminalMode = data.terminal?.mode;
      if (readVersion !== undefined && readVersion !== version || pending) { render();return; }
      const next = data.preferences;
      locks.terminal_animation_enabled = data.effective?.terminal_animation_enabled?.locked;
      if (base) for (const key of Object.keys(draft)) {
        if (next.values[key] === draft[key]) delete draft[key];
        else if (next.values[key] !== base.values[key]) { conflict = true;error = "preferences_changed"; }
      }
      base = next;
      if (!appearance) { try { appearanceBase = theme()?.read(); } catch { appearanceBase = theme()?.snapshot(); } }
      try {
        const backup = browserBackup(), retained = backup.entries.filter(entry => entry.id === base.backup?.id);
        if (retained.length && backup.entries.length > 1) localStorage.setItem(backupKey, JSON.stringify({ version: 1, entries: retained }));
      } catch { /* A damaged browser backup is reported if it is used, not erased. */ }
      render();
    }
    function schedule() {
      clearTimeout(timer);
      if (base?.values.auto_save_settings && !error) timer = setTimeout(() => { void save(); }, 300);
    }
    function edit(key, value) {
      if (!base) return;
      if (value === base.values[key]) delete draft[key];else draft[key] = value;
      if (!conflict) error = null;render();schedule();
    }
    async function commit(values, { local = appearance, action = "preferences", backup_id, revision = base?.revision } = {}) {
      if (pending || !base || conflict) return;
      clearTimeout(timer);
      const captured = { ...values }, capturedLocal = local ? { ...local } : null;
      resetting = action !== "preferences";
      error = null;
      const operation = (async () => {
        try {
          if (capturedLocal && appearanceBase && !same(theme().read(), appearanceBase)) throw Error("preferences_browser_changed");
          const data = action !== "preferences" || Object.keys(captured).length
            ? await api({ action, revision, ...(action === "preferences" ? { values: captured } : { backup_id }) }) : null;
          if (data) { base = data.preferences;version++; }
          for (const [key, value] of Object.entries(captured)) if (draft[key] === value) delete draft[key];
          if (capturedLocal) {
            if (!theme().persist(capturedLocal)) throw Error("preferences_browser_failed");
            appearanceBase = capturedLocal;
            if (same(appearance, capturedLocal)) appearance = null;
          }
          if (data) applied(data);
          if (Object.hasOwn(captured, "terminal_animation") || action !== "preferences") refreshAnimation();
          return data || { preferences: base };
        } catch (cause) {
          error = cause.code === "ccdx_settings_changed" ? "preferences_changed"
            : ["preferences_browser_failed", "preferences_browser_changed"].includes(cause.message) ? cause.message : "preferences_failed";
          conflict = error === "preferences_changed" || error === "preferences_browser_changed";
        }
      })();
      pending = operation;render();
      try { return await operation; }
      finally { pending = null;resetting = false;render();if (!error && dirty() && base.values.auto_save_settings) schedule(); }
    }
    function save() { if (dirty()) return commit(draft); }
    async function discard() {
      clearTimeout(timer);if (pending) return;
      try {
        const data = await api();draft = {};appearance = null;error = null;conflict = false;
        appearanceBase = theme().read();theme().preview(appearanceBase);base = data.preferences;version++;applied(data);refreshAnimation();render();
      } catch { error = "preferences_failed";render(); }
    }
    function open(kind) {
      if (!base || pending) return;
      dialog = kind;dialogRevision = base.revision;
      label("preferences-dialog-title", `preferences_${kind}_question`);
      label("preferences-dialog-intro", `preferences_${kind}_intro`, { count: dirty() });
      label("preferences-dialog-confirm", `preferences_${kind}_confirm`);
      el("preferences-dialog-scope").hidden = !["reset", "restore"].includes(kind);
      if (kind === "reset") label("preferences-dialog-note", dirty() ? "preferences_draft_discard" : "preferences_backup_latest");
      else { el("preferences-dialog-note").textContent = "";el("preferences-dialog-note").removeAttribute("data-i18n"); }
      el("preferences-dialog").showModal();
    }
    async function confirmed() {
      const kind = dialog;el("preferences-dialog").close();
      if (kind === "enable") { draft.auto_save_settings = true;await save();return; }
      if (kind === "nightly") { edit("nightly_updates", true);return; }
      if (kind === "restore" || kind === "reset") {
        let local, id = base.backup?.id;
        try {
          const backup = browserBackup();
          if (kind === "reset") {
            id = crypto.randomUUID();local = { theme: "dark", palette: "green" };
            const previous = { id, values: theme().read() };
            localStorage.setItem(backupKey, JSON.stringify({ version: 1, entries: [previous, ...backup.entries].slice(0, 2) }));
          } else {
            local = backup.entries.find(entry => entry.id === id)?.values;
            if (!local) throw Error("preferences_browser_backup_missing");
          }
        } catch (cause) { error = cause.message === "preferences_browser_backup_missing" ? cause.message : "preferences_browser_backup_invalid";render();return; }
        if (conflict) { error = "preferences_changed";render();return; }
        const oldDraft = draft, oldAppearance = appearance;
        draft = {};appearance = local;
        const data = await commit({}, { action: `${kind === "reset" ? "reset" : "restore"}_preferences`, backup_id: id, local, revision: dialogRevision });
        if (data) { theme().preview(local);appearance = null; }
        else if (error === "preferences_browser_failed") appearance = local;
        else { draft = oldDraft;appearance = oldAppearance; }
        render();
      }
    }
    for (const [key, id] of Object.entries(fields)) el(id).addEventListener("change", () => {
      const node = el(id), value = node.type === "checkbox" ? node.checked : node.value;
      if (key === "nightly_updates" && value) { node.checked = false;open("nightly");return; }
      edit(key, value);
    });
    function appearanceChanged() {
      if (!base) return false;
      appearance = same(theme().snapshot(), appearanceBase) ? null : theme().snapshot();
      if (!conflict) error = null;render();schedule();return true;
    }
    el("preferences-auto").addEventListener("change", async () => {
      if (el("preferences-auto").checked && dirty()) { el("preferences-auto").checked = false;open("enable");return; }
      const value = el("preferences-auto").checked;
      draft.auto_save_settings = value;
      const result = await commit({ auto_save_settings: value }, { local: null });
      if (!result) { delete draft.auto_save_settings;render(); }
    });
    el("preferences-save").addEventListener("click", () => { void save(); });
    el("preferences-discard").addEventListener("click", () => { void discard(); });
    el("preferences-retry").addEventListener("click", async () => {
      if (retrying || pending) return;
      const wasError = error;error = null;
      retrying = true;render();
      try { sync(await api());retrying = false;if (!conflict) await save(); } catch { error = wasError; }
      finally { retrying = false;render(); }
    });
    el("preferences-reset").addEventListener("click", () => open("reset"));el("preferences-restore").addEventListener("click", () => open("restore"));
    el("preferences-dialog-cancel").addEventListener("click", () => el("preferences-dialog").close());
    el("preferences-dialog-confirm").addEventListener("click", () => { void confirmed(); });
    globalThis.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault();event.returnValue = ""; } });
    return { sync, render, appearanceChanged, selectAnimation: value => edit("terminal_animation", value),
      externalAppearance() { if (!appearance) return false;conflict = true;error = "preferences_browser_changed";render();return true; },
      get version() { return version; }, get busy() { return Boolean(pending || retrying); } };
  }
  globalThis.ccdxDashboardPreferences = { create };
})();
