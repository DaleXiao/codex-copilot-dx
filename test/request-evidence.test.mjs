import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createAdapterHandler} from '../src/adapter.mjs';
import {createProviderRuntime} from '../src/provider-runtime.mjs';
import {readClientGatewayKeys} from '../src/client-gateway-keys.mjs';
import {createConversationSourceGuard} from '../src/conversation-source-guard.mjs';
import {runWithRequestContext,observeRequestedModel} from '../src/request-context.mjs';

process.env.CCDX_DISABLE_USAGE='1';
test('model resolution failures retain their requested model and app without any upstream call',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-request-evidence-')),env={CCDX_M365:'0'};
 const registry={models:{data:[{id:'gpt-visible',supported_endpoints:['/responses']}]}};let calls=0;
 const runtime=createProviderRuntime({home,env,githubRegistry:registry,githubClient:{responses:async()=>{calls++;throw Error('unexpected');}},secretStore:{close(){}},inspectDesktop:async()=>false});
 await runtime.manageConnections({operation:'client',id:'codex',enabled:true,allowed:['github'],deployments:[{source:'github',model:'gpt-visible'}]});
 const handler=createAdapterHandler({providerRuntime:runtime,modelRegistry:registry});
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{handler.dispose?.();server.closeAllConnections();await new Promise(r=>server.close(r));await runtime.close();fs.rmSync(home,{recursive:true,force:true});});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',originator:'codex_app'},body:JSON.stringify({model:'gpt-unselected',input:'private synthetic prompt'})});
 assert.equal(response.status,400);assert.equal((await response.json()).error.reason,'ccdx_model_not_selected');assert.equal(calls,0);
 const issue=handler.snapshot().http_errors.actionable_recent.at(-1);
 assert.equal(issue.model,'gpt-unselected');assert.equal(issue.requested_model,'gpt-unselected');assert.equal(issue.application,'codex_app');assert.equal(issue.reason,'ccdx_model_not_selected');assert.equal(issue.upstream_attempts,0);assert.doesNotMatch(JSON.stringify(issue),/private synthetic/);
});

test('Claude API counts retain source, model, HTTP origin and real or cached call counts',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-count-evidence-')),env={CCDX_M365:'0'};let upstream=0;
 const {createApiProvider}=await import('../src/providers/api.mjs');
 const runtime=createProviderRuntime({home,env,githubRegistry:{models:{data:[]}},secretStore:{set:async()=>{},get:async()=> 'synthetic-secret-key',close(){}},inspectDesktop:async()=>false,
  createApi:options=>createApiProvider({...options,networkFactory:async()=>({close(){},fetch:async()=>{upstream++;return Response.json({error:{code:'missing'}},{status:404});}})})});
 const saved=await runtime.manageConnections({operation:'save_api',config:{name:'Example',base_url:'https://example.test/v1',endpoints:{messages:'https://example.test/v1/messages'},auth_header:'bearer',models:[{id:'reasoner-model',protocols:['messages']}]},key:'synthetic-secret-key',allowed:['claude_app']});
 const id=saved.providers.find(x=>!x.builtin).id;
 await runtime.manageConnections({operation:'client',id:'claude_app',enabled:true,allowed:[id],deployments:[{source:id,model:'reasoner-model'}]});
 const handler=createAdapterHandler({providerRuntime:runtime}),server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{handler.dispose?.();server.closeAllConnections();await new Promise(r=>server.close(r));await runtime.close();fs.rmSync(home,{recursive:true,force:true});});
 const key=readClientGatewayKeys({home,env}).claude_app;
 for(let i=0;i<2;i++){
  const response=await fetch(`http://127.0.0.1:${server.address().port}/anthropic/v1/messages/count_tokens`,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},body:JSON.stringify({model:'reasoner-model',messages:[]})});
  assert.equal(response.status,404);await response.text();
  const issue=handler.snapshot().http_errors.capability_recent.at(-1);
  assert.equal(issue.model,'reasoner-model');assert.equal(issue.provider,id);assert.equal(issue.application,'claude_app');assert.equal(issue.origin,i?'capability_cache':'upstream_http');assert.equal(issue.upstream_attempts,i?0:1);
 }
 assert.equal(handler.snapshot().http_errors.by_category.inference,0);
 assert.equal(handler.snapshot().http_errors.actionable_recent.length,0);
});

test('diagnostic model capture rejects credential forms and arbitrary body content',()=>{
 for(const model of ['sk-private-value','Bearer private','x'.repeat(200),{value:'private'}]){const c={};runWithRequestContext(c,()=>observeRequestedModel({model}));assert.equal(c.requestedModel,undefined);}
});

test('a Claude child keeps a separate source guard while the parent and each child remain pinned',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-child-scope-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const guard=createConversationSourceGuard({home,env:{}}),body={messages:[{role:'user',content:'synthetic'}]},headers={'x-claude-code-session-id':'session-one'},salt='synthetic-key';
 guard('claude_code','source-a',body,headers,salt);
 guard('claude_code','source-b',body,{...headers,'x-claude-code-agent-id':'child-one'},salt);
 guard('claude_code','source-a',body,headers,salt);
 assert.throws(()=>guard('claude_code','source-c',body,{...headers,'x-claude-code-agent-id':'child-one'},salt),{code:'ccdx_conversation_source_changed'});
 assert.throws(()=>guard('claude_code','source-b',body,headers,salt),{code:'ccdx_conversation_source_changed'});
});
