const element = (id) => document.getElementById(id);
const text = (id, value) => { element(id).textContent = value; };
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const number = (value) => finite(value) ? Math.max(0, Math.round(Number(value))).toLocaleString() : "—";
const mib = (value) => finite(value) ? `${(Number(value) / 1048576).toFixed(1)} MiB` : "—";

function duration(value) {
  if (!finite(value)) return "—";
  const seconds = Math.max(0, Math.round(Number(value) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderFailures(recent) {
  const list = element("failures");
  list.replaceChildren();
  const failures = Array.isArray(recent) ? recent.slice(-5).reverse() : [];
  if (!failures.length) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No response.failed events recorded.";
    list.append(item);
    return;
  }
  for (const failure of failures) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    title.textContent = `${String(failure.model || "unknown_model").slice(0, 80)} / ${String(failure.code || "unknown_error").slice(0, 80)}`;
    detail.textContent = `${String(failure.message || "No message").slice(0, 240)}${failure.retried ? " / retried" : ""}`;
    item.append(title, detail);
    list.append(item);
  }
}

function render(data) {
  text("version", `v${data.version || "?"}`);
  text("uptime", `pid ${number(data.pid)} / uptime ${duration(data.uptime_ms)}`);

  const copilot = data.copilot || {};
  text("copilot", copilot.account_bound ? "BOUND" : "UNCONFIRMED");
  text("token", copilot.token_cached ? `service token / TTL ${duration(copilot.token_expires_in_ms)}` : "service token not cached");

  const models = data.models || {};
  text("models", number(models.models));
  text("model-source", `source ${String(models.source || "unknown").slice(0, 80)} / live: ccdx models`);

  const requests = data.requests || {};
  text("requests", number(requests.total));
  text("request-errors", `4xx ${number(requests.status_4xx)} / 5xx ${number(requests.status_5xx)} / active ${number(requests.active)}`);
  text("body-limits", `raw ${mib(data.limits?.max_body_bytes)} / decoded ${mib(data.limits?.max_decoded_body_bytes)}`);

  const outcomes = data.stream_performance?.by_route?.responses?.terminal_outcomes?.totals || {};
  for (const key of ["completed", "incomplete", "failed", "cancelled"]) text(key, number(outcomes[key]));

  const history = data.response_history || {};
  const limit = Number(history.maxBytes || data.limits?.response_history_max_bytes || 0);
  const used = Number(history.bytes || 0);
  text("history", `${mib(used)} / ${mib(limit)}`);
  text("history-detail", `entries ${number(history.entries)} / trees ${number(history.tree_count)} / misses ${number(history.lookup_misses)} (evicted ${number(history.evicted_lookup_misses)})`);
  element("history-meter").value = limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : 0;

  const image = data.image_generation;
  text("image", image ? `${number(image.succeeded)} succeeded` : "NOT INITIALIZED");
  text("image-detail", image
    ? `active ${number(image.active)} / failed ${number(image.failed)} / delivery failures ${number(image.delivery_failures)}`
    : "Setup state unknown / ccdx image-status");

  renderFailures(data.response_failures?.recent);
  text("updated", `Snapshot ${new Date().toLocaleTimeString()}`);
}

async function refresh() {
  const button = element("refresh");
  button.disabled = true;
  text("connection", "READING");
  element("connection").className = "badge neutral";
  try {
    const response = await fetch("/_ccdx/status", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data?.ok !== true || data?.name !== "codex-copilot-dx") throw new Error("Unexpected status response");
    render(data);
    text("connection", "LOCAL OK");
    element("connection").className = "badge good";
  } catch {
    text("connection", "UNAVAILABLE");
    element("connection").className = "badge bad";
    text("updated", "Status unavailable / check ccdx, then refresh");
  } finally {
    button.disabled = false;
  }
}

element("refresh").addEventListener("click", refresh);
refresh();

const animationRows = new Map();
let animationTimelines = [];
let savedAnimation = "";
let selectedAnimation = "";
let previewDisabledByEnvironment = false;
let previewVisible = false;
let previewTimer = null;
let previewStarted = 0;
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
  if (!previewVisible || document.visibilityState !== "visible" || reducedMotion.matches || previewDisabledByEnvironment) return;
  renderAnimationFrames(performance.now() - previewStarted);
  previewTimer = setTimeout(tickAnimationPreview, 32);
}

