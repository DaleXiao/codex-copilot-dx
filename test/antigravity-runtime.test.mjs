import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {request as httpsRequest} from "node:https";
import {Readable} from "node:stream";
import {createAntigravityRuntime} from "../src/antigravity-runtime.mjs";
import {userSettingsPath} from "../src/user-settings.mjs";
import {invokeAdapter,invokeAdapterRequest} from "../test-support/adapter.mjs";
import {parseManagedCommand} from "../src/cli-command-spec.mjs";
import {runManagementCommand} from "../src/cli-management.mjs";

const catalog={data:[{id:"gemini-4-carbon",supported_endpoints:["/chat/completions"],capabilities:{supports:{reasoning_effort:["low","medium","high"]},limits:{max_context_window_tokens:1000000,max_output_tokens:64000}}}]};
function fixture(t,state="running"){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"ccdx-gemini-")),env={},file=userSettingsPath({home,env});fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({future:"keep",terminal_color_theme:"pink"}));
  const calls=[],options={home,env,client:{},models:()=>catalog,platform:"darwin",inspect:async()=>({status:state,app:"/Applications/Gemini.app",version:"1.135.1.1291",pids:state==="running"?[38378]:[]}),exec:async(...args)=>{calls.push(args)},guardSource:()=>{}};
  const runtime=createAntigravityRuntime(options);t.after(()=>{runtime.close();fs.rmSync(home,{recursive:true,force:true})});return {runtime,options,calls,file,home};
}

