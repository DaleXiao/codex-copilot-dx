(() => {
  const root = document.getElementById("request-flow");
  if (!root) return;
  const el = id => document.getElementById(id), ns = "http://www.w3.org/2000/svg";
  const clients = new Set(["codex_app", "codex_cli", "codex", "claude_app", "claude_code", "claude", "api"]);
  const label = (node, key, values = {}) => globalThis.ccdxLanguage.set(node, key, values);
  const format = (key, values = {}) => globalThis.ccdxLanguage.format(key, values);
  const nodes = { apps: new Map(), models: new Map() };
  let rows = [], total = null, omitted = 0, fresh = false, deadline = 0, expiry = null;
  let selected = null, expanded = false, lastSignature = "", geometry = "", known = false;
  let lastApps = [], lastModels = [];
  const visible = () => document.visibilityState === "visible" && !root.closest("[hidden]");
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const appName = id => format(`flow_app_${id}`);
  const sourceName = id => id === "github" ? "GitHub Copilot" : id === "m365" ? "Microsoft 365" : globalThis.ccdxConnectionNames?.[id] || format("flow_source_unknown");
  const modelName = id => !id || id === "other" ? format("flow_model_unknown") : id;
  const modelKey = row => JSON.stringify([row.provider, row.model]);
  const related = row => !selected || (selected.type === "apps" ? row.application === selected.id : modelKey(row) === selected.id);
  const responding = row => row.first_output_ms !== null && !row.terminal_outcome;
  function status(row) {
    if (row.terminal_outcome) return "flow_finishing";
    if (responding(row)) return "flow_responding";
    if (row.upstream_attempts > 1) return "flow_retrying";
    return row.upstream_attempts ? "flow_waiting" : "flow_preparing";
  }
  function entry(tag, className) { const node = document.createElement(tag);if (className) node.className = className;return node; }
  function svg(tag, values) { const node = document.createElementNS(ns, tag);for (const [key, value] of Object.entries(values)) node.setAttribute(key, value);return node; }
  const logo = el("status-icon")?.cloneNode(true);
  if (logo) { logo.removeAttribute("id");logo.setAttribute("class", "flow-logo");el("flow-hub").prepend(logo); }

  function group(type) {
    const map = new Map();
    for (const row of rows) {
      const id = type === "apps" ? row.application : modelKey(row);
      if (!map.has(id)) map.set(id, { id, provider: row.provider, model: row.model, rows: [] });
      map.get(id).rows.push(row);
    }
    const order = ["codex_app", "codex_cli", "codex", "claude_code", "claude_app", "claude", "api"];
    return [...map.values()].sort((a, b) => type === "apps" ? order.indexOf(a.id) - order.indexOf(b.id) : a.id.localeCompare(b.id));
  }
  function project(type, groups) {
    const target = el(type === "apps" ? "flow-apps" : "flow-models"), cache = nodes[type], fragments = [];
    const ids = new Set(groups.map(group => group.id));
    for (const [id, node] of cache) if (!ids.has(id)) { node.remove();cache.delete(id); }
    for (const group of groups) {
      let node = cache.get(group.id);
      if (!node) {
        node = entry("div", "flow-node");
        const button = entry("button", "flow-choice"), count = entry("span", "flow-count"), note = entry("span", "flow-note");button.type = "button";
        button.addEventListener("click", () => {
          selected = selected?.type === type && selected.id === group.id ? null : { type, id: group.id };
          el("flow-active").open = Boolean(selected);lastSignature = "";render();
        });
        node.append(button, count, note);
        if (type === "models") node.append(entry("span", "flow-source"));
        cache.set(group.id, node);
      }
      const [button, count, note] = node.children;
      button.textContent = type === "apps" ? appName(group.id) : modelName(group.model);
      button.setAttribute("aria-pressed", String(selected?.type === type && selected.id === group.id));
      count.hidden = fresh && omitted === 0 && group.rows.length < 2;
      if (fresh && (group.rows.length || total === 0)) label(count, omitted ? "flow_count_lower" : "flow_count", { count: group.rows.length.toLocaleString() });
      else count.textContent = "—";
      if (type === "models") node.children[3].textContent = sourceName(group.provider);
      const output = group.rows.filter(responding).length;
      const phase = group.rows.every(row => row.terminal_outcome) ? "flow_finishing"
        : group.rows.every(row => row.upstream_attempts > 1) ? "flow_retrying" : "flow_waiting";
      label(note, !fresh || total && !group.rows.length ? "flow_last_observed" : !group.rows.length ? "flow_idle" : output ? group.rows.length === 1 ? "flow_responding" : "flow_group_response" : phase, { count: output });
      node.dataset.related = String(!selected || group.rows.some(related));fragments.push(node);
    }
    // Keep existing buttons and their focus when counts or phases change.
    const wanted = new Set(fragments);
    for (const node of [...target.children]) if (!wanted.has(node)) node.remove();
    fragments.forEach((node, index) => { if (target.children[index] !== node) target.insertBefore(node, target.children[index] || null); });
  }
  function details() {
    label(el("flow-active-title"), fresh ? "flow_active_count" : "flow_last_count", { count: rows.filter(related).length });
    if (!el("flow-active").open) return;
    const body = el("flow-active-body"), records = rows.filter(related);body.replaceChildren();
    for (const row of records) {
      const tr = entry("tr");
      for (const value of [appName(row.application), sourceName(row.provider), modelName(row.model), format(fresh ? status(row) : "flow_last_observed"), `${(row.elapsed_ms / 1000).toFixed(1)} s`, row.upstream_attempts.toLocaleString()]) {
        const td = entry("td");td.textContent = value;tr.append(td);
      }
      body.append(tr);
    }
    if (!records.length) { const tr = entry("tr"), td = entry("td");td.colSpan = 6;label(td, known ? "flow_no_active" : "flow_status_unknown");tr.append(td);body.append(tr); }
  }
  function render() {
    if (!visible()) { root.dataset.paused = "true";return; }
    root.dataset.paused = "false";
    const apps = group("apps"), allModels = group("models");
    if (fresh && rows.length) { lastApps = apps;lastModels = allModels; }
    if (fresh && !rows.length) { for (const groups of [lastApps, lastModels]) for (const group of groups) group.rows = []; }
    const shownApps = apps.length ? apps : lastApps, models = allModels.length ? allModels : lastModels;
    if (selected && !rows.some(related)) selected = null;
    const signature = JSON.stringify([fresh, total, omitted, selected, expanded, rows.map(row => [row.request_id, row.application, row.provider, row.model, row.phase, row.upstream_attempts, row.first_output_ms !== null, row.terminal_outcome])]);
    details();
    if (signature === lastSignature) return;
    lastSignature = signature;
    root.dataset.state = !fresh ? "unknown" : total ? "active" : "idle";
    const state = el("flow-state");
    if (fresh && total === 0) label(state, "flow_idle");
    else globalThis.ccdxIcons?.set(state, !fresh ? "flow_status_unknown" : "flow_total", !fresh ? "unavailable" : "running", { count: total });
    label(el("flow-caption"), !fresh ? "flow_status_unknown" : omitted ? "flow_omitted" : selected ? "flow_related_count" : total ? "flow_group_scope" : "flow_no_active",
      { count: rows.filter(related).length, omitted, apps: apps.length, models: allModels.length });
    el("flow-clear").hidden = !selected;
    el("flow-more").hidden = models.length <= 12;
    label(el("flow-more"), expanded ? "flow_fewer_models" : "flow_more_models", { count: Math.max(0, models.length - 12) });
    project("apps", shownApps);
    project("models", expanded ? models : models.slice(0, 12));
    geometry = "";draw();
  }
  function rounded(x0, y0, x1, y1) {
    if (Math.abs(y1 - y0) < 2) return `M${x0} ${y0}H${x1}`;
    const middle = (x0 + x1) / 2, radius = Math.min(14, (x1 - x0) / 4, Math.abs(y1 - y0) / 2), sign = Math.sign(y1 - y0);
    return `M${x0} ${y0}H${middle - radius}Q${middle} ${y0} ${middle} ${y0 + sign * radius}V${y1 - sign * radius}Q${middle} ${y1} ${middle + radius} ${y1}H${x1}`;
  }
  function draw() {
    if (!visible()) return;
    const network = el("flow-network"), rect = network.getBoundingClientRect(), hub = el("flow-hub").getBoundingClientRect(), edges = [];
    const inset = rect.width < 500 ? 2 : 6;
    if (!rect.width) return;
    for (const type of ["apps", "models"]) for (const [id, node] of nodes[type]) {
      if (!node.isConnected) continue;
      const box = node.getBoundingClientRect(), button = node.children[0].getBoundingClientRect(), left = type === "apps";
      const x0 = (left ? box.right : hub.right) - rect.left + inset, y0 = (left ? button.top + button.height / 2 : hub.top + hub.height / 2) - rect.top;
      const x1 = (left ? hub.left : box.left) - rect.left - inset, y1 = (left ? hub.top + hub.height / 2 : button.top + button.height / 2) - rect.top;
      if (x1 <= x0) continue;
      const matches = rows.filter(row => (left ? row.application : modelKey(row)) === id && related(row));
      edges.push({ d: rounded(x0, y0, x1, y1), active: fresh && matches.length > 0, moving: fresh && matches.some(responding), dim: node.dataset.related === "false", x: left ? x0 : x1, y: left ? y0 : y1, left });
    }
    const next = JSON.stringify([rect.width, rect.height, edges]);if (next === geometry) return;geometry = next;
    const wires = el("flow-wires");wires.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);wires.replaceChildren();
    for (const edge of edges) {
      wires.append(svg("path", { d: edge.d, class: `flow-wire${edge.dim ? " flow-dim" : edge.active ? " flow-live" : ""}` }));
      if (edge.moving) { const dot = svg("circle", { r: 2.4, class: "flow-packet" });dot.style.offsetPath = `path('${edge.d}')`;dot.style.animationDelay = edge.left ? "-.9s" : "0s";wires.append(dot); }
      else if (edge.active) wires.append(svg("circle", { cx: edge.x, cy: edge.y, r: 2.4, class: "flow-wait" }));
    }
  }
  function unavailable() { clearTimeout(expiry);expiry = null;fresh = false;deadline = 0;render(); }
  function visibilityChanged() { if (deadline && Date.now() >= deadline) { unavailable();return; }render();draw(); }
  el("flow-clear").addEventListener("click", () => { selected = null;render(); });
  el("flow-hub").addEventListener("click", () => { selected = null;render(); });
  el("flow-more").addEventListener("click", () => { expanded = !expanded;render(); });
  el("flow-active").addEventListener("toggle", details);
  document.addEventListener("visibilitychange", visibilityChanged);
  globalThis.addEventListener("pagehide", () => { root.dataset.paused = "true"; });
  globalThis.addEventListener("pageshow", visibilityChanged);
  new ResizeObserver(draw).observe(el("flow-network"));
  new MutationObserver(() => { lastSignature = "";render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  globalThis.ccdxDashboardFlow = {
    update(data) {
      const parts = [data?.stream_performance, (data?.providers?.claude || data?.providers?.m365?.claude)?.requests?.performance].filter(Boolean);
      if (!parts.length || parts.some(part => !integer(part.active_total) || !Array.isArray(part.active_requests))) { unavailable();return; }
      const values = parts.flatMap(part => part.active_requests).slice(0, 128);
      rows = values.filter(row => row && typeof row.model === "string" && integer(row.upstream_attempts) && Number.isFinite(row.elapsed_ms) && row.elapsed_ms >= 0).map(row => ({
        request_id: typeof row.request_id === "string" ? row.request_id.slice(0, 80) : null,
        application: clients.has(row.application) ? row.application : "api", provider: typeof row.provider === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(row.provider) ? row.provider : "unknown",
        model: row.model.slice(0, 160), phase: String(row.phase || "").slice(0, 40), elapsed_ms: row.elapsed_ms,
        upstream_attempts: row.upstream_attempts, first_output_ms: Number.isFinite(row.first_output_ms) && row.first_output_ms >= 0 ? row.first_output_ms : null,
        terminal_outcome: ["completed", "incomplete", "failed", "cancelled", "unknown"].includes(row.terminal_outcome) ? row.terminal_outcome : null,
      }));
      total = parts.reduce((sum, part) => sum + part.active_total, 0);
      if (!integer(total) || total < rows.length) { unavailable();return; }
      omitted = total - rows.length;fresh = true;known = true;
      clearTimeout(expiry);deadline = Date.now() + 6000;expiry = setTimeout(unavailable, 6000);render();
    }, unavailable, visibilityChanged,
  };
})();
