import test from 'node:test';
import assert from 'node:assert/strict';
import { statusSummary } from '../src/status-summary.mjs';
import { invokeAdapter } from '../test-support/adapter.mjs';

test('summary is explicitly scoped, small, and never mutates the complete diagnostic data', () => {
 const snapshot={ok:true,name:'codex-copilot-dx',version:'test',pid:42,uptime_ms:1,model_activity:{active:3},runtime_usage:{records:4},
  providers:{m365:{requests:{recent:Array.from({length:200},(_,i)=>({id:i,detail:'x'.repeat(200)}))}}},stream_performance:{recent_requests:[{model:'retained',outcome:'failed'}]}};
 const before=structuredClone(snapshot), summary=statusSummary(snapshot);
 assert.equal(summary.scope,'summary');assert.equal(summary.model_activity.active,3);assert.equal(summary.runtime_usage.records,4);
 assert.equal(Object.hasOwn(summary,'providers'),false);assert.equal(Object.hasOwn(summary,'stream_performance'),false);
 assert.ok(JSON.stringify(summary).length<JSON.stringify(snapshot).length/10);assert.deepEqual(snapshot,before);
});
test('default status keeps the full legacy contract while the opt-in projection stays explicit', async () => {
 const options={codexClient:{runtimeStatus:()=>({})}};
 const headers={host:'127.0.0.1:2026'};
 const complete=JSON.parse((await invokeAdapter(options,{method:'GET',url:'/_ccdx/status',headers})).text);
 const summary=JSON.parse((await invokeAdapter(options,{method:'GET',url:'/_ccdx/status?scope=summary',headers})).text);
 assert.ok(complete.stream_performance);assert.ok(complete.http_errors);assert.equal(complete.scope,undefined);
 assert.equal(summary.scope,'summary');assert.equal(summary.instance_id,complete.instance_id);assert.equal(typeof summary.instance_id,'string');assert.equal(summary.name,complete.name);assert.equal(summary.version,complete.version);
 assert.equal(Object.hasOwn(summary,'http_errors'),false);assert.equal(Object.hasOwn(summary,'providers'),false);
 const refused=await invokeAdapter(options,{method:'GET',url:'/_ccdx/status?scope=summary',headers:{host:'evil.invalid'}});assert.equal(refused.status,403);
});
