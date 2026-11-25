(() => {
  const root = document.getElementById("tool-activity");if (!root) return;
  const el = id => document.getElementById(id), canvas = el("tool-canvas"), ctx = canvas.getContext?.("2d");
  const styles = new Set(["production", "clock", "assembly", "sorter", "gantry", "rotary", "arm", "off"]), storageKey = "ccdx.dashboard.toolMotionStyle";
  const pending = state => ["preparing", "waiting"].includes(state);
  const phrase = (key, values = {}) => globalThis.ccdxLanguage.format(key, values);
  const text = (id, key, values) => globalThis.ccdxLanguage.set(el(id), key, values);
  const state = { scene: "idle", style: "production" };
  const dashboardScript = document.currentScript.src;
  const renderers = new Map();
  const rendererName = () => state.style === "arm" ? "arm" : "machines";
  try { const saved = localStorage.getItem(storageKey);if (styles.has(saved)) state.style = saved; } catch {}
  const motion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") || { matches: false, addEventListener() {} };
  let records = [], fresh = false, supported = false, visible = true, raf = 0, last = 0, start = performance.now(), expiry = null;
  let drawnTime = null;
  let visibleToolRows = new Map();
  let signature = "", box = { width: 0, height: 0 }, color = "", surface = "", omitted = 0, requests = [], requestDeadline = 0;
  const animating = () => ["calling", "parallel", "waiting", "processing", "responding"].includes(state.scene);
  const shown = () => document.visibilityState === "visible" && !root.closest("[hidden]") && visible;
  function measure() {
    box = canvas.getBoundingClientRect();
    const theme = getComputedStyle(document.documentElement);
    color = theme.getPropertyValue("--accent").trim();surface = theme.getPropertyValue("--surface").trim();
    refreshAnimation();
  }
  function draw(now = performance.now()) {
    const drawMachine = renderers.get(rendererName());
    if (!drawMachine || !box.width || !box.height) return;
    const dpr = Math.min(devicePixelRatio || 1, 1.5), width = box.width, height = box.height;
    const w = Math.round(width * dpr), h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w;canvas.height = h; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);ctx.clearRect(0, 0, w, h);
    if (animating() && !motion.matches) drawnTime = (now - start) / 1000;
    drawMachine(state.style, { time: motion.matches ? 0 : drawnTime ?? 0, width, height, dpr, ink: color, surface });
  }

  function animate(now) {
    raf = 0;
    if (!shown() || motion.matches || state.style === "off" || !animating()) return;
    if (now - last >= 1000 / 30) { last = now;draw(now); }
    raf = requestAnimationFrame(animate);
  }
  function refreshAnimation() {
    cancelAnimationFrame(raf);raf = 0;
    const ready = shown() && state.style !== "off" && renderers.get(rendererName());
    const moving = Boolean(ready && !motion.matches && animating());
    root.dataset.paused = String(!moving);
    if (!ready) {
      if (shown() && state.style !== "off" && ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }
    draw();if (moving) raf = requestAnimationFrame(animate);
  }
  function loadMachine() {
    const name = rendererName();
    if (!ctx || state.style === "off" || renderers.has(name)) return;
    renderers.set(name, null);
    const asset = new URL(dashboardScript);
    asset.pathname = "/tool-activity-" + name + ".js";
    const script = document.createElement("script");
    script.src = asset.href;
    script.addEventListener("load", () => {
      const create = name === "arm" ? globalThis.ccdxToolArm : globalThis.ccdxToolMachines;
      if (typeof create !== "function") return;
      renderers.set(name, create(ctx));
      if (rendererName() === name) refreshAnimation();
    }, { once: true });
    document.head.append(script);
  }
  function category(name) {
    const value = String(name || "").toLowerCase().split(/__|\./).at(-1);
    if (["read_file", "readfile", "view_file", "open_file", "get_file_content"].includes(value)) return "tool_action_read";
    if (["search_files", "file_search", "grep", "rg"].includes(value)) return "tool_action_search";
    if (["exec_command", "run_command", "bash", "shell"].includes(value)) return "tool_action_command";
    if (["write_file", "edit_file", "apply_patch"].includes(value)) return "tool_action_edit";
    if (["web_search", "search_web"].includes(value)) return "tool_action_web";
    return "tool_action_generic";
  }
  function appName(id) { return phrase(`flow_app_${id}`); }
  const sourceName = id => id === "github" ? "GitHub Copilot" : id === "m365" ? "Microsoft 365" : id === "google" ? "Google" : globalThis.ccdxConnectionNames?.[id] || phrase("flow_source_unknown");
  function render(force = false) {
    if (root.closest("[hidden]")) { signature = "";refreshAnimation();return; }
    loadMachine();
    const time = performance.now();
    if (requestDeadline && time >= requestDeadline) { requests = [];requestDeadline = 0;fresh = false; }
    for (const row of records) if (row.until <= time && pending(row.state)) { row.state = "unknown";row.until = time + 300000; }
    records = records.filter(row => row.until > time);
    const rows = records.slice(0, 32).map(row => fresh || !pending(row.state) ? row : { ...row, state: "unknown" });
    const agents = fresh ? requests : [];
    const next = JSON.stringify([fresh, supported, state.style, omitted, agents, rows.map(({ until, ...row }) => row)]);
    clearTimeout(expiry);expiry = null;
    const deadlines = records.map(row => row.until);if (requestDeadline) deadlines.push(requestDeadline);
    if (deadlines.length) expiry = setTimeout(() => render(), Math.max(1, Math.min(...deadlines) - time));
    if (!force && next === signature) return;
    signature = next;
    const active = rows.filter(row => pending(row.state)), preparing = active.some(row => row.state === "preparing");
    const responding = agents.some(row => row.responding);
    const scene = !fresh ? "idle" : active.length ? preparing ? active.length > 1 ? "parallel" : "calling" : "waiting"
      : agents.length ? responding ? "responding" : "processing"
      : rows.some(row => row.state === "returned") && !rows.some(row => ["failed", "cancelled", "unknown"].includes(row.state)) ? "returned" : "idle";
    const wasAnimating = animating();state.scene = scene;
    if (animating() && !wasAnimating) { start = performance.now();drawnTime = null; }
    const key = !supported || !fresh ? "flow_status_unknown" : active.length ? preparing ? active.length > 1 ? "tool_preparing_many" : "tool_preparing" : "tool_waiting"
      : agents.length ? agents.length > 1 ? "tool_requests_many" : responding ? "tool_responding" : "tool_processing"
      : rows.some(row => row.state === "failed") ? "tool_failed" : rows.some(row => row.state === "cancelled") ? "tool_cancelled"
        : rows.some(row => row.state === "unknown") ? "flow_status_unknown" : rows.length ? "tool_returned" : "tool_idle";
    const count = active.length || agents.length;
    text("tool-state", key, { count });
    canvas.setAttribute("aria-label", phrase(key, { count }));
    el("tool-style").value = state.style;el("tool-stage").dataset.style = state.style;
    el("tool-cursor").hidden = !count || state.style === "off" || !fresh;
    const displayed = active.length ? rows : agents.length ? agents : rows;
    const groups = new Map(displayed.map(row => [`${row.application}:${row.provider}:${row.model}`, row]));
    el("tool-context").hidden = !displayed.length;
    el("tool-context").textContent = groups.size === 1 ? phrase("model_action_label", { name: appName(displayed[0].application), action: displayed[0].model === "other" ? phrase("flow_model_pending") : displayed[0].model }) : phrase("tool_groups", { count: groups.size });
    const list = el("tool-list");
    const nextToolRows = new Map();
    const children = displayed.slice(0, 6).map((row, index) => {
      const agent = row.responding !== undefined, rowKey = agent ? `agent-${index}` : row.id;
      let item = visibleToolRows.get(rowKey);
      if (!item) {
        item = document.createElement("div");item.className = "tool-entry";
        const mark = document.createElement("span");mark.className = "tool-mark";mark.setAttribute("aria-hidden", "true");
        const name = document.createElement("span");name.className = "tool-name";
        const status = document.createElement("span");
        item.append(mark, name, status);
      }
      item.dataset.state = agent ? "preparing" : row.state;
      const name = phrase(agent ? row.responding ? "tool_response_action" : "tool_processing_action" : category(row.name));
      const status = phrase(agent ? "tool_row_active" : `tool_row_${row.state}`);
      if (item.children[1].textContent !== name) item.children[1].textContent = name;
      if (item.children[2].textContent !== status) item.children[2].textContent = status;
      nextToolRows.set(rowKey, item);
      return item;
    });
    if (list.children.length !== children.length || children.some((child, index) => list.children[index] !== child)) list.replaceChildren(...children);
    visibleToolRows = nextToolRows;
    const details = el("tool-details");
    details.hidden = !rows.length;
    if (details.open) {
      el("tool-technical").replaceChildren();
      for (const row of rows) {
        const line = document.createElement("tr");
        for (const [label, value] of [["client", appName(row.application)], ["source", sourceName(row.provider)], ["model", row.model],
          ["tool_name", row.name || phrase("tool_action_generic")], ["outcome", phrase(`tool_row_${row.state}`)]]) {
          const cell = document.createElement("td");cell.textContent = value;cell.dataset.label = phrase(label);line.append(cell);
        }
        el("tool-technical").append(line);
      }
    }
    el("tool-more").hidden = rows.length <= 6 && !omitted;
    text("tool-more", "tool_more", { count: Math.max(0, rows.length - 6) + omitted });
    if (force || !box.width) measure();
    else if (wasAnimating !== animating()) refreshAnimation();
  }
  el("tool-details").addEventListener("toggle", () => { if (el("tool-details").open) render(true); });
  el("tool-style").addEventListener("change", () => {
    const next = el("tool-style").value;if (!styles.has(next)) return;state.style = next;
    try { localStorage.setItem(storageKey, next); } catch {}render(true);
  });
  document.addEventListener("visibilitychange", () => { if (shown()) render();refreshAnimation(); });
  globalThis.addEventListener("pagehide", () => { cancelAnimationFrame(raf);raf = 0;root.dataset.paused = "true"; });
  motion.addEventListener("change", refreshAnimation);
  new ResizeObserver(measure).observe(canvas.parentElement);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting;refreshAnimation(); }, { threshold: .05 }).observe(canvas);
  new MutationObserver(() => render(true)).observe(document.documentElement, { attributes: true, attributeFilter: ["lang", "data-theme", "data-palette"] });
  globalThis.ccdxToolActivity = {
    update(data, { live = false } = {}) {
      const parts = [data?.stream_performance, (data?.providers?.claude || data?.providers?.m365?.claude)?.requests?.performance].filter(Boolean);
      const views = parts.map(part => part.tool_activity).filter(value => Array.isArray(value?.items));
      supported = views.length > 0 || parts.some(part => Array.isArray(part.active_requests));fresh = supported;const time = performance.now();
      requests = parts.flatMap(part => (Array.isArray(part.active_requests) ? part.active_requests.slice(0, 128) : []).filter(row => row?.purpose === "conversation" && row.terminal_outcome == null
        && typeof row.model === "string" && ["received", "admission", "body", "history", "images", "serialization", "upstream_connection", "upstream_response", "upstream_stream"].includes(row.phase))
        .map(row => ({ application: row.application || "api", provider: row.provider, model: row.model.slice(0, 160), responding: Number.isFinite(row.first_output_ms) && row.first_output_ms >= 0 }))).slice(0, 128);
      requestDeadline = live || !requests.length ? 0 : time + 6000;
      const merged = views.flatMap((view, index) => view.items.slice(0, 32).filter(row => row && typeof row.id === "string" && ["preparing", "waiting", "returned", "failed", "cancelled", "unknown"].includes(row.state)
        && Number.isFinite(row.expires_in_ms) && row.expires_in_ms > 0).map(row => ({ id: `${index}-${row.id}`, application: row.application || "api", provider: row.provider, model: row.model || "other", name: row.name,
          state: row.state, until: time + Math.min(row.expires_in_ms, 300000) })));
      merged.sort((a, b) => Number(pending(b.state)) - Number(pending(a.state)));records = merged.slice(0, 32);
      omitted = Math.max(0, merged.length - records.length) + views.reduce((sum, view) => sum + (Number.isSafeInteger(view.omitted) ? view.omitted : 0), 0);render();
    },
    unavailable() { fresh = false;requests = [];requestDeadline = 0;render(); },
    visibilityChanged() { render();refreshAnimation(); },
  };
  render();
})();
