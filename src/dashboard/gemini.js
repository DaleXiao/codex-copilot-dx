(() => {
  const el=id=>document.getElementById(id),language=globalThis.ccdxLanguage;
  let busy=false,state=null,draft=null,defaultDraft,notice=null,pendingAction=null;
  let sharedApplication=null,sharedPending=false,savedTimer,showSaved=false;
  const words=(id,key)=>language.set(el(id),key);
  const clear=id=>{el(id).removeAttribute('data-i18n');el(id).removeAttribute('data-i18n-args');el(id).textContent='';el(id).title=''};
  const controls=['gemini-enabled','gemini-open','gemini-refresh','gemini-save','gemini-cancel','gemini-use-app-default'];
  const selected=()=>state?.models.filter(model=>model.selected!==false).map(model=>model.id)||[];
  const savedDefault=()=>state?.default_model??null;
  const currentDefault=()=>defaultDraft===undefined?savedDefault():defaultDraft;
  const dirty=()=>currentDefault()!==savedDefault()||draft!==null&&JSON.stringify([...draft].sort())!==JSON.stringify(selected().sort());
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
    for(const id of controls)el(id).disabled=busy||sharedPending||!state;
    if(!state)return;
    if(sharedApplication&&(sharedApplication.inspection||0)>=(state.application?.inspection||0))state.app={...state.app,status:sharedApplication.status,version:sharedApplication.version||state.app.version};
    if(!busy)el('gemini-enabled').checked=state.enabled;
    el('gemini-save').disabled=busy||sharedPending||!dirty();el('gemini-cancel').disabled=busy||sharedPending||!dirty();
    words('gemini-save',busy&&pendingAction==='models'?'api_saving':'api_save');if(busy&&pendingAction==='models')el('gemini-save').setAttribute('aria-busy','true');else el('gemini-save').removeAttribute('aria-busy');
    el('gemini-draft-state').hidden=dirty()||!showSaved||state.app.status==='running'&&(state.models_reload_required===true||sharedApplication?.needs_reload===true);
    if(!el('gemini-draft-state').hidden)words('gemini-draft-state','cap_saved');
    el('gemini-use-app-default').hidden=currentDefault()===null;
    el('gemini-default-note').hidden=!state.default_model_unavailable||currentDefault()!==savedDefault();
    if(!el('gemini-default-note').hidden)words('gemini-default-note','gemini_default_unavailable');
    const fallback=!globalThis.ccdxApplicationControls;
    const sourceDisabled=state.enabled&&state.source_enabled===false;
    el('gemini-route-state').hidden=!sourceDisabled;
    if(sourceDisabled)words('gemini-route-state','gemini_source_disabled');
    el('gemini-version').textContent=state.app.version||'—';
    el('gemini-app-state').hidden=!fallback;
    if(fallback)words('gemini-app-state',state.app.status==='running'?'gemini_running':state.app.status==='stopped'?'gemini_stopped':state.app.status==='starting'?'gemini_starting':'gemini_unavailable');
    const hint=fallback&&state.app.status==='running'&&(!state.enabled||state.models_reload_required===true);
    el('gemini-reopen').hidden=!hint;if(hint)words('gemini-reopen',state.enabled?'gemini_reopen':'gemini_pause_reopen');
    el('gemini-open').hidden=!fallback;
    el('gemini-open').disabled=busy||sharedPending||state.app.status!=='stopped';
    const list=el('gemini-models'),focused=list.contains(document.activeElement)?document.activeElement:null;
    const focus={value:focused?.value,kind:focused?.tagName};list.replaceChildren();
    for(const model of groupedModels()){
      const chosen=new Set(draft||selected()),ids=model.efforts.map(item=>item.id);
      const row=document.createElement('tr'),name=document.createElement('td'),label=document.createElement('label'),input=document.createElement('input');
      input.type='checkbox';input.value=model.id;input.checked=ids.some(id=>chosen.has(id));input.disabled=busy||sharedPending;input.setAttribute('aria-label',model.name);
      const update=(values,checked)=>{const next=new Set(draft||selected());for(const id of values)if(checked)next.add(id);else next.delete(id);draft=[...next];if(!checked&&values.includes(currentDefault()))defaultDraft=null;notice=null;clear('gemini-note');render()};
      input.addEventListener('change',()=>{const saved=ids.filter(id=>selected().includes(id));update(input.checked&&saved.length?saved:ids,input.checked)});
      label.append(input,document.createTextNode(model.name));name.append(label);row.append(name);
      for(const [key,value]of [['source','GitHub Copilot'],['cap_context',count(model.context_window)]]){const cell=document.createElement('td');cell.textContent=value;cell.dataset.label=language.format(key);row.append(cell)}
      const efforts=document.createElement('td');efforts.dataset.label=language.format('cap_reasoning');
      efforts.textContent=model.efforts.map(item=>item.effort||'—').join(' / ');
      const preferred=document.createElement('td'),button=document.createElement('button');preferred.dataset.label=language.format('gemini_new_chat_default');
      const isDefault=ids.includes(currentDefault())&&chosen.has(currentDefault());
      button.type='button';button.value=model.id;button.disabled=busy||sharedPending;
      const title=isDefault?'cap_default':'cap_set_default';language.set(button,title);
      button.setAttribute('aria-pressed',String(isDefault));button.setAttribute('aria-label',language.format('model_action_label',{name:model.name,action:language.format(title)}));
      button.addEventListener('click',()=>{
        if(isDefault)return;
        const saved=ids.filter(id=>selected().includes(id)),visible=model.efforts.filter(item=>chosen.has(item.id));
        const available=visible.length?visible:saved.length?model.efforts.filter(item=>saved.includes(item.id)):model.efforts;
        if(!visible.length){for(const item of available)chosen.add(item.id);draft=[...chosen];}
        defaultDraft=(available.find(item=>item.effort==='medium')||available[0])?.id??null;
        notice=null;clear('gemini-note');render();
      });
      preferred.append(button);row.append(efforts,preferred);list.append(row);
    }
    if(!state.models.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=5;language.set(cell,'gemini_no_models');row.append(cell);list.append(row)}
    if(focus.kind)[...list.querySelectorAll(focus.kind.toLowerCase())].find(control=>control.value===focus.value)?.focus();
    for(const id of ['active','failed','copilot','total'])el('gemini-'+id).textContent=state.activity?.[id]??'—';
    if(notice)words('gemini-note',notice);
  }
  async function load(action,extra={},report=true){
    if(busy){if(!report)throw Error('Antigravity settings are busy');return}
    busy=true;pendingAction=action;render();
    try{
      const write=action&&action!=='summary',response=await fetch('/_ccdx/ui/gemini'+(action==='summary'?'?scope=summary':''),{method:write?'POST':'GET',headers:{'X-CCDX-Dashboard':'1',...(write?{'Content-Type':'application/json'}:{})},cache:'no-store',signal:AbortSignal.timeout(20000),...(write?{body:JSON.stringify({action,...(action==='enable'?{accept_background_copilot:true}:{}),...extra})}:{})});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Antigravity setup failed');
      state=value;if(action==='models'){
        draft=null;defaultDraft=undefined;showSaved=true;clearTimeout(savedTimer);savedTimer=setTimeout(()=>{showSaved=false;render()},2200);
      }
      globalThis.ccdxGeminiStatus=state;
      if(action&&action!=='summary'){
        const status=state.last_operation?.status;notice=action==='models'?null:status==='needs_app_relaunch'?'gemini_reopen':status==='opened'?'gemini_opened':status==='route_conflict'?'gemini_conflict':null;
        clear('gemini-note');
      }
      return state;
    }catch(error){if(!report)throw error;notice='gemini_operation_failed';words('gemini-note',notice);el('gemini-note').title=error.message}
    finally{busy=false;pendingAction=null;render();window.dispatchEvent(new CustomEvent('ccdx-gemini-state',{detail:{application:state?.application,needsCatalogReload:state?.enabled===true&&state.source_enabled!==false&&state.models_reload_required===true&&state.default_model_unavailable!==true}}))}
  }
  globalThis.ccdxAntigravity={get state(){return state},get pending(){return busy},refreshStatus:()=>load('summary'),setEnabled:enabled=>load(enabled?'enable':'disable',{},false)};
  el('gemini-enabled').addEventListener('change',event=>void load(event.target.checked?'enable':'disable'));
  el('gemini-model-form').addEventListener('submit',event=>{event.preventDefault();if(dirty())void load('models',{models:draft||selected(),...(defaultDraft!==undefined?{default_model:defaultDraft}:{})})});
  el('gemini-cancel').addEventListener('click',()=>{draft=null;defaultDraft=undefined;notice=null;clear('gemini-note');render()});
  el('gemini-use-app-default').addEventListener('click',()=>{defaultDraft=null;render();el('gemini-save').focus();});
  el('gemini-open').addEventListener('click',()=>{if(globalThis.ccdxApplicationControls)globalThis.ccdxApplicationControls.open('antigravity');else void load('open')});
  window.addEventListener('ccdx:application-state',event=>{if(event.detail?.id==='antigravity'){sharedApplication=event.detail.application;sharedPending=event.detail.pending;render()}});
  el('gemini-refresh').addEventListener('click',()=>void load('refresh'));
  el('refresh').addEventListener('click',()=>{if(['#gemini','#models'].includes(location.hash))void load(location.hash==='#models'?'summary':'refresh')});
  window.addEventListener('hashchange',()=>{if(['#gemini','#models'].includes(location.hash))void load(location.hash==='#models'?'summary':undefined)});
  new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  void load(location.hash==='#gemini'?undefined:'summary');
})();
