import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
import {createAntigravityHandler} from "./antigravity-handler.mjs";
import {createAntigravityImages} from "./antigravity-images.mjs";
import {createCopilotWeb} from "./copilot-web.mjs";
import {hasManagedAntigravityGateway,inspectGeminiApp,planGeminiAppLaunch} from "./gemini-app.mjs";
import {launchWindowsAntigravity} from "./windows-antigravity-app.mjs";
import {readUserSettings,userSettingsPath} from "./user-settings.mjs";
import {readAccessSettings} from "./access-settings.mjs";
import {readClientGatewayKeys} from "./client-gateway-keys.mjs";
import {createConversationSourceGuard} from "./conversation-source-guard.mjs";
import {readSavedGithubToken} from "./auth-credentials.mjs";
import {githubTokenFingerprint} from "./github-identity.mjs";
import {atomicWriteFileIfChangedSync} from "./atomic-file.mjs";
import {withFileLockSync} from "./lock.mjs";
import {httpError} from "./http-errors.mjs";
import {sendJsonError} from "./http-transport.mjs";
import {ANTIGRAVITY_GATEWAY_PREFIX,antigravityGatewayRoute,startAntigravityGateway} from "./antigravity-gateway.mjs";
import {createAntigravityBindings, validModel} from "./antigravity-bindings.mjs";
import {parseTimerMs} from "./runtime-config.mjs";
import {antigravityCopilotModels,antigravityGroupingClient,groupAntigravityModels,planAntigravityGatewayMenu,ANTIGRAVITY_MODEL_PREFIX,ANTIGRAVITY_NATIVE_PREFIX} from "./antigravity-models.mjs";

const execute=promisify(execFile),key="gemini_antigravity_enabled",modelKey="gemini_antigravity_models",defaultKey="gemini_antigravity_default_model";
const timeoutKey="gemini_antigravity_copilot_timeout_seconds";
const nativeSourceKey="gemini_antigravity_native_source";
const launchModeKey="gemini_antigravity_launch_mode";
const validLaunchMode=value=>value==="google"||value==="gateway";
const validTimeout=value=>Number.isSafeInteger(value)&&value>=1&&value<=600;
const validAlias=id=>typeof id==="string"&&/^ccdx-copilot-[a-z0-9._-]{1,140}$/.test(id);
const gatewayNativeAlias=row=>ANTIGRAVITY_NATIVE_PREFIX+createHash("sha256").update(JSON.stringify([row.source,row.model])).digest("hex").slice(0,32);

