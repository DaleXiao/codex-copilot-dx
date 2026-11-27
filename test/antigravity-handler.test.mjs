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
import {createRequestAdmission} from "../src/request-admission.mjs";
import {gzipSync} from "node:zlib";

const catalog={data:["gemini-4-carbon","gemini-4-argon"].map(id=>({id,supported_endpoints:["/chat/completions"],capabilities:{supports:{vision:true,reasoning_effort:["low","medium","high"]},limits:{max_context_window_tokens:1000000,max_output_tokens:64000}}}))};
const alias=antigravityCopilotModels(catalog)[2].id;

test("newly advertised Hydrogen routes xhigh while a native tiered model keeps Google",async()=>{
  const hydrogen={...catalog.data[0],id:"gemini-4-hydrogen",capabilities:{...catalog.data[0].capabilities,supports:{vision:true,reasoning_effort:["low","medium","high","xhigh"]}}};
  const f=fixture({models:()=>({data:[...catalog.data,hydrogen]})});
  const result=await invoke(f.handler,body("ccdx-copilot-gemini-4-hydrogen-xhigh")).done;
  assert.equal(result.status,200);assert.equal(f.copilot[0].value.model,hydrogen.id);assert.equal(f.copilot[0].value.reasoning_effort,"xhigh");
  const native=fixture();assert.equal((await invoke(native.handler,body("gemini-3.8-flash-tiered")).done).status,200);
  assert.equal(native.copilot.length,0);assert.equal(JSON.parse(native.google[0].request.body).model,"gemini-3.8-flash-tiered");
  assert.equal(native.handler.snapshot().google_generation,1);
});

test("Gemini-signed history stays on its native route and is diagnosed before Copilot dispatch",async()=>{
  const f=fixture(), errors=[];
  const signedTurn={role:"model",parts:[{text:"fixture answer",thoughtSignature:"fixture-signature"}]};
  const request=body();
  request.request.contents.push(signedTurn);
  const rejected=await runWithRequestContext({onHttpError:value=>errors.push(value)},()=>invoke(f.handler,request).done);
  assert.equal(rejected.status,400);
  assert.match(JSON.parse(rejected.text).error,/Message 2, part 1.*Gemini thought signature/);
  assert.doesNotMatch(rejected.text,/fixture-signature|fixture answer/);
  assert.deepEqual(errors.map(error=>[error.code,error.origin]),[["ccdx_antigravity_thought_signature","client_validation"]]);
  assert.equal(f.copilot.length+f.google.length,0);
  assert.equal((await invoke(f.handler,{...request,model:"gemini-3.8-flash-tiered"}).done).status,200);
  assert.deepEqual(JSON.parse(f.google[0].request.body).request.contents.at(-1),signedTurn);
});

test("Neon aliases send and report the chosen effort and preserve both Copilot reasoning usage formats", async () => {
  const neon = { ...catalog.data[0], id: "gemini-4-neon", capabilities: {
    ...catalog.data[0].capabilities, supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] },
  } };
  const neonCatalog = { data: [neon] };
  const variants = antigravityCopilotModels(neonCatalog);
  const medium = variants.find(model => model.effort === "medium").id;
  assert.equal(mergeAntigravityModels({ models: { native: {} }, defaultAgentModelId: "native" },
    neonCatalog, variants.map(model => model.id), medium).defaultAgentModelId, medium);
  const metrics = createStreamPerformanceMetrics({ routeNames: ["antigravity"] });
  for (const [effort, expected, usage, stream] of [
    ["low", 48, { reasoning_tokens: 48 }, false],
    ["medium", 0, { reasoning_tokens: 48, completion_tokens_details: { reasoning_tokens: 0 } }, false],
    ["high", 48, { reasoning_tokens: 48 }, true],
    ["xhigh", 9, { reasoning_tokens: 48, completion_tokens_details: { reasoning_tokens: 9 } }, true],
    ["high", undefined, { reasoning_tokens: 99 }, false],
  ]) {
    let wire;
    const f = fixture({ models: () => neonCatalog, client: { async chatCompletions(value, options) {
      options.onUpstreamStart();
      wire = value;
      const counts = { prompt_tokens: 107, completion_tokens: 88, total_tokens: 195 };
      if (!stream) return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { ...counts, ...usage } });
      const frames = [
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage },
        { choices: [], usage: { ...counts, reasoning_tokens: 48 } },
      ];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    } } });
    const tracker = metrics.begin("antigravity", { application: "gemini_app" });
    const result = await runWithRequestContext({ streamPerformance: tracker }, () =>
      invoke(f.handler, body("ccdx-copilot-gemini-4-neon-" + effort), stream ? {} : { url: "/antigravity/v1internal:generateContent" }).done);
    tracker.finish({ statusCode: result.status });
    assert.equal(result.status, 200);
    assert.equal(wire.model, neon.id);
    assert.equal(wire.reasoning_effort, effort);
    assert.equal(f.handler.snapshot().copilot_generation, 1);
    assert.equal(f.handler.snapshot().google_generation, 0);
    assert.equal(metrics.snapshot().recent_requests.at(-1).context.reasoning_effort_sent, effort);
    const projected = stream ? JSON.parse(result.text.split("\n").filter(line => line.includes('"usageMetadata"')).at(-1).slice(6)) : JSON.parse(result.text);
    assert.deepEqual(projected.response.usageMetadata,
      { promptTokenCount: 107, candidatesTokenCount: 88 - (expected ?? 0), totalTokenCount: 195, ...(expected === undefined ? {} : { thoughtsTokenCount: expected }) });
    assert.equal(f.records.length, 1);
    assert.deepEqual(f.records[0].usage, { input_tokens: 107, output_tokens: 88, total_tokens: 195,
      ...(expected === undefined ? {} : { reasoning_output_tokens: expected }) });
  }
  const blocked = fixture({ models: () => neonCatalog, privacy: { async prepareSession() {
    throw Object.assign(new Error("Fixture masking failure"), { origin: "privacy", statusCode: 503 });
  } } });
  const tracker = metrics.begin("antigravity", { application: "gemini_app" });
  const rejected = await runWithRequestContext({ streamPerformance: tracker }, () =>
    invoke(blocked.handler, body("ccdx-copilot-gemini-4-neon-high")).done);
  tracker.finish({ statusCode: rejected.status });
  assert.equal(rejected.status, 503);
  assert.equal(blocked.copilot.length, 0);
  assert.equal(metrics.snapshot().recent_requests.at(-1).context.reasoning_effort_sent, undefined);
});

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

