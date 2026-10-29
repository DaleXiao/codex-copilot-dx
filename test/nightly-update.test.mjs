import test from 'node:test';
import assert from 'node:assert/strict';
import { eligiblePatch, nightlyWindow, NIGHTLY_IDLE_MS } from '../src/nightly-update.mjs';
import { prepareNightlyRelease } from '../src/nightly-update.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runtimeReleaseTarget } from '../src/release-install.mjs';
import { privateWindowsCommand, inspectWindowsCommand } from '../src/windows-command.mjs';
import { createNightlyScheduler, switchServiceVersion } from '../src/service-supervisor.mjs';
const localDate=()=>new Date(2026,9,25,0,10);

test('nightly preparation recovers an npm policy refusal offline before touching the installed service', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-nightly-fallback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const prefix=path.join(root,'global'),target=path.join(prefix,...(process.platform==='win32'?[]:['lib']),'node_modules/codex-copilot-dx');
 fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'old.txt'),'old runtime');
 const make=extra=>{const b=Buffer.from(JSON.stringify({name:'codex-copilot-dx',version:'1.2.999',...extra})),h=Buffer.alloc(512);h.write('package/package.json');h.write(b.length.toString(8).padStart(11,'0'),124);h[156]=48;return gzipSync(Buffer.concat([h,b,Buffer.alloc((512-b.length%512)%512),Buffer.alloc(1024)]));};
 const normal=make({}),complete=make({ccdx_runtime:{schema:1,target:runtimeReleaseTarget()},bundleDependencies:['sharp','smol-toml','@azure/msal-node-runtime']});
 const name='codex-copilot-dx-1.2.999',manifest=`${createHash('sha256').update(normal).digest('hex')}  ${name}.tgz\n${createHash('sha256').update(complete).digest('hex')}  ${name}-${runtimeReleaseTarget()}.tgz\n`;
 const calls=[],candidate=await prepareNightlyRelease({version:'1.2.999'},{environment:{prefix,target,npmCli:process.execPath},root:path.join(root,'candidate'),env:{},
  fetchImpl:async url=>new Response(url.endsWith('SHA256SUMS')?manifest:url.endsWith(`${name}.tgz`)?normal:complete),verify:async()=>{},
  execute:async(_command,args)=>{
   calls.push(args);if(calls.length===1)throw Object.assign(Error('npm failed'),{stderr:'npm error code EALLOWREMOTE\n'});
   const destination=path.join(args[args.indexOf('--prefix')+1],...(process.platform==='win32'?[]:['lib']),'node_modules/codex-copilot-dx');
   fs.mkdirSync(path.join(destination,'bin'),{recursive:true});
   fs.writeFileSync(path.join(destination,'package.json'),JSON.stringify({name:'codex-copilot-dx',version:'1.2.999',bin:{ccdx:'bin/cli.mjs'}}));
   const commands=path.dirname(path.dirname(destination));
   for(const [name,script] of [['ccdx','cli.mjs']]){
    const cli=path.join(destination,'bin',script);fs.writeFileSync(cli,'// synthetic installer fixture\n');
    fs.writeFileSync(path.join(commands,name+'.cmd'),privateWindowsCommand({node:process.execPath,cli,prefix:commands}));
   }
   return {stdout:''};}});
 t.after(()=>candidate.cleanup());assert.equal(calls.length,2);assert.equal(calls[1].includes('--offline'),true);
 assert.equal(inspectWindowsCommand({platform:'win32',packageRoot:candidate.target}).status,'ready');
 assert.equal(fs.readFileSync(path.join(target,'old.txt'),'utf8'),'old runtime');
 const transaction=await candidate.install();assert.equal(calls[2].includes('--offline'),true);transaction.rollback();
 assert.equal(fs.readFileSync(path.join(target,'old.txt'),'utf8'),'old runtime');
 assert.ok(calls.every(args=>!args.some(arg=>arg.includes('--allow-remote'))));
});

