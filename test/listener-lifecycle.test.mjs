import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("a live child process does not retain the closed service listener", { timeout: 10000 }, async t => {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject);server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  t.after(() => server.close());
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  t.after(async () => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;const ended = once(child, "exit");child.kill();await ended; });
  await once(child, "spawn");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const replacement = http.createServer();t.after(() => replacement.close());
  await new Promise((resolve, reject) => { replacement.once("error", reject);replacement.listen(port, "127.0.0.1", resolve); });
  assert.equal(child.exitCode, null);assert.equal(replacement.address().port, port);
});

test('a handed-back listener disposes optional tools on every close', async () => {
 const {startAdapter}=await import('../src/adapter.mjs');const {closeHttpServer}=await import('../src/shutdown.mjs');let disposed=0;
 const server=await startAdapter(0,'127.0.0.1',{log:()=>{},dashboardOptions:{accountTools:{snapshot:()=>({source:'account_tools'}),dispose(){disposed++;}}}});
 try{
  for(let i=0;i<2;i++){
   if(i)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   const result=await fetch(`http://127.0.0.1:${server.address().port}/_ccdx/ui/account`,{headers:{'x-ccdx-dashboard':'1'}});assert.equal(result.status,200);await result.text();
   await closeHttpServer(server);assert.equal(disposed,i+1);
  }
 }finally{await closeHttpServer(server);}
});
