(() => {
  const root = document.getElementById("tool-activity");if (!root) return;
  const el = id => document.getElementById(id), canvas = el("tool-canvas"), ctx = canvas.getContext?.("2d");
  const styles = new Set(["halo", "grid", "assembly", "off"]), storageKey = "ccdx.dashboard.toolMotionStyle";
  const pending = state => ["preparing", "waiting"].includes(state);
  const phrase = (key, values = {}) => globalThis.ccdxLanguage.format(key, values);
  const text = (id, key, values) => globalThis.ccdxLanguage.set(el(id), key, values);
  const state = { scene: "idle", style: "assembly", intensity: .8, reduce: false };
  try { const saved = localStorage.getItem(storageKey);if (styles.has(saved)) state.style = saved; } catch {}
  const motion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") || { matches: false, addEventListener() {} };
  let records = [], fresh = false, supported = false, visible = true, raf = 0, last = 0, start = performance.now(), expiry = null;
  let signature = "", box = { width: 0, height: 0 }, color = "", surface = "", omitted = 0, requests = [], requestDeadline = 0;
  const animating = () => ["calling", "parallel", "waiting", "processing", "responding"].includes(state.scene);
  const shown = () => document.visibilityState === "visible" && !root.closest("[hidden]") && visible;
  function measure() {
    box = canvas.getBoundingClientRect();
    const theme = getComputedStyle(document.documentElement);
    color = theme.getPropertyValue("--accent").trim();surface = theme.getPropertyValue("--surface").trim();
    refreshAnimation();
  }
  function drawAssembly(dpr,w,h,t,active,waiting,returned,reduced) {
    const scale=Math.min((w-12)/264,(h-12)/118);
    if(scale<=0)return;
    ctx.setTransform(scale*dpr,0,0,scale*dpr,(w-264*scale)*dpr/2,(h-118*scale)*dpr/2);
    const running=active||waiting;
    const phase=reduced?.42:(t*(waiting?.7:1.04))%2.1/2.1;
    const press=running?Math.max(0,1-Math.abs(phase-.5)/.14):0;
    const workX=returned?132+91*Math.min(1,t/.85):
      phase<.34?29+103*phase/.34:phase<.66?132:132+91*(phase-.66)/.34;
    const moving=running&&(phase<.34||phase>=.66)||returned;
    const shift=moving?(reduced?0:t*78)%14:0;
    const assembled=returned||phase>=.5;
    function path(points,closed=false){
      ctx.beginPath();ctx.moveTo(points[0],points[1]);
      for(let i=2;i<points.length;i+=2)ctx.lineTo(points[i],points[i+1]);
      if(closed)ctx.closePath();
    }
    // Floor, braced stands and the rear uprights of the press.
    ctx.lineWidth=1.2;ctx.globalAlpha=.22;
    path([18,108,246,108]);ctx.stroke();
    ctx.globalAlpha=.52;
    path([35,88,35,108,55,108,55,88,35,106,55,90]);ctx.stroke();
    path([209,88,209,108,229,108,229,88,209,106,229,90]);ctx.stroke();
    ctx.fillRect(99,22,5,45);ctx.fillRect(160,22,5,45);
    ctx.strokeRect(93,11,78,13);
    ctx.globalAlpha=.23;
    ctx.fillRect(93,11,78,13);
    ctx.globalAlpha=.65;
    ctx.beginPath();
    for(let i=98;i<168;i+=8){ctx.moveTo(i,21);ctx.lineTo(i+4,14);}
    ctx.stroke();
    // Belt deck and rollers, with the drive drums in the front housing.
    ctx.globalAlpha=.18;path([13,77,239,77,252,65,26,65],true);ctx.fill();
    ctx.globalAlpha=.64;ctx.stroke();
    ctx.beginPath();
    for(let i=30;i<235;i+=14){ctx.moveTo(i+shift,75);ctx.lineTo(i+shift+9,67);}
    ctx.stroke();
    ctx.globalAlpha=.16;ctx.fillRect(13,77,226,13);
    ctx.globalAlpha=.72;ctx.strokeRect(13,77,226,13);
    for(const x of [22,230]){ctx.beginPath();ctx.arc(x,83.5,3.8,0,Math.PI*2);ctx.stroke();}
    // Cylinder, piston and platen travel together.
    const piston=press*9;
    ctx.globalAlpha=.82;ctx.strokeRect(123,24,18,13);ctx.fillRect(130,37,4,5+piston);
    ctx.fillRect(120,42+piston,24,3);
    if(running||returned){
      const x=workX-11,y=assembled?57:60;
      ctx.globalAlpha=1;ctx.fillStyle=surface;
      path([x,75,x,y,x+6,y-5,x+27,y-5,x+27,70,x+21,75],true);ctx.fill();
      ctx.fillStyle=color;ctx.globalAlpha=.24;ctx.fill();
      ctx.globalAlpha=.86;ctx.stroke();
      path([x,y,x+21,y,x+27,y-5]);ctx.stroke();
      path([x+21,y,x+21,75]);ctx.stroke();
      if(assembled){ctx.globalAlpha=.62;ctx.fillRect(x+6,y+5,9,3);}
    }
    ctx.globalAlpha=1;
  }
    function draw(now=performance.now()){
      if(!ctx||!box.width||!box.height)return;
      const dpr=Math.min(devicePixelRatio||1,1.5),w=box.width,h=box.height;
      if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      const cx=w/2,cy=h/2,r=Math.min(w,h)*.31;
      const reduced=motion.matches||state.reduce,t=reduced?0:(now-start)/1000,active=['calling','parallel','processing','responding'].includes(state.scene),waiting=state.scene==='waiting',returned=state.scene==='returned';
      const quiet=!active&&!waiting&&!returned,power=quiet?.12:waiting?.5:returned?.5:state.intensity;
      ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=.8;
      function arc(radius,a,b,alpha){ctx.globalAlpha=alpha;ctx.beginPath();ctx.arc(cx,cy,radius,a,b);ctx.stroke();}
      if(state.style==='grid'){
        const cols=12,rows=3,gap=5,size=Math.min(13,(w-32)/cols-gap),left=cx-(cols*size+(cols-1)*gap)/2,top=cy-(rows*size+(rows-1)*gap)/2;
        const head=active||waiting?(t*(waiting?11:19))%(cols*rows):-8;
        for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
          const index=row*cols+(row%2?cols-col-1:col),distance=(head-index+cols*rows)%(cols*rows),wave=Math.max(0,1-distance/8);
          ctx.globalAlpha=quiet?.1:returned?.16+Math.max(0,1-(now-start)/900)*.42:.1+wave*power;
          ctx.fillRect(left+col*(size+gap),top+row*(size+gap),size,size);
        }
        ctx.globalAlpha=1;return;
      }
      if(state.style==='assembly'){
        drawAssembly(dpr,w,h,t,active,waiting,returned,reduced);return;
      }
      arc(r,0,Math.PI*2,.25);arc(r*.85,0,Math.PI*2,.13);arc(r*1.12,0,Math.PI*2,.1);
      const spin=active?t*1.6:waiting?t*.9:0;
      if(state.style==='halo'){
        for(let i=0;i<64;i++){
          const a=i/64*Math.PI*2+spin,pulse=active||waiting?(Math.sin(t*7+i*.7)*.5+.5):returned?.6:.05;
          const length=3+(i%4===0?8:3)+pulse*(active?20:waiting?9:2)*state.intensity;
          ctx.globalAlpha=(.16+pulse*.55)*power;ctx.lineWidth=i%8===0?1.4:.75;
          ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*r*1.17,cy+Math.sin(a)*r*1.17);ctx.lineTo(cx+Math.cos(a)*(r*1.17+length),cy+Math.sin(a)*(r*1.17+length));ctx.stroke();
        }
      }
      if(state.style==='halo'){
        ctx.lineWidth=.65;const strands=28;
        for(let i=0;i<strands;i++){
          const a=i/strands*Math.PI*2+spin*.6,b=a+2.35+Math.sin(i*.68+t*1.7)*.48,inner=r*.68;
          ctx.globalAlpha=(.1+power*.2)*(quiet?.45:1);ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*inner,cy+Math.sin(a)*inner);ctx.quadraticCurveTo(cx+Math.sin(t*1.3+i)*r*.35,cy+Math.cos(i*.5+t*.7)*r*.3,cx+Math.cos(b)*inner,cy+Math.sin(b)*inner);ctx.stroke();
        }
      }
      for(let i=0;i<3;i++){
        const a=spin*(i%2?-1:1)+i*2.08,track=r*(.89+i*.06);
        ctx.lineWidth=1.3;arc(track,a,a+(active?1.25:waiting?.75:.18),quiet?.15:.75);
      }
      if(active||waiting){for(let i=0;i<3;i++){const q=(t*.85+i/3)%1;arc(r*(.55+q*.5),0,Math.PI*2,(1-q)*.12*power);}}
      if(returned&&!reduced){const q=Math.min((now-start)/850,1);arc(r*(1+q*.32),0,Math.PI*2,(1-q)*.5);}
      ctx.globalAlpha=1;
    }

  function animate(now) {
    raf = 0;
    if (!shown() || motion.matches || state.style === "off" || !animating() && !(state.scene === "returned" && now - start < 900)) return;
    if (now - last >= 1000 / 30) { last = now;draw(now); }raf = requestAnimationFrame(animate);
  }
  function refreshAnimation() {
    cancelAnimationFrame(raf);raf = 0;root.dataset.paused = String(!shown() || motion.matches);
    if (!shown() || state.style === "off") return;
    draw();if (!motion.matches && (animating() || state.scene === "returned" && performance.now() - start < 900)) raf = requestAnimationFrame(animate);
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
    if (scene !== state.scene) start = performance.now();state.scene = scene;
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
    const list = el("tool-list");list.replaceChildren();
    for (const row of displayed.slice(0, 6)) {
      const agent = row.responding !== undefined;
      const item = document.createElement("div");item.className = "tool-entry";item.dataset.state = agent ? "preparing" : row.state;
      const mark = document.createElement("span");mark.className = "tool-mark";mark.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");name.className = "tool-name";name.textContent = phrase(agent ? row.responding ? "tool_response_action" : "tool_processing_action" : category(row.name));
      const status = document.createElement("span");status.textContent = phrase(agent ? "tool_row_active" : `tool_row_${row.state}`);
      item.append(mark, name, status);list.append(item);
    }
    el("tool-details").hidden = !rows.length;
    el("tool-technical").replaceChildren();
    for (const row of rows) {
      const line = document.createElement("dl");line.className = "tool-record-fields";
      for (const [label, value] of [["client", appName(row.application)], ["source", sourceName(row.provider)],
        ["model", row.model], ["tool_heading", row.name || phrase("tool_action_generic")], ["outcome", phrase(`tool_row_${row.state}`)]]) {
        const term = document.createElement("dt"), detail = document.createElement("dd");
        term.textContent = phrase(label);detail.textContent = value;line.append(term, detail);
      }
      el("tool-technical").append(line);
    }
    el("tool-more").hidden = rows.length <= 6 && !omitted;
    text("tool-more", "tool_more", { count: Math.max(0, rows.length - 6) + omitted });
    measure();
  }
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
