function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isEncryptedContentVerificationError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = String(text).toLowerCase();
  const reasoningFailure = lower.includes("encrypted content")
    && lower.includes("could not be verified")
    && (lower.includes("could not be decrypted") || lower.includes("could not be parsed"));
  const functionOutputFailure = lower.includes("encrypted function output content")
    && lower.includes("could not be decrypted or decoded");
  const missingEncryptedContent = statusCode < 500
    && /missing required parameter:\s*(['"]?)input\[\d+\](?:\.[a-z0-9_]+|\[\d+\])*\.encrypted_content\1(?=\.?(?:\s|$|["},\]]))/.test(lower);
  return reasoningFailure || functionOutputFailure || missingEncryptedContent;
}

export function isImageNamespaceCollisionError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = String(text).toLowerCase();
  return lower.includes("namespace")
    && lower.includes("image_gen")
    && lower.includes("collid");
}

export function isCopilotImageNamespaceTool(tool, { collisionFallback = false } = {}) {
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

// Copilot currently rejects the public image-generation tool. Keep this
// provider-owned policy paired with tool_choice so request invariants survive
// the removal. Revalidate against Copilot before deleting or broadening it.
// Reference: https://github.com/Menci/Floway/blob/ac2bbb04352033a7d9d74574a9d465d40395ef06/packages/provider-copilot/src/interceptors/openai-responses/strip-image-generation.ts
export function applyCopilotResponsesRequestPolicies(body, options = {}) {
  if (!body || typeof body !== "object") return false;
  const removedNames = new Set();
  const survivingNames = new Set();
  let survivingTools = 0;
  let changed = false;
  const filter = (container, topLevel = false) => {
    if (!Array.isArray(container?.tools)) return;
    const tools = container.tools;
    const filtered = tools.filter((tool) => {
      const removed = isCopilotImageNamespaceTool(tool, options);
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

  const removedChoice = (choice) => isCopilotImageNamespaceTool(choice, options)
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

export function sanitizeImageNamespaceCollisionRequest(reqContext) {
  if (!Array.isArray(reqContext?.body?.tools)) return null;
  const body = cloneJson(reqContext.body);
  if (!applyCopilotResponsesRequestPolicies(body, { collisionFallback: true })) return null;
  return { ...reqContext, body };
}
