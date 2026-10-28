import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {apiModelDisplay,createApiModelDisplayStore} from '../src/api-model-display.mjs';
import {createProviderRuntime} from '../src/provider-runtime.mjs';import {createApiProvider} from '../src/providers/api.mjs';
import {readAccessSettings,accessSettingsPath} from '../src/access-settings.mjs';
const rev='a'.repeat(32);

test('maker declarations are bounded text, separate from ownership and capabilities',()=>{
 assert.deepEqual(apiModelDisplay({publisher:' Example AI ',vendor:'example',owned_by:'gateway',id:'ignored'}),{publisher:'Example AI',vendor:'example',owned_by:'gateway'});
 assert.deepEqual(apiModelDisplay({publisher:'sk-private',vendor:'bad\nvalue',owned_by:'x'.repeat(161)}),{});
 assert.deepEqual(apiModelDisplay({display_name:' 上游名称 ',name:'Model name'}),{display_name:'上游名称',name:'Model name'});
});

test('display cache survives reload, rejects stale revisions and fails independently of connections',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-display-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const store=createApiModelDisplayStore({home,env:{}});assert.equal(store.has('api_test',rev),false);
 store.set('api_test',rev,[{id:'same-model',display:{publisher:'Example AI',display_name:'Readable name'}}]);
 const next=createApiModelDisplayStore({home,env:{}});assert.equal(next.get('api_test',rev,'same-model').publisher,'Example AI');assert.equal(next.has('api_test','b'.repeat(32)),false);
 assert.equal(fs.existsSync(accessSettingsPath({home,env:{}})),false);
 assert.equal(next.get('api_test',rev,'same-model').display_name,'Readable name');
});

test('normal discovery publishes maker evidence without changing the legacy connection schema',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-display-runtime-')),env={CCDX_M365:'0'},secretStore={set:async()=>{},get:async()=> 'synthetic-key',close(){}};
 const make=()=>createProviderRuntime({home,env,githubClient:{},githubRegistry:{models:{data:[]}},secretStore,inspectDesktop:async()=>false,
  createApi:options=>createApiProvider({...options,networkFactory:async()=>({close(){},fetch:async()=>Response.json({data:[{id:'model-one',publisher:'Example AI',vendor:'example',owned_by:'gateway',context_window:128000,supported_endpoints:['/v1/messages']}]})})})});
 const runtime=make();t.after(async()=>{await runtime.close();fs.rmSync(home,{recursive:true,force:true});});
 const saved=await runtime.manageConnections({operation:'save_api',config:{name:'Example',base_url:'https://example.test/v1',endpoints:{messages:'https://example.test/v1/messages'},auth_header:'bearer',models:[{id:'model-one',protocols:['messages']}]},key:'synthetic-key',allowed:['claude_app']});
 const id=saved.providers.find(x=>!x.builtin).id;await runtime.manageConnections({operation:'discover',id});
 const model=runtime.dashboardCatalog({provider:id}).models[0];assert.equal(model.vendor,'Example AI');assert.equal(model.owned_by,'gateway');
 assert.doesNotMatch(fs.readFileSync(accessSettingsPath({home,env}),'utf8'),/publisher|Example AI|model_display/);assert.equal(readAccessSettings({home,env}).version,2);
 const publicApi=runtime.connections().providers.find(x=>x.id===id);
 const {id:ignored,enabled,builtin,key_saved,protocols,model_count,codex_model_count,deployment_revision,discovery,checked_at,...roundtrip}=publicApi;
 const found=await runtime.manageConnections({operation:'discover',id});roundtrip.models=structuredClone(found.discovered);
 roundtrip.model_display={'model-one':{publisher:'Not an upstream declaration'}};roundtrip.models[0].display={publisher:'Not an upstream declaration'};
 const profile=runtime.source(id).profileId('messages');
 await runtime.manageConnections({operation:'save_api',id,config:roundtrip,allowed:['claude_app']});
 assert.equal(runtime.source(id).profileId('messages'),profile);assert.equal(runtime.dashboardCatalog({provider:id}).models[0].vendor,'Example AI');
 assert.doesNotMatch(fs.readFileSync(accessSettingsPath({home,env}),'utf8'),/publisher|model_display|Not an upstream declaration/);
 await assert.rejects(runtime.manageConnections({operation:'save_api',id,config:{...roundtrip,unexpected:true},allowed:['claude_app']}),{code:'ccdx_api_config_invalid'});
 const again=make();try{assert.equal(again.dashboardCatalog({provider:id}).models[0].vendor,'Example AI');}finally{await again.close();}
});
