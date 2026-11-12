import fs from "node:fs";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execute=promisify(execFile);

export async function inspectGeminiApp({platform=process.platform,app="/Applications/Gemini.app",exec=execute,exists=fs.existsSync}={}) {
  if(platform!=="darwin")return {status:"unsupported"};
  const metadata=path.join(app,"Contents/Info.plist");
  if(!exists(metadata))return {status:"not_installed"};
  const result=await exec("/usr/bin/plutil",["-convert","json","-o","-",metadata],{encoding:"utf8",timeout:3000,maxBuffer:65536});
  const info=JSON.parse(String(result.stdout??result));
  if(info.CFBundleIdentifier!=="com.google.GeminiMacOS"||info.CFBundleExecutable!=="Gemini")throw new Error("Unrecognized Gemini App identity");
  const helper=path.join(app,"Contents/Helpers/agy");
  if(!exists(helper))return {status:"antigravity_unavailable"};
  await exec("/usr/bin/codesign",["--verify","--deep","--strict","-R",'=identifier "com.google.GeminiMacOS" and anchor apple generic',app],{encoding:"utf8",timeout:15000,maxBuffer:65536});
  const executable=path.join(app,"Contents/MacOS/Gemini");
  const processes=await exec("/bin/ps",["-axo","pid=,comm="],{encoding:"utf8",timeout:3000,maxBuffer:4*1024*1024});
  const pids=String(processes.stdout??processes).split("\n").flatMap(line=>{const match=/^\s*(\d+)\s+(.+?)\s*$/.exec(line);return match?.[2]===executable?[Number(match[1])]:[]});
  return {status:pids.length>1?"multiple":pids.length?"running":"stopped",app,executable,helper,version:info.CFBundleShortVersionString,pids};
}

// A launch plan is reviewable without changing files, credentials, or running apps.
// A prepared environment is not evidence that the App has adopted the route.
export function planGeminiAppLaunch(state,{cloudCodeUrl,env=process.env,managedGateway=false}={}) {
  if(!["running","stopped","multiple"].includes(state?.status))return {status:state?.status||"unknown"};
  if(state.status==="stopped"&&state.app!=="/Applications/Gemini.app")throw new Error("Unrecognized Gemini App location");
  const url=new URL(cloudCodeUrl);
  if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!url.port||Number(url.port)<1||url.username||url.password||url.search||url.hash)throw new Error("Gemini route must use a local CCDX endpoint");
  if(managedGateway||Object.entries(env).some(([key,value])=>key.startsWith("AGY_LLM_GATEWAY_")&&value)||env.CLOUD_CODE_URL&&env.CLOUD_CODE_URL!==url.href)return {status:"route_conflict"};
  if(state.status!=="stopped")return {status:state.status==="multiple"?"multiple":"needs_app_relaunch",pids:[...state.pids]};
  return {status:"prepared",command:"/usr/bin/open",args:["-a",state.app,"--env","CLOUD_CODE_URL="+url.href]};
}