test('nightly updates select only stable, aged patch versions in the local window',()=>{
 const now=localDate().getTime(),release={version:'1.2.23',published_at:new Date(now-86400001).toISOString()};
 assert.equal(eligiblePatch('1.2.22',release,now),true);
 for(const version of ['1.2.22','1.3.0','2.0.0','1.2.23-beta','bad'])assert.equal(eligiblePatch('1.2.22',{...release,version},now),false);
 assert.equal(eligiblePatch('1.2.22',{...release,published_at:new Date(now-1000).toISOString()},now),false);
 assert.equal(nightlyWindow(new Date(2026,9,25,3,59)),true);assert.equal(nightlyWindow(new Date(2026,9,25,4)),false);
});
test('disabled scheduling does no reads; busy work and tool gaps reset the idle interval',async()=>{
 let enabled=false,clock=localDate(),reads=0,checks=0,applied=0,total=0,busy=false;const saved=[];
 const scheduler=createNightlyScheduler({enabled:()=>enabled,now:()=>clock,currentVersion:()=> '1.2.22',
  inspect:async()=>{reads++;return {busy,activity:{active:0,total}};},
  lookup:async()=>{checks++;return {version:'1.2.23',published_at:new Date(clock-90000000).toISOString()};},
  prepare:async()=>({cleanup(){}}),apply:async()=>{applied++;},persist:value=>saved.push(value),
 });
 await scheduler.tick();assert.equal(reads,0);enabled=true;await scheduler.tick();
 total++;for(let i=0;i<10;i++){clock=new Date(+clock+60000);await scheduler.tick();}assert.equal(checks,0);
 busy=true;clock=new Date(+clock+60000);await scheduler.tick();assert.equal(checks,0);
 busy=false;for(let i=0;i<10;i++){clock=new Date(+clock+60000);await scheduler.tick();}assert.equal(checks,1);assert.equal(applied,1);
 await scheduler.tick();assert.equal(checks,1);assert.equal(saved.length,1);await scheduler.close();
});
test('work arriving during candidate preparation discards it without switching',async()=>{
 let clock=localDate(),total=0,cleaned=0;
 const scheduler=createNightlyScheduler({enabled:()=>true,now:()=>clock,currentVersion:()=> '1.2.22',inspect:async()=>({busy:false,activity:{active:0,total}}),
  lookup:async()=>({version:'1.2.23',published_at:new Date(clock-90000000).toISOString()}),prepare:async()=>{total++;return {cleanup(){cleaned++;}};},apply:async()=>assert.fail('must defer')});
 await scheduler.tick();for(let i=0;i<10;i++){clock=new Date(+clock+60000);await scheduler.tick();}assert.equal(cleaned,1);await scheduler.close();
});
function transactionFixture(failure=false){
 const events=[],business=[{id:'codex',models:[['github','gpt-probe']],default_model:'stable-route'}];
 const baseline={version:'1.2.22',fingerprint:'same',business,busy:false,activity:{active:0,total:7}};
 const state={version:1,history:'synthetic'};
 const old={call:async action=>{events.push('old:'+action);return {...baseline,...(action==='quiesce'?{state}:{})};},stop:async()=>events.push('old:stop')};
 const candidate={version:'1.2.23',target:'candidate',cleanup(){events.push('candidate:clean');},install:async()=>{events.push('install');return {commit(){events.push('commit');},rollback(){events.push('rollback');}};}};
 const current={target:'old',cleanup(){events.push('old:clean');}};
 const launch=(target,options)=>{events.push('launch:'+target);assert.equal(options.warm,true);assert.equal(options.preserve,true);return {
  ready:Promise.resolve({...baseline,version:'1.2.23'}),
  call:async (action,value)=>{events.push(target+':'+action);if(action==='import')assert.equal(value,state);if(failure&&action==='promote')throw Error('promotion failed');return {...baseline,version:'1.2.23'};},stop:async()=>events.push(target+':stop')};};
 return {events,worker:old,candidate,current,launch,baseline};
}
test('version transaction preserves business state, commits only after startup acknowledgement',async()=>{
 const f=transactionFixture();const value=await switchServiceVersion(f);assert.equal(value.version,'1.2.23');
 assert.deepEqual(f.events,['old:inspect','launch:candidate','install','old:quiesce','candidate:import','old:release','candidate:promote','candidate:commit','commit','old:stop','old:clean']);
});
test('failed promotion restores installation and resumes the original running instance',async()=>{
 const f=transactionFixture(true);await assert.rejects(switchServiceVersion(f),error=>Boolean(error.restoredWorker));
 assert.deepEqual(f.events,['old:inspect','launch:candidate','install','old:quiesce','candidate:import','old:release','candidate:promote','candidate:stop','rollback','old:resume','candidate:clean']);
});
test('a deliberate stop never resurrects either runtime',async()=>{
 const f=transactionFixture();let stopped=false;f.candidate.install=async()=>{stopped=true;return {commit(){assert.fail();},rollback(){f.events.push('rollback');}};};
 await assert.rejects(switchServiceVersion({...f,stopped:()=>stopped}));assert.equal(f.events.includes('old:stop'),false);
});

