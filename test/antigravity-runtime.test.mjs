import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createAntigravityRuntime} from "../src/antigravity-runtime.mjs";
import {userSettingsPath} from "../src/user-settings.mjs";
import {invokeAdapter} from "../test-support/adapter.mjs";
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
  const state=await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");assert.equal(state.enabled,true);assert.equal(state.models.length,3);
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
  assert.equal(state.last_operation,null);
  const blocked=await invokeAdapter({env:{},dashboardOptions:{home:f.home},codexModelRegistry:{models:catalog}},{url:"/antigravity/v1internal:streamGenerateContent",headers:{host:"127.0.0.1:2026"},body:{requestType:"agent",model:state.models[0].id,request:{contents:[{role:"user",parts:[{text:"fixture"}]}]}}});
  assert.equal(blocked.status,503);
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

test("model selection persists without altering other settings and rejects unavailable or duplicate IDs",async t=>{
  const f=fixture(t);await f.runtime.action({action:"enable",accept_background_copilot:true},"http://127.0.0.1:2026");
  const ids=f.runtime.snapshot().models.map(model=>model.id);
  const saved=await f.runtime.action({action:"models",models:[ids[2]]},"http://127.0.0.1:2026");
  assert.deepEqual(saved.models.filter(model=>model.selected).map(model=>model.id),[ids[2]]);
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