test("the standalone Antigravity gateway serves the Gemini protocol over authenticated loopback TLS",async t=>{
  const f=fixture(t,"stopped");
  await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const calls=[], native=[], source="api_configured", model="publisher/gemini-fixture";
  const alias="ccdx-copilot-gemini-4-carbon-high";
  let gateway;
  const runtime=createAntigravityRuntime({...f.options,
    client:{chatCompletions:async(body,options)=>{
      calls.push(body);options.onUpstreamStart();
      if(body.messages.at(-1)?.content==="parallel fixture"){
        const slices=[
          {choices:[{delta:{tool_calls:[{index:0,id:"tool-one",function:{name:"lookup",arguments:'{"key":'}},{index:1,id:"tool-two",function:{name:"lookup",arguments:'{"key":'}}]}}]},
          {choices:[{delta:{tool_calls:[{index:1,function:{arguments:"2}"}},{index:0,function:{arguments:"1}"}}]},finish_reason:"tool_calls"}]},
        ];
        return new Response(slices.map(row=>"data: "+JSON.stringify(row)+"\n\n").join("")+"data: [DONE]\n\n");
      }
      if(body.messages.at(-1)?.content==="partial fixture"){
        return new Response('data: {"choices":[{"delta":{"content":"partial text"}}]}\n\ndata: {"error":{"code":"unavailable"}}\n\n');
      }
      return options.signal&&!body.stream
        ?Response.json({choices:[{message:{content:"copilot reply"},finish_reason:"stop"}]})
        :new Response('data: {"choices":[{"delta":{"content":"copilot stream"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }},
    applicationControl:{snapshot:()=>({}),check:async()=>{},openStandaloneAntigravity:async prepare=>{gateway=await prepare({version:"2.35.2"});return{status:"opened"}}},
    nativeSources:()=>[{id:source,name:"Configured",models:[{id:model}]}],
    getSource:id=>id===source?{client:{gemini:async(body,{countTokens,onUpstreamStart})=>{
      native.push(body);onUpstreamStart();
      if(body.request.contents?.at(-1)?.parts?.[0]?.text==="malformed fixture")return Response.json({
        candidates:[{finishReason:"MALFORMED_FUNCTION_CALL"}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2,totalTokenCount:5},
      });
      return Response.json(countTokens?{totalTokens:42}:{candidates:[{content:{role:"model",parts:[{text:"custom reply"}]},finishReason:"STOP"}]});
    }}}:null,
    googleFetch:()=>assert.fail("standalone gateway must never call Google"),
  });
  t.after(()=>runtime.close());
  await runtime.action({action:"models",native_source:source});
  const opened=await runtime.action({action:"gateway-open"});
  assert.equal(opened.last_operation.status,"opened");
  assert.equal(opened.enterprise_gateway_running,true);
  const launch=gateway.environment,{AGY_LLM_GATEWAY_URL:url,AGY_LLM_GATEWAY_API_KEY:key,AGY_LLM_GATEWAY_CA_CERT:certificate}=launch;
  assert.equal(launch.AGY_LLM_GATEWAY_WIRE_PROTOCOL,"genai");
  assert.equal(launch.AGY_LLM_GATEWAY_MODELS,undefined);
  assert.equal(opened.catalog_reload.gateway,null);
  assert.equal(JSON.stringify(opened).includes(key),false);
  assert.equal(JSON.stringify(opened).includes(certificate),false);
  assert.match(fs.readFileSync(certificate,"utf8"),/^-----BEGIN CERTIFICATE-----/);
  const ca=fs.readFileSync(certificate);
  const request=(route,{value,authorization="Bearer "+key,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpsRequest(new URL(route,url),{ca,agent:false,method:value===undefined?"GET":"POST",
      headers:{authorization,...(value===undefined?{}:{"content-type":"application/json"}),...headers}},reply=>{
      let text="";reply.setEncoding("utf8");reply.on("data",data=>{text+=data});
      reply.on("end",()=>resolve({status:reply.statusCode,text}));
    });req.on("error",reject);req.end(value===undefined?undefined:JSON.stringify(value));
  });
  const input={contents:[{role:"user",parts:[{text:"fixture"}]}]};
  assert.equal((await request("/v1beta/models",{authorization:"Bearer wrong"})).status,403);
  assert.equal((await request("/v1beta/models",{headers:{origin:"https://example.test"}})).status,403);
  const list=JSON.parse((await request("/v1beta/models")).text);
  const custom=list.models.find(row=>row.name.startsWith("models/ccdx-gemini-")).name.slice(7);
  assert.match(custom,/^ccdx-gemini-[0-9a-f]{32}$/);
  assert.match(list.models.find(row=>row.name==="models/"+alias).displayName,/\(High\)$/);
  assert.equal(runtime.snapshot().catalog_reload.gateway,false);
  assert.equal(gateway.observation().scope,"catalog");
  assert.equal((await request("/v1beta/models/google-native:generateContent",{value:input})).status,404);
  const copilot=await request("/v1beta/models/"+alias+":generateContent",{value:input});
  assert.equal(copilot.status,200);
  assert.equal(JSON.parse(copilot.text).candidates[0].content.parts[0].text,"copilot reply");
  const streamed=await request("/v1beta1/projects/fixture/locations/global/publishers/google/models/"+alias+":streamGenerateContent?alt=sse",{value:input});
  assert.equal(streamed.status,200);
  assert.equal(JSON.parse(streamed.text.split("\n")[0].slice(6)).candidates[0].content.parts[0].text,"copilot stream");
  assert.doesNotMatch(streamed.text,/\[DONE\]/);
  assert.equal(gateway.observation().scope,"inference");
  assert.ok(calls.every(body=>body.model==="gemini-4-carbon"&&body.reasoning_effort==="high"));
  assert.ok(calls.every(body=>!JSON.stringify(body).includes(key)));
  const parallel=await request("/v1beta/models/"+alias+":streamGenerateContent?alt=sse",{value:{
    contents:[{role:"user",parts:[{text:"parallel fixture"}]}],
    tools:[{functionDeclarations:[{name:"lookup",parameters:{type:"object",properties:{key:{type:"integer"}}}}]}],
  }});
  const observedCalls=parallel.text.split("\n").filter(line=>line.startsWith("data: ")).flatMap(line=>
    JSON.parse(line.slice(6)).candidates?.flatMap(candidate=>candidate.content?.parts||[])||[]).flatMap(part=>part.functionCall?[part.functionCall]:[]);
  assert.equal(observedCalls.length,2);
  assert.notEqual(observedCalls[0].id,observedCalls[1].id);
  assert.deepEqual(observedCalls.map(call=>[call.name,call.args.key]).sort(),[["lookup",1],["lookup",2]]);
  const partial=await request("/v1beta/models/"+alias+":streamGenerateContent?alt=sse",{value:{
    contents:[{role:"user",parts:[{text:"partial fixture"}]}],
  }});
  assert.match(partial.text,/partial text/);assert.match(partial.text,/"error"/);
  assert.doesNotMatch(partial.text,/"finishReason":"STOP"|\[DONE\]/);
  const configured=await request("/v1beta/models/"+custom+":generateContent",{value:input});
  assert.equal(configured.status,200);
  assert.equal(JSON.parse(configured.text).candidates[0].content.parts[0].text,"custom reply");
  assert.deepEqual(native,[{model,request:input}]);
  const followup={contents:[...input.contents,
    {role:"model",parts:[{functionCall:{id:"native-call",name:"lookup",args:{key:1}},thoughtSignature:"c3ludGhldGlj"}]},
    {role:"user",parts:[{functionResponse:{id:"native-call",name:"lookup",response:{result:"ok"}}}]},
  ]};
  assert.equal((await request("/v1beta/models/"+custom+":generateContent",{value:followup})).status,200);
  assert.deepEqual(native.at(-1).request,followup);
  const malformed=await request("/v1beta/models/"+custom+":generateContent",{value:{contents:[{role:"user",parts:[{text:"malformed fixture"}]}]}});
  const malformedReply=JSON.parse(malformed.text);
  assert.equal(malformedReply.candidates?.[0]?.finishReason,"MALFORMED_FUNCTION_CALL");
  assert.equal(malformedReply.usageMetadata.totalTokenCount,5);
  assert.deepEqual(JSON.parse((await request("/v1beta/models/"+custom+":countTokens",{value:{generateContentRequest:input}})).text),{totalTokens:42});
  assert.deepEqual(JSON.parse((await request("/v1beta:reportMetrics",{value:{}})).text),{});
  await runtime.action({action:"models",models:["ccdx-copilot-gemini-4-carbon-low"]});
  assert.equal(runtime.snapshot().catalog_reload.gateway,true);
  assert.equal(runtime.snapshot().catalog_reload.google,null);
  assert.equal((await request("/v1beta/models/"+alias+":generateContent",{value:input})).status,503);
  assert.equal(calls.length,4);
  runtime.close();
  assert.equal(fs.existsSync(certificate),false);
  assert.equal(runtime.snapshot().enterprise_gateway_running,false);
});

test("WebUI launch preferences are explicit, persisted after launch, and separate from the observed mode",async t=>{
  const f=fixture(t,"stopped");
  const calls=[];
  const runtime=createAntigravityRuntime({...f.options,applicationControl:{snapshot:()=>({}),check:async()=>{},
    openAntigravityFromWeb:async(input,launch)=>{
      calls.push([input.operation,launch.mode,launch.preference]);
      return launch.mode||launch.preference?{status:"opened",mode:launch.mode||launch.preference}:{status:"launch_choice_required"};
    }}});
  t.after(()=>runtime.close());
  assert.equal((await runtime.action({action:"web-open"})).last_operation.status,"launch_choice_required");
  assert.equal((await runtime.action({action:"web-open",launch_mode:"gateway"})).launch_preference,"gateway");
  assert.equal((await runtime.action({action:"web-open"})).last_operation.mode,"gateway");
  assert.deepEqual(calls,[["open",undefined,null],["open","gateway",null],["open",undefined,"gateway"]]);
  assert.equal(JSON.parse(fs.readFileSync(f.file,"utf8")).future,"keep");
  await assert.rejects(runtime.action({action:"web-open",launch_mode:"invalid"}),{statusCode:400});
});
test("enable is explicit, edits only CCDX settings, and never restarts a running App",async t=>{
  const f=fixture(t);assert.equal(f.runtime.snapshot().configured,false);
  await assert.rejects(f.runtime.action({action:"enable"},"http://127.0.0.1:2026"),/accept/);
  const state=await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");assert.equal(state.enabled,true);assert.equal(state.models.length,3);assert.equal(state.models_reload_required,null,"Client directory state is unknown until native discovery");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),{future:"keep",terminal_color_theme:"pink",gemini_antigravity_enabled:true});
  const open=await f.runtime.action({action:"open"},"http://127.0.0.1:2026");assert.equal(open.last_operation.status,"needs_app_relaunch");assert.equal(f.calls.length,0);
  assert.equal(fs.existsSync(path.join(f.home,".gemini")),false);
});
test("a rejected first Copilot request cannot claim a Gemini conversation",async t=>{
  const f=fixture(t,"stopped");
  let copilot=0,google=0;
  const runtime=createAntigravityRuntime({...f.options,guardSource:undefined,readToken:()=>"fixture-provider",
    client:{chatCompletions:async()=>{copilot++;throw Error("Rejected request must not be sent");}},
    googleFetch:async()=>{google++;return Response.json({native:true});}});
  t.after(()=>runtime.close());
  await runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const user={role:"user",parts:[{text:"fixture"}]};
  const invoke=(model,contents)=>{
    const req=Readable.from([Buffer.from(JSON.stringify({model,requestType:"agent",request:{labels:{root_cascade_id:"rejected-first-fixture"},contents}}))]);
    req.method="POST";req.url="/antigravity/v1internal:generateContent";
    req.headers={host:"127.0.0.1:2026","content-type":"application/json"};req.socket={remoteAddress:"127.0.0.1"};
    return invokeAdapterRequest({},req,runtime.handle);
  };
  const rejected=await invoke("ccdx-copilot-gemini-4-carbon-high",[user,{role:"model",parts:[{text:"old reply",thoughtSignature:"fixture"}]}]);
  assert.equal(rejected.status,400);assert.equal(copilot+google,0);
  assert.equal((await invoke("gemini-native",[user])).status,200);
  assert.equal(copilot,0);assert.equal(google,1);
  assert.equal((await invoke("ccdx-copilot-gemini-4-carbon-high",[user])).status,409);
  assert.equal(copilot,0);
});
test("a closed App can be opened through the native binary's process-local route",async t=>{
  const f=fixture(t,"stopped");await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const opened=await f.runtime.action({action:"open"},"http://127.0.0.1:2026");assert.equal(opened.last_operation.status,"opened");assert.equal(opened.app.status,"starting");
  assert.equal(f.calls[0][0],"/usr/bin/open");assert.deepEqual(f.calls[0][1],["-a","/Applications/Gemini.app","--env","CLOUD_CODE_URL=http://127.0.0.1:2026/antigravity"]);
});
test("the 2.35.2 Windows client gets one Copilot group from a flat Google catalog",async t=>{
  const f=fixture(t);await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const response=await invokeAdapter({env:{},dashboardOptions:{home:f.home},codexModelRegistry:{models:catalog},
    antigravityOptions:{platform:"win32",googleFetch:async()=>Response.json({models:{native:{model:"NATIVE"}}})}},
    {url:"/antigravity/v1internal:fetchAvailableModels",headers:{host:"127.0.0.1:2026","user-agent":"antigravity/hub/2.35.2.0"},body:{}});
  assert.equal(response.status,200);
  const merged=JSON.parse(response.text),parent="ccdx-copilot-gemini-4-carbon";
  assert.deepEqual(merged.agentModelSorts[0].groups[0].modelIds,["low","medium","high"].map(effort=>parent+"-"+effort));
  assert.ok(merged.models[parent]);
  assert.deepEqual(merged.groupedModels[parent].supportedThinkingLevels.map(level=>level.thinkingSuffix),["low","medium","high"]);
});
test("pause retains a safe configured bridge and removes Copilot model access",async t=>{
  const f=fixture(t);await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  await f.runtime.action({action:"open"},"http://127.0.0.1:2026");
  const state=await f.runtime.action({action:"disable"},"http://127.0.0.1:2026");assert.equal(state.configured,true);assert.equal(state.enabled,false);assert.equal(state.models.length,3);assert.ok(state.models.every(model=>model.selected));assert.equal(f.calls.length,0);
  assert.equal(state.model_groups.length,1);assert.equal(state.model_groups[0].id,"gemini-4-carbon");assert.equal(state.model_groups[0].efforts.length,3);
  assert.equal(state.last_operation,null);
  const blocked=await invokeAdapter({env:{},dashboardOptions:{home:f.home},codexModelRegistry:{models:catalog}},{url:"/antigravity/v1internal:streamGenerateContent",headers:{host:"127.0.0.1:2026"},body:{requestType:"agent",model:state.models[0].id,request:{contents:[{role:"user",parts:[{text:"fixture"}]}]}}});
  assert.equal(blocked.status,503);
});
test("Antigravity saves a selected default atomically, supports clearing, and never starts the app",async t=>{
  const f=fixture(t),ids=f.runtime.snapshot().models.map(row=>row.id),preferred=ids[1];
  const before=fs.readFileSync(f.file,"utf8");
  for(const candidate of [ids[2],"native",false])await assert.rejects(f.runtime.action({action:"models",models:[preferred],default_model:candidate}),{statusCode:400});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  let state=await f.runtime.action({action:"models",models:ids,default_model:preferred});
  assert.equal(state.default_model,preferred);assert.equal(state.models.find(row=>row.id===preferred).default,true);
  assert.equal(state.model_groups[0].default,true);assert.equal(JSON.parse(fs.readFileSync(f.file)).future,"keep");
  state=await f.runtime.action({action:"models",models:ids});assert.equal(state.default_model,preferred);
  state=await f.runtime.action({action:"models",models:[ids[0]]});assert.equal(state.default_model,null);
  state=await f.runtime.action({action:"models",models:ids,default_model:preferred});assert.equal(state.default_model,preferred);
  state=await f.runtime.action({action:"models",models:ids,default_model:null});assert.equal(state.default_model,null);
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(f.file)),"gemini_antigravity_default_model"));assert.equal(f.calls.length,0);
});