function syncAnimationPreview() {
  stopAnimationPreview();
  if (!previewVisible || document.visibilityState !== "visible" || reducedMotion.matches || previewDisabledByEnvironment) {
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
      syncAnimationPreview();
    });
    const name = document.createElement("span");
    name.className = "theme-name";
    name.textContent = `${String(index + 1).padStart(2, "0")} ${theme.label}`;
    if (theme.default) {
      const marker = document.createElement("small");
      marker.textContent = "DEFAULT";
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

async function loadAnimation() {
  text("animation-state", "READING");
  try {
    const response = await fetch("/_ccdx/ui/animation", { cache: "no-store", headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    buildAnimationOptions(data);
    text("animation-state", `CURRENT ${data.theme.toUpperCase()}`);
    text("animation-note", animationNote(data));
  } catch (error) {
    text("animation-state", "UNAVAILABLE");
    text("animation-note", String(error.message || error).slice(0, 180));
  }
}

async function saveAnimation() {
  const button = element("save-animation");
  if (!selectedAnimation || selectedAnimation === savedAnimation) return;
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
    text("animation-state", `CURRENT ${data.theme.toUpperCase()}`);
    text("animation-note", animationNote(data));
  } catch (error) {
    text("animation-note", `Not saved / ${String(error.message || error).slice(0, 150)}`);
  } finally {
    button.disabled = selectedAnimation === savedAnimation;
  }
}

function emptyTable(bodyId, columns, message) {
  const body = element(bodyId);
  body.replaceChildren();
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = columns;
  cell.textContent = message;
  row.append(cell);
  body.append(row);
}

function tableRow(values, { total = false } = {}) {
  const row = document.createElement("tr");
  if (total) row.className = "total-row";
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
  }
  return row;
}

async function loadModels() {
  const button = element("refresh-models");
  button.disabled = true;
  text("models-state", "CHECKING LIVE");
  text("models-note", "Querying GitHub Copilot…");
  emptyTable("live-models-body", 4, "Loading…");
  try {
    const response = await fetch("/_ccdx/ui/models/live", { cache: "no-store", headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || data.source !== "live") throw new Error(data.error || `HTTP ${response.status}`);
    const body = element("live-models-body");
    body.replaceChildren();
    for (const model of data.models) {
      body.append(tableRow([model.id, model.vendor, model.endpoints.join(" / "), model.preview ? "preview" : "—"]));
    }
    if (!data.models.length) emptyTable("live-models-body", 4, "No selectable GPT models advertised.");
    text("models-state", "LIVE SNAPSHOT");
    text("models-note", `${number(data.selectable)} selectable / ${number(data.advertised)} advertised / ${data.upstream_host} / ${new Date(data.checked_at).toLocaleTimeString()}`);
  } catch (error) {
    text("models-state", "LIVE LOOKUP FAILED");
    text("models-note", String(error.message || error).slice(0, 240));
    emptyTable("live-models-body", 4, "No live catalog available.");
  } finally {
    button.disabled = false;
  }
}

function usageValues(row) {
  const rate = Number.isFinite(row.cache_hit_rate) && row.cache_hit_rate >= 0 && row.cache_hit_rate <= 1
    ? `${(row.cache_hit_rate * 100).toFixed(1)}%` : "—";
  return [row.model, number(row.requests), number(row.input_tokens), number(row.cache_read_tokens), number(row.output_tokens), number(row.total_tokens), rate];
}

async function loadUsage() {
  const button = element("refresh-usage");
  button.disabled = true;
  text("usage-state", "READING LOG");
  text("usage-note", "Aggregating local usage metadata…");
  emptyTable("usage-body", 7, "Loading…");
  try {
    const response = await fetch("/_ccdx/ui/usage", { cache: "no-store", headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || data.source !== "local_usage_log") throw new Error(data.error || `HTTP ${response.status}`);
    const body = element("usage-body");
    body.replaceChildren();
    if (data.total.requests > 0) {
      body.append(tableRow(usageValues(data.total), { total: true }));
      for (const row of data.rows) body.append(tableRow(usageValues(row)));
    } else {
      emptyTable("usage-body", 7, "No usage records.");
    }
    text("usage-state", "LOCAL LOG");
    text("usage-note", `${number(data.total.requests)} records / ${number(data.rows.length)} of ${number(data.model_count)} models shown`);
  } catch (error) {
    text("usage-state", "LOG UNAVAILABLE");
    text("usage-note", String(error.message || error).slice(0, 180));
    emptyTable("usage-body", 7, "No usage summary available.");
  } finally {
    button.disabled = false;
  }
}

element("save-animation").addEventListener("click", saveAnimation);
element("refresh-models").addEventListener("click", loadModels);
element("refresh-usage").addEventListener("click", loadUsage);
loadAnimation();
loadModels();
loadUsage();
