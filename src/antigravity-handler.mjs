import {randomUUID,createHash} from "node:crypto";
import {buildResponsesUsageRecord,recordUsage} from "./usage-store.mjs";
import {createRequestAbort,readJsonBody,readBoundedResponseText,writeOrDrain,httpError,sendJsonError} from "./http-transport.mjs";
import {safeUpstreamResponseHeaders} from "./upstream-headers.mjs";
import {isLoopbackAddress,isLoopbackHostHeader} from "./security.mjs";
import {antigravityToChat,chatToAntigravity,chatStreamToAntigravity,parseAntigravityJSON} from "./antigravity-chat-bridge.mjs";
import {ANTIGRAVITY_MODEL_PREFIX,antigravityCopilotModels,mergeAntigravityModels} from "./antigravity-models.mjs";
import {createPrivacyTextFragments} from "./privacy-stream.mjs";
import {createGoogleResponseObserver,googleUsageEvent} from "./antigravity-usage.mjs";
import {currentRequestContext,observeRequestedModel} from "./request-context.mjs";
import {markUpstreamStarted,markUpstreamHeaders,markFirstOutput,markOutputTokens,markRequestObservation,markResponseModel,markResponseTerminal} from "./stream-performance.mjs";
import {isCompactionRequest} from "./context-compaction.mjs";
import {compactionSummarizer} from "./context-compaction-wire.mjs";
import {requestPurpose} from "./request-context.mjs";
import {observeContextSession} from "./context-metrics.mjs";

const PREFIX="/antigravity";
const MAX_REPLY=64*1024*1024;
const GOOGLE_ORIGIN="https://daily-cloudcode-pa.googleapis.com";
const controlMethods=new Set(["loadCodeAssist","fetchUserInfo","fetchAdminControls","fetchAvailableModels","retrieveUserQuotaSummary","listExperiments","buildWithGooglePlugins","writeTrajectoryAcls","cascadeNuxes"]);
const passthrough=body=>({body,count:0,restoreText:value=>value,restoreValue:value=>value,restoreToolValue:value=>value,release(){}});
const nativeHeaders=req=>Object.fromEntries(["authorization","user-agent","x-goog-api-client","x-goog-user-project","accept"].filter(key=>typeof req.headers[key]==="string").map(key=>[key,req.headers[key]]));

function parseBody(text){try{return parseAntigravityJSON(text)}catch{throw httpError("Invalid Antigravity JSON",400)}}
function searchQuery(request){
  const contents=request?.contents;
  if(!Array.isArray(contents)||contents.some(item=>!Array.isArray(item.parts)||item.parts.some(part=>typeof part.text!=="string")))throw httpError("Unsupported Antigravity search request",400);
  const query=contents.flatMap(item=>item.parts.map(part=>part.text)).join("\n");
  if(!query.trim()||query.length>4096)throw httpError("Antigravity search query exceeds the Copilot search limit",400);
  return query;
}
function groundedSearch(result,query){
  if(typeof result?.output!=="string"||!Array.isArray(result.results))throw httpError("Invalid Copilot search response",502);
  const sources=result.results.filter(item=>item?.type==="text_result"&&typeof item.url==="string");
  return {candidates:[{index:0,content:{role:"model",parts:[{text:result.output}]},finishReason:"STOP",
    groundingMetadata:{webSearchQueries:[query],groundingChunks:sources.map(item=>({web:{uri:item.url,title:item.title||item.url}}))}}]};
}