test("Gemini management accepts only local same-origin changes",async t=>{
  const f=fixture(t),options={env:{},dashboardOptions:{home:f.home},codexModelRegistry:{models:catalog},antigravityOptions:{inspect:f.options.inspect,exec:f.options.exec}};
  const headers={host:"127.0.0.1:2026","x-ccdx-dashboard":"1",origin:"http://127.0.0.1:2026"};
  const enabled=await invokeAdapter(options,{url:"/_ccdx/ui/gemini",headers,body:{action:"enable",accept_background_copilot:true}});assert.equal(enabled.status,200);assert.equal(JSON.parse(enabled.text).enabled,true);
  assert.equal((await invokeAdapter(options,{url:"/_ccdx/ui/gemini",headers:{...headers,origin:"https://example.test"},body:{action:"disable"}})).status,403);
});
test("Gemini CLI uses the same management API without selecting the Codex client",async()=>{
  const command=parseManagedCommand(["app","gemini","status","--format","json"]),calls=[];
  const result=await runManagementCommand(command,{request:async input=>{calls.push(input);return {source:"gemini_antigravity",enabled:false}},output:{isTTY:false,write(){}}});
  assert.equal(JSON.parse(result).source,"gemini_antigravity");assert.deepEqual(calls,[{path:"gemini"}]);
});
test("switching an existing Copilot conversation to Google is rejected before Google receives history",async t=>{
  const f=fixture(t);await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  let googleCalls=0,copilotCalls=0;
  const options={env:{},dashboardOptions:{home:f.home},codexModelRegistry:{models:catalog},codexClient:{chatCompletions:async()=>{copilotCalls++;return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')}},
    antigravityOptions:{googleFetch:async()=>{googleCalls++;return Response.json({})}}};
  const request={requestType:"agent",model:"ccdx-copilot-gemini-4-carbon-high",request:{labels:{root_cascade_id:"fixture-root"},contents:[{role:"user",parts:[{text:"private fixture"}]}]}};
  assert.equal((await invokeAdapter(options,{url:"/antigravity/v1internal:streamGenerateContent",headers:{host:"127.0.0.1:2026"},body:request})).status,200);
  request.model="gemini-4-argon";
  assert.equal((await invokeAdapter(options,{url:"/antigravity/v1internal:streamGenerateContent",headers:{host:"127.0.0.1:2026"},body:request})).status,409);
  assert.equal(copilotCalls,1);assert.equal(googleCalls,0);
  const stored=fs.readFileSync(path.join(path.dirname(f.file),"conversation-sources.json"),"utf8");assert.doesNotMatch(stored,/private fixture|fixture-root/);
});

test("the Antigravity Copilot timeout override does not change native Google waits", async t => {
  const f = fixture(t);
  await f.runtime.action({ action: "enable", accept_background_copilot: true }, "http://127.0.0.1:2026");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const googleStarted = Promise.withResolvers(), copilotStarted = Promise.withResolvers();
  const hold = (signal, started) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started.resolve(signal);
  });
  const options = { env: { CCDX_ANTIGRAVITY_COPILOT_TIMEOUT_MS: "500" }, upstreamTimeoutMs: 100,
    dashboardOptions: { home: f.home }, codexModelRegistry: { models: catalog },
    codexClient: { chatCompletions: async (_, { signal, onUpstreamStart }) => {
      onUpstreamStart();
      return hold(signal, copilotStarted);
    } },
    antigravityOptions: { guardSource: () => {}, googleFetch: async (_, { signal }) => hold(signal, googleStarted) } };
  const invoke = model => invokeAdapter(options, { url: "/antigravity/v1internal:streamGenerateContent",
    headers: { host: "127.0.0.1:2026", authorization: "Bearer FIXTURE" },
    body: { model, requestType: "agent", request: { contents: [{ role: "user", parts: [{ text: "fixture" }] }] } } });
  const google = invoke("gemini-native"), copilot = invoke("ccdx-copilot-gemini-4-carbon-high");
  const started = (signal, response) => Promise.race([signal.promise, response.then(result => {
    throw new Error(`Fixture returned HTTP ${result.status} before calling its source`);
  })]);
  const [googleSignal, copilotSignal] = await Promise.all([started(googleStarted, google), started(copilotStarted, copilot)]);
  t.mock.timers.tick(100);
  assert.equal(googleSignal.aborted, true);
  assert.equal(copilotSignal.aborted, false);
  assert.equal((await google).status, 504);
  t.mock.timers.tick(400);
  assert.equal(copilotSignal.aborted, true);
  assert.equal((await copilot).status, 504);
});

