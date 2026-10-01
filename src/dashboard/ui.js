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
  const expanded = new Set([...list.querySelectorAll("details[open]")].map((item) => item.dataset.key));
  list.replaceChildren();
  const failures = Array.isArray(recent) ? recent.slice(-10).reverse() : [];
  text("failure-count", `${failures.length} retained / response.failed`);
  if (!failures.length) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No response.failed events recorded.";
    list.append(item);
    return;
  }
  for (const failure of failures) {
    const item = document.createElement("li");
    const details = document.createElement("details");
    details.dataset.key = `${failure.at}/${failure.response_id}/${failure.code}`;
    details.open = expanded.has(details.dataset.key);
    const title = document.createElement("summary");
    title.textContent = `${String(failure.at || "unknown time")} / ${String(failure.model || "unknown_model").slice(0, 80)} / ${String(failure.code || "unknown_error").slice(0, 80)} / ${failure.retried ? "retry attempted" : "no retry"}`;
    const fields = { time: failure.at, model: failure.model, event: failure.event_type, code: failure.code,
      message: failure.message, response_id: failure.response_id, upstream_request_id: failure.upstream_request_id,
      retry: failure.retried ? "attempted (outcome not recorded here)" : "not attempted",
      retry_policy: failure.retry_policy, retry_skipped: failure.retry_skipped };
    const diagnostic = document.createElement("dl");
    diagnostic.className = "failure-detail";
    const lines = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === "") continue;
      const label = document.createElement("dt");
      const content = document.createElement("dd");
      label.textContent = key;
      content.textContent = String(value).slice(0, 500);
      diagnostic.append(label, content);
      lines.push(`${key}: ${content.textContent}`);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy diagnostic";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        copy.textContent = "Copied";
      } catch { copy.textContent = "Copy unavailable"; }
    });
    details.append(title, diagnostic, copy);
    item.append(details);
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
let animationLoading = false;
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
  const includeFrames = element("animation-settings").open;
  if (animationLoading || (includeFrames && animationFramesLoaded)) return;
  animationLoading = true;
  text("animation-state", "READING");
  try {
    const response = await fetch(`/_ccdx/ui/animation${includeFrames ? "" : "?frames=0"}`, { cache: "no-store", headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (includeFrames) {
      buildAnimationOptions(data);
      animationFramesLoaded = true;
    } else { savedAnimation = data.theme; selectedAnimation = data.theme; }
    updateAnimationState();
    text("animation-note", animationNote(data));
  } catch (error) {
    text("animation-state", "UNAVAILABLE");
    text("animation-note", String(error.message || error).slice(0, 180));
  } finally {
    animationLoading = false;
    if (!includeFrames && element("animation-settings").open) loadAnimation();
  }
}

function updateAnimationState() {
  text("animation-state", `CURRENT ${savedAnimation.toUpperCase()}${selectedAnimation !== savedAnimation ? " / UNSAVED" : ""}`);
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
    updateAnimationState();
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
    ? `${row.cache_hit_rate_partial ? "~" : ""}${(row.cache_hit_rate * 100).toFixed(1)}%` : "—";
  return [row.model, number(row.requests), number(row.input_tokens), number(row.cache_read_tokens), number(row.output_tokens), number(row.total_tokens), rate];
}

let usageData = null;
let usageLoading = false;
let selectedUsageDate = "";

function renderUsageTable() {
  const day = selectedUsageDate && usageData.analytics?.days.find((entry) => entry.date === selectedUsageDate);
  const model = element("analytics-model").value;
  const total = day ? { model: "TOTAL", ...analyticsPoint(day, model) } : usageData.total;
  const rows = day ? day.models.filter((row) => !model || row.model === model).sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model)) : usageData.rows;
  const body = element("usage-body");
  body.replaceChildren();
  if (total.requests > 0) {
    body.append(tableRow(usageValues(total), { total: true }));
    for (const row of rows) body.append(tableRow(usageValues(row)));
  } else { emptyTable("usage-body", 7, "No usage records."); }
  element("clear-usage-day").hidden = !day;
  text("usage-state", day ? day.date : "LOCAL LOG");
  text("usage-note", `${number(total.requests)} records / ${number(rows.length)} of ${number(day ? rows.length : usageData.model_count)} models shown${day ? ` / ${usageData.analytics.time_zone} / ${model || "All models"}` : ""}`);
}

function analyticsPoint(day, model) {
  return model ? day.models.find((row) => row.model === model) || { requests: 0, input_tokens: 0, output_tokens: 0 } : day;
}

function selectUsageDay(date) {
  selectedUsageDate = date;
  renderUsageTable();
  renderAnalytics();
}

function dayButton(day, point) {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = !day.available;
  button.setAttribute("aria-pressed", String(day.date === selectedUsageDate));
  const description = !day.available ? "no retained history"
    : `${number(point.requests)} recorded calls / input ${number(point.input_tokens)} / output ${number(point.output_tokens)} / cached ${number(point.cache_read_tokens)} (included in input)${point.tokens_partial ? " / partial token counts" : ""}`;
  button.title = `${day.date} / ${description}`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", () => selectUsageDay(day.date));
  return button;
}