test("Copilot tool reasoning returns to its own account, model and complete tool turn", async () => {
  for (const mode of ["json", "sse", "truncated"]) {
    const calls = [0, 1].map(index => ({
      id: "fixture-call-" + index, type: "function", function: { name: "lookup", arguments: JSON.stringify({ path: "fixture", index }) },
    }));
    let profile = "copilot-account-one";
    const sent = [];
    const f = fixture({
      guardSource: async () => profile,
      sourceProfile: () => profile,
      client: { async chatCompletions(value) {
        sent.push(value);
        if (sent.length > 1) return sse();
        if (mode === "json") return Response.json({ choices: [{
          message: { tool_calls: calls, reasoning_opaque: "fixture-sealed" }, finish_reason: "tool_calls",
        }] });
        const frames = [
          { delta: { reasoning_opaque: "fixture-earlier", tool_calls: [{ ...calls[0], index: 0 }] } },
          { delta: { reasoning_opaque: "fixture-sealed", tool_calls: [{ ...calls[1], index: 1 }] }, finish_reason: "tool_calls" },
        ];
        return new Response(frames.map(choice => "data: " + JSON.stringify({ choices: [choice] }) + "\n\n").join("")
          + (mode === "sse" ? "data: [DONE]\n\n" : ""));
      } },
    });
    const initial = body();
    initial.request.labels = { root_cascade_id: "fixture-conversation" };
    initial.request.tools = [{ functionDeclarations: [{ name: "lookup" }] }];
    const reply = await invoke(f.handler, initial,
      mode === "json" ? { url: "/antigravity/v1internal:generateContent" } : {}).done;
    assert.doesNotMatch(reply.text, /reasoning_opaque|fixture-sealed|fixture-earlier/);
    if (mode === "truncated") assert.match(reply.text, /ended before completion/);
    else assert.equal(reply.status, 200);
    const replay = async ({ model = initial.model, conversation = "fixture-conversation", tools = calls, signed = false, rejected = false, changed = false } = {}) => {
      const request = structuredClone(initial);
      request.model = model;
      request.request.labels.root_cascade_id = conversation;
      request.request.contents.push(
        { role: "model", parts: tools.map((call,index) => ({
          functionCall: { id: call.id, name: call.function.name, args: { index: Number(call.id.at(-1)), path: changed ? "changed" : "fixture" } },
          ...(signed&&index===0?{thought_signature:"fixture-signature"}:{}),
        })) },
        { role: "user", parts: tools.map(call => ({ functionResponse: { id: call.id, name: call.function.name, response: {} } })) });
      const before=sent.length,result=await invoke(f.handler, request).done;
      if(rejected){
        assert.equal(result.status,400);assert.match(result.text,/Gemini thought signature/);
        assert.equal(sent.length,before);return;
      }
      assert.equal(result.status, 200);
      assert.doesNotMatch(JSON.stringify(sent.at(-1)),/thoughtSignature|thought_signature|fixture-signature/);
      return sent.at(-1).messages.find(message => message.role === "assistant").reasoning_opaque;
    };
    assert.equal(await replay(), mode === "truncated" ? undefined : "fixture-sealed");
    assert.equal(await replay({signed:true,rejected:mode==="truncated"}), mode === "truncated" ? undefined : "fixture-sealed");
    await replay({signed:true,rejected:true,changed:true});
    await replay({signed:true,rejected:true,tools:calls.slice(0,1)});
    await replay({signed:true,rejected:true,conversation:"different-conversation"});
    await replay({signed:true,rejected:true,model:"ccdx-copilot-gemini-4-argon-high"});
    assert.equal(await replay({ conversation: "different-conversation" }), undefined);
    assert.equal(await replay({ model: "ccdx-copilot-gemini-4-argon-high" }), undefined);
    assert.equal(await replay({ tools: calls.slice(0, 1) }), undefined);
    profile = "copilot-account-two";
    await replay({signed:true,rejected:true});
    assert.equal(await replay(), undefined);
  }
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
function invoke(handler,value,{url="/antigravity/v1internal:streamGenerateContent?alt=sse",raw,headers={},onWrite,input,method="POST"}={}){
  const req=input||Readable.from([Buffer.from(raw??JSON.stringify(value))]);req.method=method;req.url=url;req.headers={host:"127.0.0.1:2026","content-type":"application/json",authorization:"Bearer GOOGLE_FIXTURE",...headers};req.socket={remoteAddress:"127.0.0.1"};
  const res=new EventEmitter(),chunks=[];Object.assign(res,{destroyed:false,writableEnded:false,headersSent:false,statusCode:200,headers:{},
    writeHead(status,headers){this.statusCode=status;this.headers=headers;this.headersSent=true;return this},
    write(value){chunks.push(Buffer.from(value));onWrite?.(value);return true},end(value){if(value)this.write(value);this.writableEnded=true;this.emit("finish")}});
  const done=handler(req,res).then(()=>({status:res.statusCode,text:Buffer.concat(chunks).toString(),res}));return {done,req,res};
}

async function bounded(promise){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("fixture did not settle")),1500)})])}finally{clearTimeout(timer)}
}

