import fs from "node:fs";
import {createHmac} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createAntigravityHandler} from "./antigravity-handler.mjs";
import {createAntigravityImages} from "./antigravity-images.mjs";
import {createCopilotWeb} from "./copilot-web.mjs";
import {inspectGeminiApp,planGeminiAppLaunch} from "./gemini-app.mjs";
import {readUserSettings,userSettingsPath} from "./user-settings.mjs";
import {readAccessSettings} from "./access-settings.mjs";
import {readClientGatewayKeys} from "./client-gateway-keys.mjs";
import {createConversationSourceGuard} from "./conversation-source-guard.mjs";
import {readSavedGithubToken} from "./auth-credentials.mjs";
import {githubTokenFingerprint} from "./github-identity.mjs";
import {atomicWriteFileIfChangedSync} from "./atomic-file.mjs";
import {withFileLockSync} from "./lock.mjs";
import {httpError} from "./http-errors.mjs";
import {antigravityCopilotModels,ANTIGRAVITY_NATIVE_PREFIX} from "./antigravity-models.mjs";

const execute=promisify(execFile),key="gemini_antigravity_enabled",modelKey="gemini_antigravity_models",defaultKey="gemini_antigravity_default_model";
const timeoutKey="gemini_antigravity_copilot_timeout_seconds";
const nativeSourceKey="gemini_antigravity_native_source";
const validTimeout=value=>Number.isSafeInteger(value)&&value>=1&&value<=600;
const validAlias=id=>typeof id==="string"&&/^ccdx-copilot-[a-z0-9._-]{1,140}$/.test(id);

