import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../src/dashboard/live.js',import.meta.url),'utf8');
const create=runInNewContext(source+'\nccdxLive.create',{ });
const snapshot=(active=1)=>({scope:'activity',ok:true,name:'codex-copilot-dx',model_activity:{active},stream_performance:{active_requests:[]}});
function fixture(){
 let visible=true;const sockets=[],applied=[],states=[],timers=new Map();let ticks=0;
 const api=create({visible:()=>visible,apply:d=>applied.push(d),state:s=>states.push(s),tick:()=>ticks++,setTimer(fn,ms){timers.set(fn,ms);return fn},clearTimer(fn){timers.delete(fn)},eventSource:url=>{const s={url,events:{},closed:false,addEventListener(n,fn){this.events[n]=fn},close(){this.closed=true}};sockets.push(s);return s}});
 const send=(data,s=sockets.at(-1))=>s.events.activity({data:JSON.stringify(data)});
 return {api,sockets,applied,states,timers,send,get ticks(){return ticks},visible(v){visible=v;api.sync()}};
}
test('one stream supplies activity and a local clock; heartbeat keeps long requests live',()=>{
 const f=fixture();f.api.sync();f.api.sync();assert.equal(f.sockets.length,1);f.send(snapshot());assert.equal(f.states.at(-1),'live');
 const clock=[...f.timers].find(([,ms])=>ms===1000)[0];f.timers.delete(clock);clock();assert.equal(f.ticks,1);assert.equal(f.sockets.length,1);
 f.sockets[0].events.heartbeat();assert.equal(f.applied.length,1);assert.equal([...f.timers.values()].includes(45000),true);
 f.send(snapshot(0));assert.equal([...f.timers.values()].includes(1000),false);f.api.suspend();assert.equal(f.timers.size,0);
});
test('disconnect never means idle; a new snapshot replaces counts without replay or stale overwrites',()=>{
 const f=fixture();f.api.sync();f.send(snapshot());f.sockets[0].onerror();assert.equal(f.states.at(-1),'connecting');assert.equal(f.api.current,null);
 f.send(snapshot(0));assert.equal(f.api.current.model_activity.active,0);assert.equal(f.applied.length,2);
 const old=f.sockets[0];f.visible(false);assert.equal(old.closed,true);assert.equal(f.timers.size,0);f.visible(true);assert.equal(f.sockets.length,2);
 f.send(snapshot(9),old);assert.equal(f.applied.length,2);f.send(snapshot(2));assert.equal(f.api.current.model_activity.active,2);
 f.api.setAutomatic(false);assert.equal(f.sockets[1].closed,true);assert.equal(f.timers.size,0);f.api.resume();assert.equal(f.sockets.length,2);
});
test('silent connection timeout reconnects and invalid data cannot invent idle state',()=>{
 const f=fixture();f.api.sync();f.send(snapshot());const expiry=[...f.timers].find(([,ms])=>ms===45000)[0];f.timers.delete(expiry);expiry();
 assert.equal(f.sockets[0].closed,true);assert.equal(f.sockets.length,2);assert.equal(f.states.at(-1),'connecting');
 f.send({scope:'activity',model_activity:{active:-1}});assert.equal(f.api.current,null);f.api.suspend();
});
