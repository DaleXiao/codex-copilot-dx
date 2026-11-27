import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {execFile,spawn} from "node:child_process";
import {promisify} from "node:util";
import { inspectWindowsAntigravity, windowsAntigravityEnvironment, windowsAntigravityPath } from "./windows-antigravity-app.mjs";
import { googleMacTeam, macAntigravityBundles, macAntigravityBundlePaths } from "./macos-antigravity-app.mjs";
import { readBoundedFile } from "./bounded-file.mjs";

const execute=promisify(execFile);

export async function hasManagedAntigravityGateway({platform=process.platform,env=process.env,readFile=readBoundedFile}={}) {
  const directory=platform==="win32"?Object.entries(env).find(([key])=>key.toLowerCase()==="programdata")?.[1]:null;
  const file=platform==="darwin"?"/Library/Application Support/Antigravity/admin_settings.json":
    directory&&path.win32.join(directory,"Antigravity","admin_settings.json");
  if(!file)return false;
  try {
    const raw=await readFile(file,{maxBytes:1024*1024,encoding:"utf8"});
    const value=JSON.parse(raw.replace(/^\uFEFF/,""));
    return value?.gateway?.enabled===true;
  } catch(error) {
    if(error.code==="ENOENT")return false;
    throw new Error("Could not read the Antigravity managed gateway settings");
  }
}

export async function inspectGeminiApp({platform=process.platform,app,standalone=false,home=os.homedir(),env=process.env,exec=execute,exists=fs.existsSync}={}) {
  if(platform==="win32"){
    const state=await inspectWindowsAntigravity({env,exec,app});
    return !app&&state.app?inspectWindowsAntigravity({env,exec,app:state.app}):state;
  }
  if(platform!=="darwin")return {status:"unsupported"};
  app??=macAntigravityBundlePaths(home).find(candidate=>(!standalone||path.basename(candidate)==="Antigravity.app")&&exists(path.join(candidate,"Contents/Info.plist")));
  if(!app)return {status:"not_installed"};
  const bundle=macAntigravityBundles[path.basename(app)];
  if(!bundle)throw new Error("Unrecognized Antigravity App identity");
  const metadata=path.join(app,"Contents/Info.plist");
  if(!exists(metadata))return {status:"not_installed"};
  const result=await exec("/usr/bin/plutil",["-convert","json","-o","-",metadata],{encoding:"utf8",timeout:3000,maxBuffer:65536});
  const info=JSON.parse(String(result.stdout??result));
  if(info.CFBundleIdentifier!==bundle.identifier||info.CFBundleExecutable!==bundle.executable)throw new Error("Unrecognized Antigravity App identity");
  const helper=path.join(app,bundle.helper);
  if(!exists(helper))return {status:"antigravity_unavailable"};
  await exec("/usr/bin/codesign",["--verify","--deep","--strict","-R",
    `=identifier "${bundle.identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${googleMacTeam}"`,app],{encoding:"utf8",timeout:15000,maxBuffer:65536});
  const executable=path.join(app,"Contents/MacOS",bundle.executable);
  const processes=await exec("/bin/ps",["-axo","pid=,comm="],{encoding:"utf8",timeout:3000,maxBuffer:4*1024*1024});
  const pids=String(processes.stdout??processes).split("\n").flatMap(line=>{const match=/^\s*(\d+)\s+(.+?)\s*$/.exec(line);return match?.[2]===executable?[Number(match[1])]:[]});
  return {status:pids.length>1?"multiple":pids.length?"running":"stopped",app,executable,helper,version:info.CFBundleShortVersionString,pids};
}

export function launchAntigravityGatewayApp(verified, gateway, { platform=process.platform,env=process.env,spawnImpl=spawn }={}) {
  const executable=verified.executable;
  const directory=platform==="win32"?path.win32.dirname(executable):path.dirname(executable);
  const inherited=platform==="win32"?windowsAntigravityEnvironment(env):
    Object.fromEntries(Object.entries(env).filter(([name])=>/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_.*|TZ|(?:HTTP|HTTPS|ALL|NO)_PROXY)$/i.test(name)));
  return new Promise((resolve,reject)=>{
    const child=spawnImpl(executable,[],{cwd:directory,env:{...inherited,...gateway.environment},detached:true,stdio:"ignore",shell:false});
    child.once("error",reject);
    child.once("exit",gateway.close);
    child.once("spawn",()=>{child.unref();resolve(child.pid);});
  });
}

// A launch plan is reviewable without changing files, credentials, or running apps.
// A prepared environment is not evidence that the App has adopted the route.
export function planGeminiAppLaunch(state,{cloudCodeUrl,env=process.env,home=os.homedir(),platform=process.platform,managedGateway=false}={}) {
  if(!["running","stopped","multiple"].includes(state?.status))return {status:state?.status||"unknown"};
  if(state.status==="stopped"&&!(platform==="win32"?windowsAntigravityPath(state.app):
    macAntigravityBundlePaths(home).includes(state.app)))throw new Error("Unrecognized Gemini App location");
  const url=cloudCodeUrl===undefined?null:new URL(cloudCodeUrl);
  if(url&&(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!url.port||Number(url.port)<1||url.username||url.password||url.search||url.hash))throw new Error("Gemini route must use a local CCDX endpoint");
  if(url&&(managedGateway||platform==="win32"&&state.wsl||Object.entries(env).some(([name,value])=>{
    const key=name.toUpperCase();
    return Boolean(value)&&(key.startsWith("AGY_LLM_GATEWAY_")||key==="CLOUD_CODE_URL"&&value!==url.href||platform==="win32"&&key==="ANTIGRAVITY_WSL_DISTRO");
  })))return {status:"route_conflict"};
  if(state.status!=="stopped")return {status:state.status==="multiple"?"multiple":"needs_app_relaunch",pids:[...state.pids]};
  if(platform==="win32")return {status:"prepared",command:state.app,args:[],environment:windowsAntigravityEnvironment(env,url?.href)};
  return {status:"prepared",command:"/usr/bin/open",args:["-a",state.app,...(url?["--env","CLOUD_CODE_URL="+url.href]:[])]};
}
