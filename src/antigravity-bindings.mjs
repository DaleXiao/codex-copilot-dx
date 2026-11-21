import {createHmac} from "node:crypto";
import path from "node:path";
import {accessSettingsPath} from "./access-settings.mjs";
import {readClientGatewayKeys} from "./client-gateway-keys.mjs";
import {atomicWriteFile} from "./atomic-file.mjs";
import {withFileLock} from "./lock.mjs";
import {readBoundedFile} from "./bounded-file.mjs";
import {redactDiagnosticText} from "./diagnostic-text.mjs";
import {httpError} from "./http-errors.mjs";

export const validModel=id=>typeof id==="string"&&/^[\w][\w./:@+-]{0,159}$/.test(id)&&redactDiagnosticText(id)===id;

export function createAntigravityBindings(options,guard){
  let compactionSalt,conversationRoutes,pending=0;
  const routeFile=path.join(path.dirname(accessSettingsPath(options)),"antigravity-conversations.json");
  const readRoutes=async()=>{
    let value;
    try{value=JSON.parse(await readBoundedFile(routeFile,{encoding:"utf8",maxBytes:128*1024}));}
    catch(error){if(error.code==="ENOENT")return {};throw httpError("Antigravity conversation routing data could not be read",409);}
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length>256||
      Object.entries(value).some(([id,item])=>!/^[a-f0-9]{64}$/.test(id)||!item||
        !/^[a-f0-9]{64}$/.test(item.owner)||!validModel(item.model)||
        item.startedAt!==undefined&&!Number.isFinite(item.startedAt)))throw httpError("Invalid Antigravity conversation routing data",409);
    return value;
  };
  const conversationKey=body=>{
    const id=body?.request?.labels?.root_cascade_id||body?.request?.labels?.cascade_id;
    if(typeof id!=="string"||!id||id.length>160||/[\u0000-\u001f\u007f]/.test(id))return null;
    compactionSalt||=readClientGatewayKeys({...options,create:false}).codex;
    return createHmac("sha256",compactionSalt).update("antigravity-compression\0"+id).digest("hex");
  };
  const hashProfile=profile=>createHmac("sha256",compactionSalt).update(profile).digest("hex");
  const store=(routes,key,entry)=>{
    delete routes[key];routes[key]=entry;
    const keys=Object.keys(routes);
    for(const id of keys.slice(0,Math.max(0,keys.length-256)))delete routes[id];
  };
  return {
    hashProfile,
    prepare(body,profile,startedAt){
      const key=conversationKey(body),model=body.model;
      if(!key||!profile||!validModel(model))return;
      const owner=hashProfile(profile);
      return async signal=>{
        if(signal.aborted)return;
        const entry={owner,model,startedAt};
        // Check the durable order inside the lock, including successful requests
        // that use the same model. A late completion cannot change the binding.
        const newer=routes=>routes?.[key]?.owner!==owner||(routes[key].startedAt??0)<startedAt;
        if(!newer(conversationRoutes))return;
        if(!pending&&conversationRoutes?.[key]?.owner===owner&&conversationRoutes[key].model===model){
          store(conversationRoutes,key,entry);
          return;
        }
        pending++;
        try{
          await withFileLock(routeFile+".lock",async()=>{
            const routes=await readRoutes();
            if(signal.aborted||!newer(conversationRoutes))return;
            if(newer(routes)){
              const stored=routes[key];
              store(routes,key,entry);
              if(stored?.owner!==owner||stored.model!==model)await atomicWriteFile(routeFile,JSON.stringify(routes)+"\n",{mode:0o600});
            }
            if(!conversationRoutes)conversationRoutes=routes;
            else if(newer(conversationRoutes))store(conversationRoutes,key,routes[key]);
          },{timeoutMs:1000,signal});
        }catch{
          if(!signal.aborted&&newer(conversationRoutes))store(conversationRoutes||={},key,entry);
        }finally{pending--;}
      };
    },
    async resolve(body){
      const key=conversationKey(body);if(!key)return null;
      const id=body.request.labels.root_cascade_id||body.request.labels.cascade_id;
      const owner=await guard.owner("gemini",id,compactionSalt);
      if(!owner)return null;
      conversationRoutes ||= await readRoutes();
      const entry=conversationRoutes[key];
      return {owner,pinned:entry?.owner===owner?entry.model:null};
    },
  };
}
