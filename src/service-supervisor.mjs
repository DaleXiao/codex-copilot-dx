import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { nightlyUpdatePreference, userSettingsPath } from './user-settings.mjs';
import { atomicWriteFileIfChangedSync } from './atomic-file.mjs';
import { createNpmReleaseFetch } from './release-install.mjs';
import { installedUpdateEnvironment, retainCurrentRuntime, lookupNightlyRelease, eligiblePatch, nightlyWindow, nightlyDay, NIGHTLY_IDLE_MS, prepareNightlyRelease, verifyNightlyRuntime, readNightlyState } from './nightly-update.mjs';

export function launchServiceWorker(target, { args = [], env = process.env, state, preserve = false, warm = false, sources = [], onPreference = () => {}, forkImpl = fork } = {}) {
  const child = forkImpl(path.join(target,'bin/cli.mjs'),preserve ? [...args.filter(value=>value!=='--no-browser'),'--no-browser'] : args, {
    env:{...env,CCDX_SUPERVISED_SERVICE:'1',...(preserve?{CCDX_AUTO_LAUNCH:'0'}:{})},stdio:['inherit','inherit','inherit','ipc'],serialization:'advanced',windowsHide:true,
  });
  let sequence=0,settled=false;const pending=new Map();
  let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const timer=setTimeout(()=>readyReject(new Error('startup_timeout')),90000);
  let exitedResolve;const exited=new Promise(resolve=>{exitedResolve=resolve;});
  const fail=error=>{if(!settled){settled=true;clearTimeout(timer);readyReject(error);}for(const entry of pending.values())entry.reject(error);pending.clear();};
  child.on('error',()=>{fail(new Error('worker_failed'));if(!child.pid)exitedResolve({code:1,signal:null});});
  child.on('exit',(code,signal)=>{fail(new Error('worker_exited'));exitedResolve({code,signal});});
  child.on('message',message=>{
    if(message?.type==='ccdx:boot'){child.send({type:'ccdx:init',protocol:1,preserve,warm,sources,state});state=undefined;}
    else if(message?.type==='ccdx:ready'){settled=true;clearTimeout(timer);readyResolve(message.value);}
    else if(message?.type==='ccdx:preference')onPreference(message.enabled===true);
    else if(message?.type==='ccdx:reply'){
      const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);message.error?entry.reject(new Error(message.error)):entry.resolve(message.value);
    }
  });
  function call(action, value) {
    let timer;const id=++sequence;
    return Promise.race([new Promise((resolve,reject)=>{
      if(!child.connected){reject(new Error('worker_disconnected'));return;}
      pending.set(id,{resolve,reject});child.send({type:'ccdx:call',id,action,value},error=>{if(error){pending.delete(id);reject(new Error('worker_disconnected'));}});
    }),new Promise((_,reject)=>{timer=setTimeout(()=>{pending.delete(id);reject(new Error('worker_timeout'));},20000);})]).finally(()=>clearTimeout(timer));
  }
  return { child,ready,exited,call,
    status(value){if(child.connected)child.send({type:'ccdx:update-status',value},()=>{});},
    notice(code){if(child.connected)child.send({type:'ccdx:notice',code},()=>{});},
    async stop(){if(!child.pid||child.exitCode!==null||child.signalCode)return;child.send?.({type:'ccdx:stop'},()=>{});let timer,forced;
      try{await Promise.race([exited,new Promise((resolve,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');exited.then(resolve);forced=setTimeout(()=>reject(new Error('worker_stop_timeout')),5000);},15000);})]);}finally{clearTimeout(timer);clearTimeout(forced);}
    },
  };
}

// Runtime-independent transaction, exercised with real child processes by CI.
export async function switchServiceVersion({ worker, current, candidate, baseline, launch, stopped = () => false, cancelled = stopped, onPhase = () => {}, signal }) {
  let transaction,next,transfer;
  const abort = () => { void next?.stop().catch(() => {}); };
  signal?.addEventListener('abort',abort,{once:true});
  const matches = value => value?.fingerprint === baseline.fingerprint && Array.isArray(value.business) && value.business.length === baseline.business.length
    && baseline.business.every(before => {
      const after = value.business.find(client => client.id === before.id);
      if (!after || ['enabled','source','default_model'].some(key => before[key] !== after[key]) || JSON.stringify(before.scopes) !== JSON.stringify(after.scopes)
        || !before.default_unavailable && after.default_unavailable || !Array.isArray(after.models)) return false;
      const models = new Set(after.models.map(model => JSON.stringify(model)));
      return (before.models || []).every(model => models.has(JSON.stringify(model)));
    });
  const healthy = (value, promoted = false) => Object.entries(baseline.health || {}).every(([key, needed]) => !needed || key === 'prediction' && !promoted || value.health?.[key] === true);
  try {
    if(cancelled())throw new Error('update_cancelled');
    const before=await worker.call('inspect');
    if(before.busy||before.fingerprint!==baseline.fingerprint||JSON.stringify(before.business)!==JSON.stringify(baseline.business))throw new Error('service_changed');
    const sources=[...new Set(baseline.business.flatMap(client=>client.models?.map(model=>model[0])||[]))];
    next=launch(candidate.target,{preserve:true,warm:true,sources});
    const ready=await next.ready;
    if(ready.version!==candidate.version||!matches(ready))throw new Error('candidate_state_changed');
    if(!healthy(ready))throw new Error('candidate_unavailable');
    if(cancelled())throw new Error('update_cancelled');
    transaction=await candidate.install();
    if(cancelled())throw new Error('update_cancelled');
    onPhase('switching');transfer=await worker.call('quiesce');
    if(transfer.fingerprint!==baseline.fingerprint||JSON.stringify(transfer.business)!==JSON.stringify(baseline.business)||transfer.activity.total!==baseline.activity.total)throw new Error('service_changed');
    if(cancelled())throw new Error('update_cancelled');
    await next.call('import',transfer.state);
    await worker.call('release');
    if(cancelled())throw new Error('update_cancelled');
    const promoted=await next.call('promote');
    if(!matches(promoted)||!healthy(promoted,true))throw new Error('candidate_state_changed');
    if(cancelled())throw new Error('update_cancelled');
    await next.call('commit');transaction.commit();transaction=null;
    let retired;
    try { await worker.stop();current.cleanup(); } catch { retired = { worker, current };next.notice?.('old_runtime_cleanup_pending'); }
    transfer=null;return {worker:next,current:candidate,version:candidate.version,retired};
  }catch(error){
    await next?.stop();
    let failure=error;
    try{transaction?.rollback();}catch{failure=new Error('installation_restore_failed');}
    if(!stopped()){
      await worker.call('resume').catch(()=>{});
    }
    candidate.cleanup();failure.restoredWorker=worker;throw failure;
  } finally { signal?.removeEventListener('abort',abort); }
}

export function createNightlyScheduler({enabled,inspect,currentVersion,lookup,prepare,apply,status=()=>{},onFailure=()=>{},now=()=>new Date(),state={attempted_day:null,paused_version:null},persist=()=>{}}) {
 let attemptedDay=state.attempted_day,flight=null,controller,lastBusyAt=now().getTime(),lastTickAt=lastBusyAt,lastCount=null,pausedVersion=state.paused_version;
 const save=()=>persist({attempted_day:attemptedDay,paused_version:pausedVersion});
 const publish=(phase,extra={})=>status({phase,...extra});
 async function tick(){
  if(flight||!enabled())return;
  flight=(async()=>{
   const sample=await inspect(),date=now(),time=date.getTime();
   if(time-lastTickAt>120000||time<lastTickAt)lastBusyAt=time;
   lastTickAt=time;
   const count=sample.activity.total;
   if(sample.busy||sample.activity.active>0||lastCount!==count){lastBusyAt=time;lastCount=count;}
   if(!nightlyWindow(date)||attemptedDay===nightlyDay(date)||time-lastBusyAt<NIGHTLY_IDLE_MS){publish('watching');return;}
   attemptedDay=nightlyDay(date);controller=new AbortController();save();
   try{
    publish('checking');const release=await lookup({signal:controller.signal});
    if(!enabled()||controller.signal.aborted)return;
    if(!eligiblePatch(currentVersion(),release,time)||release.version===pausedVersion){publish('watching');return;}
    publish('preparing',{version:release.version});const candidate=await prepare(release,{signal:controller.signal});
    const latest=await inspect();
    if(!enabled()||controller.signal.aborted||!nightlyWindow(now())||latest.busy||latest.activity.active||latest.activity.total!==count){candidate.cleanup();publish('deferred');return;}
    try{await apply(candidate,sample,{signal:controller.signal});publish('updated',{version:release.version});}
    catch(error){if(!controller.signal.aborted&&!['service_busy','state_too_large','service_changed','update_cancelled','candidate_unavailable'].includes(error.message)){pausedVersion=release.version;save();}throw error;}
   }catch(error){
    const known=['service_busy','state_too_large','service_changed','update_cancelled','candidate_state_changed','candidate_unavailable','installation_changed','installation_restore_failed','startup_timeout','worker_exited','worker_failed','worker_timeout'];
    onFailure(known.includes(error.message)?error.message:'update_failed');
    publish(controller.signal.aborted?'cancelled':['service_busy','state_too_large','service_changed','update_cancelled','candidate_unavailable'].includes(error.message)?'deferred':'paused');
   }
   finally{controller=null;}
  })().catch(()=>publish('unavailable')).finally(()=>{controller=null;flight=null;});
  return flight;
 }
 return {tick,cancel(){controller?.abort();},wait:()=>flight,async close(){controller?.abort();await flight;},get busy(){return Boolean(flight);}};
}

export async function runServiceSupervisor({args=process.argv.slice(2),env=process.env,environment=installedUpdateEnvironment({env}),
 now=()=>new Date(),launch=launchServiceWorker,prepare=prepareNightlyRelease,lookup,processObj=process,log=message=>console.log(message),
 retain=retainCurrentRuntime,verify=verifyNightlyRuntime,timers={setInterval,clearInterval}}={}) {
 let current=retain(environment),version=JSON.parse(fs.readFileSync(path.join(current.target,'package.json'))).version;
 let stopping=false,worker,pendingWorker,timer,scheduler;const retired=new Set();
 const start=(target,options={})=>pendingWorker=launch(target,{args,env,...options,onPreference:enabled=>{if(!enabled)scheduler?.cancel();}});
 const stop=()=>{if(stopping)return;stopping=true;timers.clearInterval(timer);scheduler?.cancel();void worker?.stop().catch(()=>{});if(pendingWorker!==worker)void pendingWorker?.stop().catch(()=>{});for(const item of retired)void item.worker.stop().catch(()=>{});};
 processObj.once('SIGINT',stop);processObj.once('SIGTERM',stop);
 try{
  await verify(current.target,version,{brokerRequired:fs.existsSync(path.join(current.target,'node_modules/@azure/msal-node-runtime'))});
  if(stopping)return 0;
  worker=start(current.target);const boot=await worker.ready;
  if(boot.reused){await worker.exited;return 0;}
  const stateFile=path.join(path.dirname(userSettingsPath({env})),'nightly-update-state.json');let state;
  try{state=readNightlyState(stateFile);}catch{state=null;worker.status({phase:'unavailable'});worker.notice('update_records_unreadable');}
  let fetchImpl;
  scheduler=createNightlyScheduler({enabled:()=>!stopping&&retired.size===0&&state!==null&&nightlyUpdatePreference({env}),now,currentVersion:()=>version,state:state||undefined,
   persist:value=>atomicWriteFileIfChangedSync(stateFile,JSON.stringify(value)+'\n',{mode:0o600}),
   inspect:()=>worker.call('inspect'),status:value=>worker.status(value),
   onFailure:code=>worker.notice(code),
   lookup:lookup|| (async options=>{fetchImpl||=createNpmReleaseFetch(environment.npmCli,{env});return lookupNightlyRelease(fetchImpl,options);}),
   prepare:(release,options)=>prepare(release,{environment,env,...options,fetchImpl}),
   apply:async(candidate,baseline,options)=>{
    try{
     const globalVersion=JSON.parse(fs.readFileSync(path.join(environment.target,'package.json'))).version;
     if(globalVersion!==version){candidate.cleanup();throw new Error('installation_changed');}
     const result=await switchServiceVersion({worker,current,candidate,baseline,launch:start,stopped:()=>stopping,
       cancelled:()=>stopping||!nightlyUpdatePreference({env})||!nightlyWindow(now()),onPhase:phase=>worker.status({phase,version:candidate.version}),signal:options.signal});
     worker=result.worker;current=result.current;version=result.version;
     if(result.retired)retired.add(result.retired);
    }catch(error){if(error.restoredWorker)worker=error.restoredWorker;throw error;}
   },
  });
  timer=timers.setInterval(()=>scheduler.tick(),60000);timer.unref?.();
  // An unexpected worker exit is reported once. A deliberate Ctrl+C never restarts it.
  while(!stopping){const observed=worker;await observed.exited;if(scheduler.busy){await scheduler.wait();if(worker!==observed)continue;}break;}
  const deliberate=stopping;stop();await scheduler.close();await worker.stop();return deliberate?0:1;
 }catch(error){if(!worker&&!stopping)throw error;if(!stopping)log('[WARN] Nightly supervisor could not continue; run ccdx again.');const deliberate=stopping;stop();return deliberate?0:1;}
 finally{timers.clearInterval(timer);processObj.off('SIGINT',stop);processObj.off('SIGTERM',stop);if(stopping)await worker?.stop();for(const item of retired){try{await item.worker.stop();item.current.cleanup();}catch{}}current.cleanup();}
}