function renderAnalytics() {
  const analytics = usageData?.analytics;
  if (!analytics) return;
  const model = element("analytics-model").value;
  const days = analytics.days;
  const daily = days.slice(-Number(element("analytics-range").value));
  const maximum = Math.max(1, ...daily.map((day) => {
    const point = analyticsPoint(day, model);
    return point.input_tokens + point.output_tokens;
  }));
  const bars = element("daily-bars");
  bars.replaceChildren();
  for (const day of daily) {
    const point = analyticsPoint(day, model);
    const button = dayButton(day, point);
    button.className = "daily-bar";
    for (const key of ["output_tokens", "input_tokens"]) {
      const segment = document.createElement("span");
      segment.className = key === "input_tokens" ? "bar-input" : "bar-output";
      segment.style.height = `${point[key] / maximum * 100}%`;
      button.append(segment);
    }
    bars.append(button);
  }
  text("daily-from", daily[0].date);
  text("daily-to", analytics.to);
  const metric = element("analytics-metric").value;
  const value = (day) => {
    const point = analyticsPoint(day, model);
    return metric === "tokens" ? point.input_tokens + point.output_tokens : point.requests;
  };
  const peak = Math.max(1, ...days.map(value));
  text("activity-scale", `${metric === "tokens" ? "INPUT + OUTPUT" : "RECORDED CALLS"} / PEAK ${number(peak === 1 && days.every((day) => value(day) === 0) ? 0 : peak)}`);
  const calendar = element("activity-calendar");
  calendar.replaceChildren();
  const offset = (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const months = element("calendar-months");
  months.replaceChildren();
  const columns = Math.ceil((offset + days.length) / 7);
  let previousColumn = -4;
  days.forEach((day, index) => {
    if (index !== 0 && !day.date.endsWith("-01")) return;
    const column = Math.floor((offset + index) / 7);
    if (column - previousColumn < 4 || column + 4 > columns) return;
    previousColumn = column;
    const label = document.createElement("span");
    label.textContent = day.date.slice(0, 7);
    label.style.gridColumn = `${column + 1} / span 4`;
    months.append(label);
  });
  for (let index = 0; index < offset; index += 1) {
    const spacer = document.createElement("span");
    spacer.setAttribute("aria-hidden", "true");
    calendar.append(spacer);
  }
  for (const day of days) {
    const button = dayButton(day, analyticsPoint(day, model));
    button.className = "calendar-day";
    const count = value(day);
    button.dataset.level = String(count > 0 ? Math.min(4, Math.ceil(count / peak * 4)) : 0);
    calendar.append(button);
  }
  text("analytics-note", `${analytics.time_zone} / ${daily[0].date} — ${analytics.to} / retained history starts ${analytics.first_date || "unknown"}; oldest day may be partial.${analytics.undated_records ? ` ${number(analytics.undated_records)} records with invalid/future timestamps excluded.` : ""}${analytics.models_truncated ? " Model filters limited to 100; all-model totals include the remainder." : ""}`);
  text("analytics-selection", selectedUsageDate ? `Selected ${selectedUsageDate} / ${model || "All models"}: totals in the Usage table above / All history resets the table.` : "Select a day for model totals. Calls are usage records, not messages or time. Hatched cells: no retained history; empty cells: zero recorded calls.");
}

function updateAnalyticsModels() {
  const select = element("analytics-model");
  const previous = select.value;
  select.replaceChildren();
  for (const model of ["", ...usageData.analytics.models]) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model || "All models";
    select.append(option);
  }
  select.value = usageData.analytics.models.includes(previous) ? previous : "";
}

async function loadUsage() {
  if (usageLoading) return;
  usageLoading = true;
  const includeAnalytics = element("usage-analytics").open || Boolean(selectedUsageDate);
  const button = element("refresh-usage");
  button.disabled = true;
  text("usage-state", "READING LOG");
  text("usage-note", "Aggregating local usage metadata…");
  emptyTable("usage-body", 7, "Loading…");
  try {
    const query = includeAnalytics ? `?analytics=1&time_zone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}` : "";
    const response = await fetch(`/_ccdx/ui/usage${query}`, { cache: "no-store", headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || data.source !== "local_usage_log") throw new Error(data.error || `HTTP ${response.status}`);
    usageData = data;
    if (data.analytics) updateAnalyticsModels();
    renderUsageTable();
    renderAnalytics();
  } catch (error) {
    text("usage-state", "LOG UNAVAILABLE");
    text("usage-note", String(error.message || error).slice(0, 180));
    emptyTable("usage-body", 7, "No usage summary available.");
    if (includeAnalytics) text("analytics-note", "Analytics unavailable / refresh Usage to retry.");
  } finally {
    usageLoading = false;
    button.disabled = false;
    if (!includeAnalytics && element("usage-analytics").open) loadUsage();
  }
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
  if (element("usage-analytics").open && !usageData?.analytics) loadUsage();
});
for (const id of ["analytics-model", "analytics-range", "analytics-metric"]) element(id).addEventListener("change", () => {
  renderAnalytics();
  if (usageData && selectedUsageDate) renderUsageTable();
});
element("clear-usage-day").addEventListener("click", () => selectUsageDay(""));
element("refresh-models").addEventListener("click", loadModels);
element("refresh-usage").addEventListener("click", loadUsage);
loadAnimation();
loadModels();
loadUsage();
