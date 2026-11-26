import {uniqueModelEntries} from "./model-catalog.mjs";
import {modelDisplayName} from "./model-display.mjs";
import {modelReasoningEfforts} from "./provider-metadata.mjs";
export const ANTIGRAVITY_MODEL_PREFIX = "ccdx-copilot-";
export const ANTIGRAVITY_NATIVE_PREFIX = "ccdx-gemini-";
const geminiModel = /^gemini-[a-z0-9][a-z0-9._-]{0,100}$/;
const knownEfforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export function antigravityCopilotModels(catalog) {
  const data=Array.isArray(catalog)?catalog:catalog?.data;
  return uniqueModelEntries(Array.isArray(data)?data:[]).filter(model=>geminiModel.test(model?.id)
    &&model.model_picker_enabled!==false&&(!model.policy?.state||model.policy.state==="enabled")
    &&(!model.capabilities?.type||model.capabilities.type==="chat")
    &&model.capabilities?.supports?.streaming!==false&&model.capabilities?.supports?.tool_calls!==false
    &&model.supported_endpoints?.some(endpoint=>["/chat/completions","/v1/chat/completions"].includes(endpoint)))
    .flatMap(model=>{
      const efforts=modelReasoningEfforts(model)||[],fallback=model.id.split("-").map(word=>word[0].toUpperCase()+word.slice(1)).join(" ");
      const name=modelDisplayName({...model,name:model.name||fallback}),label=/gemini/i.test(name)?name:"Gemini · "+name;
      return (efforts.length?efforts:[null]).map(effort=>({
        id:ANTIGRAVITY_MODEL_PREFIX+model.id+(effort?"-"+effort:""),model:model.id,effort,
        displayName:label+" · Copilot"+(effort?" ("+effort[0].toUpperCase()+effort.slice(1)+")":""),
        maxTokens:model.capabilities?.limits?.max_context_window_tokens,maxOutputTokens:model.capabilities?.limits?.max_output_tokens,
        supportsImages:model.capabilities?.supports?.vision===true,
      }));
    });
}

export function groupAntigravityModels(listed, catalog) {
  const data = Array.isArray(catalog) ? catalog : catalog?.data;
  const base = new Map();
  for (const model of uniqueModelEntries(Array.isArray(data) ? data : [])) {
    if (!geminiModel.test(model?.base_model_id) || !geminiModel.test(model.id) || model.base_model_id === model.id
      || !knownEfforts.has(model.reasoning_effort)) continue;
    base.set(model.id, { id: model.base_model_id, effort: model.reasoning_effort });
  }
  const nameOf = name => name.split(" · Copilot")[0];
  const names = new Map(listed.map(variant => [variant.model, nameOf(variant.name)]));
  const groups = new Map();
  for (const variant of listed) {
    const candidate = base.get(variant.model);
    const explicit = candidate && !base.has(candidate.id) && (!variant.effort || variant.effort === candidate.effort) ? candidate : null;
    const id = explicit?.id || variant.model;
    if (!groups.has(id)) {
      const name = names.get(id) || id.split("-").map(word => word[0]?.toUpperCase() + word.slice(1)).join(" ");
      groups.set(id, { id, name, source: "github", context_window: variant.context_window, default: false, efforts: [] });
    }
    const group = groups.get(id);
    if (Number.isFinite(group.context_window) && Number.isFinite(variant.context_window)) {
      group.context_window = Math.min(group.context_window, variant.context_window);
    } else group.context_window = undefined;
    group.default ||= variant.default;
    group.efforts.push({ id: variant.id, effort: explicit?.effort || variant.effort, selected: variant.selected });
  }
  return [...groups.values()];
}

// Use the upstream's existing agent-default field only when it names a model
// in the same catalog. Do not invent a default contract for an unknown catalog.
export function hasAntigravityAgentDefault(catalog) {
  const id=catalog?.defaultAgentModelId;
  return typeof id==="string"&&!!catalog.models&&Object.hasOwn(catalog.models,id);
}

export function antigravityGroupingClient(version) {
  const match=typeof version==="string"&&/^2\.(\d{1,3})\.\d{1,4}(?:\.\d{1,4})?$/.exec(version);
  return Boolean(match&&Number(match[1])>=35);
}