export function createAntigravityHandler({client,models=()=>[],selectedModels=()=>null,enabled=()=>false,privacy,searchFn,imageFn,guardSource,acquireRequest=async()=>()=>{},
  compaction,compactionProfile=()=>"github",rememberConversationSource=()=>{},resolveCompactionSource=()=>null,recordUsageFn=recordUsage,fetchGoogle=fetch,googleOrigin=GOOGLE_ORIGIN,requestBodyTimeoutMs=120000,upstreamTimeoutMs=180000,streamIdleTimeoutMs=60000}={}) {
  if(![GOOGLE_ORIGIN,"https://cloudcode-pa.googleapis.com"].includes(googleOrigin))throw new Error("Unrecognized Google control origin");
  let active=0,observed=false,catalogModels=null;const nativeWindows=new Map();
  const counts={total:0,google:0,copilot:0,search:0,images:0,failed:0};
  const handler=async(req,res)=>{
    const abort=createRequestAbort(req,res);let release=()=>{},session,usageEvent=null,usageModel=null,outcome=null,usageMode,usageProvider;
    const captureUsage=event=>{
      if(!event?.usage&&!event?.copilot_usage)return;
      const known=value=>Number.isSafeInteger(value)&&value>=0,u={...usageEvent?.usage},incoming=event.usage;
      for(const key of ["prompt_tokens","completion_tokens","total_tokens"])if(known(incoming?.[key]))u[key]=incoming[key];
      for(const [key,field]of [["prompt_tokens_details","cached_tokens"],["completion_tokens_details","reasoning_tokens"]])if(known(incoming?.[key]?.[field]))u[key]={[field]:incoming[key][field]};
      const billing=Array.isArray(event.copilot_usage?.token_details)?event.copilot_usage:undefined;
      usageEvent={...usageEvent,...(Object.keys(u).length?{usage:u}:{}),...(billing?{copilot_usage:billing}:{}),
        ...(typeof event.id==="string"?{id:event.id}:{}),...(typeof event.model==="string"?{model:event.model}:{})};
      markOutputTokens(u.completion_tokens);
      if(typeof event.model==="string")markResponseModel(event.model);
      const hasBilling=usageEvent.copilot_usage?.token_details.some(item=>known(item?.token_count)&&item.token_count>0);
      markRequestObservation({input_tokens:u.prompt_tokens,cached_input_tokens:u.prompt_tokens_details?.cached_tokens,
        usage_state:known(u.prompt_tokens)&&known(u.completion_tokens)&&known(u.prompt_tokens_details?.cached_tokens)?"reported":Object.keys(u).length||hasBilling?"partial":"missing"});
    };
    active++;counts.total++;
    try{
      if(!enabled())throw httpError("Antigravity integration is disabled",503);
      if(!isLoopbackAddress(req.socket?.remoteAddress)||!isLoopbackHostHeader(req.headers.host)||Object.hasOwn(req.headers,"origin"))throw httpError("Antigravity requires a native local client",403);
      if(!["POST","GET"].includes(req.method))throw httpError("Unsupported Antigravity method",405);
      const local=new URL(req.url,"http://localhost"),route=local.pathname.slice(PREFIX.length);
      const match=/^\/v1internal(?::|\/)([A-Za-z][A-Za-z0-9]*)$/.exec(route);
      if(!local.pathname.startsWith(PREFIX+"/")||!match)throw httpError("Unknown Antigravity endpoint",404);
      const method=match[1];
      abort.setTimeout(requestBodyTimeoutMs,"request_body_timeout");release=await acquireRequest(req,{signal:abort.signal});
      if(req.method==="POST"&&!/^application\/json(?:;|$)/i.test(req.headers["content-type"]||""))throw httpError("Antigravity requires JSON",415);
      let body=req.method==="POST"?await readJsonBody(req,{admission:release,signal:abort.signal,parse:parseBody}):null;
      const context=currentRequestContext();if(context)context.application="gemini_app";
      const compacting=isCompactionRequest("gemini",body);
      if(compacting&&context){context.purpose=requestPurpose(req.headers["x-ccdx-purpose"],"compaction");context.streamPerformance?.setPurpose(context.purpose)}
      if(compacting)markRequestObservation({compaction:1});
      if(body?.model)observeRequestedModel(body);
      const compactBinding=compacting?await resolveCompactionSource(body):null;
      if(compactBinding?.model)body={...body,model:compactBinding.model};
      markRequestObservation({requested_model:context?.requestedModel});
      abort.setTimeout(upstreamTimeoutMs,"upstream_timeout");
      const generation=["streamGenerateContent","generateContent"].includes(method);
      const native=async()=>{
        counts.google++;
        if(generation){
          usageModel=body.model;usageProvider="google";usageMode=method==="streamGenerateContent"?"sse":"json";
          if(context){context.provider="google";context.streamPerformance?.setProvider?.("google")}
          observeContextSession(null,{session_id:body.request?.labels?.root_cascade_id||body.request?.labels?.cascade_id},{profileId:()=>"google:gemini-native"},"gemini");
          markRequestObservation({usage_state:"pending"});
        }
        const open=async(value,options={})=>{
          const internal=options.internal===true,path=internal?"/v1internal:streamGenerateContent?alt=sse":route+local.search;
          if(generation){abort.setTimeout(upstreamTimeoutMs,"upstream_timeout");markUpstreamStarted(internal||method==="streamGenerateContent")}
          const result=await fetchGoogle(googleOrigin+path,{method:internal?"POST":req.method,headers:{...nativeHeaders(req),...(value?{"content-type":"application/json"}:{}),...(internal?{accept:"text/event-stream"}:{})},
            ...(value?{body:JSON.stringify(value)}:{}),signal:options.signal||abort.signal,redirect:"error"});
          if(generation)markUpstreamHeaders(result.status);return result;
        };
        const upstream=compacting&&compaction?await compaction.run({body,protocol:"gemini",scope:JSON.stringify(["gemini","google",createHash("sha256").update(req.headers.authorization||"").update(String(body.project||"")).digest("hex")]),
          source:"google",client:"gemini",model:body.model,inputLimit:nativeWindows.get(body.model),outputAllowance:body.request?.generationConfig?.maxOutputTokens||0,native:open,options:{signal:abort.signal},
          summarize:compactionSummarizer(body,"gemini",(value,options)=>open(value,{...options,internal:true})),onActivity:()=>abort.setTimeout(streamIdleTimeoutMs,"compaction_idle_timeout")}):await open(body);
        if(method==="fetchAvailableModels"&&upstream.ok){
          const value=JSON.parse(await readBoundedResponseText(upstream,{maxBytes:8*1024*1024,signal:abort.signal,label:"Google model catalog"}));
          nativeWindows.clear();for(const[id,entry]of Object.entries(value.models||{}).slice(0,256))if(Number.isSafeInteger(entry?.maxTokens)&&entry.maxTokens>0){nativeWindows.set(id,entry.maxTokens);if(typeof entry.model==="string")nativeWindows.set(entry.model,entry.maxTokens)}
          const merged=mergeAntigravityModels(value,models(),selectedModels());
          catalogModels=Object.keys(merged.models).filter(id=>id.startsWith(ANTIGRAVITY_MODEL_PREFIX));
          res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(merged));return;
        }
        const nativeStreaming=/text\/event-stream/i.test(upstream.headers.get("content-type")||"");
        if(generation)usageMode=nativeStreaming?"sse":"json";
        const observer=generation&&upstream.ok?createGoogleResponseObserver({streaming:nativeStreaming,onEvent:value=>{
          const response=value?.response||value,event=googleUsageEvent(value);if(event)captureUsage(event);
          const candidates=response?.candidates||[];
          if(candidates.some(candidate=>candidate.content?.parts?.some(part=>part.functionCall||!part.thought&&typeof part.text==="string"&&part.text)))markFirstOutput("delta");
          if(response?.error)outcome="failed";
          else if(outcome!=="failed"&&candidates.some(candidate=>candidate.finishReason)){
            outcome=candidates.every(candidate=>candidate.finishReason==="STOP")?"completed":"incomplete";
          }
        }}):null;
        res.writeHead(upstream.status,safeUpstreamResponseHeaders(upstream.headers));
        try{
          if(upstream.body)for await(const data of upstream.body){
            abort.setTimeout(streamIdleTimeoutMs,"stream_idle_timeout");observer?.push(data);
            if(!await writeOrDrain(res,data,{signal:abort.signal}))throw httpError("Antigravity client disconnected",499);
          }
        }finally{if(observer?.finish().unavailable&&!usageEvent)markRequestObservation({usage_state:"unavailable"})}
        if(generation&&!upstream.ok)outcome="failed";
        if(outcome)markResponseTerminal(outcome);
        res.end();
      };
      if(!generation){
        if(!controlMethods.has(method)||body?.requestType||body?.request?.contents||body?.contents)throw httpError("Unsupported Antigravity control endpoint",400);
        if(method==="writeTrajectoryAcls"&&(!body||Object.keys(body).some(key=>key!=="trajectoryId")||typeof body.trajectoryId!=="string"||body.trajectoryId.length>160))throw httpError("Unsupported Antigravity trajectory permission request",400);
        observed=true;return await native();
      }
      if(req.method!=="POST"||!body||typeof body.model!=="string"||!body.request)throw httpError("Invalid Antigravity generation request",400);
      const selection=selectedModels(),copilotModels=antigravityCopilotModels(models()),selected=copilotModels.find(model=>model.id===body.model&&(selection===null||selection.includes(model.id)));
      if((body.requestType==="agent"||compactBinding?.source==="google")&&!selected){
        if(body.model.startsWith(ANTIGRAVITY_MODEL_PREFIX))throw httpError("The selected Copilot model is unavailable",503);
        if(body.requestType==="agent"||body.request?.labels?.root_cascade_id||body.request?.labels?.cascade_id)await guardSource?.(body,"google",abort.signal);
        if(body.requestType==="agent")rememberConversationSource(body,"google");
        return await native();
      }
      if(body.requestType==="agent"||compactBinding?.source==="github")await guardSource?.(body,"github",abort.signal);
      if(body.requestType==="agent")rememberConversationSource(body,"github");
      if(!copilotModels.length)throw httpError("Copilot access for Antigravity is paused or unavailable",503);
      observed=true;counts.copilot++;
      if(context){context.provider="github";context.streamPerformance?.setProvider?.("github")}
      observeContextSession(null,{session_id:body.request?.labels?.root_cascade_id||body.request?.labels?.cascade_id},{profileId:()=>"github:codex"},"chat");
      const request=body.request;
      if(body.requestType==="web_search"){
        counts.search++;if(!searchFn)throw httpError("Copilot search is unavailable",503);
        const query=searchQuery(request),input={id:randomUUID(),commands:{search_query:[{q:query}]}};
        session=privacy?.prepareSession?await privacy.prepareSession(input,{protocol:"search",client:"gemini",signal:abort.signal}):passthrough(input);
        const response=await searchFn(session.body,{signal:abort.signal});
        if(!response.ok)throw httpError("Copilot search was refused (HTTP "+response.status+")",response.status);
        const result=session.restoreValue(JSON.parse(await readBoundedResponseText(response,{maxBytes:8*1024*1024,signal:abort.signal,label:"Copilot search"})));
        markResponseTerminal("completed");
        res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({response:groundedSearch(result,query)}));return;
      }
      if(body.requestType==="image_gen"){
        counts.images++;if(!imageFn)throw httpError("Copilot image generation is unavailable",503);
        const response=await imageFn(request,{signal:abort.signal});
        markResponseTerminal("completed");
        res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({response}));return;
      }
      if(!["agent","checkpoint","summarization","title"].includes(body.requestType))throw httpError("Unsupported Antigravity inference type",400);
      const target=body.requestType==="agent"||compactBinding&&!compactBinding.background?selected:copilotModels.find(model=>model.model==="gemini-4-carbon"&&model.effort==="low");
      if(!target)throw httpError("Copilot Carbon is unavailable for Antigravity background tasks",503);
      const stream=method==="streamGenerateContent";usageModel=target.model;usageMode=stream?"sse":"json";usageProvider="github";
      const converted=antigravityToChat(request,{model:target.model,effort:target.effort,stream});
      markResponseModel(target.model);markRequestObservation({usage_state:"pending"});
      session=privacy?.prepareSession?await privacy.prepareSession(converted.chat,{protocol:"chat",client:"gemini",signal:abort.signal}):passthrough(converted.chat);
      const callOptions={signal:abort.signal,retryOptions:{retries:0},onUpstreamStart:()=>abort.setTimeout(upstreamTimeoutMs,"upstream_timeout")};
      const upstream=compacting&&compaction?await compaction.run({body:session.body,protocol:"chat",scope:JSON.stringify(["gemini","github",compactionProfile()]),source:"github",client:"gemini",
        inputLimit:target.maxTokens,outputAllowance:session.body.max_completion_tokens||session.body.max_tokens||0,native:client.chatCompletions,options:callOptions,
        summarize:compactionSummarizer(session.body,"chat",client.chatCompletions),onActivity:()=>abort.setTimeout(streamIdleTimeoutMs,"compaction_idle_timeout")}):await client.chatCompletions(session.body,callOptions);
      markUpstreamHeaders(upstream.status);
      if(!upstream.ok){await upstream.body?.cancel();throw httpError("Copilot generation was refused (HTTP "+upstream.status+")",upstream.status)}
      if(!stream){
        const data=JSON.parse(await readBoundedResponseText(upstream,{maxBytes:MAX_REPLY,signal:abort.signal,label:"Copilot response"}));captureUsage(data);
        const result=chatToAntigravity(data,converted.originalNames);
        outcome=result.candidates[0].finishReason==="STOP"?"completed":"incomplete";markResponseTerminal(outcome);
        res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({response:session.restoreValue(result)}));return;
      }
      const text=session.count?createPrivacyTextFragments(session):{push:value=>value,finish:()=>""};
      res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache"});
      const emit=chunk=>writeOrDrain(res,"data: "+JSON.stringify(chunk)+"\n\n",{signal:abort.signal});
      for await(const chunk of chatStreamToAntigravity(upstream,converted.originalNames,{onChunk:()=>abort.setTimeout(streamIdleTimeoutMs,"stream_idle_timeout"),onUsage:captureUsage})){
        const candidate=chunk.response?.candidates?.[0];
        for(const part of candidate?.content?.parts||[]){
          if(part.functionCall||typeof part.text==="string"&&part.text&&!part.thought)markFirstOutput("delta");
          if(part.functionCall){const tail=text.finish();if(tail)await emit({response:{candidates:[{index:0,content:{role:"model",parts:[{text:tail}]}}]}});Object.assign(part,session.restoreToolValue(part));}
          else if(typeof part.text==="string"&&!part.thought)part.text=text.push(part.text);
        }
        if(candidate?.finishReason){const tail=text.finish();if(tail)await emit({response:{candidates:[{index:0,content:{role:"model",parts:[{text:tail}]}}]}});outcome=candidate.finishReason==="STOP"?"completed":"incomplete";markResponseTerminal(outcome)}
        await emit(chunk);
      }
      res.end();
    }catch(error){
      if(typeof error.code==="string"&&error.code.startsWith("ccdx_compaction_"))res.setHeader("x-should-retry","false");
      counts.failed++;
      outcome=abort.signal.aborted&&["client_closed","client_aborted"].includes(abort.reason)?"cancelled":"failed";markResponseTerminal(outcome);
      if(res.headersSent&&!res.writableEnded&&!res.destroyed){res.end("data: "+JSON.stringify({error:{code:error.statusCode||502,message:error.message}})+"\n\n");}
      else sendJsonError(res,error,error.statusCode||502);
    }finally{
      session?.release();release();abort.cleanup();active--;
      if(usageEvent){
        const u=usageEvent.usage,record=buildResponsesUsageRecord({surface:"antigravity",mode:usageMode,model:usageModel,
          response:{id:usageEvent.id,model:usageEvent.model||usageModel,usage:u?{input_tokens:u.prompt_tokens,output_tokens:u.completion_tokens,
            total_tokens:u.total_tokens,input_tokens_details:u.prompt_tokens_details,output_tokens_details:u.completion_tokens_details}:undefined},
          event:{copilot_usage:usageEvent.copilot_usage}});
        if(record){
          markRequestObservation({input_tokens:record.usage?.input_tokens,cached_input_tokens:record.usage?.cached_input_tokens});
          const context=currentRequestContext();
          recordUsageFn({...record,provider:usageProvider,client:"gemini",request_id:context?.requestId,requested_model:context?.requestedModel,
            outcome:outcome||"unknown",...(outcome!=="completed"?{partial:true}:{})});
        }
      }
    }
  };
  handler.snapshot=()=>({enabled:enabled(),observed,catalog_models:catalogModels,active,...counts});
  return handler;
}
