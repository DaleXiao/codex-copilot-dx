import { spawn } from "node:child_process";
import { privateHelperEnvironment } from "../src/private-helper-environment.mjs";
import path from "node:path";
const command=path.win32.join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
async function probe(name,script,input,filtered=true){
 const start=Date.now();let output="",errors="",timeout=false,exitCode=null,finish;
 const child=spawn(command,["-NoProfile","-NonInteractive","-Command",script],{env:filtered?privateHelperEnvironment(process.env):process.env,windowsHide:true,stdio:["pipe","pipe","pipe"],shell:false});
 child.stdin.on("error",()=>{});child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
 child.stdout.on("data",x=>{output+=x;if(output.length>4096)child.kill();});child.stderr.on("data",x=>{errors+=x;if(errors.length>4096)child.kill();});
 child.once("exit",code=>{exitCode=code;});
 const done=new Promise(resolve=>{finish=resolve;child.once("error",()=>resolve({spawn_error:true}));child.once("close",(code,signal)=>resolve({code,signal}));});
 const timer=setTimeout(()=>{timeout=true;child.kill();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();finish({exitCode});},5000);
 child.stdin.end(input);const result=await done;clearTimeout(timer);
 console.log(JSON.stringify({name,...result,timeout,elapsed_ms:Date.now()-start,stdout_bytes:output.length,stderr_bytes:errors.length,reply:output.trim()==="probe"?"probe":/^\d+$/.test(output.trim())?"number":output.length?"other":"empty",error_kind:/ParserError/.test(errors)?"parser":/Exception/.test(errors)?"exception":/module/i.test(errors)?"module":"none"}));
}
const utf8="[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);";
await probe("write_filtered","[Console]::Write('probe')","");
await probe("write_full","[Console]::Write('probe')","",false);
await probe("read_line","$s=[Console]::In.ReadLine();[Console]::Write($s.Length)","synthetic-probe-token\n");
await probe("read_utf8",utf8+"$s=[Console]::In.ReadLine();[Console]::Write($s.Length)","synthetic-probe-token\n");
await probe("secure_string_utf8",utf8+"$s=ConvertTo-SecureString ([Console]::In.ReadLine()) -AsPlainText -Force;$c=ConvertFrom-SecureString $s;[Console]::Write($c.Length)","synthetic-probe-token\n");
await probe("to_secure_filtered",utf8+"$s=ConvertTo-SecureString ([Console]::In.ReadLine()) -AsPlainText -Force;[Console]::Write($s.Length)","synthetic-probe-token\n");
await probe("secure_string_full",utf8+"$s=ConvertTo-SecureString ([Console]::In.ReadLine()) -AsPlainText -Force;$c=ConvertFrom-SecureString $s;[Console]::Write($c.Length)","synthetic-probe-token\n",false);
const dpapi="Add-Type -AssemblyName System.Security;$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadLine());$c=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write($c.Length)";
await probe("dpapi_filtered",utf8+dpapi,"synthetic-probe-token\n");
await probe("dpapi_full",utf8+dpapi,"synthetic-probe-token\n",false);
