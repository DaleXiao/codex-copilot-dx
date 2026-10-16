export function isNativeImageTool(tool, { collisionFallback = false } = {}) {
  if (!tool || typeof tool !== "object") return false;
  const type = String(tool.type || "").toLowerCase();
  if (["image_gen", "image_generation"].includes(type)) return true;
  if (!collisionFallback) return false;
  const name = String(tool.name || tool.function?.name || "").toLowerCase();
  const namespace = String(tool.namespace || "").toLowerCase();
  if (["image_gen", "image_generation"].includes(name)) return true;
  if (namespace === "image_gen" || namespace === "image_generation") return true;
  return [type, name, namespace].some((value) => value.startsWith("image_gen"));
}

function toolName(tool) {
  return String(tool?.name || tool?.function?.name || "").trim();
}

// Providers opt into this only after verifying that their native image tools
// are unavailable. Preserve named function/MCP tools and tool_choice invariants.
export function removeNativeImageTools(body, options = {}) {
  if (!body || typeof body !== "object") return false;
  const removedNames = new Set();
  const survivingNames = new Set();
  let survivingTools = 0;
  let changed = false;
  const filter = (container, topLevel = false) => {
    if (!Array.isArray(container?.tools)) return;
    const tools = container.tools;
    const filtered = tools.filter((tool) => {
      const removed = isNativeImageTool(tool, options);
      const name = toolName(tool);
      if (removed && name) removedNames.add(name);
      if (!removed) {
        survivingTools += 1;
        if (name) survivingNames.add(name);
      }
      return !removed;
    });
    if (filtered.length === tools.length) return;
    changed = true;
    if (topLevel && !filtered.length) delete container.tools;
    else container.tools = filtered;
  };
  filter(body, true);
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (["additional_tools", "tool_search_output"].includes(item?.type)) filter(item);
  }
  if (!changed) return false;

  const removedChoice = (choice) => isNativeImageTool(choice, options)
    || (removedNames.has(toolName(choice)) && !survivingNames.has(toolName(choice)));
  if (body.tool_choice?.type === "allowed_tools" && Array.isArray(body.tool_choice.tools)) {
    const choices = body.tool_choice.tools.filter((choice) => !removedChoice(choice));
    body.tool_choice = choices.length ? { ...body.tool_choice, tools: choices } : "none";
  } else if (removedChoice(body.tool_choice)) {
    if (survivingTools) body.tool_choice = "none";
    else delete body.tool_choice;
  } else if (body.tool_choice === "required" && !survivingTools) {
    delete body.tool_choice;
  }
  return true;
}