export function createAntigravityRuntime({client,models=()=>[],refreshModels,privacy,home=os.homedir(),env=process.env,platform=process.platform,inspect=inspectGeminiApp,
  exec=execute,launchWindows=launchWindowsAntigravity,searchFn,imageFn,guardSource,googleFetch,acquireRequest,applicationControl,readToken=()=>readSavedGithubToken(home),
  upstreamTimeoutMs=180000,copilotTimeoutMs,nativeSources=()=>[],getSource=()=>null,handleGatewayRequest,startGateway=startAntigravityGateway,...timeouts}={}) {
  const options={home,env},guard=createConversationSourceGuard(options);
  const web=searchFn?null:createCopilotWeb({client,readToken});
  let app={status:"unknown"},route=null,lastOperation=null,gateway,gatewayRevision,gatewayDiscoversCatalog=false;
  const bindings=createAntigravityBindings(options,guard);
  const settingsFile=userSettingsPath(options);
  let settingsVersion, settingsSnapshot;
  const settings=()=>{
    let version;
    try {
      const stat=fs.statSync(settingsFile,{bigint:true});
      if(stat.isFile())version=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(":");
    } catch { /* The strict reader still decides whether the current file is usable. */ }
    if(version!==undefined&&settingsVersion===version)return settingsSnapshot;
    const saved=readUserSettings({...options,strict:true});
    if(saved[key]!==undefined&&typeof saved[key]!=="boolean")throw httpError("Invalid Gemini integration setting",409);
    if(saved[modelKey]!==undefined&&(!Array.isArray(saved[modelKey])||saved[modelKey].length>100||new Set(saved[modelKey]).size!==saved[modelKey].length||saved[modelKey].some(id=>!validAlias(id))))throw httpError("Invalid Antigravity model selection",409);
    if(saved[defaultKey]!==undefined&&!validAlias(saved[defaultKey]))throw httpError("Invalid Antigravity default model",409);
    const snapshot={configured:Object.hasOwn(saved,key),enabled:saved[key]===true,selected_models:saved[modelKey]??null,default_model:saved[defaultKey]??null,
      copilot_timeout_seconds:validTimeout(saved[timeoutKey])?saved[timeoutKey]:null,native_source:typeof saved[nativeSourceKey]==="string"?saved[nativeSourceKey]:null,
      launch_preference:validLaunchMode(saved[launchModeKey])?saved[launchModeKey]:null};
    settingsVersion=version;settingsSnapshot=snapshot;
    return snapshot;
  };
  const defaultCopilotTimeoutMs=parseTimerMs(env.CCDX_UPSTREAM_TIMEOUT_MS,180000);
  const effectiveCopilotTimeoutMs=saved=>copilotTimeoutMs??(saved.copilot_timeout_seconds===null?defaultCopilotTimeoutMs:saved.copilot_timeout_seconds*1000);
  const available=(saved=settings())=>saved.enabled&&readAccessSettings(options).providers.github?models():[];
  const nativeModels=(sourceId=settings().native_source)=>{
    if(!sourceId)return [];
    const source=nativeSources().find(item=>item.id===sourceId);
    if(!source)return [];
    return source.models.slice(0,40).map(model=>({id:ANTIGRAVITY_NATIVE_PREFIX+source.id+"-"+model.id,model:model.id,source:source.id,
      displayName:`${model.display_name||model.id} (${source.name})`,maxTokens:model.capability?.values.context_window,
      maxOutputTokens:model.capability?.values.max_output_tokens,supportsImages:model.capability?.values.input_modalities?.includes("image")===true}));
  };
  function gatewayModels(saved=settings()){
    const variants=antigravityCopilotModels(available(saved)).filter(row=>saved.selected_models===null||saved.selected_models.includes(row.id));
    return [...variants,...nativeModels(saved.native_source).map(row=>({...row,id:gatewayNativeAlias(row)}))];
  }
  const gatewayCatalog=(saved=settings(),limit=gatewayDiscoversCatalog?32:Infinity)=>
    planAntigravityGatewayMenu(gatewayModels(saved),saved.default_model,limit);
  const catalogRevision=rows=>JSON.stringify(rows.map(row=>[row.id,row.displayName,row.maxTokens,row.maxOutputTokens,row.supportsImages,row.effort]));
  async function prepareGateway(verified){
    const discovery=antigravityGroupingClient(verified?.version);
    const {menu}=gatewayCatalog(settings(),discovery?32:Infinity);
    if(!menu.length)throw httpError("Select an available Copilot or custom Gemini model before opening the gateway",409);
    const listener=await startGateway({handle:handleGatewayRequest||handle,models:discovery?undefined:menu.map(row=>row.id)});
    gateway?.close();
    gateway=listener;
    gatewayDiscoversCatalog=discovery;
    gatewayRevision=discovery?null:catalogRevision(menu);
    return gateway;
  }
  function saveLaunchPreference(mode){
    const file=userSettingsPath(options);
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    withFileLockSync(file+".lock",()=>{
      const saved=readUserSettings({...options,strict:true});
      if(saved[launchModeKey]===mode)return;
      saved[launchModeKey]=mode;
      atomicWriteFileIfChangedSync(file,JSON.stringify(saved,null,2)+"\n",{mode:0o600});
    });
  }
  const profileFor=source=>source==="github"?"codex:"+githubTokenFingerprint(readToken()||"")
    :source==="google"?"google:gemini-native":getSource(source)?.profileId("gemini");
  const sourceGuard=guardSource||(async(body,source,signal)=>{
    const labels=body.request?.labels||{},id=labels.root_cascade_id||labels.cascade_id;
    if(typeof id!=="string"||!id||id.length>160)throw httpError("Antigravity request has no stable conversation identifier",400);
    const profile=profileFor(source);
    if(!profile)throw httpError("Antigravity source is unavailable",503);
    await guard("gemini",profile,{messages:[]},{session_id:id},readClientGatewayKeys({...options,create:false}).codex,undefined,signal);
    return profile;
  });
  const handler=createAntigravityHandler({client,models:available,selectedModels:(saved=settings())=>saved.selected_models,
    defaultModel:(saved=settings())=>saved.default_model,enabled:(saved=settings())=>saved.configured||saved.native_source!==null,
    requestSettings:settings,privacy,searchFn:searchFn||web.search,
    groupCapable(userAgent){
      const advertised=typeof userAgent==="string"?/\bantigravity\/hub\/(\d+(?:\.\d+){2,3})(?=\s|$|[;)])/i.exec(userAgent)?.[1]:null;
      return antigravityGroupingClient(advertised??applicationControl?.snapshot().antigravity?.version??app.version);
    },
    nativeModels:(saved=settings())=>nativeModels(saved.native_source),
    resolveNativeModel(id,saved=settings()){
      const model=nativeModels(saved.native_source).find(entry=>entry.id===id);if(!model)return null;
      const source=getSource(model.source);return source?.client?.gemini?{...model,transport:source}:null;
    },
    imageFn:imageFn||createAntigravityImages({client,models:available,privacy}),guardSource:sourceGuard,compactionProfile:()=>githubTokenFingerprint(readToken()||""),
    prepareConversationBinding(body,source,profile,startedAt){
      return bindings.prepare(body,profile||profileFor(source),startedAt);
    },
    async resolveCompactionSource(body,saved=settings()){
      const binding=await bindings.resolve(body);
      if(!binding)return null;
      const {owner,pinned}=binding;
      if(owner===bindings.hashProfile(profileFor("google"))){
        const model=pinned||body.model;
        if(!validModel(model)||model.startsWith(ANTIGRAVITY_MODEL_PREFIX)||model.startsWith(ANTIGRAVITY_NATIVE_PREFIX))throw httpError("The conversation belongs to another model source",409);
        return{source:"google",model};
      }
      if(owner===bindings.hashProfile(profileFor("github"))){
        const model=pinned||(validAlias(body.model)?body.model:null);
        return model?{source:"github",model}:{source:"github",background:true};
      }
      const selected=saved.native_source, profile=selected&&profileFor(selected);
      const model=profile&&owner===bindings.hashProfile(profile)&&nativeModels(selected).find(entry=>entry.id===(pinned||body.model));
      if(model)return{source:selected,model:model.id};
      throw httpError("The conversation belongs to another model source",409);
    },fetchGoogle:googleFetch,acquireRequest,upstreamTimeoutMs,...timeouts,generationSettings(saved){
      return { selection:saved.selected_models, copilotTimeoutMs:effectiveCopilotTimeoutMs(saved), preferred:saved.default_model };
    }});
  function handle(req,res){
    const pathname=new URL(req.url,"http://localhost").pathname;
    if(!pathname.startsWith(ANTIGRAVITY_GATEWAY_PREFIX+"/"))return handler(req,res);
    if(!gateway?.owns(req))return sendJsonError(res,httpError("Antigravity gateway authentication is required",403));
    const wire=antigravityGatewayRoute(pathname);
    if(!wire)return sendJsonError(res,httpError("Unknown Antigravity gateway endpoint",404));
    if(wire.method==="catalog"&&req.method==="GET"){
      const {menu:entries}=gatewayCatalog();
      const models=entries.map(row=>({name:"models/"+row.id,displayName:row.displayName.replace(/ \(Xhigh\)$/," (XHigh)"),inputTokenLimit:row.maxTokens,
        outputTokenLimit:row.maxOutputTokens,supportedGenerationMethods:["generateContent","streamGenerateContent",
          ...(row.source?["countTokens"]:[])]}));
      if(gatewayDiscoversCatalog)gatewayRevision=catalogRevision(entries);
      gateway.observe?.("catalog");
      res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify({models}));return;
    }
    if(wire.method==="metrics"&&req.method==="POST"){
      req.resume();res.writeHead(200,{"Content-Type":"application/json"});res.end("{}");return;
    }
    if(!wire.model||req.method!=="POST")return sendJsonError(res,httpError("Unsupported Antigravity gateway method",405));
    if(wire.model.startsWith(ANTIGRAVITY_NATIVE_PREFIX)){
      const native=nativeModels().find(row=>gatewayNativeAlias(row)===wire.model);
      if(!native)return sendJsonError(res,httpError("The selected Antigravity gateway model is unavailable",503));
      wire.model=native.id;
    }
    const listener=gateway;
    if(wire.method!=="countTokens")res.once("finish",()=>{if(res.statusCode>=200&&res.statusCode<300)listener.observe?.("inference");});
    return handler(req,res,wire);
  }
  function snapshot(){
    const config=settings(),sourceEnabled=readAccessSettings(options).providers.github,activity=handler.snapshot(config);
    const sources=nativeSources(), selectedNative=sources.find(item=>item.id===config.native_source);
    const catalog=models();
    const listed=antigravityCopilotModels(catalog).map(({id,model,displayName,effort,maxTokens})=>({id,model,name:displayName,effort,context_window:maxTokens,default:id===config.default_model,selected:config.selected_models===null||config.selected_models.includes(id)}));
    const groups=groupAntigravityModels(listed,catalog);
    const expected=[...(config.enabled&&sourceEnabled?listed.filter(model=>model.selected).map(model=>model.id):[]),...nativeModels(config.native_source).map(model=>model.id)].sort();
    const desiredDefault=expected.includes(config.default_model)?config.default_model:null;
    const googleReload=config.enabled&&sourceEnabled||config.native_source?(activity.catalog_models===null?null:JSON.stringify([...activity.catalog_models].sort())!==JSON.stringify(expected)
      ||activity.catalog_default_supported===true&&activity.catalog_default_model!==desiredDefault):false;
    const defaultUnavailable=config.default_model!==null&&(!desiredDefault||activity.catalog_default_supported===false);
    const current=applicationControl?.snapshot().antigravity;
    const gatewayActive=gateway?.active()===true;
    const gatewayMenu=gatewayActive?gatewayCatalog(config):null;
    const gatewayReload=gatewayMenu?(gatewayRevision===null?null:gatewayRevision!==catalogRevision(gatewayMenu.menu)):false;
    const reload=current?.launch_mode==="gateway"||(!current?.launch_mode&&gatewayActive)?gatewayReload:googleReload;
    const visibleApp=current?{status:current.status,version:current.version||null,pids:current.pid?[current.pid]:[]}:app;
    return {source:"gemini_antigravity",...config,native_sources:sources.map(({id,name})=>({id,name})),copilot_timeout:{effective_ms:effectiveCopilotTimeoutMs(config),default_ms:defaultCopilotTimeoutMs,locked:copilotTimeoutMs!==undefined},
      source_enabled:sourceEnabled,default_model_unavailable:defaultUnavailable,models_reload_required:reload,app:visibleApp,application:current||null,route_observed:activity.observed,
      enterprise_gateway_running:gatewayActive,gateway_models_omitted:gatewayMenu?.omitted||0,catalog_reload:{google:googleReload,gateway:gatewayReload},
      model_source:["Google",...(config.enabled&&sourceEnabled?["GitHub Copilot"]:[]),...(selectedNative?[selectedNative.name]:[])].join(" + "),background_source:"GitHub Copilot",ordinary_chat_source:"Google (unchanged)",
      compaction_source:"Observed conversation source; existing background policy when unassigned",
      models:listed,model_groups:groups,activity,last_operation:lastOperation};
  }
  async function action(input={},baseUrl){
    if(input&&Object.keys(input).some(name=>!["action","accept_background_copilot","models","default_model","copilot_timeout_seconds","native_source","launch_mode","confirmed","expected_pid","expected_started"].includes(name)))throw httpError("Invalid Gemini operation",400);
    const operation=input.action||"status";
    const timeout=input.copilot_timeout_seconds;
    const nativeSource=input.native_source;
    if(!["status","summary","refresh","models","enable","disable","open","preview","standalone-open","gateway-open","web-open","web-restart"].includes(operation))throw httpError("Unknown Gemini operation",400);
    if((input.models!==undefined||input.default_model!==undefined)&&operation!=="models")throw httpError("Models require the models operation",400);
    if(nativeSource!==undefined&&(operation!=="models"||nativeSource!==null&&!nativeSources().some(source=>source.id===nativeSource)))throw httpError("Choose an available Gemini source",400);
    if(timeout!==undefined){
      if(operation!=="models"||timeout!==null&&!validTimeout(timeout))throw httpError("Choose a Copilot timeout from 1 to 600 seconds, or use the default",400);
      if(copilotTimeoutMs!==undefined)throw httpError("Copilot timeout is controlled by the startup environment",409);
    }
    if(operation==="web-open"||operation==="web-restart"){
      const mode=input.launch_mode;
      if(mode!==undefined&&!validLaunchMode(mode))throw httpError("Choose a valid Antigravity launch mode",400);
      if(!applicationControl?.openAntigravityFromWeb)throw httpError("Antigravity launch is unavailable",503);
      const result=await applicationControl.openAntigravityFromWeb({operation:operation==="web-open"?"open":"restart",confirmed:input.confirmed,
        expected_pid:input.expected_pid,expected_started:input.expected_started},
      {mode,preference:settings().launch_preference,available:()=>gatewayModels().length>0,prepare:prepareGateway});
      if(result.status==="opened"&&mode)saveLaunchPreference(mode);
      lastOperation={action:operation,...result};
      return snapshot();
    }
    if(operation==="gateway-open"||operation==="standalone-open"){
      if(!applicationControl?.openStandaloneAntigravity)throw httpError("Standalone Antigravity launch is unavailable",503);
      const result=await applicationControl.openStandaloneAntigravity(operation==="gateway-open"?prepareGateway:undefined);
      lastOperation={action:operation,...result};
      return snapshot();
    }
    if(operation==="refresh"){
      if(!refreshModels)throw httpError("Antigravity model refresh is unavailable in this service",503);
      await refreshModels();lastOperation={action:operation,status:"models_refreshed"};
    }
    if(operation==="models"){
      const ids=input.models;
      if(ids!==undefined||timeout===undefined&&nativeSource===undefined||input.default_model!==undefined){
        const known=new Set(antigravityCopilotModels(models()).map(model=>model.id));
        if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!known.has(id)))throw httpError("Choose available Antigravity models",400);
      }
      const file=userSettingsPath(options);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
      if(input.default_model!==undefined&&input.default_model!==null&&(!validAlias(input.default_model)||!ids.includes(input.default_model)))throw httpError("Choose a selected Antigravity model as the default",400);
      withFileLockSync(file+".lock",()=>{
        const saved=readUserSettings({...options,strict:true});
        if(ids!==undefined){
          saved[modelKey]=ids;
          if(input.default_model!==undefined&&input.default_model!==null)saved[defaultKey]=input.default_model;
          if(input.default_model===null||saved[defaultKey]!==undefined&&!ids.includes(saved[defaultKey]))delete saved[defaultKey];
        }
        if(timeout===null)delete saved[timeoutKey];
        else if(timeout!==undefined)saved[timeoutKey]=timeout;
        if(nativeSource===null)delete saved[nativeSourceKey];
        else if(nativeSource!==undefined)saved[nativeSourceKey]=nativeSource;
        atomicWriteFileIfChangedSync(file,JSON.stringify(saved,null,2)+"\n",{mode:0o600});
      });
      lastOperation={action:operation,status:"models_saved"};
    }
    if(operation==="summary"||operation==="models"&&input.models===undefined&&nativeSource===undefined)return snapshot();
    if(["enable","disable"].includes(operation)){
      if(operation==="enable"&&input.accept_background_copilot!==true)throw httpError("Antigravity background requests use GitHub Copilot; accept this scope before enabling",400);
      if(operation==="enable")readClientGatewayKeys(options);
      const file=userSettingsPath(options);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
      withFileLockSync(file+".lock",()=>{const saved=readUserSettings({...options,strict:true});atomicWriteFileIfChangedSync(file,JSON.stringify({...saved,[key]:operation==="enable"},null,2)+"\n",{mode:0o600})});
      lastOperation=null;
    }
    if(applicationControl){
      if(operation==="open"){
        const result=await applicationControl.action({id:"antigravity",operation:"open"});lastOperation={action:operation,status:result.status};
      }else if(operation==="preview"){
        const plan=await applicationControl.previewAntigravity();lastOperation={action:operation,status:plan.status,...(plan.status==="prepared"?{plan:{command:plan.command,args:plan.args}}:{})};
      }else await applicationControl.check("antigravity",true);
      return snapshot();
    }
    app=await inspect({home,env,platform,exec});route=baseUrl+"/antigravity";
    if(["open","preview"].includes(operation)){
      const config=settings();
      const cloudCodeUrl=config.enabled||config.native_source?route:undefined;
      const plan=planGeminiAppLaunch(app,{cloudCodeUrl,env,home,platform,
        managedGateway:cloudCodeUrl!==undefined&&await hasManagedAntigravityGateway({platform,env})});
      lastOperation={action:operation,status:plan.status};
      if(operation==="open"&&plan.status==="prepared"){
        if(platform==="win32")await launchWindows(plan);
        else await exec(plan.command,plan.args,{encoding:"utf8",timeout:5000,maxBuffer:4096});
        lastOperation.status="opened";app={...app,status:"starting"};
      }
      if(operation==="preview"&&plan.status==="prepared")lastOperation.plan={command:plan.command,args:plan.args};
    }
    return snapshot();
  }
  return {handle,snapshot,action,close(){gateway?.close();web?.close()}};
}
