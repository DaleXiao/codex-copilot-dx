(() => {
  const el=id=>document.getElementById(id),language=globalThis.ccdxLanguage;
  let busy=false,state=null,draft=null,defaultDraft,timeoutDraft,nativeDraft,notice=null,pendingAction=null;
  let sharedApplication=null,sharedPending=false,savedTimer,showSaved=false,savedModels=false;
  let reading, renderedSources, renderedCatalog, modelRows=[], lastFieldFocus;
  const words=(id,key)=>language.set(el(id),key);
  const clear=id=>{el(id).removeAttribute('data-i18n');el(id).removeAttribute('data-i18n-args');el(id).textContent='';el(id).title=''};
  const controls=['gemini-enabled','gemini-open','gemini-refresh','gemini-save','gemini-cancel','gemini-use-app-default'];
  const selected=()=>state?.models.filter(model=>model.selected!==false).map(model=>model.id)||[];
  const savedDefault=()=>state?.default_model??null;
  const currentDefault=()=>defaultDraft===undefined?savedDefault():defaultDraft;
  const modelsDirty=()=>currentDefault()!==savedDefault()||draft!==null&&JSON.stringify([...draft].sort())!==JSON.stringify(selected().sort());
  const savedTimeout=()=>String(state?.copilot_timeout_seconds??'');
  const timeoutDirty=()=>timeoutDraft!==undefined&&timeoutDraft!==savedTimeout();
  const nativeDirty=()=>nativeDraft!==undefined&&nativeDraft!==(state?.native_source??null);
  const dirty=()=>modelsDirty()||timeoutDirty()||nativeDirty();
  const syncSaveControls=()=>{
    el('gemini-save').disabled=busy||sharedPending||!dirty();
    el('gemini-cancel').disabled=busy||sharedPending||!dirty();
    el('gemini-draft-state').hidden=dirty()||!showSaved||savedModels&&state.app.status==='running'&&(state.models_reload_required===true||sharedApplication?.needs_reload===true);
    if(!el('gemini-draft-state').hidden)words('gemini-draft-state','cap_saved');
  };
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
    const timeout=el('gemini-copilot-timeout'),limit=state.copilot_timeout;
    timeout.disabled=busy||sharedPending||!limit||limit.locked;
    el('gemini-timeout-lock').hidden=limit?.locked!==true;
    if(limit){
      const value=limit.locked?String(limit.effective_ms/1000):timeoutDraft??savedTimeout();
      if(timeout.value!==value)timeout.value=value;
      timeout.placeholder=language.format('gemini_timeout_default',{seconds:limit.default_ms/1000});
    }
    const native=el('gemini-native-source'), sources=state.native_sources||[];
    el('gemini-native-source-field').hidden=!sources.length&&!state.native_source;
    native.disabled=busy||sharedPending;
    const options=[{id:'',name:language.format('gemini_native_source_none')},...sources];
    if(state.native_source&&!sources.some(source=>source.id===state.native_source))options.push({id:state.native_source,name:language.format('unknown'),disabled:true});
    const sourcesKey=JSON.stringify(options);
    if(sourcesKey!==renderedSources){
      native.replaceChildren(...options.map(source=>{const option=document.createElement('option');option.value=source.id;option.textContent=source.name;option.disabled=source.disabled===true;return option}));
      renderedSources=sourcesKey;
    }
    native.value=nativeDraft===undefined?state.native_source??'':nativeDraft??'';
    syncSaveControls();
    words('gemini-save',busy&&pendingAction==='models'?'api_saving':'api_save');if(busy&&pendingAction==='models')el('gemini-save').setAttribute('aria-busy','true');else el('gemini-save').removeAttribute('aria-busy');
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
    renderModels();
    for(const id of ['active','failed','copilot','total'])el('gemini-'+id).textContent=state.activity?.[id]??'—';
    if(notice)words('gemini-note',notice);
  }
  function renderModels(){
    const list=el('gemini-models'),focused=list.contains(document.activeElement)?document.activeElement:null;
    const groups=groupedModels(), catalogKey=JSON.stringify([document.documentElement.lang,groups.map(model=>
      [model.id,model.name,model.context_window,model.efforts.map(item=>[item.id,item.effort])])]);
    if(catalogKey!==renderedCatalog){
      const oldFocus=focused||(lastFieldFocus&&list.contains(lastFieldFocus)?lastFieldFocus:null);
      modelRows=groups.map(model=>{
        const ids=model.efforts.map(item=>item.id);
        const row=document.createElement('tr'),name=document.createElement('td'),label=document.createElement('label'),input=document.createElement('input');
        input.type='checkbox';input.value=model.id;input.setAttribute('aria-label',model.name);
        input.addEventListener('change',()=>{
          const saved=ids.filter(id=>selected().includes(id)),checked=input.checked;
          const values=checked&&saved.length?saved:ids,next=new Set(draft||selected());
          for(const id of values)if(checked)next.add(id);else next.delete(id);
          draft=[...next];if(!checked&&values.includes(currentDefault()))defaultDraft=null;
          notice=null;clear('gemini-note');render();
        });
        label.append(input,document.createTextNode(model.name));name.append(label);row.append(name);
        for(const [key,value]of [['source','GitHub Copilot'],['cap_context',count(model.context_window)]]){
          const cell=document.createElement('td');cell.textContent=value;cell.dataset.label=language.format(key);row.append(cell);
        }
        const efforts=document.createElement('td');efforts.dataset.label=language.format('cap_reasoning');
        efforts.textContent=model.efforts.map(item=>item.effort||'—').join(' / ');
        const preferred=document.createElement('td'),button=document.createElement('button');preferred.dataset.label=language.format('gemini_new_chat_default');
        button.type='button';button.value=model.id;
        button.addEventListener('click',()=>{
          if(button.getAttribute('aria-pressed')==='true')return;
          const chosen=new Set(draft||selected()),saved=ids.filter(id=>selected().includes(id));
          const visible=model.efforts.filter(item=>chosen.has(item.id));
          const available=visible.length?visible:saved.length?model.efforts.filter(item=>saved.includes(item.id)):model.efforts;
          if(!visible.length){for(const item of available)chosen.add(item.id);draft=[...chosen];}
          defaultDraft=(available.find(item=>item.effort==='medium')||available[0])?.id??null;
          notice=null;clear('gemini-note');render();
        });
        preferred.append(button);row.append(efforts,preferred);return {row,model,ids,input,button};
      });
      list.replaceChildren(...modelRows.map(({row})=>row));
      if(!modelRows.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=5;language.set(cell,'gemini_no_models');row.append(cell);list.append(row);}
      if(oldFocus){
        lastFieldFocus=[...list.querySelectorAll(oldFocus.tagName.toLowerCase())].find(control=>control.value===oldFocus.value);
      }
      renderedCatalog=catalogKey;
    }
    const chosen=new Set(draft||selected()),disabled=busy||sharedPending;
    for(const {model,ids,input,button} of modelRows){
      const isDefault=ids.includes(currentDefault())&&chosen.has(currentDefault());
      input.checked=ids.some(id=>chosen.has(id));input.disabled=button.disabled=disabled;
      const title=isDefault?'cap_default':'cap_set_default';language.set(button,title);
      button.setAttribute('aria-pressed',String(isDefault));button.setAttribute('aria-label',language.format('model_action_label',{name:model.name,action:language.format(title)}));
    }
    if(focused&&!focused.isConnected)lastFieldFocus?.focus({preventScroll:true});
  }
  async function load(action,extra={},report=true){
    if(busy&&!reading){if(!report)throw Error('Antigravity settings are busy');return}
    const write=Boolean(action&&action!=='summary');
    if(!write&&reading&&(reading.action===action||action==='summary'))return;
    reading?.controller.abort();
    const controller=new AbortController();
    reading=write?null:{action,controller};
    if(write||!state){busy=true;pendingAction=action;render();}
    try{
      const response=await fetch('/_ccdx/ui/gemini'+(action==='summary'?'?scope=summary':''),{method:write?'POST':'GET',headers:{'X-CCDX-Dashboard':'1',...(write?{'Content-Type':'application/json'}:{})},cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]),...(write?{body:JSON.stringify({action,...(action==='enable'?{accept_background_copilot:true}:{}),...extra})}:{})});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Antigravity setup failed');
      if(controller.signal.aborted)return;
      state=value;if(action==='models'){
        draft=null;defaultDraft=undefined;timeoutDraft=undefined;nativeDraft=undefined;showSaved=true;savedModels=extra.models!==undefined||extra.native_source!==undefined;clearTimeout(savedTimer);savedTimer=setTimeout(()=>{showSaved=false;render()},2200);
      }
      globalThis.ccdxGeminiStatus=state;
      if(action&&action!=='summary'){
        const status=state.last_operation?.status;notice=action==='models'?null:status==='needs_app_relaunch'?'gemini_reopen':status==='opened'?'gemini_opened':status==='route_conflict'?'gemini_conflict':null;
        clear('gemini-note');
      }
      return state;
    }catch(error){if(!controller.signal.aborted){if(!report)throw error;notice='gemini_operation_failed';words('gemini-note',notice);el('gemini-note').title=error.message;}}
    finally{
      if(!controller.signal.aborted){
        if(reading?.controller===controller)reading=null;
        busy=false;pendingAction=null;render();
        window.dispatchEvent(new CustomEvent('ccdx-gemini-state',{detail:{application:state?.application,needsCatalogReload:(state?.enabled===true&&state.source_enabled!==false||Boolean(state?.native_source))&&state.models_reload_required===true&&state.default_model_unavailable!==true}}));
      }
    }
  }
  globalThis.ccdxAntigravity={get state(){return state},get pending(){return busy},refreshStatus:()=>load('summary'),setEnabled:enabled=>load(enabled?'enable':'disable',{},false)};
  el('gemini-enabled').addEventListener('change',event=>void load(event.target.checked?'enable':'disable'));
  el('gemini-model-form').addEventListener('submit',event=>{
    event.preventDefault();if(!dirty())return;
    void load('models',{...(modelsDirty()?{models:draft||selected(),...(defaultDraft!==undefined?{default_model:defaultDraft}:{})}:{}),
      ...(timeoutDirty()?{copilot_timeout_seconds:timeoutDraft===''?null:Number(timeoutDraft)}:{}),
      ...(nativeDirty()?{native_source:nativeDraft}:{})});
  });
  el('gemini-copilot-timeout').addEventListener('input',event=>{timeoutDraft=event.target.value;notice=null;clear('gemini-note');syncSaveControls()});
  el('gemini-native-source').addEventListener('change',event=>{nativeDraft=event.target.value||null;notice=null;clear('gemini-note');syncSaveControls()});
  el('gemini-cancel').addEventListener('click',()=>{draft=null;defaultDraft=undefined;timeoutDraft=undefined;nativeDraft=undefined;notice=null;clear('gemini-note');render()});
  el('gemini-use-app-default').addEventListener('click',()=>{defaultDraft=null;render();el('gemini-save').focus();});
  el('gemini-open').addEventListener('click',()=>{if(globalThis.ccdxApplicationControls)globalThis.ccdxApplicationControls.open('antigravity');else void load('open')});
  window.addEventListener('ccdx:application-state',event=>{if(event.detail?.id==='antigravity'){sharedApplication=event.detail.application;sharedPending=event.detail.pending;render()}});
  el('gemini-refresh').addEventListener('click',()=>void load('refresh'));
  el('refresh').addEventListener('click',()=>{if(['#gemini','#models'].includes(location.hash))void load(location.hash==='#models'?'summary':undefined)});
  el('gemini-model-form').addEventListener('focusin',event=>{lastFieldFocus=event.target});
  window.addEventListener('hashchange',()=>{
    if(location.hash==='#gemini'){
      if(document.activeElement===el('main-content')&&lastFieldFocus?.isConnected)lastFieldFocus.focus({preventScroll:true});
      void load();
    }else if(location.hash==='#models')void load('summary');
  });
  new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  void load(location.hash==='#gemini'?undefined:'summary');
})();