function nativeGrouping(catalog) {
  const groups = catalog.groupedModels;
  return Boolean(groups && typeof groups === "object" && !Array.isArray(groups) && Object.entries(groups).some(([id, group]) =>
    Array.isArray(group?.supportedThinkingLevels) && group.supportedThinkingLevels.some(level =>
      typeof level?.thinkingSuffix === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(level.thinkingSuffix)
      && Object.hasOwn(catalog.models, id + "-" + level.thinkingSuffix))));
}

export function groupedAntigravityRoutes(id, group, models) {
  const aliases = new Map((group.supportedThinkingLevels || []).flatMap(({thinkingSuffix:suffix})=>{
    const effort=suffix.replace(/^-/,""),alias=id+"-"+effort;
    return Object.hasOwn(models,alias)?[[effort,alias]]:[];
  }));
  return {aliases,defaultAlias:aliases.get(group.defaultThinkingSuffix?.replace(/^-/,""))};
}

export function mergeAntigravityModels(googleCatalog,copilotCatalog,selection=null,defaultModel=null,nativeModels=[],groupCapable=false) {
  if(!googleCatalog?.models||typeof googleCatalog.models!=="object"||Array.isArray(googleCatalog.models))throw new Error("Unrecognized Google model catalog");
  const entries=[...antigravityCopilotModels(copilotCatalog).filter(model=>selection===null||selection.includes(model.id)),...nativeModels],models={...googleCatalog.models};
  if(!entries.length)return googleCatalog;
  const used=new Set(Object.values(models).map(model=>model?.model));let next=500;
  const modelId=()=>{
    while(next<600&&used.has("MODEL_PLACEHOLDER_M"+next))next++;
    if(next>=600)return null;
    const model="MODEL_PLACEHOLDER_M"+next++;used.add(model);return model;
  };
  for(const entry of entries){
    const model=modelId();
    if(!model||Object.hasOwn(models,entry.id))throw new Error("Antigravity model catalog has no free client identifiers");
    models[entry.id]={displayName:entry.displayName,model,maxTokens:entry.maxTokens,maxOutputTokens:entry.maxOutputTokens,
      supportsImages:entry.supportsImages,supportsThinking:Boolean(entry.effort),apiProvider:"API_PROVIDER_GOOGLE_GEMINI"};
  }
  const sorts=googleCatalog.agentModelSorts?.length?structuredClone(googleCatalog.agentModelSorts):[{displayName:"Recommended",groups:[]}];
  // Gemini App reads only the first group in the Recommended sort.
  const sort=sorts.find(item=>item.displayName?.toLowerCase()==="recommended")||sorts[0];
  sort.groups??=[];sort.groups[0]??={modelIds:[]};
  const parents=new Map();
  let groupedModels;
  if(groupCapable||nativeGrouping(googleCatalog)){
    const copilot=entries.filter(row=>row.id.startsWith(ANTIGRAVITY_MODEL_PREFIX));
    groupedModels={...googleCatalog.groupedModels};
    for(const group of groupAntigravityModels(copilot.map(row=>({...row,name:row.displayName})),copilotCatalog)){
      const parent=ANTIGRAVITY_MODEL_PREFIX+group.id;
      const rows=group.efforts.filter(row=>row.effort&&row.id===parent+"-"+row.effort);
      if(rows.length<2||Object.hasOwn(models,parent)||Object.hasOwn(groupedModels,parent))continue;
      const chosen=rows.find(row=>row.id===defaultModel)||rows.find(row=>row.effort==="medium")||rows[0];
      const displayName=models[chosen.id].displayName.split(" · Copilot")[0]+" · Copilot";
      // The app filters sort entries against models and looks up each variant as parent + '-' + suffix.
      const model=modelId();if(!model)continue;
      models[parent]={...models[chosen.id],model,displayName};
      groupedModels[parent]={displayName,defaultThinkingSuffix:chosen.effort,supportedThinkingLevels:rows.map(row=>({
        thinkingSuffix:row.effort,thinkingDisplayName:row.effort==="xhigh"?"XHigh":row.effort[0].toUpperCase()+row.effort.slice(1),
      }))};
      for(const row of rows)parents.set(row.id,parent);
    }
  }
  sort.groups[0].modelIds=[...(sort.groups[0].modelIds||[]),...new Set(entries.map(entry=>parents.get(entry.id)||entry.id))];
  return {...googleCatalog,models,agentModelSorts:sorts,...(groupedModels?{groupedModels}:{}),
    ...(hasAntigravityAgentDefault(googleCatalog)&&entries.some(entry=>entry.id===defaultModel)?{defaultAgentModelId:defaultModel}:{})};
}
