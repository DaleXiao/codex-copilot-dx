const invalid = () => Object.assign(new Error("System instructions must contain text"), { code: "ccdx_messages_system_invalid", statusCode: 400 });
const textBlocks = content => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content) && content.every(block => block?.type === "text" && typeof block.text === "string")) return content;
  throw invalid();
};

// Alias mapping never selects a content transformation. The resolved endpoint's
// protocol policy owns it; a model can explicitly override inline-role support.
export function applyMessagesSystemPolicy(body, mode = "passthrough") {
  if (mode === "passthrough") return body;
  if (!["native", "legacy"].includes(mode)) throw invalid();
  const messages = [], instructions = [];
  let leading = true;
  for (const message of body.messages) {
    if (message?.role === "system" && (mode === "legacy" || leading)) instructions.push(...textBlocks(message.content));
    else { messages.push(message);leading = false; }
  }
  return instructions.length ? { ...body, system: [...(body.system === undefined ? [] : textBlocks(body.system)), ...instructions], messages } : body;
}
