import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrivacyModel, PRIVACY_COMPONENT_RELEASE, PRIVACY_COMPONENT_ABI, PRIVACY_MODEL_REVISION, PRIVACY_MODEL_FILES } from "../src/privacy-model.mjs";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";
import { testEnvironment } from "../test/helpers/environment.mjs";
import { summarizePerformanceSamples, PRIVACY_PERFORMANCE_POLICY } from "./privacy-performance-analysis.mjs";
import { privacyRuntimeFingerprint, privacyMeasurementFingerprint } from "./privacy-performance-source.mjs";

const [component, weights, output, baselineComponent] = process.argv.slice(2);
assert.ok([component,weights,output,baselineComponent].every(value=>value&&path.isAbsolute(value)));
const options = new Map();for(let at=6;at<process.argv.length;at+=2)options.set(process.argv[at],process.argv[at+1]);
const control=options.get("--mode")==="aa",timingMode=options.get("--timing")||"gate",trials=Number(options.get("--pairs")||PRIVACY_PERFORMANCE_POLICY.pairs);
const machine=options.get("--machine")||"hosted-ci",hotRepetitions=PRIVACY_PERFORMANCE_POLICY.hot_repetitions;
const worker=options.has("--sample")?JSON.parse(options.get("--sample")):null;
assert.ok(["aa","compare"].includes(options.get("--mode")||"compare")&&["gate","report"].includes(timingMode));
assert.ok(Number.isSafeInteger(trials)&&trials>=5&&trials<=40);
const root=fs.mkdtempSync(path.join(os.tmpdir(),"ccdx-candidate-native-")),repository=fileURLToPath(new URL("../",import.meta.url));
const baselineCommit="cac4722b87d96d870f154edb46a300a5cf458d3a",samples=[];
const modelDirectory=worker?options.get("--model-directory"):path.join(root,"shared-model");assert.ok(path.isAbsolute(modelDirectory||""));
if(!worker){
 fs.mkdirSync(modelDirectory,{recursive:true});
 for(const file of PRIVACY_MODEL_FILES){const bytes=fs.readFileSync(path.join(weights,file.name));assert.equal(bytes.length,file.bytes);assert.equal(createHash("sha256").update(bytes).digest("hex"),file.sha256);fs.copyFileSync(path.join(weights,file.name),path.join(modelDirectory,file.name));}
 if(fs.existsSync(path.join(weights,"coreml")))fs.cpSync(path.join(weights,"coreml"),path.join(modelDirectory,"coreml"),{recursive:true});
}
const source=execFileSync("git",["show",baselineCommit+":src/local-privacy.mjs"],{cwd:repository,encoding:"utf8"})
  .replace(/from "\.\/([^"]+)"/g,(_,name)=>"from "+JSON.stringify(pathToFileURL(path.join(repository,"src",name)).href));
const {createLocalPrivacy:baseline}=await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));
const makeText=(count,chinese)=>Array.from({length:count},(_,i)=>chinese?"第"+i+"行包含普通说明文字和测试数据，不包含真实账户信息。\n":"line "+i+" contains ordinary sample text for an isolated history.\n").join("");
const workloads=[{name:"short-fields",values:Array.from({length:80},(_,i)=>"ordinary field "+i),append:"one additional field"},
  {name:"long-english",values:[makeText(480,false)],append:makeText(20,false)},
  {name:"long-chinese",values:[makeText(200,true)],append:makeText(10,true)}];
