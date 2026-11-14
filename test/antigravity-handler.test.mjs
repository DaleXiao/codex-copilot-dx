import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {EventEmitter} from "node:events";
import {createAntigravityHandler} from "../src/antigravity-handler.mjs";
import {antigravityCopilotModels,mergeAntigravityModels} from "../src/antigravity-models.mjs";
import {summarizeUsage} from "../src/usage-store.mjs";
import {runWithRequestContext} from "../src/request-context.mjs";
import {createStreamPerformanceMetrics} from "../src/stream-performance.mjs";
import {createGoogleResponseObserver} from "../src/antigravity-usage.mjs";
import {createContextCompactionService} from "../src/context-compaction.mjs";

const catalog={data:["gemini-4-carbon","gemini-4-argon"].map(id=>({id,supported_endpoints:["/chat/completions"],capabilities:{supports:{vision:true,reasoning_effort:["low","medium","high"]},limits:{max_context_window_tokens:1000000,max_output_tokens:64000}}}))};
const alias=antigravityCopilotModels(catalog)[2].id;

test("native Google and Copilot tool results update the same isolated activity contract",async()=>{
  for(const native of [true,false]){
    let first=true;const performance=createStreamPerformanceMetrics({routeNames:["antigravity"]});
    const f=fixture({fetchGoogle:async()=>Response.json({response:{candidates:[{content:{role:"model",parts:first?(first=false,[{functionCall:{id:"native-tool",name:"read_file",args:{private:"not retained"}}}]):[{text:"continued"}]},finishReason:"STOP"}]}}),
      client:{chatCompletions:async()=>{const message=first?(first=false,{tool_calls:[{id:"tool-one",type:"function",function:{name:"read_file",arguments:"{}"}}]}):{content:"continued"};return Response.json({choices:[{message,finish_reason:message.tool_calls?"tool_calls":"stop"}]});}}});
    const call=async value=>{
      const tracker=performance.begin("antigravity",{application:"gemini_app"});
      const result=await runWithRequestContext({streamPerformance:tracker},()=>invoke(f.handler,value,{url:"/antigravity/v1internal:generateContent"}).done);
      tracker.finish({statusCode:result.status});return result;
    };
    const initial=body(native?"native-model":alias);initial.request.labels={root_cascade_id:"observed-tool-session"};
    initial.request.tools=[{functionDeclarations:[{name:"read_file",parameters:{type:"OBJECT",properties:{}}}]}];
    const response=await call(initial);assert.equal(response.status,200);assert.equal(performance.snapshot().tool_activity.items[0].state,"waiting");
    const issued=JSON.parse(response.text).response.candidates[0].content.parts.find(part=>part.functionCall).functionCall;
    const next=structuredClone(initial);next.request.contents.push({role:"model",parts:[{functionCall:issued}]},{role:"user",parts:[{functionResponse:{id:issued.id,name:issued.name,response:{result:"not retained"}}}]});
    assert.equal((await call(next)).status,200);assert.equal(performance.snapshot().tool_activity.items[0].state,"returned");
    assert.doesNotMatch(JSON.stringify(performance.snapshot().tool_activity),/not retained|observed-tool-session/);
  }
});
test("Copilot Antigravity streaming keeps parallel calls distinct across separate chunks",async()=>{
  let requests=0;const performance=createStreamPerformanceMetrics({routeNames:["antigravity"]});
  const toolCalls=["read_file","search_files"].map((name,index)=>({index,id:`parallel-${index}`,type:"function",function:{name,arguments:"{}"}}));
  const f=fixture({client:{chatCompletions:async()=>requests++?sse("continued"):new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:toolCalls},finish_reason:"tool_calls"}]})+'\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}})}});
  const call=async value=>{const tracker=performance.begin("antigravity",{application:"gemini_app"});const result=await runWithRequestContext({streamPerformance:tracker},()=>invoke(f.handler,value).done);tracker.finish({statusCode:result.status});return result;};
  const initial=body();initial.request.labels={root_cascade_id:"parallel-tool-session"};initial.request.tools=[{functionDeclarations:toolCalls.map(call=>({name:call.function.name,parameters:{type:"OBJECT",properties:{}}}))}];
  const result=await call(initial);assert.equal(result.status,200);assert.equal(performance.snapshot().tool_activity.items.length,2);
  const parts=result.text.split('\n').filter(line=>line.startsWith('data: ')).flatMap(line=>JSON.parse(line.slice(6)).response?.candidates?.[0]?.content?.parts||[]).filter(part=>part.functionCall);
  assert.equal(parts.length,2);const next=structuredClone(initial);next.request.contents.push({role:"model",parts},{role:"user",parts:parts.map(part=>({functionResponse:{id:part.functionCall.id,name:part.functionCall.name,response:{result:"complete"}}}))});
  assert.equal((await call(next)).status,200);assert.ok(performance.snapshot().tool_activity.items.every(row=>row.state==="returned"));
});

