import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiTokenCounter } from '../src/providers/api-token-count.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
const body = { model: 'example-model', messages: [{ role: 'user', content: 'synthetic' }] };

test('identical counts share one call and return independently readable responses', async () => {
 let release, calls = 0;const observations = [];
 const counter = createApiTokenCounter({ request: async (value, options) => {
  calls++;assert.deepEqual(JSON.parse(options.bodyText), value);options.onUpstreamStart();
  await new Promise(resolve => { release = resolve; });return Response.json({ input_tokens: 7 });
 } });
 const jobs = Array.from({ length: 8 }, () => counter.count(body, { onCountObservation: value => observations.push(value) }));
 await turn();assert.equal(calls, 1);release();
 for(const response of await Promise.all(jobs))assert.deepEqual(await response.json(), { input_tokens: 7 });
 assert.equal(observations.filter(value => value.upstream).length, 8);
 const again = counter.count(body);await turn();assert.equal(calls, 2);release();await again;
});

test('cancelling one count waiter leaves another alive; all waiters abort the shared call', async () => {
 let release, signal;
 const counter = createApiTokenCounter({ request: async (_body, options) => {
  signal=options.signal;options.onUpstreamStart();await new Promise((resolve, reject) => {
   release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });return Response.json({ input_tokens: 1 });
 } });
 const a=new AbortController(),b=new AbortController();
 const one=counter.count(body,{signal:a.signal}),two=counter.count(body,{signal:b.signal});await turn();
 const rejected=assert.rejects(one,{name:'AbortError'});a.abort();await rejected;assert.equal(signal.aborted,false);
 release();assert.equal((await two).status,200);
 const c=new AbortController(),three=counter.count(body,{signal:c.signal});await turn();
 const cancelled=assert.rejects(three,{name:'AbortError'});c.abort();await cancelled;assert.equal(signal.aborted,true);
});

test('a 404 is scoped to model and beta headers, expires, and does not cross provider instances', async () => {
 let now=1000,calls=0;const run=async()=>{calls++;return new Response('safe',{status:404});};
 const counter=createApiTokenCounter({request:run,now:()=>now});
 assert.equal((await counter.count(body)).status,404);
 let evidence;assert.equal((await counter.count({...body,messages:[]} ,{onCountObservation:v=>{evidence=v;}})).status,404);
 assert.deepEqual(evidence,{cached:true});assert.equal(calls,1);
 await counter.count({...body,model:'other'});await counter.count(body,{headers:{'anthropic-beta':'beta'}});assert.equal(calls,3);
 now+=60000;await counter.count(body);assert.equal(calls,4);
 await createApiTokenCounter({request:run}).count(body);assert.equal(calls,5);
});

for(const status of [401,403,405,429,500,503])test(`count HTTP ${status} retains status and Retry-After without a capability cache`,async()=>{
 let calls=0;const counter=createApiTokenCounter({request:async()=>{calls++;return Response.json({error:{code:'safe_error'}},{status,headers:{'Retry-After':'42'}});}});
 for(let i=0;i<2;i++){const response=await counter.count(body);assert.equal(response.status,status);assert.equal(response.headers.get('retry-after'),'42');assert.equal((await response.json()).error.code,'safe_error');}
 assert.equal(calls,2);
});

test('different bodies are never coalesced; oversized count responses are rejected',async()=>{
 let calls=0;const counter=createApiTokenCounter({request:async()=>{calls++;return Response.json({input_tokens:2});}});
 await Promise.all([counter.count(body),counter.count({...body,messages:[]})]);assert.equal(calls,2);
 const large=createApiTokenCounter({request:async()=>new Response('x'.repeat(65537))});
 await assert.rejects(large.count(body),/limit|large|exceed/i);
});

test('an immediate new count after all cancellations never inherits an abandoned shared operation',async()=>{
 let calls=0,starts=0;
 const counter=createApiTokenCounter({request:async(_body,options)=>{
  calls++;options.onUpstreamStart();
  if(calls===1)await new Promise((_r,reject)=>{options.signal.addEventListener('abort',()=>setImmediate(()=>reject(options.signal.reason)),{once:true});});
  return Response.json({input_tokens:3});
 }});
 const controller=new AbortController(),old=counter.count(body,{signal:controller.signal});await turn();
 const cancelled=assert.rejects(old,{name:'AbortError'});controller.abort();
 const fresh=counter.count(body,{onUpstreamStart(){starts++;}});await cancelled;
 assert.equal((await fresh).status,200);assert.equal(starts,1);assert.equal(calls,2);
 assert.equal((await counter.count(body)).status,200);assert.equal(calls,3);
});

test('a cold unsupported model joins distinct count inputs before the first 404', async () => {
 let calls=0,release;const wait=new Promise(r=>{release=r;});
 const counter=createApiTokenCounter({request:async(_body,options)=>{calls++;options.onUpstreamStart();await wait;return new Response(null,{status:404});}});
 const inputs=Array.from({length:16},(_,i)=>counter.count({...body,messages:[{role:'user',content:'synthetic-'+i}]}));
 await turn();assert.equal(calls,1);release();
 for(const reply of await Promise.all(inputs))assert.equal(reply.status,404);
 assert.equal(calls,1);
});

test('successful capability discovery never reuses counts across different bodies',async()=>{
 let calls=0;
 const counter=createApiTokenCounter({request:async(value,options)=>{calls++;options.onUpstreamStart();return Response.json({input_tokens:value.messages[0].content.length});}});
 const results=await Promise.all([1,3,8,15].map(n=>counter.count({...body,messages:[{role:'user',content:'x'.repeat(n)}]})));
 assert.deepEqual(await Promise.all(results.map(async x=>(await x.json()).input_tokens)),[1,3,8,15]);assert.equal(calls,4);
});

test('a cancelled first capability caller leaves a different waiting input alive',async()=>{
 let release,calls=0,sharedSignal;
 const counter=createApiTokenCounter({request:async(value,options)=>{calls++;options.onUpstreamStart();if(calls===1){sharedSignal=options.signal;await new Promise(r=>{release=r;});}return Response.json({input_tokens:value.messages.length});}});
 const a=new AbortController(),one=counter.count(body,{signal:a.signal}),two=counter.count({...body,messages:[]});await turn();
 const cancelled=assert.rejects(one,{name:'AbortError'});a.abort();await cancelled;assert.equal(sharedSignal.aborted,false);release();
 assert.equal((await(await two).json()).input_tokens,0);assert.equal(calls,2);
});

test('large admitted counts also wait for a cold capability without sharing unrelated successful counts',async()=>{
 let calls=0;const counter=createApiTokenCounter({request:async()=>{calls++;await turn();return new Response(null,{status:404});}});
 const inputs=[1,2,3].map(i=>counter.count({...body,messages:[{role:'user',content:'x'.repeat(2*1024*1024)+i}]}));
 assert.ok((await Promise.all(inputs)).every(x=>x.status===404));assert.equal(calls,1);
});