test("saving only the Antigravity Copilot timeout preserves models and leaves in-flight waits alone", async t => {
  const f = fixture(t);
  await f.runtime.action({ action: "enable", accept_background_copilot: true }, "http://127.0.0.1:2026");
  const old = Promise.withResolvers(), next = Promise.withResolvers(), started = [old, next];
  const runtime = createAntigravityRuntime({ ...f.options, upstreamTimeoutMs: 100, client: { chatCompletions: async (_, { signal, onUpstreamStart }) => {
    onUpstreamStart();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.shift().resolve(signal);
    });
  } } });
  t.after(() => runtime.close());
  const invoke = () => {
    const body = { model: "ccdx-copilot-gemini-4-carbon-high", requestType: "agent",
      request: { contents: [{ role: "user", parts: [{ text: "fixture" }] }] } };
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: "POST", url: "/antigravity/v1internal:streamGenerateContent",
      headers: { host: "127.0.0.1:2026", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } });
    return invokeAdapterRequest({}, req, runtime.handle);
  };
  const save = value => runtime.action({ action: "models", copilot_timeout_seconds: value }, "http://127.0.0.1:2026");
  const original = JSON.parse(fs.readFileSync(f.file));
  assert.deepEqual(runtime.snapshot().copilot_timeout, { default_ms: 180000, effective_ms: 180000, locked: false });
  for (const invalid of [0, 601, 2.5, "180"]) await assert.rejects(save(invalid), { statusCode: 400 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = invoke(), oldSignal = await old.promise;
  const settings = await save(240);
  assert.equal(settings.copilot_timeout.effective_ms, 240000);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { ...original, gemini_antigravity_copilot_timeout_seconds: 240 });
  assert.equal(settings.selected_models, null);
  const second = invoke(), nextSignal = await next.promise;
  t.mock.timers.tick(120000);
  assert.equal(oldSignal.aborted, false);
  assert.equal(nextSignal.aborted, false);
  t.mock.timers.tick(60000);
  assert.equal(oldSignal.aborted, true);
  assert.equal(nextSignal.aborted, false);
  assert.equal((await first).status, 504);
  t.mock.timers.tick(60000);
  assert.equal((await second).status, 504);
  const sharedOptions = { ...f.options, env: { ...f.options.env, CCDX_UPSTREAM_TIMEOUT_MS: "210000" } };
  const shared = createAntigravityRuntime(sharedOptions);
  t.after(() => shared.close());
  assert.deepEqual(shared.snapshot().copilot_timeout, { default_ms: 210000, effective_ms: 240000, locked: false });
  const locked = createAntigravityRuntime({ ...sharedOptions, copilotTimeoutMs: 260000 });
  t.after(() => locked.close());
  assert.deepEqual(locked.snapshot().copilot_timeout, { default_ms: 210000, effective_ms: 260000, locked: true });
  await assert.rejects(locked.action({ action: "models", copilot_timeout_seconds: 300 }), { statusCode: 409 });
  assert.equal((await save(null)).copilot_timeout.effective_ms, 180000);
  assert.equal(shared.snapshot().copilot_timeout.effective_ms, 210000);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), original);
});

