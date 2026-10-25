// Real CLI workers, private IPC and loopback only; no user files or upstream calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchServiceWorker, switchServiceVersion } from '../src/service-supervisor.mjs';
import { defaultAccessSettings, updateAccessSettings } from '../src/access-settings.mjs';
import { deploymentModelId } from '../src/model-capabilities.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-update-replay-'));
const watchdog=setTimeout(()=>{console.error('Service update replay exceeded 120 seconds');process.exit(124);},120000);watchdog.unref();
let worker,output='',moves=0,commits=0,rollbacks=0,installs=0;const children=new Set();
try{
 const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const home=path.join(root,'home'),profile=path.join(home,'.codex'),config=path.join(profile,'config.toml');fs.mkdirSync(profile,{recursive:true});
 fs.writeFileSync(config,`openai_base_url = "http://127.0.0.1:${port}/v1"\nmodel = "gpt-5.5"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n[features]\ncontext_management = true\n`);
 const auth='{"auth_mode":"chatgpt","tokens":{"access_token":"synthetic-only"}}';fs.writeFileSync(path.join(profile,'auth.json'),auth);
 const token=path.join(home,'.local/share/copilot-api/github_token');fs.mkdirSync(path.dirname(token),{recursive:true});fs.writeFileSync(token,'synthetic-offline-token');
 const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SystemRoot','WINDIR','TMPDIR','TEMP','TMP','LANG','ProgramFiles','COMSPEC'].includes(key)));
 const env={...inherited,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),CCDX_TEST_HOME:home,CODEX_HOME:profile,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),CCDX_AUTO_LAUNCH:'0',CCDX_M365:'0',CCDX_DISABLE_TOKEN_DISCOVERY:'1',CCDX_MODEL_REFRESH_INTERVAL_MS:'0',CCDX_DISABLE_USAGE:'1',CCDX_LOG_PATH:'',ADAPTER_HOST:'127.0.0.1',ADAPTER_PORT:String(port)};
 const graph=defaultAccessSettings();graph.providers.m365=false;graph.clients.codex={enabled:true,source:'github',allowed:['github'],deployments:[{source:'github',model:'gpt-5.5'}],default_model:deploymentModelId('github','gpt-5.5'),model:'gpt-5.5'};graph.clients.claude_app.enabled=false;graph.clients.claude_code.enabled=false;
 updateAccessSettings(()=>graph,{home,env});
 const preloader=path.join(root,'preload.cjs');fs.writeFileSync(preloader,`require(${JSON.stringify(path.join(repo,'scripts/replay-fixtures/config-startup-preload.cjs'))});\nconst original=globalThis.fetch;let n=0;globalThis.fetch=async(input,init)=>{if(String(input)==='https://startup-replay.example/models'&&process.env.CCDX_TEST_CATALOG_FAIL==='1')return Response.json({error:{message:'synthetic unavailable'}},{status:503});const value=await original(input,init);if(String(input)==='https://startup-replay.example/responses'){const body=await value.json();body.id='resp_update_'+process.pid+'_'+(++n);return Response.json(body);}return value;};\n`);env.NODE_OPTIONS='--require '+JSON.stringify(preloader);
 const makeRuntime=(name,version)=>{const target=path.join(root,name);fs.mkdirSync(target);for(const dir of ['src','bin'])fs.cpSync(path.join(repo,dir),path.join(target,dir),{recursive:true});const pkg=JSON.parse(fs.readFileSync(path.join(repo,'package.json')));pkg.version=version;fs.writeFileSync(path.join(target,'package.json'),JSON.stringify(pkg));fs.symlinkSync(path.join(repo,'node_modules'),path.join(target,'node_modules'),process.platform==='win32'?'junction':'dir');return target;};
 const beforeVersion=JSON.parse(fs.readFileSync(path.join(repo,'package.json'))).version,target=makeRuntime('old',beforeVersion),candidateTarget=makeRuntime('candidate','1.2.999');
 const start=(target,options={})=>launchServiceWorker(target,{env,args:['--no-browser'],...options,forkImpl:(file,args,opts)=>{const child=fork(file,args,{...opts,stdio:['ignore','pipe','pipe','ipc']});children.add(child);child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});child.on('exit',()=>children.delete(child));return child;}});
 const origin=`http://127.0.0.1:${port}`;
 async function infer(previous){const result=await fetch(origin+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5.5',input:'synthetic continuity test',stream:false,...(previous?{previous_response_id:previous}:{})}),signal:AbortSignal.timeout(15000)});const text=await result.text();assert.equal(result.status,200,text);return JSON.parse(text);}
 worker=start(target);await worker.ready;
 const reused=start(target);assert.equal((await reused.ready).reused,true);assert.equal((await reused.exited).code,0);
 const first=await infer();const baseline=await worker.call('inspect'),savedConfig=fs.readFileSync(config,'utf8');
 const candidate={version:'1.2.999',target:candidateTarget,cleanup(){},install:async()=>{installs++;return {commit(){commits++;},rollback(){rollbacks++;}};}};
 const switched=await switchServiceVersion({worker,current:{target,cleanup(){moves++;}},candidate,baseline,launch:start});worker=switched.worker;
 const after=await infer(first.id);assert.equal(after.status,'completed');assert.equal(fs.readFileSync(config,'utf8'),savedConfig);assert.equal(fs.readFileSync(path.join(profile,'auth.json'),'utf8'),auth);
 const badTarget=path.join(root,'bad');fs.mkdirSync(path.join(badTarget,'bin'),{recursive:true});fs.writeFileSync(path.join(badTarget,'bin/cli.mjs'),'process.exit(1);');
 const healthy=await worker.call('inspect');
 await assert.rejects(switchServiceVersion({worker,current:{target:candidateTarget,cleanup(){}},candidate:{...candidate,target:badTarget,version:'1.2.1000'},baseline:healthy,launch:start}),error=>{worker=error.restoredWorker;return Boolean(worker);});
 assert.equal(worker.child.pid,switched.worker.child.pid);assert.equal((await infer(after.id)).status,'completed');
 const list=await(await fetch(origin+'/v1/models',{signal:AbortSignal.timeout(10000)})).json();assert.deepEqual((list.data||list.models).map(value=>value.id||value.slug),['gpt-5.5']);
 assert.equal(fs.readFileSync(config,'utf8'),savedConfig);assert.equal(fs.readFileSync(path.join(profile,'auth.json'),'utf8'),auth);
 const unavailableCandidate=(target,options)=>start(target,{...options,env:{...env,CCDX_TEST_CATALOG_FAIL:'1'}});
 const retainedBeforeOutage=worker;
 await assert.rejects(switchServiceVersion({worker,current:{target:candidateTarget,cleanup(){}},candidate:{...candidate},baseline:await worker.call('inspect'),launch:unavailableCandidate}),error=>{worker=error.restoredWorker;return error.message==='candidate_unavailable'&&worker===retainedBeforeOutage;});
 assert.equal((await infer(after.id)).status,'completed');
 const originalWorker=worker;
 const failedPromotion=(target,options)=>{const value=start(target,options);const call=value.call;value.call=(action,payload)=>action==='promote'?Promise.reject(Error('synthetic promotion failure')):call(action,payload);return value;};
 const retained=await worker.call('inspect');
 await assert.rejects(switchServiceVersion({worker,current:{target:candidateTarget,cleanup(){}},candidate:{...candidate},baseline:retained,launch:failedPromotion}),error=>{worker=error.restoredWorker;return worker===originalWorker;});
 assert.equal((await infer()).status,'completed');
 assert.equal(commits,1);assert.equal(rollbacks,1);assert.equal(moves,1);assert.equal(installs,2);
 await worker.stop();worker=null;
 console.log(JSON.stringify({platform:process.platform,real_cli_update:true,reuse_existing_service:true,rollback:true,retained_instance_on_catalog_outage:true,old_response_id_continues:true,config_unchanged:true,auth_unchanged:true,first_model_list_complete:true,real_provider_calls:0,commits,rollbacks}));
}catch(error){console.error(output.slice(-10000));throw error;}
finally{await worker?.stop();for(const child of children){child.kill('SIGKILL');}clearTimeout(watchdog);fs.rmSync(root,{recursive:true,force:true});}
