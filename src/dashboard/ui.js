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
const viewHelpers = { element, phrase, localize, text, finite, number, mib, tableRow, emptyTable, document, navigator: globalThis.navigator };
const { render, renderAuth, renderFailures, renderContext } = globalThis.ccdxDashboardStatus.create(viewHelpers);
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
  if (!animationTimelines.length || !element("animation-settings").open || !previewVisible || document.visibilityState !== "visible" || reducedMotion.matches || previewDisabledByEnvironment) return;
  renderAnimationFrames(performance.now() - previewStarted);
  previewTimer = setTimeout(tickAnimationPreview, 32);
}

function syncAnimationPreview() {
  stopAnimationPreview();
  if (!animationTimelines.length || !element("animation-settings").open || !previewVisible || document.visibilityState !== "visible" || reducedMotion.matches || previewDisabledByEnvironment) {
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
    localize(label, "{index} {theme}", { index: String(index + 1).padStart(2, "0"), theme: phrase(theme.label) });
    name.append(label);
    if (theme.default) {
      const marker = document.createElement("small");
      localize(marker, "DEFAULT");
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
    ? "Disabled by CCDX_TERMINAL_ANIMATION; saved choice applies after override removal and next start."
    : "Saved choice applies on next ccdx start.";
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
  text("animation-state", "CURRENT {theme}{unsaved}", { theme: phrase(savedAnimation.toUpperCase()), unsaved: selectedAnimation !== savedAnimation ? phrase(" / UNSAVED") : "" });
}

async function saveAnimation() {
  const button = element("save-animation");
  if (!selectedAnimation || selectedAnimation === savedAnimation) return;
  animationSaving = true;
  dashboardRefresh.invalidate("animation");
  button.disabled = true;
  text("animation-note", "Saving…");
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
    text("animation-note", "Not saved / {error}", { error: String(error.message || error).slice(0, 150) });
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

async function loadModels() { return dashboardRefresh.refresh("models", { force: true }); }

function applyModels(data, { changed }) {
  if (changed) {
    const body = element("live-models-body");
    body.replaceChildren();
    for (const model of data.models) {
      body.append(tableRow([model.id, model.vendor, model.endpoints.join(" / "), model.preview ? "preview" : "—"], { labels: [3] }));
    }
    if (!data.models.length) emptyTable("live-models-body", 4, "No selectable GPT models advertised.");
  }
  text("models-note", "{selectable} selectable / {advertised} advertised / {host} / {time}", { selectable: number(data.selectable), advertised: number(data.advertised), host: data.upstream_host, time: data.checked_at ? new Date(data.checked_at).toLocaleTimeString() : phrase("Unknown") });
}

async function loadUsage() { return dashboardRefresh.refresh("usage", { force: true }); }

async function readDashboard(url, { signal, timeout = 15000, source } = {}) {
  const response = await fetch(url, { cache: "no-store", headers: { "X-CCDX-Dashboard": "1", Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
  const data = await response.json();
  if (!response.ok || (source && !(Array.isArray(source) ? source : [source]).includes(data.source))) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function refreshTime(target, state) {
  const time = state.updatedAt === null ? null : new Date(state.updatedAt).toLocaleTimeString();
  if (state.error) localize(target, time ? "Update failed / last {time}" : "Update failed", { time });
  else if (time) localize(target, "Updated {time}", { time });
}

const timestamps = new Map();
for (const [key, ids] of [["status", ["client-features", "request-context", "recent-failures"]], ["models", ["upstream-models"]], ["usage", ["model-usage"]], ["animation", ["animation-settings"]]]) {
  timestamps.set(key, ids.map(id => {
    const node = document.createElement("p");
    node.className = "refresh-time";
    element(id).append(node);
    return node;
  }));
}

const dashboardRefresh = globalThis.ccdxRefresh.createController({
  visible: () => document.visibilityState === "visible",
  onState: ({ pendingKeys }) => {
    // The account read remains independent; it must not block dashboard data.
    const busy = pendingKeys.some(key => key !== "auth");
    element("refresh").disabled = busy;
    element("refresh").setAttribute("aria-busy", String(busy));
  },
  resources: {
    status: {
      visible: () => true,
      load: async ({ signal }) => {
        const data = await readDashboard("/_ccdx/status", { signal, timeout: 5000 });
        if (data.ok !== true || data.name !== "codex-copilot-dx") throw new Error("Unexpected status response");
        return data;
      },
      apply: render,
      state: state => {
        text("connection", state.pending || (!state.value && !state.error) ? "READING" : state.error ? "UNAVAILABLE" : "LOCAL OK");
        element("connection").className = `badge ${state.pending ? "neutral" : state.error ? "bad" : "good"}`;
        if (state.error) refreshTime(element("updated"), state);
        for (const node of timestamps.get("status")) refreshTime(node, state);
      },
    },
    auth: {
      visible: () => true,
      load: ({ signal }) => readDashboard("/_ccdx/ui/auth", { signal, timeout: 5000, source: "local_auth_status" }),
      apply: renderAuth,
      state: state => {
        if (state.value) renderAuth(state.value, { failed: Boolean(state.error) });
        else text("auth-account", state.error ? "GitHub / UNAVAILABLE" : "GitHub / READING");
        if (state.updatedAt !== null) localize(element("auth-account"), "Saved account / updated {time}", { time: new Date(state.updatedAt).toLocaleTimeString() }, "title");
      },
    },
    models: {
      visible: () => element("upstream-models").open,
      load: async ({ signal }) => {
        const data = await readDashboard("/_ccdx/ui/models/live", { signal, source: ["live", "catalog"] });
        if (!Array.isArray(data.models) || data.models.some(model => !model || typeof model.id !== "string" || !Array.isArray(model.endpoints))) throw new Error("Invalid model snapshot");
        return data;
      },
      project: data => [data.models, data.selectable, data.advertised, data.upstream_host],
      apply: applyModels,
      state: state => {
        element("refresh-models").disabled = Boolean(state.pending);
        text("models-state", state.pending ? "CHECKING LIVE" : state.error ? "LIVE LOOKUP FAILED" : state.value?.source === "catalog" ? "CATALOG SNAPSHOT" : "LIVE SNAPSHOT");
        if (state.error) {
          const message = String(state.error.message || state.error).slice(0, 240);
          const httpError = /^Live model lookup failed \(HTTP (\d{3})\)\. Run ccdx models for details\.$/.exec(message);
          if (httpError) text("models-note", "Live model lookup failed (HTTP {status}). Run ccdx models for details.", { status: httpError[1] });
          else text("models-note", message);
        }
        if (state.error && !state.value) emptyTable("live-models-body", 4, "No live catalog available.");
        for (const node of timestamps.get("models")) refreshTime(node, state);
      },
    },
    usage: {
      visible: () => element("model-usage").open,
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
      apply: applyUsage,
      state: state => {
        element("refresh-usage").disabled = Boolean(state.pending);
        if (element("usage-provider")) element("usage-provider").disabled = Boolean(state.pending);
        if (state.pending) text("usage-state", "READING LOG");
        else if (state.error) {
          text("usage-state", "LOG UNAVAILABLE");
          if (element("usage-analytics").open) text("analytics-note", "Analytics unavailable / refresh Usage to retry.");
          if (!state.value) emptyTable("usage-body", 7, "No usage summary available.");
        } else if (state.value) renderUsageState();
        for (const node of timestamps.get("usage")) refreshTime(node, state);
      },
    },
    animation: {
      visible: () => element("animation-settings").open && !animationSaving,
      variant: () => element("animation-settings").open && !animationFramesLoaded ? "frames" : "metadata",
      project: data => [data.theme, data.source, data.disabled_by_environment, data.themes.map(theme => [theme.id, theme.label, theme.default, Boolean(theme.frames)])],
      load: ({ variant, signal }) => readDashboard(`/_ccdx/ui/animation${variant === "frames" ? "" : "?frames=0"}`, { signal, timeout: 8000 }),
      apply: applyAnimation,
      state: state => {
        if (state.error) {
          text("animation-state", "UNAVAILABLE");
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
  text("auto-refresh", dashboardRefresh.automatic ? "Auto refresh / ON" : "Auto refresh / OFF");
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
window.addEventListener("pagehide", () => { dashboardRefresh.suspend(); stopAnimationPreview(); });
window.addEventListener("pageshow", () => { dashboardRefresh.resume(); syncAnimationPreview(); });

for (const [id, key] of [["client-features", "status"], ["request-context", "status"], ["recent-failures", "status"], ["upstream-models", "models"], ["model-usage", "usage"]]) {
  element(id).addEventListener("toggle", () => {
    if (element(id).open) {
      if (id === "request-context") renderContext();
      dashboardRefresh.refresh(key);
    }
  });
}

element("save-animation").addEventListener("click", saveAnimation);
element("animation-settings").addEventListener("toggle", () => {
  element("open-animation").setAttribute("aria-expanded", String(element("animation-settings").open));
  if (element("animation-settings").open) loadAnimation();
  syncAnimationPreview();
});
element("open-animation").addEventListener("click", () => {
  const settings = element("animation-settings");
  settings.open = true;
  settings.scrollIntoView({ block: "center" });
  settings.querySelector("summary").focus();
});
element("usage-analytics").addEventListener("toggle", () => {
  if (element("usage-analytics").open && element("model-usage").open) dashboardRefresh.refresh("usage");
});
for (const id of ["analytics-model", "analytics-range", "analytics-metric"]) element(id).addEventListener("change", () => {
  renderAnalytics();
  if (usageView.data && usageView.selectedDate) renderUsageTable();
});
element("clear-usage-day").addEventListener("click", () => selectUsageDay(""));
element("usage-provider")?.addEventListener("change", () => { dashboardRefresh.invalidate("usage");dashboardRefresh.refresh("usage", { force: true }); });
element("refresh-models").addEventListener("click", loadModels);
element("refresh-usage").addEventListener("click", loadUsage);
loadAnimation();
loadModels();
loadUsage();
refresh();
loadAuth();
animateRefresh();
