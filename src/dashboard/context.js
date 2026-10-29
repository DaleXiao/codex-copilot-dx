(() => {
  const root = document.getElementById("usage-context-pane");
  if (!root) return;
  const el = id => document.getElementById(id), ns = "http://www.w3.org/2000/svg";
  const language = globalThis.ccdxLanguage;
  const label = (node, key, values) => language.set(node, key, values);
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const number = value => valid(value) ? value.toLocaleString() : "—";
  const ratio = (input, total) => valid(input) && valid(total) && total > 0 ? `${(input / total * 100).toFixed(1)}%` : "—";
  const visible = () => document.visibilityState === "visible" && !root.closest("[hidden]");
  let entries = [], selected = null, known = false;
  const name = entry => language.format(entry.identified ? "context_conversation" : "context_request", { id: entry.id.split("-").at(-1) });
  const app = entry => language.format(`flow_app_${entry.application}`);
  const latest = entry => entry.points.at(-1) || entry.compactions.at(-1) || {};
  const time = value => globalThis.ccdxTime?.format(value) || "—";
  function cell(row, value) { const cell = document.createElement("td");cell.textContent = value;row.append(cell);return cell; }
  function chart(entry) {
    const host = el("context-history-chart");host.replaceChildren();
    const points = entry.points;
    if (!points.some(point => valid(point.input_tokens))) { label(host, "context_no_input");return; }
    if (!entry.identified) { label(host, "context_unassigned");return; }
    const width = host.clientWidth;if (!width) return;
    const height = 210, left = 64, right = 12, top = 25, bottom = 35;
    const measured = Math.max(...points.map(point => valid(point.input_tokens) ? point.input_tokens : 0), 1);
    const maximum = Math.max(measured, latest(entry).context_window_tokens || 0);
    const x = index => left + (width - left - right) * index / Math.max(1, points.length - 1);
    const y = value => top + (height - top - bottom) * (1 - value / maximum);
    const svg = document.createElementNS(ns, "svg");svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");svg.setAttribute("aria-label", language.format("context_history"));host.append(svg);
    const shape = (tag, attributes, text) => {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      if (text !== undefined) node.textContent = text;svg.append(node);return node;
    };
    for (let index = 0; index <= 2; index++) {
      const value = maximum * index / 2, py = y(value);
      shape("line", { x1: left, x2: width - right, y1: py, y2: py, class: "context-grid" });
      shape("text", { x: left - 8, y: py + 4, "text-anchor": "end" }, Math.round(value).toLocaleString());
    }
    shape("text", { x: left, y: 12 }, "tokens");
    let path = "", continuing = false;
    points.forEach((point, index) => {
      if (!valid(point.input_tokens)) { continuing = false;return; }
      path += `${continuing ? "L" : "M"}${x(index)} ${y(point.input_tokens)} `;continuing = true;
      const dot = shape("circle", { cx: x(index), cy: y(point.input_tokens), r: 3, class: "context-point" });
      const title = document.createElementNS(ns, "title");title.textContent = `${time(point.at)} · ${number(point.input_tokens)} tokens`;dot.append(title);
    });
    if (!entry.concurrent) shape("path", { d: path, class: "context-line" });
    for (const index of new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])) {
      shape("text", { x: x(index), y: height - 14, "text-anchor": index === 0 ? "start" : "end" }, String(index + 1));
    }
    for (const compact of entry.compactions) {
      const index = points.findIndex(point => point.order >= compact.order);
      if (index < 0 || compact.outcome !== "completed") continue;
      const px = x(index);shape("line", { x1: px, x2: px, y1: top, y2: height - bottom, class: "context-compact" });
    }
  }
  function render() {
    if (!visible()) return;
    const body = el("context-sessions");body.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement("tr"), button = document.createElement("button");button.type = "button";
      button.className = "context-session";label(button, entry.identified ? "context_conversation" : "context_request", { id: entry.id.split("-").at(-1) });
      button.setAttribute("aria-pressed", String(selected === entry.id));
      button.addEventListener("click", () => { selected = entry.id;render(); });cell(row, "").append(button);
      cell(row, app(entry));cell(row, entry.model || "—");const point = latest(entry);
      cell(row, ratio(point.input_tokens, point.context_window_tokens));body.append(row);
    }
    const entry = entries.find(entry => entry.id === selected);
    el("context-selection").hidden = !entry;
    if (!entry) {
      if (known) { const row = document.createElement("tr"), empty = cell(row, language.format("context_empty"));empty.colSpan = 4;body.append(row); }
      return;
    }
    label(el("context-selection-title"), entry.identified ? "context_conversation" : "context_request", { id: entry.id.split("-").at(-1) });
    el("context-selection-source").textContent = entry.provider === "github" ? "GitHub Copilot" : entry.provider === "m365" ? "Microsoft 365" : globalThis.ccdxConnectionNames?.[entry.provider] || language.format("flow_source_unknown");
    const point = latest(entry);
    el("context-latest-input").textContent = number(point.input_tokens);
    el("context-window").textContent = valid(point.context_window_tokens) && point.context_window_tokens > 0 ? number(point.context_window_tokens) : language.format("unknown");
    el("context-share").textContent = ratio(point.input_tokens, point.context_window_tokens);
    el("context-reuse").textContent = ratio(point.cached_input_tokens, point.input_tokens);
    label(el("context-history-note"), entry.concurrent ? "context_concurrent" : "context_request_order");chart(entry);
    const compactions = el("context-compactions");compactions.replaceChildren();
    for (const compact of entry.compactions) {
      const row = document.createElement("tr");cell(row, time(compact.at));const result = cell(row, "");
      label(result, ["completed", "incomplete", "failed", "cancelled"].includes(compact.outcome) ? compact.outcome : "unknown");
      cell(row, Number.isFinite(compact.elapsed_ms) ? `${(compact.elapsed_ms / 1000).toFixed(1)} s` : "—");compactions.append(row);
    }
    if (!entry.compactions.length) { const row = document.createElement("tr"), empty = cell(row, language.format("context_no_compactions"));empty.colSpan = 3;compactions.append(row); }
  }
  const tokensTab = el("usage-tokens-tab"), contextTab = el("usage-context-tab");
  function select(context) {
    root.hidden = !context;el("usage-tokens-pane").hidden = context;
    tokensTab.setAttribute("aria-selected", String(!context));contextTab.setAttribute("aria-selected", String(context));
    tokensTab.tabIndex = context ? -1 : 0;contextTab.tabIndex = context ? 0 : -1;
    render();window.dispatchEvent(new CustomEvent("ccdx:context-view"));
  }
  tokensTab.addEventListener("click", () => select(false));contextTab.addEventListener("click", () => select(true));
  for (const tab of [tokensTab, contextTab]) tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();const context = event.key === "Home" ? false : event.key === "End" ? true : root.hidden;
    select(context);(context ? contextTab : tokensTab).focus();
  });
  contextTab.tabIndex = -1;
  new ResizeObserver(() => { const entry = entries.find(entry => entry.id === selected);if (entry && visible()) chart(entry); }).observe(el("context-history-chart"));
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  globalThis.ccdxContextView = {
    visible,
    apply(data) {
      if (!Array.isArray(data.sessions) || !Array.isArray(data.unassigned)) throw Error("Invalid context snapshot");
      entries = [...data.sessions.slice(0, 128).map(entry => ({ ...entry, identified: true })),
        ...data.unassigned.slice(0, 40).map(point => ({ ...point, identified: false, concurrent: false,
          points: point.compact ? [] : [point], compactions: point.compact ? [point] : [] }))];
      entries.sort((a, b) => Date.parse(latest(b).at) - Date.parse(latest(a).at));
      if (!entries.some(entry => entry.id === selected)) selected = entries[0]?.id || null;
      known = true;render();
    },
    state(state) {
      label(el("context-view-state"), state.error ? "context_read_failed" : state.pending ? "reading" : "context_scope");
    },
    routeChanged() { render();if (visible()) window.dispatchEvent(new CustomEvent("ccdx:context-view")); },
  };
})();
