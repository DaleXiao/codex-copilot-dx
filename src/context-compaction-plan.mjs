import { createHash } from "node:crypto";

const MAX_CHUNKS = 4;
const MAX_CHUNK_BYTES = 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 422 });
const textParts = parts => Array.isArray(parts) && parts.every(part => ["text", "input_text", "output_text"].includes(part?.type) && typeof part.text === "string");

function describe(item, protocol, index, pendingNames) {
  const calls = [], results = [];let human = false, opaque = false, record = item;
  if (!item || typeof item !== "object") return { human: false, opaque: true, calls, results, record };
  if (protocol === "responses") {
    human = item.role === "user" || ["system", "developer"].includes(item.role);
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (typeof item.call_id === "string" && item.call_id) calls.push(item.call_id);else opaque = true;
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (typeof item.call_id === "string" && item.call_id) results.push(item.call_id);else opaque = true;
      if (typeof item.output !== "string") opaque ||= !textParts(item.output);
    } else if (item.type === "reasoning") {
      opaque = Boolean(item.encrypted_content) || !Array.isArray(item.summary);
    } else if (item.type === "compaction" || item.type === "compaction_trigger") opaque = true;
    else if (item.type !== "message" && item.type !== undefined) opaque = true;
    else if (typeof item.content !== "string") opaque = !textParts(item.content);
  } else if (protocol === "messages") {
    human = ["system", "developer"].includes(item.role) || item.role === "user" && (typeof item.content === "string" || !Array.isArray(item.content)
      || item.content.some(part => part?.type !== "tool_result"));
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "tool_use") { if (typeof part.id === "string" && part.id) calls.push(part.id);else opaque = true; }
        else if (part?.type === "tool_result") {
          if (typeof part.tool_use_id === "string" && part.tool_use_id) results.push(part.tool_use_id);else opaque = true;
          if (typeof part.content !== "string") opaque ||= !textParts(part.content);
        } else if (part?.type === "thinking") opaque ||= Boolean(part.signature);
        else if (part?.type !== "text") opaque = true;
      }
      record = { ...item, content: item.content.filter(part => part?.type !== "thinking" || part.signature) };
    } else opaque ||= typeof item.content !== "string";
  } else if (protocol === "chat") {
    human = ["user", "system", "developer"].includes(item.role);
    for (const call of item.tool_calls || []) { if (typeof call?.id === "string" && call.id) calls.push(call.id);else opaque = true; }
    if (item.role === "tool") { if (typeof item.tool_call_id === "string" && item.tool_call_id) results.push(item.tool_call_id);else opaque = true; }
    opaque ||= item.content !== null && typeof item.content !== "string" && !textParts(item.content);
    if (item.reasoning_content !== undefined) { const { reasoning_content, ...visible } = item;record = visible; }
  } else if (protocol === "gemini") {
    human = item.role === "user" && (!Array.isArray(item.parts) || item.parts.some(part => !part?.functionResponse));
    if (!Array.isArray(item.parts)) opaque = true;
    for (const [partIndex, part] of (item.parts || []).entries()) {
      opaque ||= Boolean(part?.thoughtSignature) || !part || !["text", "functionCall", "functionResponse"].some(key => Object.hasOwn(part, key));
      if (part?.functionCall) {
        const key = part.functionCall.id || `gemini:${index}:${partIndex}`;calls.push(key);
        const name = part.functionCall.name, queue = pendingNames.get(name) || [];queue.push(key);pendingNames.set(name, queue);
      }
      if (part?.functionResponse) {
        const key = part.functionResponse.id || pendingNames.get(part.functionResponse.name)?.shift();
        if (typeof key === "string" && key) results.push(key);else opaque = true;
      }
    }
    record = { ...item, parts: item.parts?.filter(part => !part?.thought) };
  } else throw fail("ccdx_compaction_protocol_unknown", "This interface has no verified compression adapter.");
  return { human, opaque, calls, results, record };
}

