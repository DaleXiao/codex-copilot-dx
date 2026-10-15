import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { Script } from "node:vm";
import { windowsPowerShellEnvironment } from "./native-prediction-windows.mjs";
import { predictionProxyExpression } from "./prediction-pac.mjs";

function failure(code) {
  return Object.assign(new Error(`Windows prediction network failed (${code}); existing company routes were preserved`), { code });
}

export function companyPredictionPac(script, port) {
  if (typeof script !== "string" || Buffer.byteLength(script) > 1024 * 1024 || !Number.isInteger(port) || port < 1 || port > 65535) throw failure("proxy_pac_invalid");
  // Compile only for syntax validation; never execute a downloaded PAC in Node.
  const combined = `var ccdxCompanyRoute=(function(){\n${script}\n;return FindProxyForURL;})();\nfunction FindProxyForURL(url,host){var original=ccdxCompanyRoute(url,host);if(url.indexOf('https:')===0&&(host==='chatgpt.com'||host==='ab.chatgpt.com'))return ${predictionProxyExpression(port)}+'; '+original;return original;}\n`;
  try { new Script(combined); } catch { throw failure("proxy_pac_invalid"); }
  return combined;
}

// One private child process, reused only by the opted-in prediction bridge.
// Credit-based response chunks bound buffering when the client reads slowly.
export async function startWindowsPredictionNetwork({ settings, env = process.env, spawnImpl = spawn, timeoutMs = 30_000, onFailure = () => {} } = {}) {
  const command = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const source = fileURLToPath(new URL("./windows-prediction-network.cs", import.meta.url));
  const child = spawnImpl(command, ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop';Add-Type -Path $env:CCDX_PREDICTION_NETWORK_SOURCE -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll;[CCDXPredictionNetwork]::Run()"],
  { env: { ...windowsPowerShellEnvironment(env), CCDX_PREDICTION_NETWORK_SOURCE: source }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  const requests = new Map();let sequence = 0, buffer = "", stopped = false, initialized = false, closing = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve;rejectReady = reject; });
  const write = value => { if (!stopped && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + "\n"); };
  const stop = error => {
    if(stopped)return;stopped=true;rejectReady(error);
    for(const req of [...requests.values()])req.destroy(error);
    child.stdin.destroy();child.kill();
    if(initialized&&!closing)onFailure(error);
  };
  child.on("error", () => stop(failure("proxy_worker_start_failed")));
  child.on("exit", () => stop(failure("proxy_worker_exited")));
  // Consume, but never retain or log compiler stderr (it can include paths).
  child.stderr.resume();child.stdin.on("error", () => stop(failure("proxy_worker_pipe_failed")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if(buffer.length > 2*1024*1024)return stop(failure("proxy_worker_output_limit"));
    let boundary;
    while((boundary=buffer.indexOf("\n"))>=0) {
      const line=buffer.slice(0,boundary);buffer=buffer.slice(boundary+1);let event;
      try{event=JSON.parse(line);}catch{return stop(failure("proxy_worker_protocol_error"));}
      if(event.type==="ready") {
        if(event.pac!==null && typeof event.pac!=="string")return stop(failure("proxy_worker_protocol_error"));
        const script=event.pac===null?null:Buffer.from(event.pac,"base64").toString("utf8").replace(/^\uFEFF/, "");
        try{if(script!==null)companyPredictionPac(script,1);}catch(error){return stop(error);}
        resolveReady(script);continue;
      }
      const req=requests.get(event.id);
      if(!req){if(event.type==="error"&&!event.id)return stop(failure(/^winhttp_[a-z0-9_]+$/.test(event.code)?event.code:"proxy_worker_failed"));continue;}
      req.frame(event);
    }
  });
  write({autoDetect:settings.autoDetect===true,pac:settings.pac||""});
  const timer=setTimeout(()=>stop(failure("proxy_wpad_timeout")),timeoutMs);
  let script;
  try{script=await ready;}catch(error){stop(error);throw error;}finally{clearTimeout(timer);}
  initialized=true;
  const requestImpl=(options,callback)=>{
    const id=++sequence;let reply,done=false,started=false,uploadCallback;
    const finish=()=>{clearTimeout(deadline);requests.delete(id);done=true;};
    const deadline=setTimeout(()=>req.destroy(failure("proxy_request_timeout")),timeoutMs);
    const start=()=>{
      if(started)return;started=true;
      const host=options.hostname;
      if(!["chatgpt.com","ab.chatgpt.com"].includes(host)||!String(options.path).startsWith("/")||String(options.path).startsWith("//"))throw failure("proxy_target_invalid");
      const headers=[];
      for(const [name,value]of Object.entries(options.headers||{})){
        if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name))throw failure("proxy_headers_invalid");
        for(const item of Array.isArray(value)?value:[value]){
          if(/[\r\n]/.test(String(item)))throw failure("proxy_headers_invalid");headers.push(`${name}: ${item}`);
        }
      }
      const headerText=headers.join("\r\n")+"\r\n";
      if(headerText.length>32768)throw failure("proxy_headers_limit");
      if(requests.size>=32)throw failure("proxy_admission_limit");
      const rawLength=options.headers?.["content-length"];
      const length=rawLength===undefined?(["GET","HEAD"].includes(options.method||"GET")?0:-1):Number(rawLength);
      if(!Number.isSafeInteger(length)||length < -1)throw failure("proxy_upload_length_invalid");
      requests.set(id,req);write({op:"request",id,url:`https://${host}${options.path}`,method:options.method||"GET",headers:headerText,length});
    };
    const req=new Writable({highWaterMark:32*1024,autoDestroy:false,
      write(chunk,_encoding,complete){
        try{start();}catch(error){complete(error);return;}
        let offset=0;
        const next=()=>{if(offset>=chunk.length){uploadCallback=undefined;complete();return;}
          const bytes=chunk.subarray(offset,offset+65536);offset+=bytes.length;
          uploadCallback=next;write({op:"upload",id,body:bytes.toString("base64")});};next();
      },
      final(complete){try{start();write({op:"upload_end",id});complete();}catch(error){complete(error);}},
      destroy(error,complete){if(!done){write({op:"cancel",id});finish();reply?.destroy(error);uploadCallback=undefined;}complete(error);},
    });
    req.setTimeout=(milliseconds,handler)=>{if(handler)req.once("timeout",handler);return req;};
    req.frame=event=>{
      deadline.refresh();
      if(event.type==="headers"){
        if(reply||typeof event.headers!=="string"||event.headers.length>65536)return req.destroy(failure("proxy_worker_protocol_error"));
        const lines=event.headers.split("\r\n"),match=/^HTTP\/\S+ (\d{3})(?: (.*))?$/.exec(lines.shift());
        if(!match)return req.destroy(failure("proxy_worker_protocol_error"));
        reply=new PassThrough({highWaterMark:32*1024});reply.statusCode=Number(match[1]);reply.statusMessage=match[2]||"";reply.headers={};
        for(const line of lines){const colon=line.indexOf(":");if(colon<1)continue;const name=line.slice(0,colon).toLowerCase(),value=line.slice(colon+1).trim();
          if(name==="set-cookie")(reply.headers[name]||=[]).push(value);else reply.headers[name]=reply.headers[name]?reply.headers[name]+", "+value:value;}
        reply.once("close",()=>{if(!done)req.destroy();});callback(reply);
      }else if(event.type==="upload_ack"){if(!uploadCallback)return req.destroy(failure("proxy_worker_protocol_error"));uploadCallback();}
      else if(event.type==="data"){
        if(!reply||typeof event.body!=="string"||event.body.length>22000)return req.destroy(failure("proxy_worker_protocol_error"));
        const ack=()=>write({op:"ack",id});if(reply.write(Buffer.from(event.body,"base64")))ack();else reply.once("drain",ack);
      }else if(event.type==="end"){if(!reply)return req.destroy(failure("proxy_worker_protocol_error"));finish();reply.end();}
      else if(event.type==="error")req.destroy(failure(/^winhttp_[a-z0-9_]+$/.test(event.code)?event.code:"proxy_request_failed"));
      else req.destroy(failure("proxy_worker_protocol_error"));
    };
    if(stopped)queueMicrotask(()=>req.destroy(failure("proxy_worker_closed")));
    return req;
  };
  return {script,requestImpl,pac:port=>companyPredictionPac(script,port),healthy:()=>!stopped,close(){closing=true;stop(failure("proxy_worker_closed"));}};
}
