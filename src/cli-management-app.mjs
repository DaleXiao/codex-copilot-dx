import { CLI_CLIENTS } from "./cli-command-spec.mjs";
import { projectTerminalState, retainedRequests, clientSetup, TERMINAL_CLIENT_NAMES } from "./terminal-state.mjs";
import { terminalCell } from "./cli-table.mjs";
import { deploymentModelId } from "./model-capabilities.mjs";

export async function runAppCommand({ path, ids, flags, output, request, readStatus, ask, print, confirm,
  choose, connection, requireManagement, save, getClient, clientBody, readFile }) {
  const action = path.at(-1);
  if (path.length === 3 && ["open", "focus", "restart", "check"].includes(action)) {
    const id = ["antigravity", "gemini"].includes(path[1]) ? "antigravity" : CLI_CLIENTS[ids.app || path[1]];
    if (!["codex", "claude_app", "antigravity"].includes(id)) throw new Error("This command opens desktop apps. Run Claude Code in your terminal.");
    const settings = await request({ path: "settings?application=" + id + "&fresh=1", timeoutMs: 15000 }), app = settings.applications?.[id];
    if (!app) throw new Error("This command needs the updated running service; no app was changed.");
    if (action === "check" || flags.preview) return print({ id, ...app, ...(flags.preview ? { action, performed: false } : {}) });
    if (action === "restart") await confirm("Reopen " + path[1] + "? This may interrupt its current tasks.");
    const result = await request({ path: "settings", body: { action: "application", id, operation: action,
      ...(action === "restart" ? { confirmed: true, ...(app.pid ? { expected_pid: app.pid, expected_started: app.started } : {}) } : {}) }, timeoutMs: 65000 });
    return print(result.last_operation?.result || result.applications?.[id]);
  }
  if (["gemini", "antigravity"].includes(path[1])) {
    if (["enable", "disable"].includes(action)) {
      const preview = { action, background_source: "GitHub Copilot (all Antigravity summaries, searches and image generation)", ordinary_Gemini_chat: "Google; no routing change" };
      if (flags.preview) return print(preview);
      output.write(print(preview) + "\n");await confirm(action === "enable" ? "Enable this Antigravity-only routing scope?" : "Pause Copilot access? Reopen Gemini afterward to restore its native route.");
    }
    if(action==="models"&&flags.edit){
      const state=await request({path:"gemini",...(flags.refresh?{body:{action:"refresh"},timeoutMs:20000}:{})});
      let ids, preferred;
      if(flags.file){
        const file=readFile(),listed=file.models;preferred=file.default_model;if(!Array.isArray(listed))throw new Error("Model files require a models array.");
        ids=listed.flatMap(id=>state.model_groups?.find(model=>model.id===id)?.efforts.map(item=>item.id)||[id]);
      }
      else if(Array.isArray(state.model_groups)){
        const groups=state.model_groups,selected=await choose(groups.map(model=>model.name),groups.flatMap((model,index)=>model.efforts.some(item=>item.selected)?[index]:[]));
        ids=[];
        for(const index of selected){
          const model=groups[index],previous=model.efforts.flatMap((item,i)=>item.selected?[i]:[]);
          const efforts=await choose(model.efforts.map(item=>model.name+" / "+(item.effort||"default")),previous.length?previous:model.efforts.map((_,i)=>i));
          ids.push(...efforts.map(i=>model.efforts[i].id));
        }
      }else ids=(await choose(state.models.map(model=>model.name),state.models.flatMap((model,index)=>model.selected!==false?[index]:[]))).map(index=>state.models[index].id);
      if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!state.models.some(model=>model.id===id)))throw new Error("Choose listed Antigravity model IDs.");
      const available=state.models.filter(model=>ids.includes(model.id));
      if(!flags.file&&available.length&&Object.hasOwn(state,"default_model")){
        available.forEach((model,index)=>output.write(`${index+1}. ${terminalCell(model.name)}${model.id===state.default_model?" (default)":""}\n`));
        const answer=(await ask("Default model number (Enter keeps it; none uses the app default): ")).trim();
        if(answer==="none")preferred=null;
        else if(answer){if(!/^\d+$/.test(answer)||!available[Number(answer)-1])throw new Error("Choose a listed default model number.");preferred=available[Number(answer)-1].id;}
      }
      if(preferred!==undefined&&preferred!==null&&!ids.includes(preferred)){
        const choices=available.filter(item=>item.model===preferred);
        preferred=(choices.find(item=>item.effort==="medium")||choices[0])?.id;
        if(!preferred)throw new Error("Choose a selected Antigravity model as the default.");
      }
      const body={models:ids,...(preferred!==undefined?{default_model:preferred}:{})};
      if(flags.preview)return print({...body,saved:false});
      await confirm("Save Antigravity model settings? Reopen Gemini afterward to reload them.");
      return print(await request({path:"gemini",body:{action:"models",...body}}));
    }
    const state = await request({ path: "gemini", ...(action==="models"&&flags.refresh?{body:{action:"refresh"},timeoutMs:20000}:["status", "models"].includes(action) ? {} : { body: { action: flags.preview ? "preview" : action, ...(action === "enable" ? { accept_background_copilot: true } : {}) }, timeoutMs: 20000 }) });
    if(action==="models"&&flags.format!=="json"&&state.model_groups)return print(state.model_groups.map(model=>({model:model.name,id:model.id,source:"GitHub Copilot",context:model.context_window,default:model.default===true,
      efforts:model.efforts.map(item=>(item.effort||"default")+(item.selected?" ✓":"")).join(" / ")})),[["model","Model"],["id","ID"],["source","Source"],["context","Context"],["efforts","Reasoning (selected ✓)"],["default","Default"]]);
    return print(action === "models" ? state.models : state);
  }
  const graph = await connection(), snapshot = (await readStatus()).data, view = projectTerminalState(snapshot);
  if (action === "list") {
    const clients=[...view.clients];
    if(!clients.some(client=>client.id==="antigravity"))clients.push({id:"antigravity",name:"Antigravity",setup:"Not checked",active:null});
    return print(clients, [["id", "ID"], ["name", "Client"], ["setup", "Setup"], ["active", "Active"]]);
  }
  const id = ids.app ? CLI_CLIENTS[ids.app] : "codex", client = getClient(graph, id), modelPlan = client.model_plan;
  if (!flags.preview && (flags.edit || ["sync", "enable", "disable"].includes(action))) requireManagement();
  const feature = path.length > 3 ? path[2] : null;
  if (feature || action === "status") {
    const settings = id === "codex" && (flags.details || feature) ? await request({ path: "settings" }) : null;
    const preference = settings?.providers?.[client.source || "github"]?.preference || {};
    const locked = preference.source === "environment";
    const reviewId = (locked ? preference.model : client.auto_review_model || preference.auto_review_model || preference.model) || null;
    const reviewModel = modelPlan?.models.find(model => [model.id, model.public_id, model.route_id].includes(reviewId));
    const details = { predictions: snapshot.client_integrations?.prediction || null, images: settings?.effective?.image_enabled || null,
      auto_review: { model: reviewModel?.id || reviewId, source: reviewModel?.source || client.source,
        ...(locked ? { mode: "Startup override" } : preference.followModel ? { mode: "Follow conversation model" } : {}),
        effort: (locked && client.auto_review_model !== reviewModel?.route_id ? undefined : client.auto_review_effort)
          ?? (locked ? undefined : preference.auto_review_effort ?? preference.reasoningEffort)
          ?? (reviewModel?.capability?.values?.reasoning_efforts?.includes("low") ? "low if omitted" : "Follows client") }, memory_model: client.memory_model || { model: null } };
    if (feature) return print({ client: "Codex", feature, state: details[{ prediction: "predictions", image: "images", review: "auto_review" }[feature]] });
    const observed = retainedRequests(snapshot).filter(row => id === "codex" ? ["codex", "codex_app", "codex_cli"].includes(row.application) : row.application === id).at(-1);
    return print({ id: ids.app, access: client.enabled ? clientSetup(client) === "Paused" ? "Paused" : "Enabled" : "Disabled", setup: view.clients.find(row => row.id === id)?.setup || clientSetup(client),
      selected_models: Array.isArray(client.deployments) ? client.deployments.length : modelPlan?.models.length ?? null, unavailable_selection: (modelPlan?.unavailable || []).filter(model => !modelPlan?.available.some(candidate => candidate.source === model.source && candidate.id === model.id)),
      app_adoption: view.clients.find(row => row.id === id)?.active > 0 ? "Active gateway request observed; process liveness not checked" : observed ? `Gateway request observed${observed.at || observed.time ? ` at ${observed.at || observed.time}` : ""}; process liveness not checked` : client.observed_at ? `Gateway request observed at ${client.observed_at}; process liveness not checked` : "Not observed",
      active: view.clients.find(row => row.id === id)?.active ?? null, ...(id.startsWith("claude_") && flags.details ? { capability_support: modelPlan?.support, capability_adoption: client.capability_adoption, capability_sync: modelPlan?.sync } : {}), ...(id === "codex" && flags.details ? { features: details, chatgpt_sign_in: "Managed by Codex; not inferred from GitHub credentials" } : {}) });
  }
  if (action === "models" && !flags.edit) {
    if (flags.format === "json") return print(modelPlan);
    return print([...(modelPlan?.models || []).map(model => ({ source: model.source, model: model.display_name || model.id, id: model.id, state: "Selected", default: [model.route_id, model.public_id].includes(modelPlan.default_model) })),
      ...(id === "codex" ? (modelPlan?.image?.models || []).map(model => ({ source: "github", model: model.name, id: model.id, state: modelPlan.image.selected_model === model.id ? "Selected image" : "Image", default: false })) : []),
      ...(id === "codex" && modelPlan?.image?.selected_model && !modelPlan.image.selected_available ? [{ source: "github", model: modelPlan.image.selected_model, id: modelPlan.image.selected_model, state: "Image unavailable; retained", default: false }] : []),
      ...(modelPlan?.unavailable || []).map(model => ({ source: model.source, model: model.id, id: model.id, state: !client.enabled && modelPlan?.available.some(item => item.source === model.source && item.id === model.id) ? "Retained; access disabled" : "Unavailable; retained", default: model.route_id === modelPlan.default_model }))], [["model", "Model"], ["source", "Source"], ["state", "Selection"], ["default", "Default"]]);
  }
  if (action === "sync") {
    const preview = { client: ids.app, models: modelPlan?.models.map(model => ({ source: model.source, model: model.display_name || model.id, id: model.id, context_window: model.capability?.values.context_window ?? null, reasoning_efforts: model.capability?.values.reasoning_efforts ?? null })), unavailable: modelPlan?.unavailable, default_model: modelPlan?.default_model, image: modelPlan?.image,
      current_setup: clientSetup(client), note: "Model/configuration plan only, not a byte-level file diff. Ownership is rechecked on sync; no App is restarted." };
    if (flags.preview) return print(preview);output.write(print(preview) + "\n");await confirm("Write CCDX-owned client settings now?");
    const result = await save({ operation: "sync_client", id, client_revision: client.revision });return print({ client: ids.app, setup: getClient(result, id).setup, image: getClient(result, id).model_plan?.image, app_adoption: "Not verified by writing configuration" });
  }
  if (["enable", "disable"].includes(action)) {
    const enabled = action === "enable", preview = { client: ids.app, access: enabled ? "Enabled" : "Disabled", retained_source: client.source,
      retained_models: client.deployments || "Legacy source binding retained", note: "Only gateway access changes; the client program stays open." };
    if (flags.preview) return print(preview);output.write(print(preview) + "\n");
    await confirm(enabled ? "Enable gateway access with the saved selection?" : "Disable gateway access? Later turns may fail; saved selections are retained.");
    const result = await save({ operation: "client_state", id, enabled, client_revision: client.revision });
    return print({ client: ids.app, setup: getClient(result, id).setup, saved: true, app_adoption: "Not verified" });
  }
  const body = clientBody(client);
  if (action === "models") {
    if (flags.file) {
      const file = readFile();if (Object.keys(file).some(key => !["deployments", "default_model", "auto_sync", "image_model"].includes(key))) throw new Error("Model files allow deployments, default_model, auto_sync and image_model only.");
      if (!Array.isArray(file.deployments)) throw new Error("Model files require an explicit deployments array; use [] to pause access.");
      Object.assign(body, file);if (!body.deployments.length) body.default_model = null;
    } else {
      const available = [...(modelPlan?.available || [])], selected = Array.isArray(client.deployments) ? client.deployments : modelPlan?.models.map(model => ({ source: model.source, model: model.id })) || [];
      for (const old of selected) if (!available.some(row => row.source === old.source && row.id === old.model)) available.push({ source: old.source, id: old.model, unavailable: true });
      const indexes = await choose(available.map(row => `${row.source} / ${row.id}${row.unavailable ? " (unavailable; selection retained)" : ""}`), available.flatMap((row, index) => selected.some(item => item.source === row.source && item.model === row.id) ? [index] : []));
      body.deployments = indexes.map(index => ({ ...selected.find(item => item.source === available[index].source && item.model === available[index].id), source: available[index].source, model: available[index].id }));
      body.default_model = client.default_model || modelPlan?.default_model || null;
      if (body.deployments.length) {
        const defaults = body.deployments.map(item => deploymentModelId(item.source, item.model));
        output.write(body.deployments.map((item, index) => `${index + 1} ${item.source} / ${item.model}`).join("\n") + "\n");
        const value = (await ask(`Default model number [${Math.max(1, defaults.indexOf(body.default_model) + 1)}]: `)).trim();
        if (value && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > defaults.length)) throw new Error("Choose a listed default model number.");
        body.default_model = defaults[value ? Number(value) - 1 : Math.max(0, defaults.indexOf(body.default_model))];
      } else body.default_model = null;
      if (id === "claude_app") for (const item of body.deployments) {
        const entry = available.find(row => row.source === item.source && row.id === item.model), levels = entry?.capability?.values.reasoning_efforts || [];
        if (entry?.effort_control !== "gateway" && item.reasoning_effort === undefined) continue;
        output.write(`Reasoning for ${item.source} / ${item.model}: follow-app${levels.length ? ", " + levels.join(", ") : ""}\n`);
        const answer = (await ask(`Default when the app omits effort [${item.reasoning_effort || "follow-app"}]: `)).trim();
        if (answer === "follow-app") delete item.reasoning_effort;
        else if (answer) { if (!levels.includes(answer)) throw new Error("Choose a declared reasoning level or follow-app.");item.reasoning_effort = answer; }
      }
    }
    if (id === "codex" && !flags.file && modelPlan?.image?.models?.length) {
      const images = modelPlan.image.models, current = images.findIndex(model => model.id === modelPlan.image.selected_model);
      output.write(images.map((model, i) => `${i + 1} ${model.name || model.id} [Image]`).join("\n") + "\n");
      const answer = (await ask(`Image model number [${Math.max(1, current + 1)}]: `)).trim();
      if (answer && (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > images.length)) throw new Error("Choose a listed image model number.");
      body.image_model = images[answer ? Number(answer) - 1 : Math.max(0, current)].id;
    }
    if (body.deployments?.some(item => modelPlan?.unavailable.some(row => row.source === item.source && row.id === item.model))) throw new Error("Unavailable selections were kept. Wait for the catalog or explicitly deselect them before saving a changed plan.");
  } else throw new Error("Unsupported client action.");
  const memory = id === "codex" ? client.memory_model?.model : null;
  const memoryModels = [...(modelPlan?.models || []), ...(modelPlan?.available || []), ...(modelPlan?.unavailable || [])].filter(row => [row.id, row.route_id, row.public_id].includes(memory));
  const memoryPairs = new Set(memoryModels.map(row => row.source + "\0" + row.id));
  const memoryMatch = row => memoryPairs.size ? memoryPairs.has(row.source + "\0" + (row.model || row.id)) : [row.model, row.id, row.route_id, row.public_id].includes(memory);
  if (memory && (client.deployments || modelPlan?.models || []).some(memoryMatch) && Array.isArray(body.deployments) && !body.deployments.some(memoryMatch)) {
    output.write(`Warning: ${terminalCell(memory)} is an observed memory dependency; memory writing may fail if it is unselected.\n`);
  }
  const previousModels = client.deployments || modelPlan?.models.map(model => ({ source: model.source, model: model.id })) || [];
  const previousKeys = new Set(previousModels.map(item => item.source + "\0" + item.model));
  const previousDefault = client.default_model || modelPlan?.models.find(model => model.public_id === modelPlan.default_model)?.route_id || null;
  const imageOnly = id === "codex" && body.image_model && body.image_model !== modelPlan?.image?.selected_model
    && body.deployments?.length === previousKeys.size && body.deployments.every(item => previousKeys.has(item.source + "\0" + item.model))
    && body.default_model === previousDefault && (body.auto_sync !== false) === (client.auto_sync !== false);
  const checked = await save({ ...body, operation: "preview_client" });
  output.write(print({ client: ids.app, planned_models: checked.preview?.models.map(model => ({ source: model.source, id: model.id })), change: action, enabled: body.enabled, deployments: body.deployments, default_model: body.default_model }) + "\n");
  if (flags.preview) return "Preview only; no settings changed.";
  await confirm(body.enabled ? "Save this client selection?" : "Disable gateway access? Later turns may fail; the client program stays open.");
  const result = await save(imageOnly ? { operation: "image_model", id: "codex", model: body.image_model, client_revision: client.revision } : body);return print({ client: ids.app, setup: getClient(result, id).setup, saved: true, app_adoption: "Not verified" });
}