test("known Google compaction stays on Google and recovers within the same model",async()=>{
  const calls=[],records=[],compaction=createContextCompactionService({recordUsageFn:record=>records.push(record)});
  const f=fixture({compaction,resolveCompactionSource:()=>({source:"google",model:"native-bound-model"}),fetchGoogle:async(url,request)=>{
    calls.push({url,body:JSON.parse(request.body)});
    if(calls.length===1)return Response.json({error:{message:"The input token count (20000) exceeds the maximum number of tokens allowed (16000)."}},{status:400});
    return Response.json({response:{candidates:[{index:0,content:{role:"model",parts:[{text:"verified continuation"}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:2,cachedContentTokenCount:0}}});
  }});
  const request=body("native-default","summarization");request.request.contents=[{role:"user",parts:[{text:"keep requirements"}]},{role:"model",parts:[{text:"verified old facts"}]},{role:"user",parts:[{text:"compact"}]}];
  const result=await invoke(f.handler,request,{url:"/antigravity/v1internal:generateContent"}).done;
  assert.equal(result.status,200);assert.equal(calls.length,3);assert.equal(f.copilot.length,0);assert.ok(calls.every(call=>call.body.model==="native-bound-model"));
  assert.match(calls[1].url,/streamGenerateContent/);assert.deepEqual(calls[1].body.request.generationConfig.thinkingConfig,request.request.generationConfig.thinkingConfig);
  assert.equal(records.length,1);assert.equal(records[0].provider,"google");assert.equal(records[0].purpose,"compaction");assert.equal(f.records[0].provider,"google");
});

test("known Copilot compaction retains the selected reasoning alias instead of another background model",async()=>{
  const calls=[],compaction=createContextCompactionService({recordUsageFn(){}});
  const f=fixture({compaction,resolveCompactionSource:()=>({source:"github",model:alias}),client:{chatCompletions:async(value)=>{
    calls.push(value);if(calls.length===1)return Response.json({error:{type:"invalid_request_error",message:"Range of input length should be [1, 1048576]"}},{status:400});
    return Response.json({model:value.model,usage:{prompt_tokens:7,completion_tokens:2},choices:[{index:0,message:{content:"verified continuation"},finish_reason:"stop"}]});
  }}});
  const request=body("native-default","summarization");request.request.contents=[{role:"user",parts:[{text:"keep requirements"}]},{role:"model",parts:[{text:"verified old facts"}]},{role:"user",parts:[{text:"compact"}]}];
  const result=await invoke(f.handler,request,{url:"/antigravity/v1internal:generateContent"}).done;
  assert.equal(result.status,200);assert.equal(f.google.length,0);assert.equal(calls.length,3);assert.ok(calls.every(call=>call.model==="gemini-4-carbon"&&call.reasoning_effort==="high"));
});
const body=(model=alias,requestType="agent")=>({model,requestType,request:{contents:[{role:"user",parts:[{text:"fixture"}]}],generationConfig:{thinkingConfig:{includeThoughts:true,thinkingBudget:4096}}}});
const sse=(content="ok")=>new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:"stop"}]})+'\n\ndata: [DONE]\n\n');
function fixture(options={}){
  const google=[],copilot=[],records=[];
  const handler=createAntigravityHandler({enabled:()=>true,models:()=>catalog,recordUsageFn:record=>records.push(record),
    fetchGoogle:async(url,request)=>{google.push({url,request});return Response.json({native:true})},
    client:{chatCompletions:async(value,options)=>{copilot.push({value,options});return sse()}},...options});
  return {handler,google,copilot,records};
}
function invoke(handler,value,{url="/antigravity/v1internal:streamGenerateContent?alt=sse",raw,headers={},onWrite}={}){
  const req=Readable.from([Buffer.from(raw??JSON.stringify(value))]);req.method="POST";req.url=url;req.headers={host:"127.0.0.1:2026","content-type":"application/json",authorization:"Bearer GOOGLE_FIXTURE",...headers};req.socket={remoteAddress:"127.0.0.1"};
  const res=new EventEmitter(),chunks=[];Object.assign(res,{destroyed:false,writableEnded:false,headersSent:false,statusCode:200,headers:{},
    writeHead(status,headers){this.statusCode=status;this.headers=headers;this.headersSent=true;return this},
    write(value){chunks.push(Buffer.from(value));onWrite?.(value);return true},end(value){if(value)this.write(value);this.writableEnded=true;this.emit("finish")}});
  const done=handler(req,res).then(()=>({status:res.statusCode,text:Buffer.concat(chunks).toString(),res}));return {done,req,res};
}