test("model selection persists without altering other settings and rejects unavailable or duplicate IDs",async t=>{
  const f=fixture(t);await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const ids=f.runtime.snapshot().models.map(model=>model.id);
  const saved=await f.runtime.action({action:"models",models:[ids[2]]},"http://127.0.0.1:2026");
  assert.deepEqual(saved.models.filter(model=>model.selected).map(model=>model.id),[ids[2]]);
  assert.deepEqual(saved.model_groups[0].efforts.filter(item=>item.selected).map(item=>item.effort),["high"]);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).future,"keep");
  const before=fs.readFileSync(f.file,"utf8");
  for(const models of [["unknown"],[ids[0],ids[0]],null,"all"])
    await assert.rejects(f.runtime.action({action:"models",models},"http://127.0.0.1:2026"),/available/);
  await assert.rejects(f.runtime.action({action:"enable",models:[]},"http://127.0.0.1:2026"),/Models require/);
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const empty=await f.runtime.action({action:"models",models:[]},"http://127.0.0.1:2026");assert.equal(empty.models.filter(model=>model.selected).length,0);
  assert.equal(empty.enabled,true);assert.equal(f.calls.length,0);
});
test("terminal status includes Antigravity before its first UI visit and summary never inspects the native App",async t=>{
  const f=fixture(t);await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  let inspections=0;const options={env:{},dashboardOptions:{home:f.home},antigravityOptions:{inspect:async()=>{inspections++;throw Error("should not inspect")}}};
  const result=await invokeAdapter(options,{method:"GET",url:"/_ccdx/status",headers:{host:"127.0.0.1:2026"}});
  assert.equal(JSON.parse(result.text).gemini.enabled,true);
  const summary=await invokeAdapter(options,{method:"GET",url:"/_ccdx/ui/gemini?scope=summary",headers:{host:"127.0.0.1:2026","x-ccdx-dashboard":"1"}});
  assert.equal(summary.status,200);assert.equal(JSON.parse(summary.text).enabled,true);assert.equal(inspections,0);
});

