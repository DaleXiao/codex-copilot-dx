import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createCodexMemoryModel} from '../src/codex-memory-model.mjs';
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-memory-model-'));fs.mkdirSync(path.join(home,'.codex'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return{home,env:{},config:path.join(home,'.codex/config.toml')};}

test('explicit native extraction model is read without changing config or using the main model',async t=>{
 const f=fixture(t),text='model="main-model"\n[features]\nmemories=true\n[memories]\nextract_model="background-model"\n';fs.writeFileSync(f.config,text);
 const reader=createCodexMemoryModel({...f,probe:()=>assert.fail('configured role needs no log probe')});await reader.refresh();
 assert.deepEqual(reader.snapshot(),{model:'background-model',basis:'configured',enabled:true});assert.equal(fs.readFileSync(f.config,'utf8'),text);await reader.close();
});

test('observed models are cached as evidence, expire and never become a claimed default',async t=>{
 const f=fixture(t);fs.writeFileSync(f.config,'[features]\nmemories=true\n');let now=100000,calls=0;
 const reader=createCodexMemoryModel({...f,now:()=>now,probe:async()=>{calls++;return{model:'observed-model',at:100000};}});await reader.refresh();assert.equal(reader.snapshot().basis,'observed');assert.equal(reader.snapshot().model,'observed-model');
 await reader.refresh();assert.equal(calls,1);now+=86400001;await reader.refresh();assert.equal(reader.snapshot().model,null);await reader.close();
});

test('disabled memory generation never starts a native log worker',async t=>{
 const f=fixture(t);fs.writeFileSync(f.config,'[features]\nmemories=true\n[memories]\ngenerate_memories=false\n');const reader=createCodexMemoryModel({...f,probe:()=>assert.fail('disabled')});await reader.refresh();assert.equal(reader.snapshot().enabled,false);assert.equal(reader.snapshot().model,null);await reader.close();
});

test('native log helper correlates only bounded task and loopback HTTP metadata',t=>{
 const f=fixture(t),dir=path.join(f.home,'.codex'),at=Math.floor(Date.now()/1000);
 const sql=`import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec('create table logs(ts integer,process_uuid text,target text,feedback_log_body text)');const s=d.prepare('insert into logs values(?,?,?,?)');s.run(${at},'process','codex_memories_write::phase1::job::result','Phase 1 job failed ccdx_api_model_unavailable');s.run(${at},'process','codex_http_client::client','model_client.stream_responses_api{model=background-model wire_api=responses}: Request completed url=http://127.0.0.1:2026/v1/responses status=400 Bad Request');d.close();`;
 execFileSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',sql,path.join(dir,'logs_2.sqlite')]);
 const result=JSON.parse(execFileSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('../src/codex-memory-probe.mjs',import.meta.url)),dir,'http://127.0.0.1:2026/v1',String(at-1)],{encoding:'utf8'}));assert.deepEqual(result,{model:'background-model',at:at*1000});
});