test("catalog merging preserves native models, defaults, and quotas without enum collisions",()=>{
  const native={models:{native:{model:"MODEL_PLACEHOLDER_M500",quotaInfo:{remaining:10}}},defaultAgentModelId:"native",agentModelSorts:[{groups:[{modelIds:["native"]}]}],entitlements:{keep:true}};
  const before=structuredClone(native),result=mergeAntigravityModels(native,catalog);
  assert.deepEqual(native,before);assert.deepEqual(result.models.native,before.models.native);assert.equal(result.defaultAgentModelId,"native");assert.deepEqual(result.entitlements,{keep:true});
  assert.equal(new Set(Object.values(result.models).map(x=>x.model)).size,7);assert.equal(result.agentModelSorts[0].groups[0].modelIds[0],"native");
  assert.ok(antigravityCopilotModels(catalog).every(model=>model.displayName.toLowerCase().includes("gemini")),"Gemini App filters models by their display label");
  assert.equal(result.agentModelSorts[0].groups[0].modelIds.length,7,"Native and Copilot models must share the first group for Gemini App");
  assert.equal(mergeAntigravityModels(native,[]),native);
});
test("Copilot main requests use the advertised model and level without forwarding Google authorization",async()=>{
  const f=fixture(),result=await invoke(f.handler,body()).done;
  assert.equal(result.status,200);assert.equal(f.google.length,0);assert.equal(f.copilot.length,1);
  assert.equal(f.copilot[0].value.model,"gemini-4-carbon");assert.equal(f.copilot[0].value.reasoning_effort,"high");assert.equal(JSON.stringify(f.copilot).includes("GOOGLE_FIXTURE"),false);
  assert.match(result.text,/"finishReason":"STOP"/);assert.equal(f.copilot[0].options.retryOptions.retries,0);
});
test("native Google main requests retain their model and authorization",async()=>{
  const f=fixture();assert.equal((await invoke(f.handler,body("gemini-4-argon")).done).status,200);
  assert.equal(f.copilot.length,0);assert.equal(f.google.length,1);assert.equal(f.google[0].request.headers.authorization,"Bearer GOOGLE_FIXTURE");
  assert.equal(JSON.parse(f.google[0].request.body).model,"gemini-4-argon");
});
test("unattributed background summaries use Copilot even when the requested model is Google",async()=>{
  const f=fixture();const result=await invoke(f.handler,body("gemini-3.8-flash","checkpoint")).done;
  assert.equal(result.status,200);assert.equal(f.google.length,0);assert.equal(f.copilot[0].value.model,"gemini-4-carbon");assert.equal(f.copilot[0].value.reasoning_effort,"low");
});
test("search uses Copilot sources and never Google's inference service",async()=>{
  const queries=[],f=fixture({searchFn:async(value)=>{queries.push(value);return Response.json({output:"Fixture excerpt",results:[{type:"text_result",url:"https://example.test/actual",title:"Fixture"}]})}});
  const result=await invoke(f.handler,body("gemini-3.8-flash","web_search"),{url:"/antigravity/v1internal:generateContent"}).done;
  assert.equal(result.status,200);assert.equal(f.google.length,0);assert.equal(f.copilot.length,0);assert.equal(queries[0].commands.search_query[0].q,"fixture");
  assert.equal(JSON.parse(result.text).response.candidates[0].groundingMetadata.groundingChunks[0].web.uri,"https://example.test/actual");
});
test("unsupported or paused Copilot requests never fall back to Google",async()=>{
  let background=0;
  const f=fixture({models:()=>({data:[]}),searchFn:async()=>{background++},imageFn:async()=>{background++}});
  for(const type of ["agent","checkpoint","web_search","image_gen"])assert.equal((await invoke(f.handler,body(alias,type)).done).status,503);
  assert.equal(f.google.length,0);assert.equal(background,0);
  const unknown=fixture();assert.equal((await invoke(unknown.handler,body(alias,"unknown_activity")).done).status,400);assert.equal(unknown.google.length,0);
});
test("ordinary Gemini endpoints and browser-origin callers cannot enter the Antigravity bridge",async()=>{
  const f=fixture();assert.equal((await invoke(f.handler,body(),{url:"/gemini/chat"}).done).status,404);
  assert.equal((await invoke(f.handler,body(),{headers:{origin:"https://example.test"}}).done).status,403);assert.equal(f.google.length+f.copilot.length,0);
});
test("large tool integers survive the incoming request and outgoing function call",async()=>{
  let seen;const f=fixture({client:{chatCompletions:async value=>{seen=value;return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{\\"n\\":9007199254740993}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n')}}});
  const value=body();value.request.tools=[{functionDeclarations:[{name:"read",parameters:{type:"OBJECT",properties:{n:{type:"INTEGER"}}}}]}];
  value.request.contents.push({role:"model",parts:[{functionCall:{id:"prior",name:"read",args:{n:1}}}]},{role:"user",parts:[{functionResponse:{id:"prior",name:"read",response:{output:"ok"}}}]});
  const raw=JSON.stringify(value).replace('"n":1','"n":9007199254740993');const result=await invoke(f.handler,value,{raw}).done;
  assert.equal(result.status,200);assert.match(seen.messages.find(x=>x.tool_calls).tool_calls[0].function.arguments,/9007199254740993/);assert.match(result.text,/9007199254740993/);
});
test("a truncated upstream stream reports an error without a successful finish",async()=>{
  const f=fixture({client:{chatCompletions:async()=>new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')}}),result=await invoke(f.handler,body()).done;
  assert.match(result.text,/partial/);assert.match(result.text,/ended before completion/);assert.doesNotMatch(result.text,/"finishReason":"STOP"/);
});
test("privacy sessions restore split text tokens and release on completion",async()=>{
  const token="{{CCDX_"+"a".repeat(24)+"}}";let released=false,masked=false;
  const f=fixture({privacy:{prepareSession:async value=>{value.messages[0].content=token;masked=true;return {body:value,count:1,restoreText:text=>text.replaceAll(token,"fixture-secret"),restoreValue:value=>value,restoreToolValue:value=>value,release(){released=true}}}},
    client:{chatCompletions:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:token.slice(0,12)}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{content:token.slice(12)},finish_reason:"stop"}]})+'\n\ndata: [DONE]\n\n')}});
  const result=await invoke(f.handler,body()).done;assert.equal(masked,true);assert.equal(released,true);assert.match(result.text,/fixture-secret/);assert.doesNotMatch(result.text,/CCDX_aaaa/);
});

test("unselected Copilot models are absent from discovery and rejected before either provider receives history",async()=>{
  const native={models:{native:{model:"NATIVE"}},agentModelSorts:[{groups:[{modelIds:["native"]}]}]};
  const merged=mergeAntigravityModels(native,catalog,[alias]);assert.deepEqual(Object.keys(merged.models),["native",alias]);
  assert.deepEqual(mergeAntigravityModels(native,catalog,[]),native);
  const f=fixture({selectedModels:()=>[]});const result=await invoke(f.handler,body()).done;
  assert.equal(result.status,503);assert.equal(f.google.length,0);assert.equal(f.copilot.length,0);
  const background=await invoke(f.handler,body("gemini-3.8-flash","checkpoint")).done;
  assert.equal(background.status,200);assert.equal(f.copilot.length,1);
});

test("successful native model discovery acknowledges the latest configuration",async()=>{
  const f=fixture({fetchGoogle:async()=>Response.json({models:{native:{model:"NATIVE"}}})});
  const result=await invoke(f.handler,{}, {url:"/antigravity/v1internal:fetchAvailableModels"}).done;
  assert.equal(result.status,200);assert.ok(f.handler.snapshot().catalog_models.includes(alias));assert.ok(JSON.parse(result.text).models[alias]);
});

test("Copilot JSON usage reaches the Gemini ledger without dropping zero cache or reasoning counts",async()=>{
  const usage={prompt_tokens:100,completion_tokens:25,total_tokens:125,prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:10}};
  const copilot_usage={token_details:[{token_type:"input",token_count:100},{token_type:"output",token_count:25}],total_nano_aiu:123};
  const f=fixture({client:{chatCompletions:async()=>Response.json({id:"usage-json",model:"gemini-4-carbon",usage,copilot_usage,choices:[{finish_reason:"stop",message:{content:"ok"}}]})}});
  const result=await invoke(f.handler,body(),{url:"/antigravity/v1internal:generateContent"}).done;assert.equal(result.status,200);
  assert.equal(f.records.length,1);assert.equal(f.records[0].model,"gemini-4-carbon");assert.equal(f.records[0].provider,"github");assert.equal(f.records[0].surface,"antigravity");
  assert.deepEqual(f.records[0].usage,{input_tokens:100,cached_input_tokens:0,output_tokens:25,reasoning_output_tokens:10,total_tokens:125});
  assert.equal(f.records[0].copilot_usage.total_nano_aiu,123);
  assert.equal(f.records[0].outcome,"completed");assert.equal(f.records[0].partial,undefined);
  assert.equal(summarizeUsage(f.records).byModel["gemini-4-carbon"].input_tokens,100);
});
test("streamed Gemini usage records once and keeps billed partial usage on truncated streams",async()=>{
  const event={id:"usage-sse",usage:{prompt_tokens:40,completion_tokens:5,total_tokens:45,prompt_tokens_details:{cached_tokens:12}},choices:[]};
  for(const truncated of [false,true]){
    const data='data: '+JSON.stringify(event)+'\n\ndata: '+JSON.stringify(event)+'\n\n'+(truncated?'':'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const model=truncated?"gemini-4-argon":"gemini-4-carbon",id=antigravityCopilotModels(catalog).find(entry=>entry.model===model).id;
    const f=fixture({client:{chatCompletions:async()=>new Response(data)}});await invoke(f.handler,body(id)).done;
    assert.equal(f.records.length,1);assert.equal(f.records[0].usage.cached_input_tokens,12);assert.equal(f.records[0].usage.output_tokens,5);
    assert.equal(f.records[0].outcome,truncated?"failed":"completed");assert.equal(f.records[0].partial,truncated?true:undefined);
    assert.equal(summarizeUsage(f.records).bySourceModel["github / "+model].output_tokens,5);
  }
  const absent=fixture();await invoke(absent.handler,body()).done;assert.equal(absent.records.length,0,"Missing upstream usage cannot be invented");
});

test("Gemini usage without cache metadata keeps cache unknown and attributes background tasks to the actual Copilot model",async()=>{
  const f=fixture({client:{chatCompletions:async()=>Response.json({usage:{prompt_tokens:10,completion_tokens:2},choices:[{finish_reason:"stop",message:{content:"ok"}}]})}});
  await invoke(f.handler,body("gemini-3.8-flash","checkpoint"),{url:"/antigravity/v1internal:generateContent"}).done;
  assert.equal(f.records.length,1);assert.equal(f.records[0].model,"gemini-4-carbon");assert.equal(f.records[0].usage.cached_input_tokens,undefined);
  assert.equal(f.records[0].usage.total_tokens,12);
});

test("client cancellation retains returned Gemini usage once and releases admission",async()=>{
  let released=0,call;
  const f=fixture({acquireRequest:async()=>()=>{released++},client:{chatCompletions:async(_,{signal})=>new Response(new ReadableStream({start(controller){
    signal.addEventListener("abort",()=>controller.error(new Error("cancelled")),{once:true});
    controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":10,"completion_tokens":1},"choices":[{"delta":{"content":"partial"}}]}\n\n'));
  }}))}});
  call=invoke(f.handler,body(),{onWrite:()=>{call.res.destroyed=true;call.res.emit("close")}});await call.done;
  assert.equal(f.records.length,1);assert.equal(f.records[0].outcome,"cancelled");assert.equal(f.records[0].partial,true);
  assert.equal(f.records[0].usage.output_tokens,1);assert.equal(released,1);assert.equal(f.handler.snapshot().active,0);
});

test("request identity survives Copilot alias resolution and remains attached to usage",async()=>{
  const metrics=createStreamPerformanceMetrics({routeNames:["antigravity"]}),tracker=metrics.begin("antigravity",{requestId:"identity",application:"gemini_app"});
  const context={requestId:"identity",streamPerformance:tracker};
  const f=fixture({client:{chatCompletions:async()=>Response.json({usage:{prompt_tokens:2,completion_tokens:1,prompt_tokens_details:{cached_tokens:0}},choices:[{finish_reason:"stop",message:{content:"ok"}}]})}});
  await runWithRequestContext(context,()=>invoke(f.handler,body(),{url:"/antigravity/v1internal:generateContent"}).done);tracker.finish({statusCode:200});
  assert.equal(context.requestedModel,alias);assert.equal(context.model,"gemini-4-carbon");
  assert.equal(f.records[0].request_id,"identity");assert.equal(f.records[0].requested_model,alias);
  const recent=metrics.snapshot().recent_requests[0];assert.equal(recent.context.requested_model,alias);assert.equal(recent.context.usage_state,"reported");
});

test("native Google JSON preserves response bytes and separates cached input and thought tokens",async()=>{
  const wire=JSON.stringify({response:{responseId:"google-json",modelVersion:"gemini-native-version",usageMetadata:{promptTokenCount:100,toolUsePromptTokenCount:5,candidatesTokenCount:20,thoughtsTokenCount:10,cachedContentTokenCount:0,totalTokenCount:135},candidates:[{finishReason:"STOP",content:{parts:[{text:"原样返回"}]}}]}});
  const f=fixture({fetchGoogle:async()=>new Response(wire,{headers:{"content-type":"application/json"}})});
  const result=await invoke(f.handler,body("gemini-native"),{url:"/antigravity/v1internal:generateContent"}).done;
  assert.equal(result.text,wire);assert.equal(f.records.length,1);assert.equal(f.records[0].provider,"google");assert.equal(f.records[0].model,"gemini-native-version");
  assert.deepEqual(f.records[0].usage,{input_tokens:105,cached_input_tokens:0,output_tokens:30,reasoning_output_tokens:10,total_tokens:135});
  assert.equal(summarizeUsage(f.records).providers.google,1);
});

test("fragmented native Google SSE remains byte-exact and records cumulative usage once",async()=>{
  const final={response:{usageMetadata:{promptTokenCount:12,candidatesTokenCount:3,cachedContentTokenCount:4},candidates:[{finishReason:"STOP"}]}};
  const wire=': heartbeat\r\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}}\r\n\r\ndata: '+JSON.stringify(final)+'\r\n\r\ndata: '+JSON.stringify(final)+'\r\n\r\n';
  const bytes=Buffer.from(wire);let offset=0;
  const f=fixture({fetchGoogle:async()=>new Response(new ReadableStream({pull(controller){if(offset===bytes.length)controller.close();else controller.enqueue(bytes.subarray(offset,++offset));}}),{headers:{"content-type":"text/event-stream"}})});
  const result=await invoke(f.handler,body("gemini-native")).done;
  assert.equal(result.text,wire);assert.equal(f.records.length,1);assert.equal(f.records[0].usage.input_tokens,12);assert.equal(f.records[0].usage.cached_input_tokens,4);assert.equal(f.records[0].outcome,"completed");
});

test("Google metadata observation stays bounded and cannot fabricate usage from text",()=>{
  const seen=[],observer=createGoogleResponseObserver({streaming:true,maxBytes:150,onEvent:event=>seen.push(event)});
  observer.push(Buffer.from('data: '+JSON.stringify({text:'"usageMetadata": {"promptTokenCount":999}',padding:"x".repeat(200)})+'\r\n\r\n'));
  observer.push(Buffer.from('data: {"response":{\r\ndata: "usageMetadata":{"promptTokenCount":0}}}\r\n\r\n'));
  assert.equal(observer.finish().unavailable,true);assert.equal(seen.length,1);assert.equal(seen[0].response.usageMetadata.promptTokenCount,0);
  const json=createGoogleResponseObserver({streaming:false,maxBytes:10,onEvent:()=>assert.fail("oversized metadata must be skipped")});json.push(Buffer.from('{"text":"a very large response"}'));assert.equal(json.finish().unavailable,true);
});

test("native forwarding stops at downstream backpressure and cancellation keeps already returned usage",async()=>{
  let pulls=0,cancelled=false,call,signalWritten;const written=new Promise(resolve=>{signalWritten=resolve});
  const first='data: {"response":{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1},"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n';
  const f=fixture({fetchGoogle:async()=>new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(Buffer.from(first));},cancel(){cancelled=true}},{highWaterMark:0}),{headers:{"content-type":"text/event-stream"}})});
  call=invoke(f.handler,body("gemini-native"),{onWrite:()=>signalWritten()});const write=call.res.write;call.res.write=function(value){write.call(this,value);return false};
  await written;assert.equal(pulls,1);call.res.destroyed=true;call.res.emit("close");await call.done;
  assert.equal(cancelled,true);assert.equal(pulls,1);assert.equal(f.records.length,1);assert.equal(f.records[0].outcome,"cancelled");assert.equal(f.records[0].usage.output_tokens,1);
});

