import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import {inspectGeminiApp,planGeminiAppLaunch} from "../src/gemini-app.mjs";
import {launchWindowsAntigravity} from "../src/windows-antigravity-app.mjs";

const info={CFBundleIdentifier:"com.google.GeminiMacOS",CFBundleExecutable:"Gemini",CFBundleShortVersionString:"1.135.1.1291"};
const options=(metadata=info,processes="")=>{const calls=[];return {calls,platform:"darwin",exists:()=>true,exec:async(command,args)=>{calls.push({command,args});return {stdout:command.endsWith("plutil")?JSON.stringify(metadata):command.endsWith("ps")?processes:""}}}};

test("native Gemini identity and existing process are inspected without controlling it",async()=>{
  const input=options(info,"38378 "+path.join("/Applications/Gemini.app","Contents/MacOS/Gemini")+"\n38444 "+path.join("/Applications/Gemini.app","Contents/Helpers/agy"));
  const state=await inspectGeminiApp(input);assert.equal(state.status,"running");assert.deepEqual(state.pids,[38378]);
  assert.deepEqual(input.calls.map(x=>x.command),["/usr/bin/plutil","/usr/bin/codesign","/bin/ps"]);
});
test("an unrelated app is refused before signature or process checks",async()=>{
  const input=options({...info,CFBundleIdentifier:"other.app"});await assert.rejects(inspectGeminiApp(input),/identity/);assert.equal(input.calls.length,1);
});
test("the standalone macOS App is found, signed by Google and routed through its own launcher",async()=>{
  const app="/Applications/Antigravity.app";
  const input=options({CFBundleIdentifier:"com.google.antigravity",CFBundleExecutable:"Antigravity",CFBundleShortVersionString:"2.35.1"});
  input.exists=file=>file.includes("Antigravity.app");
  const state=await inspectGeminiApp(input);
  assert.equal(state.status,"stopped");
  assert.equal(state.app,app);
  assert.equal(state.helper,path.join(app,"Contents/Resources/bin/language_server"));
  assert.match(input.calls[1].args.join(" "),/com\.google\.antigravity.*certificate leaf.*EQHXZ8M8AV/);
  const plan=planGeminiAppLaunch(state,{platform:"darwin",cloudCodeUrl:"http://127.0.0.1:2026/antigravity",env:{}});
  assert.deepEqual(plan.args,["-a",app,"--env","CLOUD_CODE_URL=http://127.0.0.1:2026/antigravity"]);
  const ide=options({CFBundleIdentifier:"com.google.antigravity",CFBundleExecutable:"Electron"});
  await assert.rejects(inspectGeminiApp({...ide,app}),/identity/);
});
test("a running native app requires a separate relaunch decision",()=>{
  const plan=planGeminiAppLaunch({status:"running",pids:[38378]},{platform:"darwin",cloudCodeUrl:"http://127.0.0.1:18080/antigravity/",env:{}});
  assert.equal(plan.status,"needs_app_relaunch");assert.equal(plan.command,undefined);
});
test("a stopped app gets only a process-local route in its launch plan",()=>{
  const env={OTHER:"keep"},plan=planGeminiAppLaunch({status:"stopped",app:"/Applications/Gemini.app",pids:[]},{platform:"darwin",cloudCodeUrl:"http://127.0.0.1:18080/antigravity/",env});
  assert.equal(plan.status,"prepared");assert.deepEqual(plan.args,["-a","/Applications/Gemini.app","--env","CLOUD_CODE_URL=http://127.0.0.1:18080/antigravity/"]);assert.deepEqual(env,{OTHER:"keep"});
});
test("the trusted user's Applications folder shares the same launch boundary",()=>{
  const home=path.resolve("synthetic-home"),app=path.join(home,"Applications/Gemini.app");
  const plan=planGeminiAppLaunch({status:"stopped",app,pids:[]},{platform:"darwin",home,cloudCodeUrl:"http://127.0.0.1:2026/antigravity",env:{}});
  assert.equal(plan.status,"prepared");assert.equal(plan.args[1],app);
  assert.throws(()=>planGeminiAppLaunch({status:"stopped",app:path.join(home,"Elsewhere/Gemini.app")},{platform:"darwin",home,cloudCodeUrl:"http://127.0.0.1:2026/antigravity",env:{}}),/location/);
});
test("remote routes and overrides of existing gateways are refused",()=>{
  const state={status:"stopped",app:"/Applications/Gemini.app",pids:[]},cloudCodeUrl="http://127.0.0.1:18080/antigravity/";
  assert.throws(()=>planGeminiAppLaunch(state,{platform:"darwin",cloudCodeUrl:"https://example.test/",env:{}}),/local/);
  assert.throws(()=>planGeminiAppLaunch(state,{platform:"darwin",cloudCodeUrl:"http://127.0.0.1:0/",env:{}}),/local/);
  assert.throws(()=>planGeminiAppLaunch({...state,app:"/Applications/Other.app"},{platform:"darwin",cloudCodeUrl,env:{}}),/location/);
  assert.equal(planGeminiAppLaunch(state,{platform:"darwin",cloudCodeUrl,env:{AGY_LLM_GATEWAY_URL:"https://company.example/"}}).status,"route_conflict");
  assert.equal(planGeminiAppLaunch(state,{platform:"darwin",cloudCodeUrl,env:{},managedGateway:true}).status,"route_conflict");
});
test("unsupported platforms and missing native helpers remain explicit",async()=>{
  assert.equal((await inspectGeminiApp({platform:"linux"})).status,"unsupported");
  const input=options();input.exists=file=>path.basename(file)!=="agy";assert.equal((await inspectGeminiApp(input)).status,"antigravity_unavailable");
});