test("explicit refresh updates available models without changing saved choices or starting clients",async t=>{
  const f=fixture(t),registry={models:structuredClone(catalog)};let reads=0,fail=false;
  const hydrogen={...catalog.data[0],id:"gemini-4-hydrogen",capabilities:{...catalog.data[0].capabilities,supports:{reasoning_effort:["low","medium","high","xhigh"]}}};
  const runtime=createAntigravityRuntime({...f.options,models:()=>registry.models,refreshModels:async()=>{reads++;if(fail)throw Error("catalog unavailable");registry.models={data:[...catalog.data,hydrogen]}}});t.after(()=>runtime.close());
  const selected=["ccdx-copilot-gemini-4-carbon-high"];
  await runtime.action({action:"models",models:selected},"http://127.0.0.1:2026");const before=fs.readFileSync(f.file,"utf8");
  await runtime.action({action:"summary"});assert.equal(reads,0);
  const state=await runtime.action({action:"refresh"},"http://127.0.0.1:2026");assert.equal(reads,1);assert.equal(state.model_groups.length,2);
  assert.deepEqual(state.models.filter(row=>row.selected).map(row=>row.id),selected);assert.equal(state.models.find(row=>row.effort==="xhigh").selected,false);
  assert.equal(fs.readFileSync(f.file,"utf8"),before);assert.equal(f.calls.length,0);
  fail=true;await assert.rejects(runtime.action({action:"refresh"},"http://127.0.0.1:2026"),/unavailable/);assert.equal(runtime.snapshot().model_groups.length,2);assert.equal(fs.readFileSync(f.file,"utf8"),before);
  registry.models={data:[...registry.models.data,{...hydrogen,id:"gemini-3.8-flash"}]};
  const dotted="ccdx-copilot-gemini-3.8-flash-xhigh";
  await runtime.action({action:"models",models:[dotted]},"http://127.0.0.1:2026");assert.equal(runtime.snapshot().models.find(model=>model.id===dotted).selected,true);
});