test("Copilot Antigravity preserves retry guidance and correlation without exposing the source body or retrying",async()=>{
  let calls=0;const evidence=[],gate=createRequestAdmission({maxBytes:4096});
  const f=fixture({acquireRequest:gate,client:{chatCompletions:async()=>{
    calls++;return new Response("private source body",{status:429,headers:{"Retry-After":"23.2","X-GitHub-Request-Id":"abc:123","Set-Cookie":"private=example"}});
  }}});
  const result=await runWithRequestContext({onHttpError:value=>evidence.push(value)},()=>invoke(f.handler,body()).done);
  assert.equal(result.status,429);assert.equal(calls,1);
  const headers=new Headers(result.res.headers);
  assert.equal(headers.get("Retry-After"),"24");assert.equal(headers.get("X-Upstream-Request-Id"),"abc:123");
  assert.equal(headers.has("Set-Cookie"),false);assert.doesNotMatch(result.text,/private/);
  assert.equal(evidence.at(-1)?.origin,"upstream_http");
  assert.equal(gate.diagnostics().activeBytes,0, "Upstream failure releases request-body admission");
});

test("held Google and Copilot streams release body admission before another client enters",async()=>{
  for(const native of [true,false])for(const compressed of [true,false]){
    const gate=createRequestAdmission({maxBytes:4096,waitTimeoutMs:500}),opened=Promise.withResolvers();
    let responseBody,privacySession,restorationReleased=0;
    const response=new Response(new ReadableStream({start(controller){responseBody=controller}}),{headers:{"content-type":"text/event-stream"}});
    const f=fixture({acquireRequest:gate,privacy:{prepareSession:async value=>(privacySession={body:value,count:0,restoreValue:value=>value,restoreToolValue:value=>value,release(){restorationReleased++}})},
      fetchGoogle:async()=>response,client:{chatCompletions:async()=>response}});
    const request=body(native?"native-model":alias);request.request.contents[0].parts[0].text="private history ".repeat(80);
    const raw=compressed?gzipSync(JSON.stringify(request)):JSON.stringify(request);
    const headers=compressed?{"content-encoding":"gzip"}:{};
    const call=invoke(f.handler,request,{raw,headers,onWrite:()=>opened.resolve()});
    responseBody.enqueue(new TextEncoder().encode(native?'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n':'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    try{
      await bounded(opened.promise);
      assert.equal(call.res.writableEnded,false);assert.equal(f.handler.snapshot().active,1);
      assert.equal(gate.diagnostics().activeBytes,0);assert.equal(gate.diagnostics().decodedBodyBytes,0);
      if(!native){assert.equal(privacySession.body,null);assert.equal(restorationReleased,0,"Response restoration stays alive until stream completion")}
      const releaseOther=await bounded(gate({headers:{"content-length":"2"}}));releaseOther();
      assert.equal(gate.diagnostics().timedOut,0);
    }finally{
      responseBody.enqueue(new TextEncoder().encode(native?'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n':'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      responseBody.close();await bounded(call.done);
    }
    assert.equal(gate.diagnostics().activeRequests,0);if(!native)assert.equal(restorationReleased,1);
  }
});

test("preparation and compaction retain input admission until their last upstream request completes",async()=>{
  for(const native of [true,false]){
    const gate=createRequestAdmission({maxBytes:4096,waitTimeoutMs:500}),preparing=Promise.withResolvers(),prepared=Promise.withResolvers(),recovering=Promise.withResolvers(),recovered=Promise.withResolvers();
    const f=fixture({acquireRequest:gate,guardSource:async()=>{preparing.resolve();await prepared.promise},resolveCompactionSource:()=>({source:native?"google":"github",model:native?"native-model":alias}),
      compaction:{run:async({body:input,native:open,options})=>{recovering.resolve();await recovered.promise;assert.ok(input.request||input.messages);return open(input,options)}}});
    const value=body(native?"native-model":alias);value.requestType="summarization";value.request.labels={root_cascade_id:"admission-fixture"};
    const bytes=Buffer.byteLength(JSON.stringify(value));
    const call=invoke(f.handler,value);let other;
    try{
      await bounded(preparing.promise);assert.equal(gate.diagnostics().activeBytes,bytes);
      other=gate({headers:{"content-length":"2"}});await bounded(other);assert.equal(gate.diagnostics().queued,0);
      prepared.resolve();await bounded(recovering.promise);assert.equal(gate.diagnostics().activeBytes,bytes+2);assert.equal(gate.diagnostics().queued,0);
    }finally{prepared.resolve();recovered.resolve();await bounded(call.done);if(other)(await bounded(other))()}
    assert.equal(gate.diagnostics().activeBytes,0);
  }
});

test("Antigravity can send a short chunked generation while another app still holds a small reservation", async () => {
  const gate=createRequestAdmission({maxBytes:4096,waitTimeoutMs:40}),held=await gate({headers:{"content-length":"256"}});
  const f=fixture({acquireRequest:gate}),value=body();
  try {
    const result=await bounded(invoke(f.handler,value,{headers:{"transfer-encoding":"chunked"}}).done);
    assert.equal(result.status,200);assert.equal(f.copilot.length,1);
    assert.equal(gate.diagnostics().queuedTotal,0);assert.equal(gate.stats().activeBytes,256);
  } finally { held(); }
  assert.equal(gate.stats().activeBytes,0);
});

test("only clearly bodyless control GETs skip the shared request-body queue",async()=>{
  const gate=createRequestAdmission({maxBytes:4096,waitTimeoutMs:40}),held=await gate({headers:{}});
  const f=fixture({acquireRequest:gate}),url="/antigravity/v1internal:loadCodeAssist";
  try{
    const result=await bounded(invoke(f.handler,null,{url,method:"GET"}).done);
    assert.equal(result.status,200);assert.equal(f.google[0].request.method,"GET");assert.equal(f.google[0].request.body,undefined);
    assert.equal(gate.diagnostics().queuedTotal,0);assert.equal(gate.diagnostics().total,1);
    for(const input of [{method:"GET",headers:{"transfer-encoding":"chunked"}},{method:"GET",headers:{"content-length":"1"}},{}]){
      const attempt=await bounded(invoke(f.handler,{}, {url,...input}).done);assert.equal(attempt.status,503);
    }
    assert.equal(f.google.length,1);assert.equal(gate.diagnostics().timedOut,3);
  }finally{held()}
});

test("short read-only control POSTs progress behind a queued whole-pool upload",async()=>{
  const gate=createRequestAdmission({maxBytes:32768,waitTimeoutMs:2000}),held=await gate({headers:{"content-length":"512"}});
  const f=fixture({acquireRequest:gate}),controlURL="/antigravity/v1internal:fetchUserInfo";
  const exclusive=gate({headers:{"content-length":"32768"}});
  const raw=JSON.stringify({project:"local-test-fixture"});
  const headers={"content-length":String(Buffer.byteLength(raw))};
  const blocked=[];
  try{
    const result=await bounded(invoke(f.handler,null,{url:controlURL,raw,headers}).done);
    assert.equal(result.status,200);assert.equal(f.google.length,1);
    for(const options of [
      {url:"/antigravity/v1internal:writeTrajectoryAcls",headers},
      {url:controlURL,headers:{"transfer-encoding":"chunked"}},
      {url:controlURL,headers:{"content-length":"8193"}},
      {url:controlURL,headers:{...headers,"content-encoding":"gzip"}},
    ])blocked.push(invoke(f.handler,null,{raw,...options}));
    assert.equal(gate.diagnostics().queued,5);assert.equal(f.google.length,1);
  }finally{
    for(const request of blocked)request.req.emit("aborted");
    await bounded(Promise.all(blocked.map(request=>request.done)));
    held();(await exclusive)();
  }
  assert.equal(gate.stats().activeBytes,0);
});

test("short control lane bounds concurrent fetches and gives the slot back after a disconnect",async()=>{
  const pending=[];
  const f=fixture({fetchGoogle:(_url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener("abort",()=>reject(signal.reason),{once:true});pending.push(resolve);
  })});
  const options={url:"/antigravity/v1internal:fetchUserInfo",raw:"{}",headers:{"content-length":"2"}};
  const reads=Array.from({length:5},()=>invoke(f.handler,null,options));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pending.length,4);
  assert.equal(f.handler.snapshot().short_control_queue.waiting,1);
  reads[0].req.emit("aborted");
  await bounded(reads[0].done);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pending.length,5);
  for(const resolve of pending.slice(1))resolve(Response.json({}));
  assert.deepEqual(await Promise.all(reads.slice(1).map(read=>bounded(read.done).then(reply=>reply.status))),[200,200,200,200]);
  assert.equal(f.handler.snapshot().short_control_queue.active,0);
});