test("Windows trusts known official routing payloads and starts a detached local process", async () => {
  const app=String.raw`C:\Users\fixture\AppData\Local\Programs\Antigravity\Antigravity.exe`;
  const hashes=["fdf8a0a6af474d54301740bdf0144d95a30be3105d96a2cb39bb8086278513ac",
    "9f0aad7274795d7fbde04931d96b348dcfc5f3d81d7373e6b70aeb09307442df",
    "73ce9a2405b455a93d1f13db2ae555da50406110217a349b6dd85c377fbdb9d1"];
  const calls=[],env={SystemRoot:String.raw`C:\Windows`,Path:"fixture", HTTPS_PROXY:"http://proxy.example", GH_TOKEN:"fixture-private", NODE_OPTIONS:"fixture-private"};
  const exec=async(command,args,options)=>{calls.push({command,args,options});return {stdout:JSON.stringify([{app,version:"2.35.1",hashes,pids:[]}])};};
  const verified=await inspectGeminiApp({platform:"win32",app,env,exec});
  assert.equal(verified.status,"stopped");
  assert.equal(calls[0].options.env.CCDX_AGY_INSPECT_APP,app);
  assert.match(calls[0].args.at(-1), /Get-FileHash.*-Algorithm SHA256/);
  const route="http://127.0.0.1:2026/antigravity",plan=planGeminiAppLaunch(verified,{platform:"win32",cloudCodeUrl:route,env});
  assert.deepEqual(plan,{status:"prepared",command:app,args:[],environment:{SystemRoot:env.SystemRoot,Path:"fixture",HTTPS_PROXY:env.HTTPS_PROXY,CLOUD_CODE_URL:route}});
  let launch,unref=false;
  await launchWindowsAntigravity(plan,{spawnImpl:(command,args,options)=>{
    launch={command,args,options};
    const child=new EventEmitter();child.unref=()=>{unref=true;};queueMicrotask(()=>child.emit("spawn"));return child;
  }});
  assert.equal(launch.command,app);
  assert.equal(launch.options.detached,true);
  assert.equal(launch.options.shell,false);
  assert.equal(unref,true);
  assert.equal(planGeminiAppLaunch(verified,{platform:"win32",cloudCodeUrl:route,env:{Cloud_Code_Url:"https://work.example"}}).status,"route_conflict");
  assert.equal(planGeminiAppLaunch({...verified,wsl:true},{platform:"win32",cloudCodeUrl:route,env:{}}).status,"route_conflict");
  hashes[1]="0".repeat(64);
  assert.equal((await inspectGeminiApp({platform:"win32",app,env,exec})).status,"unverified_build");
});
