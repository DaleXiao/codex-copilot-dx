(() => {
  const el=id=>document.getElementById(id),language=globalThis.ccdxLanguage;
  let busy=false,state=null,draft=null,notice=null,pendingAction=null;
  const words=(id,key)=>language.set(el(id),key);
  const clear=id=>{el(id).removeAttribute('data-i18n');el(id).removeAttribute('data-i18n-args');el(id).textContent='';el(id).title=''};
  const controls=['gemini-enabled','gemini-open','gemini-refresh','gemini-save','gemini-cancel'];
  const selected=()=>state?.models.filter(model=>model.selected!==false).map(model=>model.id)||[];
  const dirty=()=>draft!==null&&JSON.stringify([...draft].sort())!==JSON.stringify(selected().sort());
  const count=value=>!value?'—':value>=1000000?`${Number((value/1000000).toFixed(2))}M`:value>=1000?`${Number((value/1000).toFixed(1))}K`:String(value);
  const groupedModels=()=>{
    if(Array.isArray(state.model_groups))return state.model_groups;
    const groups=new Map();
    for(const variant of state.models){
      const name=variant.name.split(' · Copilot')[0],id=variant.model||name;
      if(!groups.has(id))groups.set(id,{id,name,context_window:variant.context_window,efforts:[]});
      groups.get(id).efforts.push({id:variant.id,effort:variant.effort,selected:variant.selected});
    }
    return [...groups.values()];
  };
  function render(){
    for(const id of controls)el(id).disabled=busy||!state;
    if(!state)return;
    if(!busy)el('gemini-enabled').checked=state.enabled;
    el('gemini-save').disabled=busy||!dirty();el('gemini-cancel').disabled=busy||!dirty();
    words('gemini-save',busy&&pendingAction==='models'?'api_saving':'api_save');if(busy&&pendingAction==='models')el('gemini-save').setAttribute('aria-busy','true');else el('gemini-save').removeAttribute('aria-busy');
    words('gemini-draft-state',dirty()?'cap_unsaved':'cap_saved');
    words('gemini-route-state',!state.enabled?'gemini_disabled':state.source_enabled===false?'gemini_source_disabled':state.app.status==='starting'?'gemini_route_waiting':state.models_reload_required===null?'gemini_catalog_unknown':state.models_reload_required?'gemini_models_pending':state.route_observed?'gemini_route_observed':'gemini_route_waiting');
    el('gemini-version').textContent=state.app.version||'—';
    words('gemini-app-state',state.app.status==='running'?'gemini_running':state.app.status==='stopped'?'gemini_stopped':state.app.status==='starting'?'gemini_starting':'gemini_unavailable');
    const needsReload=state.enabled&&state.source_enabled!==false&&(state.models_reload_required===true||state.models_reload_required===null);
    const hint=!state.enabled&&state.app.status==='running'?'gemini_pause_reopen':needsReload?(state.app.status==='running'?(state.models_reload_required===null?'gemini_maybe_reopen':'gemini_reopen'):state.app.status==='stopped'?'gemini_open_to_load':null):null;
    el('gemini-reopen').hidden=!hint;if(hint)words('gemini-reopen',hint);
    el('gemini-open').disabled=busy||state.app.status!=='stopped';
    const list=el('gemini-models'),focus=list.contains(document.activeElement)?document.activeElement.value:null;list.replaceChildren();
    for(const model of groupedModels()){
      const chosen=new Set(draft||selected()),ids=model.efforts.map(item=>item.id);
      const row=document.createElement('tr'),name=document.createElement('td'),label=document.createElement('label'),input=document.createElement('input');
      input.type='checkbox';input.value=model.id;input.checked=ids.every(id=>chosen.has(id));input.indeterminate=!input.checked&&ids.some(id=>chosen.has(id));input.disabled=busy;input.setAttribute('aria-label',model.name);
      const update=(values,checked)=>{const next=new Set(draft||selected());for(const id of values)if(checked)next.add(id);else next.delete(id);draft=[...next];notice=null;clear('gemini-note');render()};
      input.addEventListener('change',()=>update(ids,input.checked));
      label.append(input,document.createTextNode(model.name));name.append(label);row.append(name);
      for(const [key,value]of [['source','GitHub Copilot'],['cap_context',count(model.context_window)]]){const cell=document.createElement('td');cell.textContent=value;cell.dataset.label=language.format(key);row.append(cell)}
      const efforts=document.createElement('td');efforts.dataset.label=language.format('cap_reasoning');
      for(const item of model.efforts){
        const label=document.createElement('label'),choice=document.createElement('input');choice.type='checkbox';choice.value=item.id;choice.checked=chosen.has(item.id);choice.disabled=busy;
        choice.setAttribute('aria-label',model.name+' · '+language.format(item.effort));choice.addEventListener('change',()=>update([item.id],choice.checked));
        label.append(choice,document.createTextNode(language.format(item.effort)));efforts.append(label,document.createTextNode(' '));
      }
      row.append(efforts);list.append(row);
    }
    if(!state.models.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;language.set(cell,'gemini_no_models');row.append(cell);list.append(row)}
    if(focus)[...list.querySelectorAll('input')].find(input=>input.value===focus)?.focus();
    for(const id of ['active','failed','copilot','total'])el('gemini-'+id).textContent=state.activity?.[id]??'—';
    if(notice)words('gemini-note',notice);
  }
  async function load(action,extra={},report=true){
    if(busy){if(!report)throw Error('Antigravity settings are busy');return}
    busy=true;pendingAction=action;render();
    try{
      const write=action&&action!=='summary',response=await fetch('/_ccdx/ui/gemini'+(action==='summary'?'?scope=summary':''),{method:write?'POST':'GET',headers:{'X-CCDX-Dashboard':'1',...(write?{'Content-Type':'application/json'}:{})},cache:'no-store',signal:AbortSignal.timeout(20000),...(write?{body:JSON.stringify({action,...(action==='enable'?{accept_background_copilot:true}:{}),...extra})}:{})});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Antigravity setup failed');
      state=value;if(action==='models')draft=null;
      globalThis.ccdxGeminiStatus=state;
      if(action&&action!=='summary'){
        const status=state.last_operation?.status;notice=action==='models'?null:status==='needs_app_relaunch'?'gemini_reopen':status==='opened'?'gemini_opened':status==='route_conflict'?'gemini_conflict':null;
        clear('gemini-note');
      }
      return state;
    }catch(error){if(!report)throw error;notice='gemini_operation_failed';words('gemini-note',notice);el('gemini-note').title=error.message}
    finally{busy=false;pendingAction=null;render();window.dispatchEvent(new Event('ccdx-gemini-state'))}
  }
  globalThis.ccdxAntigravity={get state(){return state},get pending(){return busy},setEnabled:enabled=>load(enabled?'enable':'disable',{},false)};
  el('gemini-enabled').addEventListener('change',event=>void load(event.target.checked?'enable':'disable'));
  el('gemini-model-form').addEventListener('submit',event=>{event.preventDefault();if(dirty())void load('models',{models:draft})});
  el('gemini-cancel').addEventListener('click',()=>{draft=null;notice=null;clear('gemini-note');render()});
  el('gemini-open').addEventListener('click',()=>void load('open'));
  el('gemini-refresh').addEventListener('click',()=>void load());
  el('refresh').addEventListener('click',()=>{if(['#gemini','#models'].includes(location.hash))void load(location.hash==='#models'?'summary':undefined)});
  window.addEventListener('hashchange',()=>{if(['#gemini','#models'].includes(location.hash))void load(location.hash==='#models'?'summary':undefined)});
  new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  void load(location.hash==='#gemini'?undefined:'summary');
})();
