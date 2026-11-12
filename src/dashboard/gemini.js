(() => {
  const el=id=>document.getElementById(id),language=globalThis.ccdxLanguage;
  let busy=false;
  const words=(id,key)=>language.set(el(id),key);
  async function load(action){
    if(busy)return;busy=true;
    for(const id of ["gemini-enable","gemini-disable","gemini-open","gemini-refresh"])el(id).disabled=true;
    try{
      const response=await fetch("/_ccdx/ui/gemini",{method:action?"POST":"GET",headers:{"X-CCDX-Dashboard":"1",...(action?{"Content-Type":"application/json"}:{})},
        cache:"no-store",signal:AbortSignal.timeout(20000),...(action?{body:JSON.stringify({action,...(action==="enable"?{accept_background_copilot:true}:{})})}:{})});
      const state=await response.json();if(!response.ok)throw new Error(state.error||"Gemini setup failed");
      globalThis.ccdxGeminiStatus=state;window.dispatchEvent(new Event("ccdx-gemini-state"));
      words("gemini-state",state.enabled?"gemini_enabled":"gemini_disabled");
      el("gemini-version").textContent=state.app.version||"—";
      words("gemini-app-state",state.app.status==="running"?"gemini_running":state.app.status==="stopped"?"gemini_stopped":state.app.status==="starting"?"gemini_starting":"gemini_unavailable");
      el("gemini-reopen").hidden=state.app.status!=="running";
      const list=el("gemini-models");list.replaceChildren();for(const model of state.models){const item=document.createElement("li");item.textContent=model.name;list.append(item)}
      const status=state.last_operation?.status;
      const notice=status==="needs_app_relaunch"?"gemini_reopen":status==="opened"?"gemini_opened":status==="route_conflict"?"gemini_conflict":null;
      if(notice)words("gemini-note",notice);else el("gemini-note").textContent="";
    }catch(error){el("gemini-note").textContent=error.message}
    finally{busy=false;for(const id of ["gemini-enable","gemini-disable","gemini-open","gemini-refresh"])el(id).disabled=false}
  }
  for(const action of ["enable","disable","open"])el("gemini-"+action).addEventListener("click",()=>void load(action));
  el("gemini-refresh").addEventListener("click",()=>void load());
  const navigate=()=>{if(location.hash==="#gemini")void load()};window.addEventListener("hashchange",navigate);navigate();
})();
