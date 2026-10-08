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
let authLoading = false;
let contextRequests = [];
let contextCompactions = {};

function renderAuth(data) {
  const account = data.login ? `@${data.login}` : data.id ? `ID ${data.id}` : phrase("account unknown");
  const label = data.reason === "credential_read_failed" ? "UNAVAILABLE"
    : !data.configured ? "NOT CONFIGURED" : !data.valid ? "INVALID" : "SAVED";
  text("auth-account", label === "SAVED" ? "GitHub / {account} / SAVED" : `GitHub / ${label}`, { account });
}

async function loadAuth() {
  if (authLoading) return;
  authLoading = true;
  text("auth-account", "GitHub / READING");
  try {
    const response = await fetch("/_ccdx/ui/auth", { cache: "no-store", headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    if (!response.ok || data.source !== "local_auth_status") throw new Error("Auth status unavailable");
    renderAuth(data);
  } catch {
    text("auth-account", "GitHub / UNAVAILABLE");
  } finally { authLoading = false; }
}

function duration(value) {
  if (!finite(value)) return "—";
  const seconds = Math.max(0, Math.round(Number(value) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderFailures(recent, recentRequests = []) {
  const list = element("failures");
  const expanded = new Set([...list.querySelectorAll("details[open]")].map((item) => item.dataset.key));
  list.replaceChildren();
  const requests = Array.isArray(recentRequests) ? recentRequests.slice(-20) : [];
  const byRequest = new Map(requests.filter((request) => request.request_id).map((request) => [request.request_id, request]));
  const failures = Array.isArray(recent) ? recent.slice(-10).map((failure) => ({ ...failure, timeline: byRequest.get(failure.request_id) })) : [];
  const recorded = new Set(failures.map((failure) => failure.request_id).filter(Boolean));
  for (const request of requests) {
    if (!request.failed || recorded.has(request.request_id)) continue;
    failures.push({ at: request.at, model: request.model, request_id: request.request_id,
      event_type: `request.${request.outcome}`, code: request.origin, timeline: request,
      message: "Request ended without successful completion.", local_message: true, retried: request.upstream_attempts > 1 });
  }
  failures.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  failures.splice(0, Math.max(0, failures.length - 10));
  failures.reverse();
  text("failure-count", "{count} retained / requests + events", { count: failures.length });
  if (!failures.length) {
    const item = document.createElement("li");
    item.className = "empty";
    localize(item, "No recent request failures recorded.");
    list.append(item);
    return;
  }
  for (const failure of failures) {
    const item = document.createElement("li");
    const details = document.createElement("details");
    details.dataset.key = `${failure.at}/${failure.request_id || failure.response_id}/${failure.code}`;
    details.open = expanded.has(details.dataset.key);
    const title = document.createElement("summary");
    localize(title, "{detail} / {retry}", {
      detail: phrase("{time} / {model} / {code}", {
        time: failure.at ? String(failure.at) : phrase("unknown time"),
        model: failure.model ? String(failure.model).slice(0, 80) : phrase("unknown_model"),
        code: failure.code ? String(failure.code).slice(0, 80) : phrase("unknown_error"),
      }),
      retry: phrase(failure.retried ? "retry attempted" : "no retry"),
    });
    const timeline = failure.timeline;
    const timings = timeline?.timings_ms || {};
    const timingText = ["admission", "body", "history", "images", "serialization", "upstream_start", "upstream_headers", "first_output", "last_activity", "terminal", "finished"]
      .filter((key) => finite(timings[key])).map((key) => `${key}=${Number(timings[key]).toFixed(1)}`).join(" / ");
    const fields = { time: failure.at, model: failure.model, event: failure.event_type, code: failure.code,
      message: failure.message, response_id: failure.response_id, upstream_request_id: failure.upstream_request_id,
      retry: failure.retried ? (timeline ? "attempted" : "attempted (outcome not recorded here)") : "not attempted",
      retry_policy: failure.retry_policy, retry_skipped: failure.retry_skipped,
      request_id: failure.request_id, outcome: timeline?.outcome, origin: timeline?.origin,
      phase: timeline?.phase, http_status: timeline?.http_status, upstream_attempts: timeline?.upstream_attempts,
      timings_ms: timingText };
    const diagnostic = document.createElement("dl");
    diagnostic.className = "failure-detail";
    const lines = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === "") continue;
      const label = document.createElement("dt");
      const content = document.createElement("dd");
      localize(label, key);
      const rawValue = String(value).slice(0, 500);
      if (key === "retry" || (key === "message" && failure.local_message)) localize(content, rawValue);
      else content.textContent = rawValue;
      diagnostic.append(label, content);
      lines.push(`${key}: ${rawValue}`);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    localize(copy, "Copy diagnostic");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        localize(copy, "Copied");
      } catch { localize(copy, "Copy unavailable"); }
    });
    details.append(title, diagnostic, copy);
    item.append(details);
    list.append(item);
  }
}

function render(data) {
  text("version", `v${data.version || "?"}`);
  text("uptime", "pid {pid} / uptime {duration}", { pid: number(data.pid), duration: duration(data.uptime_ms) });

  const copilot = data.copilot || {};
  text("copilot", copilot.account_bound ? "BOUND" : "UNCONFIRMED");
  text("token", copilot.token_cached ? "service token / TTL {duration}" : "service token not cached", { duration: duration(copilot.token_expires_in_ms) });

  const models = data.models || {};
  text("models", number(models.models));
  text("model-source", "source {source} / live: ccdx models", { source: phrase(String(models.source || "unknown").slice(0, 80)) });

  const requests = data.requests || {};
  text("requests", number(requests.total));
  text("request-errors", "4xx {client} / 5xx {server} / active {active}", { client: number(requests.status_4xx), server: number(requests.status_5xx), active: number(requests.active) });
  text("body-limits", "raw {raw} / decoded {decoded}", { raw: mib(data.limits?.max_body_bytes), decoded: mib(data.limits?.max_decoded_body_bytes) });

  const outcomes = data.stream_performance?.by_route?.responses?.terminal_outcomes?.totals || {};
  for (const key of ["completed", "incomplete", "failed", "cancelled"]) text(key, number(outcomes[key]));

  const history = data.response_history || {};
  const limit = Number(history.maxBytes || data.limits?.response_history_max_bytes || 0);
  const used = Number(history.bytes || 0);
  text("history", `${mib(used)} / ${mib(limit)}`);
  text("history-detail", "entries {entries} / trees {trees} / misses {misses} (evicted {evicted})", { entries: number(history.entries), trees: number(history.tree_count), misses: number(history.lookup_misses), evicted: number(history.evicted_lookup_misses) });
  element("history-meter").value = limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : 0;

  const image = data.image_generation;
  text("image", image ? "{count} succeeded" : "NOT INITIALIZED", { count: number(image?.succeeded) });
  text("image-detail", image
    ? "active {active} / failed {failed} / delivery failures {delivery}"
    : "Setup state unknown / ccdx image-status", { active: number(image?.active), failed: number(image?.failed), delivery: number(image?.delivery_failures) });

  renderFailures(data.response_failures?.recent, data.stream_performance?.recent_requests);
  renderContext(data.stream_performance);
  text("updated", "Snapshot {time}", { time: new Date().toLocaleTimeString() });
}

function renderContext(performance) {
  if (performance !== undefined) {
    contextRequests = Array.isArray(performance?.recent_requests) ? performance.recent_requests.slice(-20).reverse() : [];
    contextCompactions = performance?.by_route?.responses_compact?.terminal_outcomes?.totals || {};
  }
  const body = element("context-body");
  if (!body) return;
  text("context-note", "20 latest finished requests / compactions: {completed} completed, {incomplete} incomplete, {failed} failed", {
    completed: number(contextCompactions.completed), incomplete: number(contextCompactions.incomplete), failed: number(contextCompactions.failed),
  });
  if (element("request-context")?.open === false) return;
  body.replaceChildren();
  for (const request of contextRequests) {
    const context = request.context || {};
    const outcome = ["completed", "incomplete", "failed", "cancelled"].includes(request.outcome)
      ? request.outcome[0].toUpperCase() + request.outcome.slice(1) : "Unknown";
    const ratio = finite(context.input_tokens) && finite(context.context_window_tokens) && Number(context.context_window_tokens) > 0
      ? `${(100 * Number(context.input_tokens) / Number(context.context_window_tokens)).toFixed(1)}%` : "—";
    body.append(tableRow([String(request.model || "unknown").slice(0, 80),
      finite(context.payload_bytes) ? (Number(context.payload_bytes) / 1048576).toFixed(2) : "—",
      number(context.images), number(context.input_tokens), number(context.context_window_tokens), ratio,
      outcome], { labels: [6] }));
  }
  if (!contextRequests.length) emptyTable("context-body", 7, "No observed request metadata.");
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

element("refresh").addEventListener("click", () => { refresh(); loadAuth(); });
element("request-context").addEventListener("toggle", () => { if (element("request-context").open) renderContext(); });
refresh();
loadAuth();

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
  text("animation-state", "CURRENT {theme}{unsaved}", { theme: phrase(savedAnimation.toUpperCase()), unsaved: selectedAnimation !== savedAnimation ? phrase(" / UNSAVED") : "" });
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
    text("animation-note", "Not saved / {error}", { error: String(error.message || error).slice(0, 150) });
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
      body.append(tableRow([model.id, model.vendor, model.endpoints.join(" / "), model.preview ? "preview" : "—"], { labels: [3] }));
    }
    if (!data.models.length) emptyTable("live-models-body", 4, "No selectable GPT models advertised.");
    text("models-state", "LIVE SNAPSHOT");
    text("models-note", "{selectable} selectable / {advertised} advertised / {host} / {time}", { selectable: number(data.selectable), advertised: number(data.advertised), host: data.upstream_host, time: new Date(data.checked_at).toLocaleTimeString() });
  } catch (error) {
    text("models-state", "LIVE LOOKUP FAILED");
    const message = String(error.message || error).slice(0, 240);
    const httpError = /^Live model lookup failed \(HTTP (\d{3})\)\. Run ccdx models for details\.$/.exec(message);
    if (httpError) text("models-note", "Live model lookup failed (HTTP {status}). Run ccdx models for details.", { status: httpError[1] });
    else text("models-note", message);
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
  const total = day ? { ...analyticsPoint(day, model), model: "TOTAL" } : usageData.total;
  const rows = day ? day.models.filter((row) => !model || row.model === model).sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model)) : usageData.rows;
  const body = element("usage-body");
  body.replaceChildren();
  if (total.requests > 0) {
    body.append(tableRow(usageValues(total), { total: true }));
    for (const row of rows) body.append(tableRow(usageValues(row)));
  } else { emptyTable("usage-body", 7, "No usage records."); }
  element("clear-usage-day").hidden = !day;
  text("usage-state", day ? day.date : "LOCAL LOG");
  text("usage-note", "{records} records / {shown} of {models} models shown{day}", {
    records: number(total.requests), shown: number(rows.length), models: number(day ? rows.length : usageData.model_count),
    day: day ? phrase(" / {zone} / {model}", { zone: usageData.analytics.time_zone, model: model || phrase("All models") }) : "",
  });
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
  const description = !day.available ? phrase("no retained history")
    : phrase("{calls} recorded calls / input {input} / output {output} / cached {cached} (included in input){partial}", {
      calls: number(point.requests), input: number(point.input_tokens), output: number(point.output_tokens), cached: number(point.cache_read_tokens), partial: point.tokens_partial ? phrase(" / partial token counts") : "",
    });
  for (const attribute of ["title", "aria-label"]) localize(button, "{date} / {description}", { date: day.date, description }, attribute);
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
  text("activity-scale", "{metric} / PEAK {peak}", { metric: phrase(metric === "tokens" ? "INPUT + OUTPUT" : "RECORDED CALLS"), peak: number(peak === 1 && days.every((day) => value(day) === 0) ? 0 : peak) });
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
  text("analytics-note", "{zone} / {from} — {to} / retained history starts {first}; oldest day may be partial.{excluded}{limit}", {
    zone: analytics.time_zone, from: daily[0].date, to: analytics.to, first: analytics.first_date || phrase("unknown"),
    excluded: analytics.undated_records ? phrase(" {count} records with invalid/future timestamps excluded.", { count: number(analytics.undated_records) }) : "",
    limit: analytics.models_truncated ? phrase(" Model filters limited to 100; all-model totals include the remainder.") : "",
  });
  text("analytics-selection", selectedUsageDate ? "Selected {date} / {model}: totals in the Usage table above / All history resets the table." : "Select a day for model totals. Calls are usage records, not messages or time. Hatched cells: no retained history; empty cells: zero recorded calls.", { date: selectedUsageDate, model: model || phrase("All models") });
}

function updateAnalyticsModels() {
  const select = element("analytics-model");
  const previous = select.value;
  select.replaceChildren();
  for (const model of ["", ...usageData.analytics.models]) {
    const option = document.createElement("option");
    option.value = model;
    if (model) option.textContent = model;
    else localize(option, "All models");
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
