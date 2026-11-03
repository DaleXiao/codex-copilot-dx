import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createLocalPrivacy} from '../src/local-privacy.mjs';import {startAdapter} from '../src/adapter.mjs';import {startClaudeGateway} from '../src/claude-gateway.mjs';import {userSettingsPath} from '../src/user-settings.mjs';
import {createPrivacyModel,PRIVACY_COMPONENT_RELEASE,PRIVACY_COMPONENT_ABI,PRIVACY_MODEL_REVISION,PRIVACY_MODEL_FILES} from '../src/privacy-model.mjs';import {createHash} from 'node:crypto';import {testEnvironment} from '../test/helpers/environment.mjs';
process.env.CCDX_DISABLE_USAGE='1';
const opts=new Map(process.argv.slice(2).reduce((a,v,i,all)=>i%2?a:[...a,[v,all[i+1]]],[]));const binary=opts.get('--binary'),kind=opts.get('--client'),mode=opts.get('--privacy')||'on';assert.ok(path.isAbsolute(binary)&&fs.existsSync(binary)&&['codex','claude'].includes(kind)&&['on','off'].includes(mode));
const targetRounds=Number(opts.get('--rounds')||2);assert.ok(Number.isInteger(targetRounds)&&targetRounds>=2&&targetRounds<=12);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-private-client-')),profile=path.join(root,kind),work=path.join(root,'workspace');fs.mkdirSync(profile);fs.mkdirSync(work);
const env=testEnvironment(root,{XDG_CONFIG_HOME:path.join(root,'config'),XDG_CACHE_HOME:path.join(root,'cache')}),settings=userSettingsPath({home:root,env});fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,JSON.stringify({privacy_enabled:mode==='on'}));
const sentinel='ghp_'+ 'p'.repeat(36),receipt=path.join(root,'mcp-result.json'),component=opts.get('--component-dir'),weights=opts.get('--model-dir');
let rounds=0,returned=false,calls=[],checks=0,recovery=null;const checkWork=[];let server,child,privacy,detector;
function declarations(tools,namespace){return (tools||[]).flatMap(t=>t.type==='namespace'?declarations(t.tools,t.name):[{name:t.name||t.function?.name,type:t.type||'function',...(namespace?{namespace}:{})}]);}
function requestTools(body){return [...(body.tools||[]),...(body.input||[]).flatMap(item=>item.type==='additional_tools'?item.tools||[]:[])];}
function chosen(body,needle){return declarations(requestTools(body)).find(t=>t.name?.includes(needle));}
function tokenIn(body){const text=JSON.stringify(body);if(mode==='on'){assert.ok(!text.includes(sentinel),'original synthetic credential reached mock upstream');const m=text.match(/Credential: (\{\{CCDX_[a-f0-9]{24}\}\})/);assert.ok(m,'mock model cannot locate the requested credential placeholder');return m[1];}return sentinel;}
function response(body,protocol){
 rounds++;assert.ok(rounds<=targetRounds,'unexpected extra model round');const token=tokenIn(body),toolRound=rounds<targetRounds;
 if(rounds>1){const text=JSON.stringify(body);returned=text.includes('MCP_EXECUTED:')&&(kind!=='codex'||text.includes('SHELL_EXECUTED:'))&&fs.existsSync(receipt)&&JSON.parse(fs.readFileSync(receipt)).valid;}
 const tool=chosen(body,'privacy_fixture__echo')||chosen(body,'echo')||chosen(body,'exec');const input={type:'thinking',id:token,name:token,signature:token,encrypted_content:token,data:token};
 calls.push({round:rounds,tool:tool?.name,returned,input_types:(body.input||[]).map(x=>x.type)});
 if(protocol==='messages'){
  const content=toolRound?[{type:'tool_use',id:'tool_private_fixture_'+rounds,name:tool?.name||'mcp__privacy_fixture__echo',input}]:[{type:'text',text:returned?'NATIVE_TOOL_ROUND_OK':'NATIVE_TOOL_ROUND_FAILED'}];
  const msg={id:'msg_fixture_'+rounds,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}};
  const events=[{type:'message_start',message:msg},{type:'content_block_start',index:0,content_block:toolRound?{...content[0],input:{}}:{type:'text',text:''}}];
  if(toolRound){const json=JSON.stringify(input);events.push({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:json.slice(0,21)}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:json.slice(21)}});}else events.push({type:'content_block_delta',index:0,delta:{type:'text_delta',text:content[0].text}});
  events.push({type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:toolRound?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'});return sse(events);
 }
 const item=toolRound&&tool?.type==='custom'?{type:'custom_tool_call',id:'cc_private_fixture_'+rounds,call_id:'call_private_fixture_'+rounds,name:tool.name,...(tool.namespace?{namespace:tool.namespace}:{}),input:`const result = await tools.mcp__privacy_fixture__echo(${JSON.stringify(input)}); text(result); const command = await tools.exec_command(${JSON.stringify({cmd: "echo 'SHELL_EXECUTED:"+token+"'",yield_time_ms:1000,max_output_tokens:1000})}); text(command);`,status:'completed'}:toolRound?{type:'function_call',id:'fc_private_fixture_'+rounds,call_id:'call_private_fixture_'+rounds,name:tool?.name||'mcp__privacy_fixture__echo',...(tool?.namespace?{namespace:tool.namespace}:{}),arguments:JSON.stringify(input),status:'completed'}:{type:'message',id:'msg_private_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:returned?'NATIVE_TOOL_ROUND_OK':'NATIVE_TOOL_ROUND_FAILED',annotations:[]}]};
 const resp={id:'resp_fixture_'+rounds,object:'response',model:body.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 const events=[{type:'response.created',response:{...resp,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',...(toolRound?item.type==='custom_tool_call'?{input:''}:{arguments:''}:{content:[]})}}];
 if(toolRound&&item.type==='custom_tool_call')events.push({type:'response.custom_tool_call_input.delta',output_index:0,item_id:item.id,delta:item.input.slice(0,21)},{type:'response.custom_tool_call_input.delta',output_index:0,item_id:item.id,delta:item.input.slice(21)},{type:'response.custom_tool_call_input.done',output_index:0,item_id:item.id,input:item.input});
 else if(toolRound)events.push({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments.slice(0,21)},{type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments.slice(21)},{type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:item.arguments});
 else events.push({type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:item.content[0].text});
 events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:resp});return sse(events);
}
function sse(events){return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});}
const fixture=fileURLToPath(new URL('./replay-fixtures/privacy-mcp.mjs',import.meta.url));const key='a'.repeat(64);
try{
 let model={load:async()=>{},find:async texts=>texts.map(()=>[]),snapshot:()=>({state:'ready'}),close(){},busy:()=>false};
 if(component){
  assert.ok(mode==='on'&&path.isAbsolute(component)&&path.isAbsolute(weights));
  const release=opts.get('--component-release')||PRIVACY_COMPONENT_RELEASE;assert.ok([PRIVACY_COMPONENT_RELEASE,'1.3.6','1.3.9'].includes(release));
  detector=createPrivacyModel({home:root,env,fetchImpl:async()=>{throw Error('Replay forbids background downloads');}});fs.mkdirSync(detector.paths.model,{recursive:true});fs.mkdirSync(path.dirname(detector.paths.runner),{recursive:true});
  for(const file of PRIVACY_MODEL_FILES)fs.copyFileSync(path.join(weights,file.name),path.join(detector.paths.model,file.name));
  const runner=fs.readFileSync(path.join(component,detector.paths.name)),target=release==='1.3.6'?detector.paths.legacyRunner:path.join(detector.paths.components,release,detector.paths.name);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,runner,{mode:0o700});fs.writeFileSync(target+'.json',JSON.stringify({release,abi:PRIVACY_COMPONENT_ABI,model_revision:PRIVACY_MODEL_REVISION,sha256:createHash('sha256').update(runner).digest('hex')}));
  await detector.load();model={...detector,find:async (texts,options={})=>{
    checks++;const sizes=texts.map(text=>Buffer.byteLength(text)),row={texts:texts.length,bytes:sizes.reduce((a,b)=>a+b,0),max_text_bytes:Math.max(...sizes),hashes:texts.map(text=>createHash('sha256').update(text).digest('hex')),submitted:false},start=performance.now();
    if(checkWork.length<64)checkWork.push(row);try{return await detector.find(texts,{...options,onSubmitted(){row.submitted=true;options.onSubmitted?.();}});}finally{row.elapsed_ms=Math.round(performance.now()-start);}
  }};
 }
 const privacyOptions={home:root,env,model};privacy=createLocalPrivacy(privacyOptions);
 if(detector){
  privacyOptions.checkTimeoutMs=1;
  const sample={input:'Synthetic cold history with ordinary text. '.repeat(512)};
  await assert.rejects(privacy.prepare(sample,{protocol:'responses'}),{code:'ccdx_privacy_check_timeout'});
  const pending=detector.snapshot().pending_checks;assert.ok(pending>0,'the real native job must survive its waiter');
  const deadline=Date.now()+180000;
  while(privacy.busy()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(privacy.busy(),false);const completed=new Set(checkWork.filter(row=>row.submitted).flatMap(row=>row.hashes)),before=checkWork.length;privacyOptions.checkTimeoutMs=15000;
  assert.equal(await privacy.prepare(sample,{protocol:'responses'}),sample);
  const newPieces=checkWork.slice(before).filter(row=>row.submitted).flatMap(row=>row.hashes);assert.ok(newPieces.every(hash=>!completed.has(hash)),'retry repeated a completed native piece');
  const hot=checks;assert.equal(await privacy.prepare(sample,{protocol:'responses'}),sample);assert.equal(checks,hot,'exact hot history repeated native work');
  recovery={timed_out:true,physical_jobs_after_timeout:pending,repeated_pieces:0,remaining_pieces:newPieces.length,hot_repeated_checks:checks-hot};
 }
 server=kind==='codex'?await startAdapter(0,'127.0.0.1',{privacy,env,dashboardOptions:{home:root,env},modelRegistry:{models:{data:[{id:'gpt-6.1-sol',supported_endpoints:['/responses'],capabilities:{supports:{tool_calls:true}}}]}},codexClient:{getCachedModelEndpoints:()=>['/responses']},responsesFn:async body=>response(body,'responses')}):await startClaudeGateway({port:0,apiKey:key,privacy,privacyClient:'claude_code',env,record(){},provider:{id:'m365',models:()=>[{id:'claude-opus-5.5'}],client:{messages:async body=>response(body,'messages')}}});
 const port=kind==='codex'?server.address().port:server.port;
 const childEnv=testEnvironment(root);
 childEnv.CCDX_DISABLE_USAGE='1';let args;
 if(kind==='codex'){
  childEnv.CODEX_HOME=profile;childEnv.CCDX_FIXTURE_KEY='synthetic';
  fs.writeFileSync(path.join(profile,'config.toml'),`model_provider="privacy_fixture"\nmodel="gpt-6.1-sol"\nmodel_reasoning_effort="low"\nweb_search="disabled"\n[features]\napps=false\nplugins=false\nremote_plugin=false\n[model_providers.privacy_fixture]\nname="Privacy fixture"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nenv_key="CCDX_FIXTURE_KEY"\nsupports_websockets=false\nrequest_max_retries=${detector?3:0}\nstream_max_retries=0\n[mcp_servers.privacy_fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([fixture,receipt,sentinel])}\n`);
  args=['exec','--ephemeral','--json','--skip-git-repo-check','--sandbox','read-only','--cd',work,`Synthetic tool privacy test. Credential: ${sentinel}. Use the fixture echo tool, then report the result.`];
 }else{
  childEnv.CLAUDE_CONFIG_DIR=profile;childEnv.ANTHROPIC_BASE_URL=`http://127.0.0.1:${port}`;childEnv.ANTHROPIC_AUTH_TOKEN=key;childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
  const cfg=path.join(root,'mcp.json');fs.writeFileSync(cfg,JSON.stringify({mcpServers:{privacy_fixture:{command:process.execPath,args:[fixture,receipt,sentinel]}}}));
  args=['-p',`Synthetic tool privacy test. Credential: ${sentinel}. Use the fixture echo tool, then report the result.`,'--model','claude-opus-5.5','--output-format','stream-json','--verbose','--mcp-config',cfg,'--strict-mcp-config','--allowedTools','mcp__privacy_fixture__echo'];
 }
 child=spawn(binary,args,{cwd:work,env:childEnv,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>{try{if(process.platform==='win32')child.kill();else process.kill(-child.pid,'SIGTERM');}catch{}},detector?180000:90000);const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});clearTimeout(timer);
 const executed=fs.existsSync(receipt)?JSON.parse(fs.readFileSync(receipt)):null;console.log(JSON.stringify({client:kind,privacy:mode,detector:detector?'native':'simulated',component_release:detector?.snapshot().component_release,target_rounds:targetRounds,checks,check_work:checkWork,recovery,code,rounds,calls,executed,returned,continued:stdout.includes('NATIVE_TOOL_ROUND_OK'),stderr_tail:stderr.slice(-1400)}));
 assert.equal(code,0);assert.equal(rounds,targetRounds);assert.equal(executed?.executions,targetRounds-1);assert.ok(executed?.valid&&returned&&stdout.includes('NATIVE_TOOL_ROUND_OK'),'native tool execution/return/continuation did not complete');
}finally{
 if(child&&child.exitCode===null){try{if(process.platform==='win32')child.kill();else process.kill(-child.pid,'SIGTERM');}catch{}}
 if(kind==='codex'&&server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else await server?.close();privacy?.close();detector?.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:3});
}
