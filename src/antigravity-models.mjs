const supported = new Map([["gemini-4-carbon","Carbon"],["gemini-4-argon","Argon"]]);
const levels = ["low","medium","high"];
export const ANTIGRAVITY_MODEL_PREFIX = "ccdx-copilot-";

export function antigravityCopilotModels(catalog) {
  const data=Array.isArray(catalog)?catalog:catalog?.data;
  return (data||[]).filter(model=>supported.has(model.id)&&model.policy?.state!=="disabled"&&model.supported_endpoints?.some(endpoint=>["/chat/completions","/v1/chat/completions"].includes(endpoint)))
    .flatMap(model=>levels.filter(level=>model.capabilities?.supports?.reasoning_effort?.includes(level)).map(effort=>({
      id:ANTIGRAVITY_MODEL_PREFIX+model.id+"-"+effort,model:model.id,effort,
      displayName:"Gemini 4 "+supported.get(model.id)+" · Copilot ("+effort[0].toUpperCase()+effort.slice(1)+")",
      maxTokens:model.capabilities.limits?.max_context_window_tokens,maxOutputTokens:model.capabilities.limits?.max_output_tokens,
      supportsImages:model.capabilities.supports.vision===true,
    })));
}

export function mergeAntigravityModels(googleCatalog,copilotCatalog,selection=null) {
  if(!googleCatalog?.models||typeof googleCatalog.models!=="object"||Array.isArray(googleCatalog.models))throw new Error("Unrecognized Google model catalog");
  const entries=antigravityCopilotModels(copilotCatalog).filter(model=>selection===null||selection.includes(model.id)),models={...googleCatalog.models};
  if(!entries.length)return googleCatalog;
  const used=new Set(Object.values(models).map(model=>model?.model));let next=500;
  for(const entry of entries){
    while(next<600&&used.has("MODEL_PLACEHOLDER_M"+next))next++;
    if(next>=600||Object.hasOwn(models,entry.id))throw new Error("Antigravity model catalog has no free client identifiers");
    const model="MODEL_PLACEHOLDER_M"+next++;used.add(model);
    models[entry.id]={displayName:entry.displayName,model,maxTokens:entry.maxTokens,maxOutputTokens:entry.maxOutputTokens,
      supportsImages:entry.supportsImages,supportsThinking:true,apiProvider:"API_PROVIDER_GOOGLE_GEMINI"};
  }
  const sorts=googleCatalog.agentModelSorts?.length?structuredClone(googleCatalog.agentModelSorts):[{displayName:"Recommended",groups:[]}];
  // Gemini App reads only the first group in the Recommended sort.
  const sort=sorts.find(item=>item.displayName?.toLowerCase()==="recommended")||sorts[0];
  sort.groups??=[];sort.groups[0]??={modelIds:[]};
  sort.groups[0].modelIds=[...(sort.groups[0].modelIds||[]),...entries.map(entry=>entry.id)];
  return {...googleCatalog,models,agentModelSorts:sorts};
}
