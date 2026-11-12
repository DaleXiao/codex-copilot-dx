import test from "node:test";
import assert from "node:assert/strict";
import {inspectGeminiApp,planGeminiAppLaunch} from "../src/gemini-app.mjs";

const info={CFBundleIdentifier:"com.google.GeminiMacOS",CFBundleExecutable:"Gemini",CFBundleShortVersionString:"1.135.1.1291"};
const options=(metadata=info,processes="")=>{const calls=[];return {calls,platform:"darwin",exists:()=>true,exec:async(command,args)=>{calls.push({command,args});return {stdout:command.endsWith("plutil")?JSON.stringify(metadata):command.endsWith("ps")?processes:""}}}};

test("native Gemini identity and existing process are inspected without controlling it",async()=>{
  const input=options(info,"38378 /Applications/Gemini.app/Contents/MacOS/Gemini\n38444 /Applications/Gemini.app/Contents/Helpers/agy");
  const state=await inspectGeminiApp(input);assert.equal(state.status,"running");assert.deepEqual(state.pids,[38378]);
  assert.deepEqual(input.calls.map(x=>x.command),["/usr/bin/plutil","/usr/bin/codesign","/bin/ps"]);
});
test("an unrelated app is refused before signature or process checks",async()=>{
  const input=options({...info,CFBundleIdentifier:"other.app"});await assert.rejects(inspectGeminiApp(input),/identity/);assert.equal(input.calls.length,1);
});
test("a running native app requires a separate relaunch decision",()=>{
  const plan=planGeminiAppLaunch({status:"running",pids:[38378]},{cloudCodeUrl:"http://127.0.0.1:18080/antigravity/",env:{}});
  assert.equal(plan.status,"needs_app_relaunch");assert.equal(plan.command,undefined);
});
test("a stopped app gets only a process-local route in its launch plan",()=>{
  const env={OTHER:"keep"},plan=planGeminiAppLaunch({status:"stopped",app:"/Applications/Gemini.app",pids:[]},{cloudCodeUrl:"http://127.0.0.1:18080/antigravity/",env});
  assert.equal(plan.status,"prepared");assert.deepEqual(plan.args,["-a","/Applications/Gemini.app","--env","CLOUD_CODE_URL=http://127.0.0.1:18080/antigravity/"]);assert.deepEqual(env,{OTHER:"keep"});
});
test("remote routes and overrides of existing gateways are refused",()=>{
  const state={status:"stopped",app:"/Applications/Gemini.app",pids:[]},cloudCodeUrl="http://127.0.0.1:18080/antigravity/";
  assert.throws(()=>planGeminiAppLaunch(state,{cloudCodeUrl:"https://example.test/",env:{}}),/local/);
  assert.throws(()=>planGeminiAppLaunch(state,{cloudCodeUrl:"http://127.0.0.1:0/",env:{}}),/local/);
  assert.throws(()=>planGeminiAppLaunch({...state,app:"/Applications/Other.app"},{cloudCodeUrl,env:{}}),/location/);
  assert.equal(planGeminiAppLaunch(state,{cloudCodeUrl,env:{AGY_LLM_GATEWAY_URL:"https://company.example/"}}).status,"route_conflict");
  assert.equal(planGeminiAppLaunch(state,{cloudCodeUrl,env:{},managedGateway:true}).status,"route_conflict");
});
test("unsupported platforms and missing native helpers remain explicit",async()=>{
  assert.equal((await inspectGeminiApp({platform:"win32"})).status,"unsupported");
  const input=options();input.exists=file=>!file.endsWith("/agy");assert.equal((await inspectGeminiApp(input)).status,"antigravity_unavailable");
});
