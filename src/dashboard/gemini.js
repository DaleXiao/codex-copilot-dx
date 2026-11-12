(() => {
  const el=id=>document.getElementById(id),language=globalThis.ccdxLanguage;
  let busy=false,state=null,draft=null;
  const words=(id,key)=>language.set(el(id),key);
  const controls=["gemini-enabled","github-antigravity-enabled","gemini-open","gemini-refresh","gemini-save","gemini-cancel"];
  const selected=()=>state?.models.filter(model=>model.selected!==false).map(model=>model.id)||[];
  const dirty=()=>draft!==null&&JSON.stringify([...draft].sort())!==JSON.stringify(selected().sort());
  function render(){
    for(const id of controls)el(id).disabled=busy||!state;
    if(!state)return;
    if(!busy)for(const id of ["gemini-enabled","github-antigravity-enabled"])el(id).checked=state.enabled;
    el("gemini-save").disabled=busy||!dirty();el("gemini-cancel").disabled=busy||!dirty();
    words("gemini-state",dirty()?"cap_unsaved":state.enabled&&state.source_enabled!==false?"gemini_enabled":"gemini_disabled");
    words("gemini-route-state",state.last_operation?.status==="models_saved"?"gemini_models_saved":state.route_observed?"gemini_route_observed":"gemini_route_waiting");
    el("gemini-version").textContent=state.app.version||"—";
    words("gemini-app-state",state.app.status==="running"?"gemini_running":state.app.status==="stopped"?"gemini_stopped":state.app.status==="starting"?"gemini_starting":"gemini_unavailable");
    el("gemini-reopen").hidden=!state.enabled||(state.route_observed&&state.last_operation?.status!=="models_saved");
    const list=el("gemini-models");list.replaceChildren();
    for(const model of state.models){
      const row=document.createElement("tr"),name=document.createElement("td"),label=document.createElement("label"),input=document.createElement("input");
      input.type="checkbox";input.value=model.id;input.checked=(draft||selected()).includes(model.id);input.disabled=busy;
      input.addEventListener("change",()=>{const next=new Set(draft||selected());if(input.checked)next.add(model.id);else next.delete(model.id);draft=[...next];el("gemini-save").disabled=!dirty();el("gemini-cancel").disabled=!dirty();words("gemini-state",dirty()?"cap_unsaved":"cap_saved")});
      label.append(input,document.createTextNode(model.name));name.append(label);row.append(name);
      for(const [key,value] of [["source","GitHub Copilot"],["cap_context",model.context_window?new Intl.NumberFormat().format(model.context_window):"—"],["cap_reasoning",model.effort||"—"]]){
        const cell=document.createElement("td");cell.textContent=value;language.set(cell,key,{},"data-label");row.append(cell);
      }
      list.append(row);
    }
    if(!state.models.length){const row=document.createElement("tr"),cell=document.createElement("td");cell.colSpan=4;language.set(cell,"gemini_no_models");row.append(cell);list.append(row)}
    for(const id of ["active","failed","copilot","total"])el("gemini-"+id).textContent=state.activity?.[id]??"—";
  }
  async function load(action,extra={}){
    if(busy)return;busy=true;render();
    try{
      const response=await fetch("/_ccdx/ui/gemini"+(action==="summary"?"?scope=summary":""),{method:action&&action!=="summary"?"POST":"GET",headers:{"X-CCDX-Dashboard":"1",...(action&&action!=="summary"?{"Content-Type":"application/json"}:{})},
        cache:"no-store",signal:AbortSignal.timeout(20000),...(action&&action!=="summary"?{body:JSON.stringify({action,...(action==="enable"?{accept_background_copilot:true}:{}),...extra})}:{})});
      const value=await response.json();if(!response.ok)throw new Error(value.error||"Antigravity setup failed");
      state=value;if(action==="models"||action==="disable")draft=null;
      globalThis.ccdxGeminiStatus=state;window.dispatchEvent(new Event("ccdx-gemini-state"));
      const status=state.last_operation?.status;
      const notice=status==="models_saved"?"gemini_models_saved":status==="needs_app_relaunch"?"gemini_reopen":status==="opened"?"gemini_opened":status==="route_conflict"?"gemini_conflict":null;
      for(const id of ["gemini-note","github-antigravity-note"])if(notice)words(id,notice);else el(id).textContent="";
    }catch(error){for(const id of ["gemini-note","github-antigravity-note"])el(id).textContent=error.message}
    finally{busy=false;render()}
  }
  for(const id of ["gemini-enabled","github-antigravity-enabled"])el(id).addEventListener("change",event=>void load(event.target.checked?"enable":"disable"));
  el("gemini-model-form").addEventListener("submit",event=>{event.preventDefault();if(dirty())void load("models",{models:draft})});
  el("gemini-cancel").addEventListener("click",()=>{draft=null;render()});
  el("gemini-open").addEventListener("click",()=>void load("open"));
  el("gemini-refresh").addEventListener("click",()=>void load());
  el("refresh").addEventListener("click",()=>{if(["#gemini","#models"].includes(location.hash))void load()});
  const navigate=()=>{if(["#gemini","#models"].includes(location.hash))void load()};window.addEventListener("hashchange",navigate);
  void load(["#gemini","#models"].includes(location.hash)?undefined:"summary");
})();