export function createAntigravityRuntime({client,models=()=>[],refreshModels,privacy,home=os.homedir(),env=process.env,inspect=inspectGeminiApp,
  exec=execute,searchFn,imageFn,guardSource,googleFetch,acquireRequest,applicationControl,readToken=()=>readSavedGithubToken(home),
  upstreamTimeoutMs=180000,copilotTimeoutMs,nativeSources=()=>[],getSource=()=>null,...timeouts}={}) {
  const options={home,env},guard=createConversationSourceGuard(options);
  const web=searchFn?null:createCopilotWeb({client,readToken});
  let app={status:"unknown"},route=null,lastOperation=null,compactionSalt;const conversationSources=new Map();
  const conversationKey=body=>{
    const id=body?.request?.labels?.root_cascade_id||body?.request?.labels?.cascade_id;
    if(typeof id!=="string"||!id||id.length>160||/[\u0000-\u001f\u007f]/.test(id))return null;
    compactionSalt||=readClientGatewayKeys({...options,create:false}).codex;
    return createHmac("sha256",compactionSalt).update("antigravity-compression\0"+id).digest("hex");
  };
  const settings=()=>{
    const saved=readUserSettings({...options,strict:true});
    if(saved[key]!==undefined&&typeof saved[key]!=="boolean")throw httpError("Invalid Gemini integration setting",409);
    if(saved[modelKey]!==undefined&&(!Array.isArray(saved[modelKey])||saved[modelKey].length>100||new Set(saved[modelKey]).size!==saved[modelKey].length||saved[modelKey].some(id=>!validAlias(id))))throw httpError("Invalid Antigravity model selection",409);
    if(saved[defaultKey]!==undefined&&!validAlias(saved[defaultKey]))throw httpError("Invalid Antigravity default model",409);
    return {configured:Object.hasOwn(saved,key),enabled:saved[key]===true,selected_models:saved[modelKey]??null,default_model:saved[defaultKey]??null,
      copilot_timeout_seconds:validTimeout(saved[timeoutKey])?saved[timeoutKey]:null,native_source:typeof saved[nativeSourceKey]==="string"?saved[nativeSourceKey]:null};
  };
  const configuredTimeout=saved=>copilotTimeoutMs??(saved.copilot_timeout_seconds===null?undefined:saved.copilot_timeout_seconds*1000);
  const available=()=>settings().enabled&&readAccessSettings(options).providers.github?models():[];
  const nativeModels=(sourceId=settings().native_source)=>{
    if(!sourceId)return [];
    const source=nativeSources().find(item=>item.id===sourceId);
    if(!source)return [];
    return source.models.slice(0,40).map(model=>({id:ANTIGRAVITY_NATIVE_PREFIX+source.id+"-"+model.id,model:model.id,source:source.id,
      displayName:`${model.display_name||model.id} (${source.name})`,maxTokens:model.capability?.values.context_window,
      maxOutputTokens:model.capability?.values.max_output_tokens,supportsImages:model.capability?.values.input_modalities?.includes("image")===true}));
  };
  const sourceGuard=guardSource||((body,source,signal)=>{
    const labels=body.request?.labels||{},id=labels.root_cascade_id||labels.cascade_id;
    if(typeof id!=="string"||!id||id.length>160)throw httpError("Antigravity request has no stable conversation identifier",400);
    const profile=source==="github"?"codex:"+githubTokenFingerprint(readToken()||""):source==="google"?"google:gemini-native":getSource(source)?.profileId("gemini");
    if(!profile)throw httpError("Antigravity source is unavailable",503);
    return guard("gemini",profile,{messages:[]},{session_id:id},readClientGatewayKeys({...options,create:false}).codex,undefined,signal);
  });
  const handler=createAntigravityHandler({client,models:available,selectedModels:()=>settings().selected_models,defaultModel:()=>settings().default_model,enabled:()=>{const saved=settings();return saved.configured||saved.native_source!==null;},privacy,searchFn:searchFn||web.search,
    nativeModels,resolveNativeModel(id){const model=nativeModels().find(entry=>entry.id===id);if(!model)return null;const source=getSource(model.source);return source?.client?.gemini?{...model,transport:source}:null;},
    imageFn:imageFn||createAntigravityImages({client,models:available,privacy}),guardSource:sourceGuard,compactionProfile:()=>githubTokenFingerprint(readToken()||""),
    rememberConversationSource(body,source){const key=conversationKey(body);if(!key||typeof body.model!=="string"||!/^[\w][\w./:@+-]{0,159}$/.test(body.model))return;conversationSources.delete(key);conversationSources.set(key,{source,model:body.model});while(conversationSources.size>256)conversationSources.delete(conversationSources.keys().next().value)},
    async resolveCompactionSource(body){
      const key=conversationKey(body);if(!key)return null;if(conversationSources.has(key))return conversationSources.get(key);
      const id=body.request.labels.root_cascade_id||body.request.labels.cascade_id,owner=await guard.owner("gemini",id,compactionSalt);
      const profileHash=value=>createHmac("sha256",compactionSalt).update(value).digest("hex");
      if(owner===profileHash("google:gemini-native")){
        if(body.model.startsWith("ccdx-copilot-"))throw httpError("The conversation belongs to another model source",409);
        return{source:"google",model:body.model};
      }
      if(owner===profileHash("codex:"+githubTokenFingerprint(readToken()||"")))return{source:"github",background:true};
      if(owner){
        const selected=settings().native_source, profile=selected&&getSource(selected)?.profileId("gemini");
        const model=nativeModels(selected).find(entry=>entry.id===body.model);
        if(profile&&owner===profileHash(profile)&&model)return{source:selected,model:model.id};
        throw httpError("The conversation belongs to another model source",409);
      }
      return null;
    },fetchGoogle:googleFetch,acquireRequest,upstreamTimeoutMs,...timeouts,generationSettings(){
      const saved=settings();return { selection:saved.selected_models, copilotTimeoutMs:configuredTimeout(saved) };
    }});
  function snapshot(){
    const config=settings(),sourceEnabled=readAccessSettings(options).providers.github,activity=handler.snapshot();
    const sources=nativeSources(), selectedNative=sources.find(item=>item.id===config.native_source);
    const listed=antigravityCopilotModels(models()).map(({id,model,displayName,effort,maxTokens})=>({id,model,name:displayName,effort,context_window:maxTokens,default:id===config.default_model,selected:config.selected_models===null||config.selected_models.includes(id)}));
    const groups=new Map();
    for(const variant of listed){
      if(!groups.has(variant.model))groups.set(variant.model,{id:variant.model,name:variant.name.split(" · Copilot")[0],source:"github",context_window:variant.context_window,default:false,efforts:[]});
      const group=groups.get(variant.model);group.default||=variant.default;group.efforts.push({id:variant.id,effort:variant.effort,selected:variant.selected});
    }
    const expected=[...(config.enabled&&sourceEnabled?listed.filter(model=>model.selected).map(model=>model.id):[]),...nativeModels(config.native_source).map(model=>model.id)].sort();
    const desiredDefault=expected.includes(config.default_model)?config.default_model:null;
    const reload=config.enabled&&sourceEnabled||config.native_source?(activity.catalog_models===null?null:JSON.stringify([...activity.catalog_models].sort())!==JSON.stringify(expected)
      ||activity.catalog_default_supported===true&&activity.catalog_default_model!==desiredDefault):false;
    const defaultUnavailable=config.default_model!==null&&(!desiredDefault||activity.catalog_default_supported===false);
    const current=applicationControl?.snapshot().antigravity;
    const visibleApp=current?{status:current.status,version:current.version||null,pids:current.pid?[current.pid]:[]}:app;
    return {source:"gemini_antigravity",...config,native_sources:sources.map(({id,name})=>({id,name})),copilot_timeout:{effective_ms:configuredTimeout(config)??upstreamTimeoutMs,default_ms:upstreamTimeoutMs,locked:copilotTimeoutMs!==undefined},
      source_enabled:sourceEnabled,default_model_unavailable:defaultUnavailable,models_reload_required:reload,app:visibleApp,application:current||null,route_observed:activity.observed,
      model_source:["Google",...(config.enabled&&sourceEnabled?["GitHub Copilot"]:[]),...(selectedNative?[selectedNative.name]:[])].join(" + "),background_source:"GitHub Copilot",ordinary_chat_source:"Google (unchanged)",
      compaction_source:"Observed conversation source; existing background policy when unassigned",
      models:listed,model_groups:[...groups.values()],activity,last_operation:lastOperation};
  }
  async function action(input={},baseUrl){
    if(input&&Object.keys(input).some(name=>!["action","accept_background_copilot","models","default_model","copilot_timeout_seconds","native_source"].includes(name)))throw httpError("Invalid Gemini operation",400);
    const operation=input.action||"status";
    const timeout=input.copilot_timeout_seconds;
    const nativeSource=input.native_source;
    if(!["status","summary","refresh","models","enable","disable","open","preview"].includes(operation))throw httpError("Unknown Gemini operation",400);
    if((input.models!==undefined||input.default_model!==undefined)&&operation!=="models")throw httpError("Models require the models operation",400);
    if(nativeSource!==undefined&&(operation!=="models"||nativeSource!==null&&!nativeSources().some(source=>source.id===nativeSource)))throw httpError("Choose an available Gemini source",400);
    if(timeout!==undefined){
      if(operation!=="models"||timeout!==null&&!validTimeout(timeout))throw httpError("Choose a Copilot timeout from 1 to 600 seconds, or use the default",400);
      if(copilotTimeoutMs!==undefined)throw httpError("Copilot timeout is controlled by the startup environment",409);
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
    app=await inspect();route=baseUrl+"/antigravity";
    if(["open","preview"].includes(operation)){
      const config=settings();
      const plan=config.enabled||config.native_source?planGeminiAppLaunch(app,{cloudCodeUrl:route,env,home}):app.status==="stopped"?{status:"prepared",command:"/usr/bin/open",args:["-a",app.app]}:{status:app.status==="running"?"needs_app_relaunch":app.status};
      lastOperation={action:operation,status:plan.status};
      if(operation==="open"&&plan.status==="prepared"){
        await exec(plan.command,plan.args,{encoding:"utf8",timeout:5000,maxBuffer:4096});lastOperation.status="opened";app={...app,status:"starting"};
      }
      if(operation==="preview"&&plan.status==="prepared")lastOperation.plan={command:plan.command,args:plan.args};
    }
    return snapshot();
  }
  return {handle:handler,snapshot,action,close(){web?.close()}};
}