test("sparse usage frames retain the last reported fields and invalid usage stays missing",async()=>{
  const data='data: {"usage":{"prompt_tokens":9,"prompt_tokens_details":{"cached_tokens":0}},"choices":[]}\n\ndata: {"usage":{"completion_tokens":2},"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: {"usage":{},"copilot_usage":{"token_details":{}},"choices":[]}\n\ndata: [DONE]\n\n';
  const f=fixture({client:{chatCompletions:async()=>new Response(data)}});await invoke(f.handler,body()).done;
  assert.equal(f.records.length,1);assert.equal(f.records[0].usage.input_tokens,9);assert.equal(f.records[0].usage.output_tokens,2);assert.equal(f.records[0].usage.cached_input_tokens,0);
  const metrics=createStreamPerformanceMetrics({routeNames:["antigravity"]}),tracker=metrics.begin("antigravity",{requestId:"invalid-usage",application:"gemini_app"});
  const bad=fixture({client:{chatCompletions:async()=>Response.json({usage:{prompt_tokens:-1,completion_tokens:"3"},choices:[{finish_reason:"stop",message:{content:"ok"}}]})}});
  const result=await runWithRequestContext({streamPerformance:tracker},()=>invoke(bad.handler,body(),{url:"/antigravity/v1internal:generateContent"}).done);tracker.finish({statusCode:result.status});
  assert.equal(result.status,200);assert.equal(bad.records.length,0);assert.equal(metrics.snapshot().recent_requests[0].context.usage_state,"missing");
});

test("a native Google stream failure after a finish frame remains failed with returned usage",async()=>{
  let step=0;const metrics=createStreamPerformanceMetrics({routeNames:["antigravity"]}),tracker=metrics.begin("antigravity",{requestId:"cut",application:"gemini_app"});
  const f=fixture({fetchGoogle:async()=>new Response(new ReadableStream({pull(controller){
    if(step++===0)controller.enqueue(Buffer.from('data: {"response":{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1},"candidates":[{"finishReason":"STOP"}]}}\n\n'));
    else controller.error(new Error("stream cut"));
  }}),{headers:{"content-type":"text/event-stream"}})});
  await runWithRequestContext({requestId:"cut",streamPerformance:tracker},()=>invoke(f.handler,body("gemini-native")).done);tracker.finish({statusCode:200});
  assert.equal(f.records.length,1);assert.equal(f.records[0].outcome,"failed");assert.equal(f.records[0].partial,true);
  assert.equal(metrics.snapshot().recent_requests[0].outcome,"failed");
});