test("Copilot success headers without a stream return 502 before opening downstream SSE",async()=>{
  const f=fixture({client:{chatCompletions:async()=>new Response(null)}});
  const result=await invoke(f.handler,body()).done;
  assert.equal(result.status,502);assert.match(new Headers(result.res.headers).get("content-type"),/application\/json/i);
  assert.match(result.text,/stream has no body/);
});

test("admission timeout stays local 503 and does not consume the request-body deadline",async()=>{
  const gate=createRequestAdmission({maxBytes:4096,waitTimeoutMs:40}),held=await gate({headers:{}}),errors=[];
  const performance=createStreamPerformanceMetrics({routeNames:["antigravity"]}),tracker=performance.begin("antigravity");
  const f=fixture({acquireRequest:gate,requestBodyTimeoutMs:5});
  try{
    const result=await bounded(runWithRequestContext({streamPerformance:tracker,onHttpError:value=>errors.push(value)},()=>invoke(f.handler,body()).done));
    tracker.finish({statusCode:result.status});
    assert.equal(result.status,503);assert.equal(f.copilot.length+f.google.length,0);
    assert.equal(gate.diagnostics().timedOut,1);assert.equal(gate.diagnostics().aborted,0);assert.equal(gate.diagnostics().queued,0);
    assert.equal(errors[0].origin,"transport");assert.equal(errors[0].code,"ccdx_request_admission_unavailable");
    const recent=performance.snapshot().recent_requests[0];assert.ok(recent.timings_ms.admission>=5);assert.equal(recent.upstream_attempts,0);
  }finally{held()}
});

