// Real browser/SSE replay; synthetic observers only, no accounts or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createAdapterHandler} from '../src/adapter.mjs';
import {createRequestMetrics} from '../src/observability.mjs';
import {createStreamPerformanceMetrics} from '../src/stream-performance.mjs';
import {createTerminalConsole} from '../src/terminal-console.mjs';
import {closeHttpServer} from '../src/shutdown.mjs';
const options=new Map();for(let i=2;i<process.argv.length;i+=2)options.set(process.argv[i],process.argv[i+1]);
const module=await import(pathToFileURL(options.get('--playwright')).href);const playwright=module.default||module;
const home=await fs.mkdtemp(path.join(os.tmpdir(),'ccdx-activity-browser-'));
const metrics=createRequestMetrics(),codex=createStreamPerformanceMetrics(),claude=createStreamPerformanceMetrics({routeNames:['messages']});
const handler=createAdapterHandler({requestMetrics:metrics,streamPerformanceMetrics:codex,terminalActivity:{beginRequest:()=>()=>{}},providerRuntime:{claudePerformance:claude,snapshot:()=>({})},
  dashboardOptions:{home,env:{},providerStateFn:()=>[],connectionsFn:()=>({source:'connections',providers:[],clients:[],managed:false}),authStatusFn:()=>({profiles:{codex:{configured:false,valid:false}}})}});
let subscriptions=0;const responses=new Set();
const server=http.createServer((req,res)=>{if(req.url==='/_ccdx/activity'){subscriptions++;responses.add(res);res.once('close',()=>responses.delete(res));}return handler(req,res)});
server.ccdxCloseActivity=handler.closeActivity;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,writes=[];
const terminal=createTerminalConsole({env:{NO_COLOR:''},snapshot:handler.snapshot,subscribe:handler.subscribeActivity,output:{isTTY:true,columns:100,rows:30,write:v=>writes.push(v)},errorOutput:{isTTY:true}});terminal.start();
function begin(application,model,route){const complete=metrics.begin(route),r=(route==='messages'?claude:codex).begin(route,{requestId:model,application});r.setProvider(route==='messages'?'m365':'github');r.setModel(model);r.upstreamStarted();r.firstOutput();r.upstreamActivity();return()=>{r.terminal('completed',{origin:'upstream_response'});r.finish({statusCode:200});complete({statusCode:200})}}
let browser;const receipts=[];
try{
 for(const engine of (options.get('--engines')||'chromium').split(',')){
  browser=await playwright[engine].launch({headless:true,...(options.get('--channel')?{channel:options.get('--channel')} : {}),...(options.get('--'+engine)?{executablePath:options.get('--'+engine)}:{})});
  console.log(`Activity replay: ${engine}`);
  const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(15000);const watchdog=setTimeout(()=>{console.error(`Activity replay timed out: ${engine}`);process.exit(1)},120000);watchdog.unref();
  await page.goto(base+'/#requests');await page.waitForFunction(()=>document.querySelector('#request-flow').dataset.state==='idle',{timeout:10000});
  const finish=[begin('codex_app','gpt-one','responses'),begin('claude_app','claude-two','messages'),begin('claude_code','claude-three','messages')];
  await page.waitForFunction(()=>document.querySelector('#request-flow').dataset.state==='active'&&document.querySelector('#flow-models').children.length===3);
  assert.match(writes.at(-1),/Active/);if(options.get('--output'))await page.screenshot({path:options.get('--output'),fullPage:true});
  await page.locator('[data-route=overview]').click();await page.locator('#refresh').click();
  await page.waitForTimeout(6500);assert.equal(await page.locator('#model-activity').getAttribute('data-state'),'active','manual summary refresh cannot reinstate the 6s expiry on healthy SSE');
  await page.locator('[data-route=requests]').click();await page.waitForFunction(()=>document.querySelector('#request-flow').dataset.state==='active');
  await context.setOffline(true);for(const res of responses)res.destroy();await page.waitForFunction(()=>document.querySelector('#model-activity').dataset.state==='unknown');for(const end of finish)end();await page.waitForTimeout(150);
  assert.match(writes.at(-1),/Idle/);
  await context.setOffline(false);for(const res of responses)res.end();
  await page.waitForFunction(()=>document.querySelector('#request-flow').dataset.state==='idle',{timeout:15000});
  assert.equal(await page.locator('#model-activity').getAttribute('data-state'),'idle');
  await page.locator('#auto-refresh').click();const before=subscriptions;const end=begin('claude_app','paused-model','messages');await page.waitForTimeout(200);assert.equal(subscriptions,before);
  await page.locator('#auto-refresh').click();await page.waitForFunction(()=>document.querySelector('#request-flow').dataset.state==='active');end();await page.waitForFunction(()=>document.querySelector('#request-flow').dataset.state==='idle');
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
  await page.waitForTimeout(100);assert.equal(responses.size,0);const hidden=subscriptions;
  await page.waitForTimeout(100);assert.equal(subscriptions,hidden);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'))});
  await page.waitForFunction(()=>document.querySelector('#request-flow').dataset.state==='idle');assert.deepEqual(errors,[]);
  receipts.push({engine,concurrent_apps:3,concurrent_models:3,long_stream:true,reconnect:true,pause:true,hidden_page:true,page_errors:errors.length});
  await context.close();await browser.close();browser=null;clearTimeout(watchdog);
 }
 console.log(JSON.stringify(receipts));
}finally{await browser?.close();terminal.cleanup();await closeHttpServer(server);handler.cleanup();await fs.rm(home,{recursive:true,force:true})}
