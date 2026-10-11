import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { readSuggestionConfig, suggestionConfigPath } from "./suggestion-config.mjs";
import { readSuggestionContext } from "./suggestion-context.mjs";
import { generateSuggestion } from "./suggestion-provider.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const RETENTION_MS = 10 * 60_000;
function storeDirectory(filePath) { return path.join(path.dirname(filePath), "suggestion-state"); }
function keyFile(filePath, threadId) {
  if (!UUID.test(threadId)) throw new Error("Invalid suggestion conversation ID");
  return path.join(storeDirectory(filePath), `${createHash("sha256").update(threadId).digest("hex")}.json`);
}
function readRecord(file) {
  try {
    const stat=fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) return null;
    const record = JSON.parse(fs.readFileSync(file,"utf8"));
    return record && typeof record === "object" && !Array.isArray(record) ? record : null;
  } catch { return null; }
}
export function readAutomaticSuggestion(filePath, threadId) { return readRecord(keyFile(filePath, threadId)); }
function save(filePath, threadId, record) { atomicWriteFileIfChangedSync(keyFile(filePath,threadId),JSON.stringify(record)+"\n"); }
function cleanup(directory, now) {
  const files = fs.readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
  const retained = [];
  for (const name of files) {
    const file=path.join(directory,name),record=readRecord(file);
    if (!record || !Number.isFinite(record.at) || now-record.at>RETENTION_MS) fs.unlinkSync(file);
    else retained.push({file,at:record.at});
  }
  retained.sort((a,b)=>b.at-a.at);
  for(const record of retained.slice(31))fs.unlinkSync(record.file);
}
export function automaticSuggestionStatus(filePath, now = Date.now()) {
  try {
    const directory=storeDirectory(filePath);
    const records=fs.readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).slice(0,64)
      .map(name=>readRecord(path.join(directory,name))).filter(record=>record && Number.isFinite(record.at)&&now-record.at<=RETENTION_MS);
    const recent=records.sort((a,b)=>b.at-a.at)[0];
    return recent ? { state:["generating","ready","empty","failed","cancelled"].includes(recent.state)?recent.state:"unknown",
      at:new Date(recent.at).toISOString(),reason:["context_unavailable","model_failed","settings_changed","turn_changed","timeout"].includes(recent.reason)?recent.reason:null } : {state:"idle",at:null,reason:null};
  } catch { return {state:"idle",at:null,reason:null}; }
}

export async function runAutomaticSuggestion(event, {
  filePath = suggestionConfigPath(), readContext = readSuggestionContext, generate = generateSuggestion,
  now = Date.now, timeoutMs = 30_000,
} = {}) {
  const config=readSuggestionConfig({filePath});
  if(!config.enabled || !config.automatic || event?.hook_event_name!=="Stop" || event.stop_hook_active===true
    || !UUID.test(event.session_id||"") || !UUID.test(event.turn_id||"")) return {skipped:true};
  const threadId=event.session_id,turnId=event.turn_id,directory=storeDirectory(filePath);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(!fs.lstatSync(directory).isDirectory())return {skipped:true};
  cleanup(directory,now());
  const prior=readAutomaticSuggestion(filePath,threadId);
  if(prior?.turnId===turnId)return {skipped:true};
  // One local slot bounds independent asynchronous hook processes. Only owned
  // lock files are reclaimed after their 30-second operation deadline.
  let lock;
  for(let slot=0;slot<1;slot++){
    const file=path.join(directory,`slot-${slot}.lock`);
    try{if(now()-fs.statSync(file).mtimeMs>60_000)fs.unlinkSync(file)}catch(error){if(error.code!=="ENOENT")return {skipped:true}}
    try{const fd=fs.openSync(file,"wx",0o600);fs.closeSync(fd);lock=file;break}catch(error){if(error.code!=="EEXIST")return {skipped:true}}
  }
  if(!lock)return {skipped:true,busy:true};
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs);
  let stage="context_unavailable";
  try {
    // The slot acquisition and marker commit are synchronous within this process.
    if(readAutomaticSuggestion(filePath,threadId)?.turnId===turnId)return {skipped:true};
    save(filePath,threadId,{state:"generating",at:now(),turnId,model:config.model});
    const page=await readContext(threadId,config,{signal:abort.signal,includePage:true});
    if(page.latestTurnId!==turnId){save(filePath,threadId,{state:"cancelled",at:now(),turnId,model:config.model,reason:"turn_changed"});return {skipped:true};}
    const current=readSuggestionConfig({filePath});
    if(!current.enabled||!current.automatic||current.model!==config.model||current.adapter_url!==config.adapter_url){stage="settings_changed";throw new Error();}
    stage="model_failed";
    const suggestion=await generate(page.messages,config,{signal:abort.signal});
    abort.signal.throwIfAborted();
    const latest=readSuggestionConfig({filePath});
    if(!latest.enabled||!latest.automatic||latest.model!==config.model||latest.adapter_url!==config.adapter_url){stage="settings_changed";throw new Error();}
    stage="context_unavailable";
    const finalPage=await readContext(threadId,config,{signal:abort.signal,includePage:true});
    if(finalPage.latestTurnId!==turnId){stage="turn_changed";throw new Error();}
    const result={state:suggestion?"ready":"empty",at:now(),turnId,model:config.model,suggestion,candidate_id:suggestion?randomUUID():null};
    save(filePath,threadId,result);return result;
  } catch {
    const result={state:abort.signal.aborted?"cancelled":"failed",at:now(),turnId,model:config.model,reason:abort.signal.aborted?"timeout":stage};
    // Don't overwrite a newer hook's marker.
    if(readAutomaticSuggestion(filePath,threadId)?.turnId===turnId)save(filePath,threadId,result);
    return result;
  } finally {clearTimeout(timer);try{fs.unlinkSync(lock)}catch{}}
}

async function main(){
  let chunks=[],bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>64*1024)return;chunks.push(chunk)}
  let event;try{event=JSON.parse(Buffer.concat(chunks).toString("utf8"))}catch{return}
  // Informational hook: no continuation, warnings, approval or user messages.
  await runAutomaticSuggestion(event);
  process.stdout.write("{}\n");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stdout.write("{}\n")});
