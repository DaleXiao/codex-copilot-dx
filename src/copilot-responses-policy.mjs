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
  if (!Array.isArray(body?.tools)) return false;
  const removedNames = new Set();
  const filtered = body.tools.filter((tool) => {
    const removed = isCopilotImageNamespaceTool(tool, options);
    if (removed) {
      const name = toolName(tool);
      if (name) removedNames.add(name);
    }
    return !removed;
  });
  if (filtered.length === body.tools.length) return false;
  if (filtered.length) body.tools = filtered;
  else delete body.tools;

  const choiceName = toolName(body.tool_choice);
  const choiceTargetsRemovedTool = choiceName
    && removedNames.has(choiceName)
    && !filtered.some((tool) => toolName(tool) === choiceName);
  if (isCopilotImageNamespaceTool(body.tool_choice, options)
    || choiceTargetsRemovedTool
    || (body.tool_choice === "required" && !body.tools)) {
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