try {
 for(const workload of workloads) for(let trial=0;trial<trials;trial++) {
  if(worker&&(worker.workload!==workload.name||worker.trial!==trial))continue;
  const variants=trial%2?[["candidate-1.3.12",control?baseline:createLocalPrivacy],["baseline-1.3.11-detection",baseline]]:[["baseline-1.3.11-detection",baseline],["candidate-1.3.12",control?baseline:createLocalPrivacy]];
  for(const [label,factory] of variants) {
   if(worker&&worker.label!==label)continue;
   if(!worker){
    const value=execFileSync(process.execPath,[fileURLToPath(import.meta.url),component,weights,output,baselineComponent,
      "--mode",control?"aa":"compare","--pairs",String(trials),"--timing","report","--machine",machine,
      "--sample",JSON.stringify({workload:workload.name,trial,label}),"--model-directory",modelDirectory],{
      cwd:repository,env:testEnvironment(root,{PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH||"")}),encoding:"utf8",timeout:240000,maxBuffer:4*1024*1024});
    samples.push(JSON.parse(value));console.log(JSON.stringify({workload:workload.name,trial,variant:label,completed:true}));continue;
   }
   const home=path.join(root,workload.name,String(trial),label),env=testEnvironment(home,{XDG_CONFIG_HOME:path.join(home,"config"),XDG_CACHE_HOME:path.join(home,"cache")});
   const detector=createPrivacyModel({home,env,fetchImpl:async()=>{throw Error("Candidate replay forbids downloads")},
     spawnImpl:(file,_args,options)=>spawn(file,[modelDirectory],options)});let privacy;
   const isBaseline=control||label.startsWith("baseline");
   try {
    fs.mkdirSync(detector.paths.model,{recursive:true});fs.mkdirSync(path.dirname(detector.paths.runner),{recursive:true});
    for(const file of PRIVACY_MODEL_FILES)fs.linkSync(path.join(modelDirectory,file.name),path.join(detector.paths.model,file.name));
    const directory=isBaseline?baselineComponent:component,binary=fs.readFileSync(path.join(directory,detector.paths.name));
    if(isBaseline){const manifest=fs.readFileSync(path.join(directory,"SHA256SUMS"),"utf8");const expected=manifest.split("\n").find(line=>line.endsWith("  "+detector.paths.name))?.slice(0,64);assert.equal(createHash("sha256").update(binary).digest("hex"),expected,"Baseline component bytes changed");}
    const release=isBaseline?"1.3.10":PRIVACY_COMPONENT_RELEASE,runner=path.join(detector.paths.components,release,detector.paths.name);fs.mkdirSync(path.dirname(runner),{recursive:true});fs.writeFileSync(runner,binary,{mode:0o700});
    fs.writeFileSync(runner+".json",JSON.stringify({release,abi:PRIVACY_COMPONENT_ABI,model_revision:PRIVACY_MODEL_REVISION,sha256:createHash("sha256").update(binary).digest("hex")}));
    const load=performance.now();await detector.load();if(!isBaseline)assert.equal(detector.snapshot().window_cache,true,"Window reuse capability missing");
    assert.equal(detector.snapshot().component_release,release,"The selected component changed during measurement");
    const loadMs=performance.now()-load,settings=userSettingsPath({home,env});fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,JSON.stringify({privacy_enabled:true}));
    let calls=0,bytes=0,evaluations=0,hits=0,totals=0;const findings=new Map();
    const model={...detector,close(){},stop(){},find:async(texts,options={})=>{const found=await detector.find(texts,{...options,cacheWindows:!isBaseline,
      onWindowWork(work){evaluations+=work.evaluated;hits+=work.hits+work.shared;totals+=work.total;options.onWindowWork?.(work)},
      onSubmitted(){calls++;bytes+=texts.reduce((sum,text)=>sum+Buffer.byteLength(text),0);options.onSubmitted?.()}});
      texts.forEach((text,index)=>findings.set(createHash("sha256").update(text).digest("hex"),found[index]));return found;}};
    privacy=factory({home,env,model,...(isBaseline?{checkTimeoutMs:180000}:{})});
    const first={messages:workload.values.map(content=>({role:"user",content}))},next=workload.name==="short-fields"?{messages:[...first.messages,{role:"user",content:workload.append}]}:{messages:[{role:"user",content:workload.values[0]+workload.append}]};
    const timings=[];
    for(const [phase,body]of [["cold",first],["append",next],["hot",next]]) {
      findings.clear();const oldCalls=calls,oldBytes=bytes,oldEvaluations=evaluations,oldHits=hits,oldTotals=totals,start=performance.now(),repetitions=phase==="hot"?hotRepetitions:1;
      for(let at=0;at<repetitions;at++)await privacy.prepare(body,{protocol:"messages",client:"isolated_candidate"});
      const sample={phase,ms:(performance.now()-start)/repetitions,repetitions,submitted_batches:calls-oldCalls,submitted_bytes:bytes-oldBytes,window_evaluations:evaluations-oldEvaluations,window_hits:hits-oldHits,window_total:totals-oldTotals,
        wait_budget_ms:privacy.snapshot().last_check?.wait_budget_ms||180000,
        finding_digest:createHash("sha256").update(JSON.stringify([...findings].sort(([a],[b])=>a.localeCompare(b)))).digest("hex")};timings.push(sample);
      if(phase==="hot")assert.equal(sample.submitted_batches,0,"Exact hot history repeated native work");
    }
    const probe=["The password is "+["hun","terTwo","Three"].join("")+". Please keep it private.","张三的邮箱是 "+["private","sample"].join(".")+"@example.org。"];
    const probeResult=await detector.find(probe,{cacheWindows:!isBaseline});
    samples.push({probe:probeResult,js_process_id:process.pid,component_release:detector.snapshot().component_release,component_sha256:createHash("sha256").update(binary).digest("hex"),workload:workload.name,variant:label,trial,input_bytes:workload.values.reduce((sum,text)=>sum+Buffer.byteLength(text),0),load_ms:loadMs,backend:detector.snapshot().backend,device:detector.snapshot().device,timings});
   }finally{privacy?.close();detector.close();fs.rmSync(home,{recursive:true,force:true,maxRetries:3})}
  }
 }
 if(worker){assert.equal(samples.length,1);console.log(JSON.stringify(samples[0]));}
 else{
 const analysis=summarizePerformanceSamples(samples,{control});
 for(const workload of workloads){
  const before=samples.filter(s=>s.workload===workload.name&&s.variant.startsWith("baseline")),after=samples.filter(s=>s.workload===workload.name&&s.variant.startsWith("candidate"));
  for(let trial=0;trial<trials;trial++){
    const a=before[trial].probe,b=after[trial].probe;assert.equal(a.length,b.length);for(let row=0;row<a.length;row++){assert.equal(a[row]?.length||0,b[row]?.length||0,"Classifier spans changed");for(let span=0;span<(a[row]?.length||0);span++){assert.equal(a[row][span].start,b[row][span].start);assert.equal(a[row][span].end,b[row][span].end);assert.equal(a[row][span].label,b[row][span].label);assert.ok(Math.abs(a[row][span].score-b[row][span].score)<0.000001,"Classifier score changed");}}
    if(!control)assert.equal(after[trial].timings[0].window_evaluations,after[trial].timings[0].window_total,"Cold input must not reuse calibration windows or duplicate inference");
    assert.equal(after[trial].timings[0].finding_digest,before[trial].timings[0].finding_digest,"Cold classifier results changed");
    assert.equal(after[trial].timings[1].finding_digest,before[trial].timings[1].finding_digest,"Append classifier results changed");
    if(!control&&workload.name!=="short-fields")assert.ok(after[trial].timings[1].window_evaluations<after[trial].timings[1].window_total/2,"Append repeated unchanged windows");
  }
 }
 const result={version:JSON.parse(fs.readFileSync(path.join(repository,"package.json"))).version,platform:process.platform,arch:process.arch,baseline_commit:baselineCommit,
  comparison_scope:"Verified 1.3.11 baseline, paired fresh JS and native processes for every sample, same owned model directory with copied weights and acceleration cache. Detector caches are empty for cold input. Candidate uses production waits. Hot means amortized repeated same-body checks. No downloads, cloud inference or signed App execution.",
  mode:control?"aa":"compare",machine,runtime_fingerprint:privacyRuntimeFingerprint(repository),measurement_fingerprint:privacyMeasurementFingerprint(repository),
  machine_configuration:{platform:process.platform,arch:process.arch,os_release:os.release(),available_parallelism:os.availableParallelism()},samples,...analysis};
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,"privacy-candidate-"+process.platform+"-"+process.arch+".json"),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
 if(process.env.GITHUB_STEP_SUMMARY){
  const rows=result.comparisons.flatMap(row=>Object.entries(row.phases).map(([phase,value])=>`| ${row.workload} | ${phase} | ${(100*(value.ratio_median-1)).toFixed(2)}% | ${value.interval.low.toFixed(4)} – ${value.interval.high===null?"unknown":value.interval.high.toFixed(4)} | ${value.decision} |`));
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\nPrivacy performance: ${result.decision}\n\n| Workload | Phase | Paired median | Confidence interval | Decision |\n|---|---|---|---|---|\n${rows.join("\n")}\n`);
 }
 if(timingMode==="gate")assert.equal(result.decision,control?"qualified":"pass","Privacy performance evidence did not pass; receipt retained");
 else if(result.decision!==(control?"qualified":"pass"))console.log("::warning::Privacy timing "+result.decision+"; correctness remains blocking, fixed-machine release evidence required");
 }
}finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:3})}
