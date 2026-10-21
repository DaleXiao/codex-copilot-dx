const element = (id) => document.getElementById(id);
const phrase = (key, values = {}) => ({ key, values });
const english = (key, values = {}) => String(key).replace(/\{(\w+)\}/g, (match, name) => {
  if (!Object.hasOwn(values, name)) return match;
  const value = values[name];
  return value && typeof value === "object" && typeof value.key === "string" ? english(value.key, value.values) : String(value ?? "");
});
const localize = (target, key, values = {}, attribute = "textContent") => {
  if (globalThis.ccdxLanguage) return globalThis.ccdxLanguage.set(target, key, values, attribute);
  const value = english(key, values);
  if (attribute === "textContent") target.textContent = value;
  else target.setAttribute(attribute, value);
};
const text = (id, key, values) => { localize(element(id), key, values); };
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const number = (value) => finite(value) ? Math.max(0, Math.round(Number(value))).toLocaleString() : "—";
const mib = (value) => finite(value) ? `${(Number(value) / 1048576).toFixed(1)} MiB` : "—";
const viewHelpers = { element, phrase, localize, text, finite, number, mib, tableRow, emptyTable, document, navigator: globalThis.navigator,
  motionAllowed: () => !reducedMotion.matches && document.visibilityState === "visible" && element("usage-analytics").open && element("model-usage").open && !element("model-usage").closest("[hidden]") };
const { render, renderProviders, renderFailures, renderContext } = globalThis.ccdxDashboardStatus.create(viewHelpers);
const usageView = globalThis.ccdxDashboardUsage.create(viewHelpers);
const { applyUsage, renderUsageState, renderAnalytics, renderUsageTable, selectUsageDay } = usageView;
const loadAuth = () => dashboardRefresh.refresh("auth", { force: true });

const refresh = () => dashboardRefresh.refresh("status", { force: true });