test("source waiting rejection keeps Retry-After and source admission attribution",async()=>{
  const errors=[],f=fixture({client:{chatCompletions:async()=>{throw Object.assign(new Error("Source recovery is pending"),{
    code:"ccdx_source_limited",origin:"source_admission",statusCode:429,retryAfterMs:60000})}}});
  const result=await runWithRequestContext({onHttpError:value=>errors.push(value)},()=>invoke(f.handler,body()).done);
  assert.equal(result.status,429);assert.equal(result.res.headers["Retry-After"],"60");
  assert.equal(errors[0].origin,"source_admission");assert.equal(errors[0].code,"ccdx_source_limited");
});

test("body, upstream and compaction deadlines return their own status and release all admission",async()=>{
  for(const reason of ["body","upstream","compaction"]){
    const gate=createRequestAdmission({maxBytes:4096,waitTimeoutMs:500}),errors=[];
    const waitForAbort=signal=>new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener("abort",()=>reject(signal.reason),{once:true})});
    const f=fixture({acquireRequest:gate,requestBodyTimeoutMs:20,upstreamTimeoutMs:20,streamIdleTimeoutMs:20,
      ...(reason==="compaction"?{compaction:{run:async({options,onActivity})=>{onActivity();return waitForAbort(options.signal)}}}:{}),client:{chatCompletions:async(_,{signal})=>waitForAbort(signal)}});
    const value=body();if(reason==="compaction")value.requestType="summarization";
    const call=runWithRequestContext({onHttpError:value=>errors.push(value)},()=>invoke(f.handler,value,reason==="body"?{input:new Readable({read(){}})}:{}));
    const result=await bounded(call.done);
    assert.equal(result.status,reason==="body"?408:504);assert.equal(errors[0].origin,"transport");
    assert.equal(errors[0].code,reason==="body"?"request_body_timeout":reason==="compaction"?"compaction_idle_timeout":"upstream_timeout");
    assert.equal(gate.diagnostics().activeRequests,0);assert.equal(gate.diagnostics().decodedBodyBytes,0);assert.equal(f.handler.snapshot().active,0);
  }
});

test("the Copilot headers override does not extend the wait for the first stream chunk", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = Promise.withResolvers();
  const f = fixture({ copilotTimeoutMs: 500, streamIdleTimeoutMs: 80, client: { chatCompletions: async (_, { signal, onUpstreamStart }) => {
    onUpstreamStart();
    return new Response(new ReadableStream({
      start(controller) { signal.addEventListener("abort", () => controller.error(signal.reason), { once: true }); },
      pull() { reading.resolve(signal); },
    }));
  } } });
  const done = invoke(f.handler, body()).done;
  const signal = await reading.promise;
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(79);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  const result = await done;
  assert.equal(result.status, 200);
  assert.match(result.text, /"code":504/);
});

test("a completed one-shot send releases local input before headers, while compaction retains it", async () => {
  for (const compacting of [false, true]) {
    const gate = createRequestAdmission({ maxBytes: 4096 }), opened = Promise.withResolvers(), pending = Promise.withResolvers();
    const f = fixture({ acquireRequest: gate, client: { chatCompletions: async (_, options) => {
      opened.resolve(options.onBodySent);
      return pending.promise;
    } } });
    const request = body(alias, compacting ? "summarization" : "agent");
    const call = invoke(f.handler, request);
    const sent = await bounded(opened.promise);
    assert.ok(gate.diagnostics().activeBytes > 0);
    if (compacting) assert.equal(sent, undefined);
    else {
      sent();sent();
      assert.equal(gate.diagnostics().activeRequests, 0);
      assert.equal(gate.diagnostics().activeBytes, 0);
      assert.equal(call.res.headersSent, false);
    }
    pending.resolve(sse("fixture"));
    assert.equal((await call.done).status, 200);
    assert.equal(gate.diagnostics().activeBytes, 0);
  }
});

test("an explicitly selected native Gemini alias preserves tool numbers and uses only that source", async () => {
  const id = "ccdx-gemini-api_fixture-gemini-model", calls = [], guarded = [];
  const selected = { id, model: "gemini-model", source: "api_fixture", maxTokens: 1000000, transport: {
    profileId: () => "api-fixture-profile",
    client: { gemini: async (value, options) => {
      options.onUpstreamStart();
      calls.push({ value, options });
      if (options.countTokens) return Response.json({ totalTokens: 32 });
      return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"key":9007199254740993}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":2,"totalTokenCount":14}}\n\n',
        { headers: { "content-type": "text/event-stream" } });
    } },
  } };
  const f = fixture({ resolveNativeModel: model => model === id ? selected : null, guardSource: (_, source) => guarded.push(source) });
  const request = body(id);
  request.request.contents.push({ role: "user", parts: [] });
  const result = await invoke(f.handler, request).done;
  assert.equal(result.status, 200);
  assert.match(result.text, /"response":\{"candidates".*9007199254740993/);
  assert.equal(calls[0].value.model, "gemini-model");
  assert.deepEqual(calls[0].value.request.contents, request.request.contents);
  assert.equal(calls[0].options.stream, true);
  assert.deepEqual(guarded, ["api_fixture"]);
  assert.equal(f.records[0].provider, "api_fixture");
  assert.equal(f.records[0].usage.total_tokens, 14);
  assert.equal((await invoke(f.handler, body(id), { url: "/antigravity/v1internal:countTokens" }).done).text, '{"totalTokens":32}');
  assert.equal((await invoke(f.handler, body(id + "-removed")).done).status, 503);
  assert.equal(f.handler.snapshot().custom_generation, 1);
  assert.equal(f.google.length + f.copilot.length, 0);
});

