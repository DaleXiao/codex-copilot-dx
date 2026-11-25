import { invalidUpstreamStream } from "./stream-contract.mjs";

function unsupported() {
  throw invalidUpstreamStream("Unsupported upstream Chat stream content");
}

export function chatOutputParts(content) {
  if (content == null || content === "") return [];
  if (typeof content === "string") return [{ text: content, thought: false }];
  if (!Array.isArray(content)) unsupported();
  return content.flatMap(part => {
    if (part?.type === "text" && typeof part.text === "string") return [{ text: part.text, thought: false }];
    if (part?.type === "thinking") {
      if (typeof part.thinking === "string") return [{ text: part.thinking, thought: true }];
      if (Array.isArray(part.thinking) && part.thinking.every(chunk => chunk?.type === "text" && typeof chunk.text === "string"))
        return part.thinking.map(chunk => ({ text: chunk.text, thought: true }));
    }
    return unsupported();
  }).filter(part => part.text);
}
