import fs from "node:fs";
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
import {antigravityCopilotModels} from "./antigravity-models.mjs";

const execute=promisify(execFile),key="gemini_antigravity_enabled";

export function createAntigravityRuntime({client,models=()=>[],privacy,home=os.homedir(),env=process.env,inspect=inspectGeminiApp,
  exec=execute,searchFn,imageFn,guardSource,googleFetch,acquireRequest,readToken=()=>readSavedGithubToken(home),...timeouts}={}) {
  const options={home,env},guard=createConversationSourceGuard(options);
  const web=searchFn?null:createCopilotWeb({client,readToken});
  let app={status:"unknown"},route=null,lastOperation=null;
  const settings=()=>{
    const saved=readUserSettings({...options,strict:true});
    if(saved[key]!==undefined&&typeof saved[key]!=="boolean")throw httpError("Invalid Gemini integration setting",409);
    return {configured:Object.hasOwn(saved,key),enabled:saved[key]===true};
  };
  const available=()=>settings().enabled&&readAccessSettings(options).providers.github?models():[];
  const sourceGuard=guardSource||((body,source,signal)=>{
    const labels=body.request?.labels||{},id=labels.root_cascade_id||labels.cascade_id;
    if(typeof id!=="string"||!id||id.length>160)throw httpError("Antigravity request has no stable conversation identifier",400);
    const profile=source==="github"?"codex:"+githubTokenFingerprint(readToken()||""):"google:gemini-native";
    return guard("gemini",profile,{messages:[]},{session_id:id},readClientGatewayKeys({...options,create:false}).codex,undefined,signal);
  });
  const handler=createAntigravityHandler({client,models:available,enabled:()=>settings().configured,privacy,searchFn:searchFn||web.search,
    imageFn:imageFn||createAntigravityImages({client,models:available,privacy}),guardSource:sourceGuard,fetchGoogle:googleFetch,acquireRequest,...timeouts});
  function snapshot(){
    const config=settings();
    return {source:"gemini_antigravity",...config,app,route_observed:handler.snapshot().observed,
      model_source:"Google + GitHub Copilot",background_source:"GitHub Copilot",ordinary_chat_source:"Google (unchanged)",
      models:antigravityCopilotModels(available()).map(({id,displayName})=>({id,name:displayName})),activity:handler.snapshot(),last_operation:lastOperation};
  }
  async function action(input={},baseUrl){
    if(input&&Object.keys(input).some(name=>!["action","accept_background_copilot"].includes(name)))throw httpError("Invalid Gemini operation",400);
    const operation=input.action||"status";
    if(!["status","enable","disable","open","preview"].includes(operation))throw httpError("Unknown Gemini operation",400);
    if(["enable","disable"].includes(operation)){
      if(operation==="enable"&&input.accept_background_copilot!==true)throw httpError("Antigravity background requests use GitHub Copilot; accept this scope before enabling",400);
      if(operation==="enable")readClientGatewayKeys(options);
      const file=userSettingsPath(options);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
      withFileLockSync(file+".lock",()=>{const saved=readUserSettings({...options,strict:true});atomicWriteFileIfChangedSync(file,JSON.stringify({...saved,[key]:operation==="enable"},null,2)+"\n",{mode:0o600})});
      lastOperation=null;
    }
    app=await inspect();route=baseUrl+"/antigravity";
    if(["open","preview"].includes(operation)){
      const config=settings();
      const plan=config.enabled?planGeminiAppLaunch(app,{cloudCodeUrl:route,env}):app.status==="stopped"?{status:"prepared",command:"/usr/bin/open",args:["-a",app.app]}:{status:app.status==="running"?"needs_app_relaunch":app.status};
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