test("queued client cancellation is 499 and leaves no reservation or upstream call",async()=>{
  const gate=createRequestAdmission({maxBytes:4096,waitTimeoutMs:500}),held=await gate({headers:{}}),errors=[];
  const f=fixture({acquireRequest:gate});
  const call=runWithRequestContext({onHttpError:value=>errors.push(value)},()=>invoke(f.handler,body()));
  try{
    assert.equal(gate.diagnostics().queued,1);call.req.emit("aborted");
    assert.equal((await bounded(call.done)).status,499);assert.equal(errors[0].origin,"client_disconnect");
    assert.equal(gate.diagnostics().aborted,1);assert.equal(gate.diagnostics().queued,0);assert.equal(f.copilot.length+f.google.length,0);
  }finally{held()}
  assert.equal(gate.diagnostics().activeRequests,0);
});

test("invalid plain and compressed bodies release every reservation before returning",async()=>{
  for(const headers of [{},{"content-encoding":"gzip"}]){
    const gate=createRequestAdmission({maxBytes:4096,waitTimeoutMs:500}),f=fixture({acquireRequest:gate});
    const result=await invoke(f.handler,null,{raw:"invalid JSON or gzip",headers}).done;
    assert.equal(result.status,400);assert.equal(f.google.length+f.copilot.length,0);
    const state=gate.diagnostics();assert.equal(state.activeRequests,0);assert.equal(state.decodedBodyBytes,0);assert.equal(state.decompressionsActive,0);
  }
});

test("catalog merging preserves native models, defaults, and quotas without enum collisions",()=>{
  const native={models:{native:{model:"MODEL_PLACEHOLDER_M500",quotaInfo:{remaining:10}}},defaultAgentModelId:"native",agentModelSorts:[{groups:[{modelIds:["native"]}]}],entitlements:{keep:true}};
  const before=structuredClone(native),result=mergeAntigravityModels(native,catalog);
  assert.deepEqual(native,before);assert.deepEqual(result.models.native,before.models.native);assert.equal(result.defaultAgentModelId,"native");assert.deepEqual(result.entitlements,{keep:true});
  assert.equal(new Set(Object.values(result.models).map(x=>x.model)).size,7);assert.equal(result.agentModelSorts[0].groups[0].modelIds[0],"native");
  assert.ok(antigravityCopilotModels(catalog).every(model=>model.displayName.toLowerCase().includes("gemini")),"Gemini App filters models by their display label");
  assert.equal(result.agentModelSorts[0].groups[0].modelIds.length,7,"Native and Copilot models must share the first group for Gemini App");
  assert.equal(mergeAntigravityModels(native,[]),native);
});
test("an Antigravity default changes only a compatible agent catalog, not explicit requests",async()=>{
  const preferred="ccdx-copilot-gemini-4-argon-medium";
  const native={models:{native:{model:"NATIVE",maxTokens:123}},defaultModelId:"native",defaultAgentModelId:"native"};
  const f=fixture({defaultModel:()=>preferred,fetchGoogle:async()=>Response.json(native)});
  const result=await invoke(f.handler,{}, {url:"/antigravity/v1internal:fetchAvailableModels"}).done,merged=JSON.parse(result.text);
  assert.equal(merged.defaultAgentModelId,preferred);assert.equal(merged.defaultModelId,"native");assert.deepEqual(merged.models.native,native.models.native);
  assert.equal(f.handler.snapshot().catalog_default_model,preferred);
  assert.equal((await invoke(f.handler,body()).done).status,200);assert.equal(f.copilot[0].value.model,"gemini-4-carbon");assert.equal(f.copilot[0].value.reasoning_effort,"high");
  assert.equal(mergeAntigravityModels(native,catalog,[alias],preferred).defaultAgentModelId,"native");
  assert.equal(Object.hasOwn(mergeAntigravityModels({models:native.models},catalog,null,preferred),"defaultAgentModelId"),false);
  assert.equal(mergeAntigravityModels({...native,defaultAgentModelId:23},catalog,null,preferred).defaultAgentModelId,23);
});
test("native grouped choices route and pin the exact selected alias in a conversation",async()=>{
  const parent="ccdx-copilot-gemini-4-carbon",level=parent+"-medium",pins=[];
  const native={models:{native:{model:"NATIVE"},"native-low":{model:"NATIVE_LOW"},"native-high":{model:"NATIVE_HIGH"}},
    groupedModels:{native:{displayName:"Native",defaultThinkingSuffix:"low",
      supportedThinkingLevels:[{thinkingSuffix:"low",thinkingDisplayName:"Low"},{thinkingSuffix:"high",thinkingDisplayName:"High"}]}},
    defaultAgentModelId:"native",agentModelSorts:[{groups:[{modelIds:["native"]}]}]};
  const f=fixture({defaultModel:()=>level,prepareConversationBinding:body=>{pins.push(body.model);},fetchGoogle:async()=>Response.json(native)});
  assert.equal((await invoke(f.handler,{}, {url:"/antigravity/v1internal:fetchAvailableModels"}).done).status,200);
  assert.ok(!f.handler.snapshot().catalog_models.includes(parent));
  assert.equal(f.handler.snapshot().catalog_group_count,2);
  assert.equal((await invoke(f.handler,body(parent)).done).status,200);
  const groupedHigh=body(parent);
  groupedHigh.request.generationConfig.thinkingConfig.thinkingLevel="HIGH";
  assert.equal((await invoke(f.handler,groupedHigh).done).status,200);
  assert.equal((await invoke(f.handler,body(alias)).done).status,200);
  groupedHigh.request.generationConfig.thinkingConfig.thinkingLevel="MAX";
  assert.equal((await invoke(f.handler,groupedHigh).done).status,400);
  assert.deepEqual(f.copilot.map(call=>call.value.reasoning_effort),["medium","high","high"]);
  assert.deepEqual(pins,[level,alias,alias]);
});