export function compactionItems(body, protocol) {
  const items = protocol === "responses" ? body.input : protocol === "gemini" ? body.request?.contents : body.messages;
  if (!Array.isArray(items)) throw fail("ccdx_compaction_history_unavailable", "A complete structured conversation is required for compression.");
  return items;
}

export function compactionMessage(protocol, text) {
  const content = "[Earlier assistant and tool activity, compressed by CCDX]\n" + text;
  if (protocol === "responses") return { type: "message", role: "assistant", content: [{ type: "output_text", text: content }] };
  if (protocol === "gemini") return { role: "model", parts: [{ text: content }] };
  return { role: "assistant", content };
}

export function replaceCompactionItems(body, protocol, items) {
  return protocol === "responses" ? { ...body, input: items } : protocol === "gemini"
    ? { ...body, request: { ...body.request, contents: items } } : { ...body, messages: items };
}

export function planContextCompaction(body, { protocol, inputLimit, outputAllowance = 0 } = {}) {
  if (!Number.isSafeInteger(inputLimit) || inputLimit <= 0) throw fail("ccdx_compaction_limit_unknown", "The source input window is unknown; native compression remains available.");
  const budget = Math.min(MAX_CHUNK_BYTES, inputLimit - outputAllowance - 4096);
  if (budget < 1024) throw fail("ccdx_compaction_budget_unavailable", "The source window leaves insufficient room for a compression request.");
  const items = compactionItems(body, protocol), pendingNames = new Map(), facts = items.map((item, index) => describe(item, protocol, index, pendingNames));
  const parents = items.map((_, index) => index), protectedItems = new Set(), references = new Map();
  const root = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]];index = parents[index]; }return index; };
  const join = (a, b) => { parents[root(a)] = root(b); };
  facts.forEach((fact, index) => {
    if (fact.human || fact.opaque || index === items.length - 1) protectedItems.add(index);
    for (const [kind, ids] of [["calls", fact.calls], ["results", fact.results]]) for (const id of ids) {
      const entry = references.get(id) || { calls: [], results: [] };entry[kind].push(index);references.set(id, entry);
    }
  });
  for (const { calls, results } of references.values()) {
    const linked = [...calls, ...results];for (const index of linked.slice(1)) join(linked[0], index);
    if (calls.length !== 1 || results.length !== 1) for (const index of linked) protectedItems.add(index);
  }
  const protectedRoots = new Set([...protectedItems].map(root)), selected = new Set();
  facts.forEach((_fact, index) => { if (!protectedRoots.has(root(index))) selected.add(index); });
  if (!selected.size) throw fail("ccdx_compaction_protected_history", "No completed history can be compressed while preserving user content, signed state and unfinished tools.");
  const transcript = [...selected].map(index => JSON.stringify({ position: index, record: facts[index].record })).join("\n"), bytes = Buffer.from(transcript);
  if (bytes.length > budget * MAX_CHUNKS) throw fail("ccdx_compaction_work_limit", "The history exceeds the bounded compression workload; the original conversation was kept.");
  const chunks = [];let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(bytes.length, offset + budget);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(offset, end).toString("utf8"));offset = end;
  }
  return {
    chunks, selected_items: selected.size, preserved_items: items.length - selected.size, bytes: bytes.length,
    fingerprint: createHash("sha256").update(bytes).digest("hex"), sizing: "utf8_bytes_not_token_count",
    rewriteItem(summaryItem) {
      const output = [];let inserted = false;
      for (const [index, item] of items.entries()) {
        if (selected.has(index)) { if (!inserted) { output.push(summaryItem);inserted = true; } }
        else if (item?.type !== "compaction_trigger") output.push(item);
      }
      return replaceCompactionItems(body, protocol, output);
    },
    rewrite(summary) { return this.rewriteItem(compactionMessage(protocol, summary)); },
  };
}