test('wake from sleep requires a newly observed idle interval before updating',async()=>{
 let clock=localDate(),checks=0;
 const scheduler=createNightlyScheduler({enabled:()=>true,now:()=>clock,currentVersion:()=> '1.2.22',inspect:async()=>({busy:false,activity:{active:0,total:0}}),lookup:async()=>{checks++;return {version:'1.2.22'};},prepare:async()=>assert.fail(),apply:async()=>assert.fail()});
 await scheduler.tick();clock=new Date(+clock+3600000);await scheduler.tick();assert.equal(checks,0);
 for(let i=0;i<10;i++){clock=new Date(+clock+60000);await scheduler.tick();}assert.equal(checks,1);await scheduler.close();
});

for(const fails of [false,true])test(`foreground supervisor keeps control after ${fails?'rollback':'a version switch'} and stops without respawning`,{timeout:5000},async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {EventEmitter}=await import('node:events');const {runServiceSupervisor}=await import('../src/service-supervisor.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-supervisor-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const before=path.join(root,'old'),globalTarget=path.join(root,'global');for(const dir of [before,globalTarget]){fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({version:'1.2.22'}));}
 const env={XDG_CONFIG_HOME:path.join(root,'config')};const {writeNightlyUpdatePreference}=await import('../src/user-settings.mjs');writeNightlyUpdatePreference(true,{env});
 const processObj=new EventEmitter(),workers=[],business=[{id:'codex',models:[['github','gpt-probe']]}];let clock=localDate(),tick,phase,cleaned=0;
 const launch=(target,options)=>{
  let finish,closed=false;const exited=new Promise(resolve=>{finish=resolve;});
  const data={version:target===before?'1.2.22':'1.2.23',fingerprint:'same',business,busy:false,activity:{active:0,total:0}};
  const worker={ready:fails&&target!==before?Promise.reject(Error('startup failed')):Promise.resolve(data),exited,
   call:async action=>({...data,...(action==='quiesce'?{state:{synthetic:true}}:{})}),
   status:value=>{phase=value.phase;},notice(){},stop:async()=>{if(!closed){closed=true;finish({code:0});}},options,target};
  Object.defineProperty(worker,'stopped',{get:()=>closed});workers.push(worker);return worker;
 };
 const run=runServiceSupervisor({environment:{target:globalTarget,package_root:before},env,now:()=>clock,processObj,launch,
  retain:()=>({target:before,cleanup(){cleaned++;}}),verify:async()=>{},timers:{setInterval(fn){tick=fn;return {unref(){}};},clearInterval(){}},
  lookup:async()=>({version:'1.2.23',published_at:new Date(+clock-90000000).toISOString()}),
  prepare:async()=>({target:'candidate',version:'1.2.23',cleanup(){cleaned++;},install:async()=>{fs.writeFileSync(path.join(globalTarget,'package.json'),JSON.stringify({version:'1.2.23'}));return {commit(){},rollback(){fs.writeFileSync(path.join(globalTarget,'package.json'),JSON.stringify({version:'1.2.22'}));}};}}),log(){} });
 while(!tick)await new Promise(resolve=>setImmediate(resolve));await tick();
 for(let i=0;i<10;i++){clock=new Date(+clock+60000);await tick();}
 assert.equal(phase,fails?'paused':'updated');assert.equal(workers.length,2);assert.equal(workers[0].stopped,!fails);assert.equal(workers.at(-1).target,'candidate');
 processObj.emit('SIGINT');assert.equal(await run,0);const count=workers.length;
 await new Promise(resolve=>setImmediate(resolve));assert.equal(workers.length,count);assert.ok(cleaned>=1);
});

test('worker spawn failure rejects readiness and never waits for a nonexistent process to exit',{timeout:1000},async()=>{
 const {EventEmitter}=await import('node:events');const {launchServiceWorker}=await import('../src/service-supervisor.mjs');
 const child=new EventEmitter();child.connected=false;child.exitCode=null;child.signalCode=null;
 const worker=launchServiceWorker('/synthetic/missing',{forkImpl:()=>{queueMicrotask(()=>child.emit('error',Error('synthetic denied')));return child;}});
 await assert.rejects(worker.ready,/worker_failed/);await worker.stop();assert.equal((await worker.exited).code,1);
});