test("an explicit grouped effort survives a flat catalog read by another client and honors revoked selection", async () => {
  const parent = "ccdx-copilot-gemini-4-carbon";
  const catalogPath = "/antigravity/v1internal:fetchAvailableModels";
  let grant = null;
  let nativeGeneration = 0;
  const native = { models: { native: { model: "NATIVE" } } };
  const options = {
    groupCapable: agent => agent === "grouped-client",
    generationSettings: () => ({ selection: grant }),
    selectedModels: () => grant,
    fetchGoogle: async url => {
      if (!url.endsWith("fetchAvailableModels")) nativeGeneration++;
      return Response.json(native);
    },
  };
  const f = fixture(options);
  const request = body(parent);
  request.request.generationConfig.thinkingConfig.thinkingLevel = "HIGH";
  const grouped = await invoke(f.handler, {}, { url: catalogPath, headers: { "user-agent": "grouped-client" } }).done;
  assert.ok(JSON.parse(grouped.text).groupedModels[parent]);
  const flat = await invoke(f.handler, {}, { url: catalogPath, headers: { "user-agent": "flat-client" } }).done;
  assert.equal(JSON.parse(flat.text).groupedModels, undefined);
  assert.equal(f.handler.snapshot().catalog_group_count, 0);
  assert.equal((await invoke(f.handler, request).done).status, 200);
  assert.equal(f.copilot[0].value.model, "gemini-4-carbon");
  assert.equal(f.copilot[0].value.reasoning_effort, "high");
  assert.equal((await invoke(f.handler, body(parent)).done).status, 200);
  assert.equal(f.copilot[1].value.reasoning_effort, "medium");

  const restarted = fixture(options);
  assert.equal((await invoke(restarted.handler, body(parent)).done).status, 503);
  assert.equal((await invoke(restarted.handler, request).done).status, 200);
  assert.equal(restarted.copilot[0].value.reasoning_effort, "high");
  grant = [parent + "-low"];
  assert.equal((await invoke(f.handler, request).done).status, 503);
  assert.equal(f.copilot.length, 2);
  assert.equal(nativeGeneration, 0);
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
test("a malformed Copilot event after output fails the same stream without replay", async()=>{
  let calls=0;
  const perf=createStreamPerformanceMetrics({routeNames:["antigravity"]}),tracker=perf.begin("antigravity");
  const f=fixture({client:{chatCompletions:async()=>{
    calls++;return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: not-json\n\n');
  }}});
  const result=await runWithRequestContext({streamPerformance:tracker},()=>invoke(f.handler,body()).done);
  tracker.finish({statusCode:result.status});
  assert.equal(result.status,200);assert.equal(calls,1);
  assert.match(result.text,/partial/);assert.match(result.text,/"error"/);assert.doesNotMatch(result.text,/"finishReason":"STOP"/);
  assert.equal(perf.snapshot().recent_requests.at(-1).outcome,"failed");
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

test("model placeholders from an old client never enter Google or Copilot generation", async () => {
  const f=fixture();
  for(const path of [":generateContent","/generateContent",":streamGenerateContent","/streamGenerateContent"]){
    const reply=await invoke(f.handler,body("MODEL_PLACEHOLDER_M501"),{url:"/antigravity/v1internal"+path}).done;
    assert.equal(reply.status,409);
    assert.match(reply.text,/internal model identifier/);
  }
  assert.equal(f.handler.snapshot().generation,4);
  assert.equal(f.handler.snapshot().google_generation,0);
  assert.equal(f.google.length,0);
  assert.equal(f.copilot.length,0);
});

test("late discovery replies respect the latest local authorization and cannot replace a newer snapshot", async () => {
  const oldStarted=Promise.withResolvers(),oldFinished=Promise.withResolvers();
  let calls=0,allowed=true;
  const f=fixture({models:()=>allowed?catalog:[],fetchGoogle:async()=>{
    if(++calls===1){oldStarted.resolve();await oldFinished.promise;return Response.json({models:{old:{}},defaultAgentModelId:"old"});}
    return Response.json({models:{new:{}}});
  }});
  const url="/antigravity/v1internal:fetchAvailableModels";
  const older=invoke(f.handler,{},{url}).done;
  await oldStarted.promise;
  allowed=false;
  const newer=await invoke(f.handler,{},{url}).done;
  assert.deepEqual(Object.keys(JSON.parse(newer.text).models),["new"]);
  oldFinished.resolve();
  assert.deepEqual(Object.keys(JSON.parse((await older).text).models),["old"]);
  assert.deepEqual(f.handler.snapshot().catalog_models,[]);
  assert.equal(f.handler.snapshot().catalog_default_supported,false);
  assert.equal(f.handler.snapshot().catalog,2);
  assert.equal((await invoke(f.handler,body()).done).status,503);
  assert.equal(f.copilot.length,0);
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
  const trailing=[],raw=createGoogleResponseObserver({streaming:true,maxBytes:70,onEvent:event=>trailing.push(event)});
  raw.push(Buffer.from('data: {"candidates":[{"finishReason":"STOP"}]}\n\n'));
  for(const line of ['{\n','"error":{\n','"message":"'+'a'.repeat(50)+'",\n','"code":503\n','}\n','}\n'])raw.push(Buffer.from(line));
  assert.equal(raw.finish().unavailable,true);assert.equal(trailing.length,1);
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
  const f=fixture({client:{chatCompletions:async()=>new Response(data)}});
  const reply=await invoke(f.handler,body()).done;
  assert.match(reply.text,/"usageMetadata":\{"promptTokenCount":9,"candidatesTokenCount":2,"cachedContentTokenCount":0\}/);
  assert.doesNotMatch(reply.text,/"totalTokenCount":0/);
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


test("a bare Google JSON error after a finish frame preserves bytes but fails the request", async () => {
  const metrics=createStreamPerformanceMetrics({routeNames:["antigravity"]}),tracker=metrics.begin("antigravity",{requestId:"bare-tail",application:"gemini_app"});
  const frames=['data: {"response":{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1},"candidates":[{"finishReason":"STOP"}]}}\n\n',
    '{\r\n  "er', 'ror": {"code": 503, "message": "fixture refusal"}\r\n}'];
  const f=fixture({fetchGoogle:async()=>new Response(new ReadableStream({start(controller){for(const chunk of frames)controller.enqueue(Buffer.from(chunk));controller.close()}}),{headers:{"content-type":"text/event-stream"}})});
  const result=await runWithRequestContext({requestId:"bare-tail",streamPerformance:tracker},()=>invoke(f.handler,body("gemini-native")).done);tracker.finish({statusCode:result.status});
  assert.equal(result.status,200);assert.equal(result.text,frames.join(""));assert.equal(f.records.length,1);
  assert.equal(f.records[0].outcome,"failed");assert.equal(f.records[0].partial,true);
  const row=metrics.snapshot().recent_requests[0];assert.equal(row.outcome,"failed");assert.equal(row.origin,"upstream_event");
});

test("equal saved and default response-header budgets both switch to stream idle on headers",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  for(const copilotTimeoutMs of [undefined,30]){
    let controller, signal;
    const f=fixture({upstreamTimeoutMs:30,copilotTimeoutMs,streamIdleTimeoutMs:120,client:{async chatCompletions(_,{signal:requestSignal,onUpstreamStart}){
      signal=requestSignal;onUpstreamStart();
      return new Response(new ReadableStream({start(value){
        controller=value;signal.addEventListener("abort",()=>controller.error(signal.reason),{once:true});
      }}),{headers:{"Content-Type":"text/event-stream"}});
    }}});
    const call=invoke(f.handler,body());
    for(let i=0;i<8&&!call.res.headersSent;i++)await new Promise(setImmediate);
    assert.equal(call.res.headersSent,true);
    t.mock.timers.tick(60);
    assert.equal(signal.aborted,false);
    controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    controller.close();
    assert.match((await call.done).text,/"finishReason":"STOP"/);
  }
});

test("an unbound background task can use an eligible model when Carbon is absent",async()=>{
  const models=()=>({data:catalog.data.filter(model=>model.id==="gemini-4-argon")});
  const f=fixture({models});
  for(const type of ["title","summarization"]){
    const reply=await invoke(f.handler,body("ccdx-copilot-gemini-4-argon-high",type)).done;
    assert.equal(reply.status,200);
  }
  assert.deepEqual(f.copilot.map(call=>[call.value.model,call.value.reasoning_effort]),[["gemini-4-argon","low"],["gemini-4-argon","low"]]);
});

test("a structured SSE rate rejection records safe upstream evidence without replay",async()=>{
  let calls=0;const observed=[];
  const f=fixture({client:{chatCompletions:async()=>{
    calls++;
    return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"code":"rate_limit_exceeded","message":"private fixture text"}}\n\n',{headers:{"Retry-After":"5","X-Request-Id":"fixture-id"}});
  }}});
  const result=await runWithRequestContext({onHttpError:value=>observed.push(value)},()=>invoke(f.handler,body()).done);
  assert.equal(result.status,200);assert.equal(calls,1);assert.match(result.text,/partial/);assert.doesNotMatch(result.text,/private fixture text|finishReason/);
  assert.equal(observed[0].origin,"upstream_event");assert.equal(observed[0].upstream_code,"rate_limit_exceeded");assert.equal(observed[0].headers.get("retry-after"),"5");
});
