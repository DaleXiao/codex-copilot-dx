import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createActivityEvents, createChangeSignal } from '../src/activity-events.mjs';
import { createStreamPerformanceMetrics } from '../src/stream-performance.mjs';
import { startAdapter } from '../src/adapter.mjs';
import { closeHttpServer } from '../src/shutdown.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const timeouts = new Map(), intervals = new Map();let reads = 0;
  const source = createChangeSignal();
  const events = createActivityEvents({ sources: [source], snapshot() { reads++;return { records: reads }; }, timers: {
    setTimeout(fn, ms) { timeouts.set(fn, ms);return fn; }, clearTimeout(fn) { timeouts.delete(fn); },
    setInterval(fn, ms) { intervals.set(fn, ms);return fn; }, clearInterval(fn) { intervals.delete(fn); },
  } });
  const flush = () => { for (const fn of [...timeouts.keys()]) { timeouts.delete(fn);fn(); } };
  return { events, source, timeouts, intervals, flush, get reads() { return reads; } };
}
test('idle publishers perform no snapshot work; subscribers share coalesced snapshots and reconnect fresh', () => {
  const f = fixture();for (let i=0;i<100;i++) f.source.changed();assert.equal(f.reads,0);
  const a=[],b=[];const off=f.events.subscribe(v=>a.push(v)), off2=f.events.subscribe(v=>b.push(v));
  f.events.subscribe(()=>{throw Error('presentation failure')});
  for(let i=0;i<1000;i++)f.source.changed();assert.equal(f.timeouts.size,1);f.flush();
  assert.equal(f.reads,4);assert.equal(a.at(-1),b.at(-1));off();off2();f.events.close();
  assert.equal(f.timeouts.size,0);f.source.changed();assert.equal(f.reads,4);
});
test('stream activity emits phase changes once, never per token, and preserves completed outcomes', () => {
  const metrics=createStreamPerformanceMetrics();let changes=0;const off=metrics.subscribe(()=>changes++);
  const r=metrics.begin('responses',{requestId:'one',application:'codex_app'});r.setModel('test');r.setProvider('github');r.upstreamStarted();r.upstreamHeaders(200);
  r.upstreamActivity();r.firstOutput();const before=changes;
  for(let i=0;i<10000;i++){r.upstreamActivity();r.firstOutput();}assert.equal(changes,before);
  r.terminal('completed',{origin:'upstream_response'});r.finish({statusCode:200});
  const snapshot=metrics.activitySnapshot();assert.equal(snapshot.active_total,0);assert.equal(snapshot.by_route.responses.terminal_outcomes.totals.completed,1);
  assert.equal(snapshot.recent_requests[0].outcome,'completed');assert.equal(snapshot.by_route.responses.ttft_ms,undefined);
  off();
});
class Response extends EventEmitter {
  writes=[];statusCode=0;ended=false;blocked=false;
  writeHead(status,headers){this.statusCode=status;this.headers=headers;}
  write(value){this.writes.push(value);return !this.blocked;}
  end(){this.ended=true;this.emit('close');}
  destroy(){this.destroyed=true;this.ended=true;this.emit('close');}
}
test('slow consumers retain only the latest snapshot; heartbeats and shutdown clean up owned streams', () => {
  const f=fixture(),res=new Response();f.events.serve({},res);assert.equal(res.statusCode,200);
  res.blocked=true;f.source.changed();f.flush();const count=res.writes.length;
  for(let i=0;i<100;i++){f.source.changed();f.flush();}assert.equal(res.writes.length,count);
  res.blocked=false;res.emit('drain');assert.equal(res.writes.length,count+1);assert.match(res.writes.at(-1),/"records":102/);
  const heartbeat=[...f.intervals.keys()][0];heartbeat();assert.match(res.writes.at(-1),/^event: heartbeat/);
  f.events.close();assert.equal(res.ended,true);assert.equal(f.intervals.size,0);assert.equal(f.timeouts.size,0);
});
test('a blocked connection is disconnected at its heartbeat rather than growing a queue',()=>{
  const f=fixture(),res=new Response();res.blocked=true;f.events.serve({},res);
  [...f.intervals.keys()][0]();assert.equal(res.ended,true);assert.equal(f.intervals.size,0);f.events.close();
});
test('stream subscribers are capped and released on browser disconnect',()=>{
  const f=fixture(),responses=Array.from({length:9},()=>new Response());
  responses.forEach(res=>f.events.serve({},res));assert.equal(responses[8].statusCode,503);
  responses[0].emit('close');const next=new Response();f.events.serve({},next);assert.equal(next.statusCode,200);f.events.close();
});

async function openStream(url, headers = {}) {
  return new Promise((resolve,reject)=>{
    const request=http.get(url,{headers,agent:false},response=>{
      const iterator=response[Symbol.asyncIterator]();
      resolve({status:response.statusCode,reader:{read:()=>iterator.next()},close:()=>{response.destroy();request.destroy();}});
    });request.on('error',reject);
  });
}
async function nextEvent(reader) {
  let text='';
  for (;;) { const {value,done}=await reader.read();assert.equal(done,false);text+=new TextDecoder().decode(value);const at=text.indexOf('data: ');const end=text.indexOf('\n\n',at);if(at>=0&&end>=0)return JSON.parse(text.slice(at+6,end)); }
}
test('real HTTP SSE excludes itself from work, rejects foreign origins, resyncs and exits without forced shutdown',async t=>{
  const claude=createStreamPerformanceMetrics({routeNames:['messages']});let fullReads=0;
  const server=await startAdapter(0,'127.0.0.1',{terminalActivity:{beginRequest:()=>()=>{}},providerRuntime:{claudePerformance:claude,snapshot(){fullReads++;return {};}}});
  t.after(()=>closeHttpServer(server));const base=`http://127.0.0.1:${server.address().port}`;
  const bad=await openStream(base+'/_ccdx/activity',{Origin:'https://example.test'});assert.equal(bad.status,403);bad.close();
  const stream=await openStream(base+'/_ccdx/activity');assert.equal(stream.status,200);
  const reader=stream.reader,first=await nextEvent(reader);assert.equal(first.model_activity.active,0);assert.equal(first.requests.total,0);assert.equal(fullReads,0);assert.equal(server.ccdxBusy(),false);
  const tui=[];const off=server.ccdxSubscribeActivity(value=>tui.push(value));
  const request=claude.begin('messages',{requestId:'background-task',application:'claude_app'});request.setModel('claude-test');request.setProvider('m365');request.upstreamStarted();
  const active=await nextEvent(reader);assert.equal(active.providers.claude.requests.performance.active_total,1);
  assert.equal(tui.at(-1).providers.claude.requests.performance.active_total,1);
  stream.close();await wait(5);
  request.terminal('completed',{origin:'upstream_response'});request.finish({statusCode:200});await wait(65);off();
  const again=await openStream(base+'/_ccdx/activity');const resumed=await nextEvent(again.reader);
  assert.equal(resumed.providers.claude.requests.performance.active_total,0);assert.equal(resumed.providers.claude.requests.performance.by_route.messages.terminal_outcomes.totals.completed,1);
  assert.equal(resumed.providers.claude.requests.performance.recent_requests[0].request_id,'background-task');assert.equal(fullReads,0);
  const ended=await closeHttpServer(server,{timeoutMs:1000});assert.equal(ended.forced,false);again.close();
});