test("Antigravity CLI refresh uses the same explicit catalog operation",async()=>{
  const command=parseManagedCommand(["app","antigravity","models","--refresh","--format","json"]),calls=[];
  await runManagementCommand(command,{request:async input=>{calls.push(input);return{models:[]}},output:{isTTY:false,write(){}}});
  assert.deepEqual(calls,[{path:"gemini",body:{action:"refresh"},timeoutMs:20000}]);
});

test("Antigravity CLI opts into the standalone mode without changing the ordinary open action",async()=>{
  for(const [args,action] of [[["gateway-open"],"gateway-open"],[["open","--standalone"],"standalone-open"]]){
    const calls=[],command=parseManagedCommand(["app","antigravity",...args,"--format","json"]);
    await runManagementCommand(command,{request:async input=>{
      calls.push(input);return {last_operation:{action,status:"opened"}};
    },output:{isTTY:false,write(){}}});
    assert.deepEqual(calls,[{path:"gemini",body:{action},timeoutMs:65000}]);
  }
});

test("dashboard refresh uses the existing GitHub catalog runtime and leaves settings unchanged",async t=>{
  const f=fixture(t),registry={models:structuredClone(catalog)},calls=[],before=fs.readFileSync(f.file,"utf8");
  const response=await invokeAdapter({env:{},dashboardOptions:{home:f.home},codexModelRegistry:registry,
    providerRuntime:{snapshot:()=>({}),dashboardCatalog:async input=>{calls.push(input);registry.models={data:[...catalog.data,{...catalog.data[0],id:"gemini-4-hydrogen"}]};return{source:"live"}}},
    antigravityOptions:{inspect:f.options.inspect,exec:f.options.exec}},
    {url:"/_ccdx/ui/gemini",headers:{host:"127.0.0.1:2026",origin:"http://127.0.0.1:2026","x-ccdx-dashboard":"1"},body:{action:"refresh"}});
  assert.equal(response.status,200);assert.deepEqual(calls,[{provider:"github"}]);assert.equal(JSON.parse(response.text).model_groups.length,2);
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
});

