import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import { invokeAdapter } from '../test-support/adapter.mjs';

function fixture(){
 class Node{constructor(){this.children=[];this.events={};}setAttribute(){}append(...nodes){this.children.push(...nodes);}remove(){this.removed=true;}addEventListener(name,fn){this.events[name]=fn;}}
 const root=new Node(),context={document:{getElementById:()=>root,createElement:()=>new Node()},ccdxLanguage:{set(node,key){node.textContent=key;}}};
 runInNewContext(fs.readFileSync(new URL('../src/dashboard/view-boundary.js',import.meta.url),'utf8'),context);
 return {root,create:context.ccdxViewBoundary.create};
}
test('optional initialization failure stays local and retry replays the latest bounded view state',()=>{
 const f=fixture();let broken=true,applied;
 const a=f.create('usage',()=>{if(broken)throw Error('synthetic');return {draw(value){applied=value;},get data(){return applied;}};},['draw']);
 a.draw('old');a.draw('latest');assert.equal(f.root.children.length,1);
 const b=f.create('settings',()=>({draw:()=>42}),['draw']);assert.equal(b.draw(),42);
 broken=false;f.root.children[0].children[1].events.click();assert.equal(applied,'latest');assert.equal(a.data,'latest');
});
test('an asynchronous drawing rejection is contained and cleanup still runs',async()=>{
 const f=fixture();let stopped=0;
 const a=f.create('usage',()=>({draw:async()=>{throw Error('synthetic');},stopMotion:()=>{stopped++;}}),['draw','stopMotion']);
 await a.draw();a.stopMotion();assert.equal(stopped,1);assert.equal(f.root.children.length,1);
});
test('dashboard resource validators distinguish HTML, content changes and mismatched versions',async()=>{
 const headers={host:'127.0.0.1:2026'};
 const first=await invokeAdapter({}, {method:'GET',url:'/flow.js',headers});assert.equal(first.status,200);assert.match(first.headers.etag||first.headers.ETag,/^"[a-f0-9]{64}"$/);
 const etag=first.headers.etag||first.headers.ETag;
 const same=await invokeAdapter({}, {method:'GET',url:'/flow.js',headers:{...headers,'if-none-match':etag}});assert.equal(same.status,304);assert.equal(same.text,'');
 const changed=await invokeAdapter({}, {method:'GET',url:'/flow.js',headers:{...headers,'if-none-match':'"other"'}});assert.equal(changed.status,200);
 const wrong=await invokeAdapter({}, {method:'GET',url:'/flow.js?v=0.0.0',headers});assert.equal(wrong.status,409);assert.equal(wrong.headers['Cache-Control'],'no-store');
 const html=await invokeAdapter({}, {method:'GET',url:'/',headers});assert.equal(html.headers['Cache-Control'],'no-store');assert.match(html.text,/flow\.js\?v=\d+\.\d+\.\d+/);
 for(const match of html.text.matchAll(/src="(\/[a-z-]+\.js(?:\?[^\"]*)?)"/g)){
  const asset=await invokeAdapter({}, {method:'GET',url:match[1],headers});assert.equal(asset.status,200,match[1]);
  assert.match(asset.headers['Content-Type'],/javascript/);
 }
});