function animateRefresh() {
  const icon = element("status-icon");
  if (!icon || reducedMotion.matches || !icon.animate) return;
  for (const animation of icon.getAnimations?.() || []) animation.cancel();
  icon.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
    { duration: 450, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
}
element("refresh").addEventListener("click", () => {
  animateRefresh();
  dashboardRefresh.refreshVisible({ force: true });
});

const animationRows = new Map();
let animationTimelines = [];
let savedAnimation = "";
let selectedAnimation = "";
let previewDisabledByEnvironment = false;
let previewVisible = false;
let previewTimer = null;
let previewStarted = 0;
let animationSaving = false;
let animationFramesLoaded = false;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function renderAnsiFrame(target, frame) {
  const fragments = String(frame).split(/\u001b\[([0-9;]+)m/);
  const content = document.createDocumentFragment();
  let color = "";
  for (let index = 0; index < fragments.length; index += 2) {
    if (fragments[index]) {
      const span = document.createElement("span");
      span.className = color;
      span.textContent = fragments[index];
      content.append(span);
    }
    const code = fragments[index + 1];
    color = code === "97" ? "ansi-white"
      : /^38;5;(159|123|87|51|45|39|33)$/.test(code || "") ? `ansi-${code.slice(5)}` : "";
  }
  target.replaceChildren(content);
}

function renderAnimationFrames(elapsed) {
  for (const timeline of animationTimelines) {
    const position = timeline.id === selectedAnimation ? elapsed % timeline.duration : 0;
    const frameIndex = timeline.frames.findIndex(({ until }) => position < until);
    if (frameIndex === timeline.lastFrame) continue;
    timeline.lastFrame = frameIndex;
    renderAnsiFrame(timeline.target, frameIndex < 0 ? `[${" ".repeat(20)}]` : timeline.frames[frameIndex].ansi);
  }
}

function stopAnimationPreview() {
  if (previewTimer !== null) clearTimeout(previewTimer);
  previewTimer = null;
}

function tickAnimationPreview() {
  previewTimer = null;
  if (!animationTimelines.length || !element("animation-settings").open || element("animation-settings").closest("[hidden]") || !previewVisible || document.visibilityState !== "visible" || reducedMotion.matches || previewDisabledByEnvironment) return;
  renderAnimationFrames(performance.now() - previewStarted);
  previewTimer = setTimeout(tickAnimationPreview, 32);
}

function syncAnimationPreview() {
  stopAnimationPreview();
  if (!animationTimelines.length || !element("animation-settings").open || element("animation-settings").closest("[hidden]") || !previewVisible || document.visibilityState !== "visible" || reducedMotion.matches || previewDisabledByEnvironment) {
    for (const timeline of animationTimelines) timeline.lastFrame = -2;
    renderAnimationFrames(0);
    return;
  }
  previewStarted = performance.now();
  tickAnimationPreview();
}

new IntersectionObserver(([entry]) => {
  previewVisible = entry.isIntersecting;
  syncAnimationPreview();
}).observe(element("animation-options"));
document.addEventListener("visibilitychange", syncAnimationPreview);
reducedMotion.addEventListener("change", syncAnimationPreview);
reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) usageView.stopMotion(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") usageView.stopMotion(); });
new IntersectionObserver(([entry]) => usageView.setChartVisible(entry.isIntersecting)).observe(element("daily-bars"));

function buildAnimationOptions(data) {
  const container = element("animation-options");
  container.replaceChildren();
  animationRows.clear();
  animationTimelines = [];
  savedAnimation = data.theme;
  selectedAnimation = data.theme;
  previewDisabledByEnvironment = data.disabled_by_environment === true;
  for (const [index, theme] of data.themes.entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "theme-option";
    option.setAttribute("aria-pressed", String(theme.id === data.theme));
    option.addEventListener("click", () => {
      selectedAnimation = theme.id;
      for (const [id, row] of animationRows) row.setAttribute("aria-pressed", String(id === theme.id));
      element("save-animation").disabled = selectedAnimation === savedAnimation;
      updateAnimationState();
      syncAnimationPreview();
    });
    const name = document.createElement("span");
    name.className = "theme-name";
    const label = document.createElement("span");
    localize(label, "index_theme", { index: String(index + 1).padStart(2, "0"), theme: phrase(theme.label) });
    name.append(label);
    if (theme.default) {
      const marker = document.createElement("small");
      localize(marker, "default");
      name.append(marker);
    }
    const preview = document.createElement("span");
    preview.className = "theme-preview";
    preview.setAttribute("aria-hidden", "true");
    option.append(name, preview);
    container.append(option);
    animationRows.set(theme.id, option);
    let until = 0;
    const frames = theme.frames.map((frame) => {
      until += frame.delay_ms;
      return { ansi: frame.ansi, until };
    });
    animationTimelines.push({ id: theme.id, target: preview, frames, duration: until + theme.loop_pause_ms, lastFrame: -2 });
  }
  element("save-animation").disabled = true;
  syncAnimationPreview();
}

function animationNote(data) {
  return data.disabled_by_environment
    ? "disabled_by_ccdx_terminal_animation_saved_choice_applies_after_o"
    : "saved_choice_applies_to_the_running_terminal";
}

function loadAnimation(options) {
  if (!animationSaving) return dashboardRefresh.refresh("animation", options);
}

function applyAnimation(data, { changed } = {}) {
  if (changed === false) { updateAnimationState(); return; }
  if (!animationFramesLoaded && data.themes.some(theme => theme.frames)) {
    buildAnimationOptions(data);
    animationFramesLoaded = true;
  } else {
    const dirty = selectedAnimation && selectedAnimation !== savedAnimation;
    savedAnimation = data.theme;
    if (!dirty) selectedAnimation = data.theme;
    previewDisabledByEnvironment = data.disabled_by_environment === true;
    for (const [id, row] of animationRows) row.setAttribute("aria-pressed", String(id === selectedAnimation));
    element("save-animation").disabled = selectedAnimation === savedAnimation;
    syncAnimationPreview();
  }
  updateAnimationState();
  text("animation-note", animationNote(data));
}

function updateAnimationState() {
  text("animation-state", "current_theme_unsaved", { theme: phrase(savedAnimation.toUpperCase()), unsaved: selectedAnimation !== savedAnimation ? phrase("unsaved") : "" });
}

async function saveAnimation() {
  const button = element("save-animation");
  if (!selectedAnimation || selectedAnimation === savedAnimation) return;
  animationSaving = true;
  dashboardRefresh.invalidate("animation");
  button.disabled = true;
  text("animation-note", "saving");
  try {
    const response = await fetch("/_ccdx/ui/animation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CCDX-Dashboard": "1" },
      body: JSON.stringify({ theme: selectedAnimation }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    savedAnimation = data.theme;
    updateAnimationState();
    text("animation-note", animationNote(data));
  } catch (error) {
    text("animation-note", "not_saved_error", { error: String(error.message || error).slice(0, 150) });
  } finally {
    animationSaving = false;
    button.disabled = selectedAnimation === savedAnimation;
    loadAnimation({ force: true });
  }
}

function emptyTable(bodyId, columns, message) {
  const body = element(bodyId);
  body.replaceChildren();
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = columns;
  localize(cell, message);
  row.append(cell);
  body.append(row);
}

function tableRow(values, { total = false, labels = [] } = {}) {
  const row = document.createElement("tr");
  if (total) row.className = "total-row";
  for (const [index, value] of values.entries()) {
    const cell = document.createElement("td");
    if ((total && index === 0) || labels.includes(index)) localize(cell, value);
    else cell.textContent = value;
    row.append(cell);
  }
  return row;
}

let providerEntries = [];
let usageProviders = {};
let selectedProvider = "";
const modelSnapshots = new Map();
const providerTabs = new Map();
try { selectedProvider = localStorage.getItem("ccdx.dashboard.modelProvider") || ""; } catch { /* Page-local choice still works. */ }

function syncUsageProviders() {
  const selector = element("usage-provider"), selected = selector.value;
  const entries = new Map(providerEntries.map(provider => [provider.id, provider.name]));
  for (const id of Object.keys(usageProviders)) if (usageProviders[id] > 0 && !entries.has(id)) entries.set(id, id);
  const signature = JSON.stringify([...entries]);
  if (selector.dataset.providers === signature) return;
  selector.dataset.providers = signature;
  selector.replaceChildren();
  const all = document.createElement("option");all.value = "";localize(all, "all_providers");selector.append(all);
  for (const [id, name] of entries) { const option = document.createElement("option");option.value = id;option.textContent = name;selector.append(option); }
  selector.value = entries.has(selected) ? selected : "";
}

function chooseProvider(id) {
  if (selectedProvider === id) return;
  selectedProvider = id;
  syncProviderDetails();
  try { localStorage.setItem("ccdx.dashboard.modelProvider", id); } catch { /* Keep the current choice. */ }
  for (const [key, button] of providerTabs) { button.setAttribute("aria-selected", String(key === id));button.tabIndex = key === id ? 0 : -1; }
  dashboardRefresh.invalidate("models", { clear: true });
  const previous = modelSnapshots.get(id);
  if (previous) applyModels(previous, { changed: true });
  else { emptyTable("live-models-body", 6, "reading_provider_catalog");text("models-note", "reading_provider_catalog"); }
  element("live-models-body").setAttribute("aria-labelledby", `model-provider-${id}`);
  window.dispatchEvent(new CustomEvent("ccdx:source-view"));
  void loadModels();
}

function syncProviderDetails() {
  for (const row of element("provider-auth").children) row.hidden = row.dataset.provider !== selectedProvider;
}

function applyProviders(data, { changed }) {
  const wasInitialized = providerEntries.length > 0, previousSelection = selectedProvider;
  const choices = entries => JSON.stringify(entries.map(source => [source.id, source.name, source.generation, source.selection]));
  const sourceChoicesChanged = choices(providerEntries) !== choices(data.providers);
  let reloadModels = false;
  const previous = new Map(providerEntries.map(entry => [entry.id, JSON.stringify([entry.generation, entry.auth?.account])]));
  providerEntries = data.providers;
  if (sourceChoicesChanged) window.dispatchEvent(new CustomEvent("ccdx:providers"));
  for (const [id] of modelSnapshots) {
    const provider = providerEntries.find(entry => entry.id === id);
    if (!provider) {
      modelSnapshots.delete(id);
      if (id === selectedProvider) { reloadModels = true;dashboardRefresh.invalidate("models", { clear: true });emptyTable("live-models-body", 6, "reading_provider_catalog"); }
    }
  }
  for (const provider of providerEntries) {
    if (previous.has(provider.id) && previous.get(provider.id) !== JSON.stringify([provider.generation, provider.auth?.account])) {
      modelSnapshots.delete(provider.id);
      if (provider.id === selectedProvider) { reloadModels = true;dashboardRefresh.invalidate("models", { clear: true });emptyTable("live-models-body", 6, "reading_provider_catalog"); }
    }
  }
  if (changed || dashboardRefresh.state("auth").error) renderProviders(data);
  syncUsageProviders();
  const available = providerEntries.some(provider => provider.id === selectedProvider);
  if (!available) selectedProvider = providerEntries.find(provider => provider.clients?.some(client => client.id === "codex" && client.selected))?.id || providerEntries[0]?.id || "";
  syncProviderDetails();
  const container = element("model-providers");
  for (const [id, button] of providerTabs) if (!providerEntries.some(provider => provider.id === id)) { button.remove();providerTabs.delete(id); }
  for (const provider of providerEntries) {
    let button = providerTabs.get(provider.id);
    if (!button) {
      button = document.createElement("button");button.type = "button";button.setAttribute("role", "tab");
      button.id = `model-provider-${provider.id}`;button.setAttribute("aria-controls", "source-account-panel");
      button.addEventListener("click", () => chooseProvider(provider.id));
      button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const ids = [...providerTabs.keys()], index = ids.indexOf(provider.id);
        const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
        chooseProvider(ids[next]);providerTabs.get(ids[next]).focus();
      });
      providerTabs.set(provider.id, button);container.append(button);
    }
    button.textContent = provider.name;button.setAttribute("aria-selected", String(provider.id === selectedProvider));button.tabIndex = provider.id === selectedProvider ? 0 : -1;
  }
  element("live-models-body").setAttribute("aria-labelledby", `model-provider-${selectedProvider}`);
  if (wasInitialized && (reloadModels || selectedProvider !== previousSelection)) { dashboardRefresh.invalidate("models", { clear: true });void loadModels(); }
}

async function loadModels() { return dashboardRefresh.refresh("models", { force: true }); }

function applyModels(data, { changed }) {
  if (data.provider && data.provider !== selectedProvider) return;
  modelSnapshots.set(selectedProvider, data);
  if (changed) {
    const body = element("live-models-body");body.replaceChildren();
    for (const model of data.models) {
      const clients = (model.clients || []).map(id => ({ codex: "Codex App", claude_app: "Claude App", claude_code: "Claude Code" })[id] || id).join(" / ") || "—";
      body.append(tableRow([model.id, model.vendor, model.endpoints.join(" / "), clients,
        model.reasoning_efforts === null || model.reasoning_efforts === undefined ? "—" : model.reasoning_efforts.join(" / ") || "—",
        model.preview ? "preview" : model.state || "listed"], { labels: [5] }));
    }
    if (!data.models.length) emptyTable("live-models-body", 6, "no_models_advertised");
  }
  text("models-note", "selectable_selectable_advertised_advertised_host_time", { selectable: number(data.selectable), advertised: number(data.advertised), host: data.upstream_host, time: data.checked_at ? new Date(data.checked_at).toLocaleTimeString() : phrase("unknown") });
}

async function loadUsage() { return dashboardRefresh.refresh("usage", { force: true }); }

async function readDashboard(url, { signal, timeout = 15000, source } = {}) {
  const response = await fetch(url, { cache: "no-store", headers: { "X-CCDX-Dashboard": "1", Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
  const data = await response.json();
  if (!response.ok || (source && !(Array.isArray(source) ? source : [source]).includes(data.source))) {
    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { diagnostic: data.diagnostic });
  }
  return data;
}

function refreshTime(target, state) {
  const time = state.updatedAt === null ? null : new Date(state.updatedAt).toLocaleTimeString();
  if (state.error) localize(target, time ? "update_failed_last_time" : "update_failed", { time });
  else if (time) localize(target, "updated_time", { time });
}

const timestamps = new Map();
for (const [key, ids] of [["auth", ["account-authorization", "client-features", "claude-connections"]], ["status", ["source-requests", "request-context", "recent-failures", "runtime-resources", "additional-capabilities", "codex-performance", "claude-performance", "runtime-diagnostics"]], ["models", ["upstream-models"]], ["usage", ["model-usage"]], ["animation", ["animation-settings"]]]) {
  timestamps.set(key, ids.map(id => {
    const node = document.createElement("p");
    node.className = "refresh-time";
    element(id).append(node);
    return node;
  }));
}

const updateView = globalThis.ccdxDashboardUpdates.create(viewHelpers);
const dashboardRefresh = globalThis.ccdxRefresh.createController({
  visible: () => document.visibilityState === "visible",
  onState: ({ pendingKeys }) => {
    // Account and release reads must not block normal dashboard refreshes.
    const busy = pendingKeys.some(key => key !== "auth" && key !== "updates");
    element("refresh").disabled = busy;
    element("refresh").setAttribute("aria-busy", String(busy));
  },
  resources: {
    updates: {
      visible: () => !element("version-updates").closest("[hidden]"),
      load: ({ signal }) => readDashboard("/_ccdx/ui/updates", { signal, timeout: 20000, source: "release_status" }),
      apply: updateView.render,
      state: updateView.state,
    },
    status: {
      visible: () => true,
      load: async ({ signal }) => {
        const data = await readDashboard("/_ccdx/status", { signal, timeout: 5000 });
        if (data.ok !== true || data.name !== "codex-copilot-dx") throw new Error("Unexpected status response");
        return data;
      },
      apply: render,
      state: state => {
        if (state.error || !state.value) globalThis.ccdxDashboardActivity?.unavailable();
        text("connection", state.pending && !state.value ? "reading" : state.error ? "unavailable_eb0be" : "service_reachable");
        element("connection").className = `badge ${state.pending ? "neutral" : state.error ? "bad" : "good"}`;
        globalThis.ccdxIcons?.set(element("connection"), state.pending && !state.value ? "reading" : state.error ? "unavailable_eb0be" : "service_reachable",
          state.pending && !state.value ? "unknown" : state.error ? "unavailable" : "running");
        if (state.error) refreshTime(element("updated"), state);
        for (const node of timestamps.get("status")) refreshTime(node, state);
      },
    },
    auth: {
      visible: () => true,
      load: ({ signal }) => readDashboard("/_ccdx/ui/providers", { signal, timeout: 5000, source: "provider_status" }),
      apply: applyProviders,
      state: state => {
        if (state.error) {
          if (state.value) localize(element("source-status-note"), "update_failed_last_time", { time: new Date(state.updatedAt).toLocaleTimeString() });
          else text("source-status-note", "unavailable_eb0be");
        } else element("source-status-note").textContent = "";
        for (const node of timestamps.get("auth")) refreshTime(node, state);
      },
    },
    models: {
      visible: () => providerEntries.length > 0 && element("upstream-models").open && !element("upstream-models").closest("[hidden]"),
      variant: () => selectedProvider,
      load: async ({ signal, variant }) => {
        if (!variant) throw new Error("reading_provider_catalog");
        const data = await readDashboard(`/_ccdx/ui/models/live?provider=${encodeURIComponent(variant)}`, { signal, source: ["live", "catalog"] });
        if (!Array.isArray(data.models) || data.models.some(model => !model || typeof model.id !== "string" || !Array.isArray(model.endpoints))) throw new Error("Invalid model snapshot");
        return { ...data, provider: variant };
      },
      project: data => [data.provider, data.models, data.selectable, data.advertised, data.upstream_host],
      apply: applyModels,
      state: state => {
        element("refresh-models").disabled = Boolean(state.pending);
        text("models-state", state.pending ? "checking_live" : state.error ? "live_lookup_failed" : state.value?.source === "catalog" ? "catalog_snapshot" : "live_snapshot");
        element("model-check-details").hidden = !state.error;
        if (state.error) {
          const message = String(state.error.message || state.error).slice(0, 240);
          const httpError = /^Live model lookup failed \(HTTP (\d{3})\)\. Run ccdx models for details\.$/.exec(message);
          const sourceReason = /^Model catalog unavailable \/ (m365_[a-z0-9_]+)$/.exec(message);
          const diagnostic = state.error.diagnostic || {}, network = diagnostic.network;
          const reason = network ? phrase(`network_cause_${network.cause_code}`) : httpError ? phrase("live_model_lookup_failed_http_status_run_ccdx_models_for_details", { status: httpError[1] })
            : sourceReason ? phrase("source_catalog_unavailable", { code: sourceReason[1] }) : phrase(message);
          const source = providerEntries.find(entry => entry.id === selectedProvider)?.name || selectedProvider;
          const previous = modelSnapshots.get(selectedProvider);
          element("models-note").removeAttribute("data-i18n");
          element("models-note").replaceChildren();
          const summary = document.createElement("span"), kept = document.createElement("span");
          localize(summary, "source_check_failed", { source });
          localize(kept, previous?.checked_at ? "source_check_previous" : "source_check_none", { time: previous?.checked_at ? new Date(previous.checked_at).toLocaleTimeString() : "" });
          element("models-note").append(summary, document.createElement("br"), kept);
          const fields = element("model-check-fields");fields.replaceChildren();
          for (const [key, value] of [["source", source], ["source_check_time", diagnostic.checked_at], ["source_check_reason", reason],
            ["network_route_source", network ? phrase(`network_source_${network.source}`) : null],
            ["network_failure_stage", network ? phrase(`network_stage_${network.stage}`) : null],
            ["network_cause_code", network?.cause_code], ["http_status", diagnostic.http_status]]) {
            if (value === null || value === undefined || value === "") continue;
            const term = document.createElement("dt"), detail = document.createElement("dd");localize(term, key);
            if (value?.key) localize(detail, value.key, value.values);else detail.textContent = String(value).slice(0, 300);
            fields.append(term, detail);
          }
          if (Number.isFinite(diagnostic.retry_after_ms) && diagnostic.retry_after_ms > 0) {
            const term = document.createElement("dt"), detail = document.createElement("dd");localize(term, "retry");
            const checked = Date.parse(diagnostic.checked_at);
            if (Number.isFinite(checked)) { localize(detail, "source_retry_time", { time: new Date(checked + diagnostic.retry_after_ms).toLocaleTimeString() });fields.append(term, detail); }
          }
        }
        if (state.error && !modelSnapshots.has(selectedProvider)) emptyTable("live-models-body", 6, "no_catalog_available");
        for (const node of timestamps.get("models")) refreshTime(node, state);
      },
    },
    usage: {
      visible: () => element("model-usage").open && !element("model-usage").closest("[hidden]"),
      variant: () => {
        const mode = ((element("model-usage").open && element("usage-analytics").open) || Boolean(usageView.selectedDate)) ? "analytics" : "summary";
        const provider = element("usage-provider")?.value || "";
        return mode + (provider ? `:${provider}` : "");
      },
      load: async ({ variant, signal }) => {
        const [mode, provider = ""] = variant.split(":"), query = new URLSearchParams();
        if (mode === "analytics") { query.set("analytics", "1");query.set("time_zone", Intl.DateTimeFormat().resolvedOptions().timeZone); }
        if (provider) query.set("provider", provider);
        const data = await readDashboard(`/_ccdx/ui/usage${query.size ? `?${query}` : ""}`, { signal, source: "local_usage_log" });
        if (!data.total || !Array.isArray(data.rows) || (mode === "analytics" && (!Array.isArray(data.analytics?.days) || !data.analytics.days.length))) throw new Error("Invalid usage snapshot");
        return data;
      },
      apply: (data, options) => {
        usageProviders = data.provider && data.provider !== "all" ? { ...usageProviders, ...data.providers } : data.providers || {};
        syncUsageProviders();applyUsage(data, options);
      },
      state: state => {
        element("refresh-usage").disabled = Boolean(state.pending);
        if (element("usage-provider")) element("usage-provider").disabled = Boolean(state.pending);
        if (state.pending) text("usage-state", "reading_log");
        else if (state.error) {
          text("usage-state", "log_unavailable");
          if (element("usage-analytics").open) text("analytics-note", "analytics_unavailable_refresh_usage_to_retry");
          if (!state.value) emptyTable("usage-body", 7, "no_usage_summary_available");
        } else if (state.value) renderUsageState();
        for (const node of timestamps.get("usage")) refreshTime(node, state);
      },
    },
    animation: {
      visible: () => element("animation-settings").open && !element("animation-settings").closest("[hidden]") && !animationSaving,
      variant: () => element("animation-settings").open && !animationFramesLoaded ? "frames" : "metadata",
      project: data => [data.theme, data.source, data.disabled_by_environment, data.themes.map(theme => [theme.id, theme.label, theme.default, Boolean(theme.frames)])],
      load: ({ variant, signal }) => readDashboard(`/_ccdx/ui/animation${variant === "frames" ? "" : "?frames=0"}`, { signal, timeout: 8000 }),
      apply: applyAnimation,
      state: state => {
        if (state.error) {
          text("animation-state", "unavailable_eb0be");
          text("animation-note", String(state.error.message || state.error).slice(0, 180));
        }
        for (const node of timestamps.get("animation")) refreshTime(node, state);
      },
    },
  },
});

const autoRefreshKey = "ccdx.dashboard.autoRefresh";
const updateAutoRefresh = () => {
  element("auto-refresh").setAttribute("aria-pressed", String(dashboardRefresh.automatic));
  text("auto-refresh", dashboardRefresh.automatic ? "auto_refresh_on" : "auto_refresh_off");
};
let automatic = true;
try { automatic = localStorage.getItem(autoRefreshKey) !== "off"; } catch { /* Keep the default when browser storage is unavailable. */ }
dashboardRefresh.setAutomatic(automatic);
updateAutoRefresh();
element("auto-refresh").addEventListener("click", () => {
  dashboardRefresh.setAutomatic(!dashboardRefresh.automatic);
  updateAutoRefresh();
  try { localStorage.setItem(autoRefreshKey, dashboardRefresh.automatic ? "on" : "off"); } catch { /* Keep the current choice. */ }
});
document.addEventListener("visibilitychange", () => dashboardRefresh.visibilityChanged());
window.addEventListener("pagehide", () => { dashboardRefresh.suspend(); stopAnimationPreview();usageView.stopMotion(); });
window.addEventListener("pageshow", () => { dashboardRefresh.resume(); syncAnimationPreview(); });

for (const [id, key] of [["account-authorization", "auth"], ["client-features", "status"], ["request-context", "status"], ["recent-failures", "status"], ["upstream-models", "models"], ["model-usage", "usage"]]) {
  element(id).addEventListener("toggle", () => {
    if (element(id).open) {
      if (id === "request-context") renderContext();
      dashboardRefresh.refresh(key);
    }
  });
}

element("save-animation").addEventListener("click", saveAnimation);
element("check-updates").addEventListener("click", () => dashboardRefresh.refresh("updates", { force: true }));
element("animation-settings").addEventListener("toggle", () => {
  if (element("animation-settings").open) loadAnimation();
  syncAnimationPreview();
});
element("usage-analytics").addEventListener("toggle", () => {
  if (element("usage-analytics").open) usageView.revealChart();else usageView.stopMotion();
  if (element("usage-analytics").open && element("model-usage").open) dashboardRefresh.refresh("usage");
});
for (const id of ["analytics-model", "analytics-range", "analytics-metric", "analytics-view"]) element(id).addEventListener("change", () => {
  renderAnalytics();
  if (usageView.data && usageView.selectedDate) renderUsageTable();
});
element("clear-usage-day").addEventListener("click", () => selectUsageDay(""));
element("usage-provider")?.addEventListener("change", () => { dashboardRefresh.invalidate("usage");dashboardRefresh.refresh("usage", { force: true }); });
element("refresh-models").addEventListener("click", loadModels);
element("refresh-usage").addEventListener("click", loadUsage);
for (const link of document.querySelectorAll("[data-source-link]")) link.addEventListener("click", () => {
  const id = link.dataset.sourceLink === "codex" ? providerEntries.find(provider => provider.clients?.some(client => client.id === "codex" && client.selected))?.id : link.dataset.sourceLink;
  if (providerEntries.some(provider => provider.id === id)) chooseProvider(id);
});
loadAnimation();
refresh();
loadAuth();
animateRefresh();