test("a reconstructed gateway keeps a known Copilot conversation's compression model and effort",async t=>{
  const f=fixture(t),sent=[];
  await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const registry={data:[...catalog.data,{...catalog.data[0],id:"gemini-4-argon"}]};
  const environment={env:{},dashboardOptions:{home:f.home},codexModelRegistry:{models:registry},codexClient:{async chatCompletions(value){
    sent.push([value.model,value.reasoning_effort]);
    return Response.json({choices:[{finish_reason:"stop",message:{content:"ok"}}]});
  }}};
  const request={requestType:"agent",model:"ccdx-copilot-gemini-4-carbon-high",request:{labels:{root_cascade_id:"fixture-compression-session"},contents:[{role:"user",parts:[{text:"private fixture"}]}]}};
  const call=body=>invokeAdapter(environment,{url:"/antigravity/v1internal:generateContent",headers:{host:"127.0.0.1:2026"},body});
  assert.equal((await call(request)).status,200);
  const invalid={...request,model:"ccdx-copilot-gemini-4-argon-high",request:{
    ...request.request,contents:[{role:"user",parts:[{unsupported_part:true}]}],
  }};
  assert.equal((await call(invalid)).status,400);
  assert.equal(sent.length,1,"a locally rejected model switch never reaches upstream");
  assert.equal((await call({...request,requestType:"summarization",model:"discovery-model"})).status,200);
  assert.deepEqual(sent,[["gemini-4-carbon","high"],["gemini-4-carbon","high"]]);
  assert.doesNotMatch(fs.readFileSync(path.join(path.dirname(f.file),"antigravity-conversations.json"),"utf8"),/fixture-compression-session|private fixture/);
});

test("parallel model choices commit in request order and a failed SSE cannot replace the successful choice",async t=>{
  const f=fixture(t),sent=[],pending=Promise.withResolvers(),release=Promise.withResolvers();
  await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const argon="gemini-4-argon",registry={data:[...catalog.data,{...catalog.data[0],id:argon}]};
  const runtime=createAntigravityRuntime({...f.options,guardSource:undefined,models:()=>registry,
    client:{async chatCompletions(value){
      sent.push(value.model);
      if(sent.length===1){pending.resolve();await release.promise;}
      if(value.stream)return new Response(
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"code":"upstream_error"}}\n\n',
        {headers:{"content-type":"text/event-stream"}},
      );
      return Response.json({choices:[{finish_reason:"stop",message:{content:"ok"}}]});
    }}});
  t.after(()=>runtime.close());
  const call=(model,{stream=false,type="agent"}={})=>{
    const body={model,requestType:type,request:{labels:{root_cascade_id:"ordered-compaction"},contents:[{role:"user",parts:[{text:"fixture"}]}]}};
    const req=Readable.from([JSON.stringify(body)]);
    Object.assign(req,{method:"POST",url:"/antigravity/v1internal:"+(stream?"streamGenerateContent":"generateContent"),
      headers:{host:"127.0.0.1:2026","content-type":"application/json"},socket:{remoteAddress:"127.0.0.1"}});
    return invokeAdapterRequest({},req,runtime.handle);
  };
  const carbon="ccdx-copilot-gemini-4-carbon-high", alternative="ccdx-copilot-gemini-4-argon-high";
  const old=call(carbon);
  try{
    await pending.promise;
    assert.equal((await call(alternative)).status,200);
  }finally{release.resolve();}
  assert.equal((await old).status,200);
  const failed=await call(carbon,{stream:true});
  assert.equal(failed.status,200);assert.match(failed.text,/"error"/);
  assert.equal((await call("placeholder",{type:"summarization"})).status,200);
  assert.deepEqual(sent,["gemini-4-carbon",argon,"gemini-4-carbon",argon]);
});

test("explicit reasoning families group the API and TUI choices without replacing wire aliases", async t => {
  const f = fixture(t);
  const model = id => ({ id, supported_endpoints: ["/chat/completions"] });
  const runtime = createAntigravityRuntime({ ...f.options, models: () => ({ data: [
    { ...model("gemini-4-carbon-low"), base_model_id: "gemini-4-carbon", reasoning_effort: "low" },
    { ...model("gemini-4-carbon-high"), base_model_id: "gemini-4-carbon", reasoning_effort: "high" },
    model("gemini-4-carbon-preview"), model("gemini-4-independent-high"),
  ] }) });
  t.after(() => runtime.close());
  const high = "ccdx-copilot-gemini-4-carbon-high";
  const state = await runtime.action({ action: "models", models: [high], default_model: high }, "http://127.0.0.1:2026");
  assert.equal(state.default_model, high);
  assert.equal(state.models.find(row => row.id === high).model, "gemini-4-carbon-high");
  assert.deepEqual(state.model_groups.map(row => row.id), ["gemini-4-carbon", "gemini-4-carbon-preview", "gemini-4-independent-high"]);
  assert.deepEqual(state.model_groups[0].efforts.map(row => [row.effort, row.selected]), [["low", false], ["high", true]]);
});
