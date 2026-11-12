import {randomUUID} from "node:crypto";
import {createRequestAbort,readJsonBody,readBoundedResponseText,writeOrDrain,httpError,sendJsonError} from "./http-transport.mjs";
import {safeUpstreamResponseHeaders} from "./upstream-headers.mjs";
import {isLoopbackAddress,isLoopbackHostHeader} from "./security.mjs";
import {antigravityToChat,chatToAntigravity,chatStreamToAntigravity,parseAntigravityJSON} from "./antigravity-chat-bridge.mjs";
import {ANTIGRAVITY_MODEL_PREFIX,antigravityCopilotModels,mergeAntigravityModels} from "./antigravity-models.mjs";
import {createPrivacyTextFragments} from "./privacy-stream.mjs";
import {currentRequestContext,observeRequestedModel} from "./request-context.mjs";
import {markUpstreamStarted,markUpstreamHeaders,markFirstOutput,markResponseTerminal} from "./stream-performance.mjs";

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
  fetchGoogle=fetch,googleOrigin=GOOGLE_ORIGIN,requestBodyTimeoutMs=120000,upstreamTimeoutMs=180000,streamIdleTimeoutMs=60000}={}) {
  if(![GOOGLE_ORIGIN,"https://cloudcode-pa.googleapis.com"].includes(googleOrigin))throw new Error("Unrecognized Google control origin");
  let active=0,observed=false;
  const counts={total:0,google:0,copilot:0,search:0,images:0,failed:0};
  const handler=async(req,res)=>{
    const abort=createRequestAbort(req,res);let release=()=>{},session;
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
      const body=req.method==="POST"?await readJsonBody(req,{admission:release,signal:abort.signal,parse:parseBody}):null;
      const context=currentRequestContext();if(context)context.application="gemini_app";
      if(body?.model)observeRequestedModel(body);
      abort.setTimeout(upstreamTimeoutMs,"upstream_timeout");
      const generation=["streamGenerateContent","generateContent"].includes(method);
      const native=async()=>{
        counts.google++;
        if(generation)markUpstreamStarted(method==="streamGenerateContent");
        const upstream=await fetchGoogle(googleOrigin+route+local.search,{method:req.method,headers:{...nativeHeaders(req),...(body?{"content-type":"application/json"}:{})},
          ...(body?{body:JSON.stringify(body)}:{}),signal:abort.signal,redirect:"error"});
        if(generation)markUpstreamHeaders(upstream.status);
        if(method==="fetchAvailableModels"&&upstream.ok){
          const value=JSON.parse(await readBoundedResponseText(upstream,{maxBytes:8*1024*1024,signal:abort.signal,label:"Google model catalog"}));
          const merged=mergeAntigravityModels(value,models(),selectedModels());
          res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(merged));return;
        }
        res.writeHead(upstream.status,safeUpstreamResponseHeaders(upstream.headers));
        if(upstream.body)for await(const data of upstream.body){abort.setTimeout(streamIdleTimeoutMs,"stream_idle_timeout");await writeOrDrain(res,data,{signal:abort.signal})}
        res.end();
      };
      if(!generation){
        if(!controlMethods.has(method)||body?.requestType||body?.request?.contents||body?.contents)throw httpError("Unsupported Antigravity control endpoint",400);
        if(method==="writeTrajectoryAcls"&&(!body||Object.keys(body).some(key=>key!=="trajectoryId")||typeof body.trajectoryId!=="string"||body.trajectoryId.length>160))throw httpError("Unsupported Antigravity trajectory permission request",400);
        observed=true;return await native();
      }
      if(req.method!=="POST"||!body||typeof body.model!=="string"||!body.request)throw httpError("Invalid Antigravity generation request",400);
      const selection=selectedModels(),copilotModels=antigravityCopilotModels(models()),selected=copilotModels.find(model=>model.id===body.model&&(selection===null||selection.includes(model.id)));
      if(body.requestType==="agent"&&!selected){
        if(body.model.startsWith(ANTIGRAVITY_MODEL_PREFIX))throw httpError("The selected Copilot model is unavailable",503);
        await guardSource?.(body,"google",abort.signal);
        return await native();
      }
      if(body.requestType==="agent")await guardSource?.(body,"github",abort.signal);
      if(!copilotModels.length)throw httpError("Copilot access for Antigravity is paused or unavailable",503);
      observed=true;counts.copilot++;
      if(context){context.provider="github";context.streamPerformance?.setProvider?.("github")}
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
      const target=body.requestType==="agent"?selected:copilotModels.find(model=>model.model==="gemini-4-carbon"&&model.effort==="low");
      if(!target)throw httpError("Copilot Carbon is unavailable for Antigravity background tasks",503);
      const stream=method==="streamGenerateContent";
      const converted=antigravityToChat(request,{model:target.model,effort:target.effort,stream});
      observeRequestedModel({model:target.model});
      session=privacy?.prepareSession?await privacy.prepareSession(converted.chat,{protocol:"chat",client:"gemini",signal:abort.signal}):passthrough(converted.chat);
      const upstream=await client.chatCompletions(session.body,{signal:abort.signal,retryOptions:{retries:0}});
      if(!upstream.ok){await upstream.body?.cancel();throw httpError("Copilot generation was refused (HTTP "+upstream.status+")",upstream.status)}
      if(!stream){
        const result=chatToAntigravity(JSON.parse(await readBoundedResponseText(upstream,{maxBytes:MAX_REPLY,signal:abort.signal,label:"Copilot response"})),converted.originalNames);
        markResponseTerminal(result.candidates[0].finishReason==="STOP"?"completed":"incomplete");
        res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({response:session.restoreValue(result)}));return;
      }
      const text=session.count?createPrivacyTextFragments(session):{push:value=>value,finish:()=>""};
      res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache"});
      const emit=chunk=>writeOrDrain(res,"data: "+JSON.stringify(chunk)+"\n\n",{signal:abort.signal});
      for await(const chunk of chatStreamToAntigravity(upstream,converted.originalNames,{onChunk:()=>abort.setTimeout(streamIdleTimeoutMs,"stream_idle_timeout")})){
        const candidate=chunk.response?.candidates?.[0];
        for(const part of candidate?.content?.parts||[]){
          if(part.functionCall||typeof part.text==="string"&&part.text&&!part.thought)markFirstOutput("delta");
          if(part.functionCall){const tail=text.finish();if(tail)await emit({response:{candidates:[{index:0,content:{role:"model",parts:[{text:tail}]}}]}});Object.assign(part,session.restoreToolValue(part));}
          else if(typeof part.text==="string"&&!part.thought)part.text=text.push(part.text);
        }
        if(candidate?.finishReason){const tail=text.finish();if(tail)await emit({response:{candidates:[{index:0,content:{role:"model",parts:[{text:tail}]}}]}});markResponseTerminal(candidate.finishReason==="STOP"?"completed":"incomplete")}
        await emit(chunk);
      }
      res.end();
    }catch(error){
      counts.failed++;
      markResponseTerminal(abort.signal.aborted&&["client_closed","client_aborted"].includes(abort.reason)?"cancelled":"failed");
      if(res.headersSent&&!res.writableEnded&&!res.destroyed){res.end("data: "+JSON.stringify({error:{code:error.statusCode||502,message:error.message}})+"\n\n");}
      else sendJsonError(res,error,error.statusCode||502);
    }finally{session?.release();release();abort.cleanup();active--}
  };
  handler.snapshot=()=>({enabled:enabled(),observed,active,...counts});
  return handler;
}
