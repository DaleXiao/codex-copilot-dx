import { spawn } from "node:child_process";
import { privateHelperEnvironment } from "../src/private-helper-environment.mjs";
import path from "node:path";
import { windowsPowerShellEnvironment } from "../src/windows-process.mjs";
const command=path.win32.join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
async function probe(name,script,input,filtered=true){
 const start=Date.now();let output="",errors="",timeout=false,exitCode=null,finish;
 const child=spawn(command,["-NoProfile","-NonInteractive","-Command",script],{env:filtered==="windows"?windowsPowerShellEnvironment(Object.fromEntries(Object.entries(process.env).filter(([k])=>Object.hasOwn(privateHelperEnvironment(process.env),k)||/^(?:USERNAME|USERDOMAIN|COMPUTERNAME|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|PROGRAMDATA|ALLUSERSPROFILE|OS|PROCESSOR_ARCHITECTURE|PATHEXT|COMSPEC)$/i.test(k)))):filtered?privateHelperEnvironment(process.env):process.env,windowsHide:true,stdio:["pipe","pipe","pipe"],shell:false});
 child.stdin.on("error",()=>{});child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
 child.stdout.on("data",x=>{output+=x;if(output.length>4096)child.kill();});child.stderr.on("data",x=>{errors+=x;if(errors.length>4096)child.kill();});
 child.once("exit",code=>{exitCode=code;});
 const done=new Promise(resolve=>{finish=resolve;child.once("error",()=>resolve({spawn_error:true}));child.once("close",(code,signal)=>resolve({code,signal}));});
 const timer=setTimeout(()=>{timeout=true;child.kill();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();finish({exitCode});},5000);
 child.stdin.end(input);const result=await done;clearTimeout(timer);
 console.log(JSON.stringify({name,...result,timeout,elapsed_ms:Date.now()-start,stdout_bytes:output.length,stderr_bytes:errors.length,stages:output.replace(/[^0-9;]/g,""),reply:output.trim()==="probe"?"probe":/^\d+$/.test(output.trim())?"number":output.length?"other":"empty",error_kind:/ParserError/.test(errors)?"parser":/Exception/.test(errors)?"exception":/module/i.test(errors)?"module":"none"}));
}
const pure = "$ErrorActionPreference='Stop';[Console]::Write('1;');$null=[Reflection.Assembly]::LoadWithPartialName('System.Security');[Console]::Write('2;');$s=[Console]::In.ReadLine();[Console]::Write('3;');$b=[Text.Encoding]::UTF8.GetBytes($s);[Console]::Write('4;');$c=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write('5;');[Console]::Write($c.Length)";
await probe("dpapi_stages_filtered",pure,"synthetic-probe-token\n");
await probe("dpapi_stages_full",pure,"synthetic-probe-token\n",false);
const secure = "$ErrorActionPreference='Stop';[Console]::Write('1;');$s=[Console]::In.ReadLine();[Console]::Write('2;');$s=ConvertTo-SecureString $s -AsPlainText -Force;[Console]::Write('3;');$c=ConvertFrom-SecureString $s;[Console]::Write('4;');[Console]::Write($c.Length)";
await probe("secure_stages_filtered",secure,"synthetic-probe-token\n","windows");
