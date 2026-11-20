import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import {createAntigravityRuntime} from "../src/antigravity-runtime.mjs";
import {userSettingsPath} from "../src/user-settings.mjs";
import {invokeAdapter,invokeAdapterRequest} from "../test-support/adapter.mjs";
import {parseManagedCommand} from "../src/cli-command-spec.mjs";
import {runManagementCommand} from "../src/cli-management.mjs";

const catalog={data:[{id:"gemini-4-carbon",supported_endpoints:["/chat/completions"],capabilities:{supports:{reasoning_effort:["low","medium","high"]},limits:{max_context_window_tokens:1000000,max_output_tokens:64000}}}]};
function fixture(t,state="running"){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"ccdx-gemini-")),env={},file=userSettingsPath({home,env});fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({future:"keep",terminal_color_theme:"pink"}));
  const calls=[],options={home,env,client:{},models:()=>catalog,inspect:async()=>({status:state,app:"/Applications/Gemini.app",version:"1.135.1.1291",pids:state==="running"?[38378]:[]}),exec:async(...args)=>{calls.push(args)},guardSource:()=>{}};
  const runtime=createAntigravityRuntime(options);t.after(()=>{runtime.close();fs.rmSync(home,{recursive:true,force:true})});return {runtime,options,calls,file,home};
}
test("enable is explicit, edits only CCDX settings, and never restarts a running App",async t=>{
  const f=fixture(t);assert.equal(f.runtime.snapshot().configured,false);
  await assert.rejects(f.runtime.action({action:"enable"},"http://127.0.0.1:2026"),/accept/);
  const state=await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");assert.equal(state.enabled,true);assert.equal(state.models.length,3);assert.equal(state.models_reload_required,null,"Client directory state is unknown until native discovery");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),{future:"keep",terminal_color_theme:"pink",gemini_antigravity_enabled:true});
  const open=await f.runtime.action({action:"open"},"http://127.0.0.1:2026");assert.equal(open.last_operation.status,"needs_app_relaunch");assert.equal(f.calls.length,0);
  assert.equal(fs.existsSync(path.join(f.home,".gemini")),false);
});
test("a closed App can be opened through the native binary's process-local route",async t=>{
  const f=fixture(t,"stopped");await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const opened=await f.runtime.action({action:"open"},"http://127.0.0.1:2026");assert.equal(opened.last_operation.status,"opened");assert.equal(opened.app.status,"starting");
  assert.equal(f.calls[0][0],"/usr/bin/open");assert.deepEqual(f.calls[0][1],["-a","/Applications/Gemini.app","--env","CLOUD_CODE_URL=http://127.0.0.1:2026/antigravity"]);
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
  for (const invalid of [0, 601, 2.5, "180"]) await assert.rejects(save(invalid), { statusCode: 400 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = invoke(), oldSignal = await old.promise;
  const settings = await save(1);
  assert.equal(settings.copilot_timeout.effective_ms, 1000);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { ...original, gemini_antigravity_copilot_timeout_seconds: 1 });
  assert.equal(settings.selected_models, null);
  const second = invoke(), nextSignal = await next.promise;
  t.mock.timers.tick(100);
  assert.equal(oldSignal.aborted, true);
  assert.equal(nextSignal.aborted, false);
  assert.equal((await first).status, 504);
  t.mock.timers.tick(900);
  assert.equal((await second).status, 504);
  const locked = createAntigravityRuntime({ ...f.options, copilotTimeoutMs: 180000 });
  t.after(() => locked.close());
  assert.equal(locked.snapshot().copilot_timeout.effective_ms, 180000);
  await assert.rejects(locked.action({ action: "models", copilot_timeout_seconds: 300 }), { statusCode: 409 });
  assert.equal((await save(null)).copilot_timeout.effective_ms, 100);
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
  const environment={env:{},dashboardOptions:{home:f.home},codexModelRegistry:{models:catalog},codexClient:{async chatCompletions(value){
    sent.push([value.model,value.reasoning_effort]);
    return Response.json({choices:[{finish_reason:"stop",message:{content:"ok"}}]});
  }}};
  const request={requestType:"agent",model:"ccdx-copilot-gemini-4-carbon-high",request:{labels:{root_cascade_id:"fixture-compression-session"},contents:[{role:"user",parts:[{text:"private fixture"}]}]}};
  const call=body=>invokeAdapter(environment,{url:"/antigravity/v1internal:generateContent",headers:{host:"127.0.0.1:2026"},body});
  assert.equal((await call(request)).status,200);
  assert.equal((await call({...request,requestType:"summarization",model:"discovery-model"})).status,200);
  assert.deepEqual(sent,[["gemini-4-carbon","high"],["gemini-4-carbon","high"]]);
  assert.doesNotMatch(fs.readFileSync(path.join(path.dirname(f.file),"antigravity-conversations.json"),"utf8"),/fixture-compression-session|private fixture/);
});
