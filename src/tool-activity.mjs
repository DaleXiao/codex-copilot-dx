import { hash } from "node:crypto";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

export const TOOL_ACTIVITY_LIMITS = Object.freeze({ retained: 128, visible: 32, per_request: 32, stale_ms: 90_000, terminal_ms: 15_000, unknown_ms: 300_000 });
const pending = state => state === "preparing" || state === "waiting";
const nameOf = value => typeof value === "string" && /^[\w./:@-]{1,80}$/.test(value) && redactDiagnosticText(value) === value ? value : null;
const idOf = value => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
const toolTypes = new Set(["function_call", "custom_tool_call", "web_search_call", "file_search_call", "computer_call", "tool_search_call", "mcp_call", "shell_call", "image_generation_call", "program", "multi_agent_call"]);
const hostedTools = new Set(["web_search_call", "file_search_call", "mcp_call", "image_generation_call"]);
const messageResult = value => typeof value?.type === "string" && value.type.endsWith("_tool_result") && idOf(value.tool_use_id);
const items = value => Array.isArray(value) ? value.slice(0, 64) : [];
export function isToolActivityOutput(value, protocol = "responses") {
  if (!value || typeof value !== "object") return false;
  if (protocol === "messages") return ["tool_use", "server_tool_use", "mcp_tool_use"].includes((value.content_block || value).type) || Boolean(messageResult(value.content_block || value))
    || items(value.content).some(item => ["tool_use", "server_tool_use", "mcp_tool_use"].includes(item?.type) || messageResult(item));
  if (protocol === "gemini") return Boolean(value.functionCall) || items((value.response || value).candidates).some(candidate => items(candidate?.content?.parts).some(part => part?.functionCall));
  return toolTypes.has((value.item || value).type) || items(value.response?.output || value.output).some(item => toolTypes.has(item?.type));
}

// Metadata only: arguments, input/output text and raw conversation/call IDs never leave the request.
export function createToolActivity({ now = Date.now, changed = () => {} } = {}) {
  const entries = new Map();let sequence = 0;
  function sweep() {
    const time = now();
    for (const [key, entry] of entries) {
      if (pending(entry.state) && time - entry.updated >= TOOL_ACTIVITY_LIMITS.stale_ms) { entry.state = "unknown";entry.updated = time; }
      if (!pending(entry.state) && time - entry.updated >= (entry.state === "unknown" ? TOOL_ACTIVITY_LIMITS.unknown_ms : TOOL_ACTIVITY_LIMITS.terminal_ms)) entries.delete(key);
    }
  }
  const change = (entry, state) => {
    if (!entry || entry.state === state || !pending(entry.state) && entry.state !== "unknown") return;
    entry.state = state;entry.updated = now();changed();
  };
  return {
    get size() { return entries.size; },
    request(metadata) {
      const aliases = new Map(), owned = new Set(), local = ++sequence;
      let lastNotice = now();
      const scope = () => { const m = metadata();return m.session ? `${m.application}\0${m.session}` : `request:${local}`; };
      const keyFor = id => hash("sha256", `${scope()}\0${id}`, "hex");
      function record(id, name, alias, resultId) {
        id = idOf(id);const known = aliases.get(id) || aliases.get(alias);
        if (known) { const next = nameOf(name);if (next && known.name !== next) { known.name = next;changed(); }if (id) aliases.set(id, known);if (idOf(resultId)) known.result_key = keyFor(resultId);return known; }
        if (owned.size >= TOOL_ACTIVITY_LIMITS.per_request) return null;
        sweep();const key = keyFor(id || `anonymous:${local}:${owned.size}`), m = metadata();
        if (entries.has(key) && pending(entries.get(key).state)) return entries.get(key);
        const entry = { id: `tool-${++sequence}`, application: m.application, provider: m.provider || "unknown", model: m.model,
          name: nameOf(name), state: "preparing", updated: now(), key, scope: scope(), ...(idOf(resultId) ? { result_key: keyFor(resultId) } : {}) };
        entries.set(key, entry);owned.add(entry);if (id) aliases.set(id, entry);if (alias !== undefined) aliases.set(alias, entry);
        while (entries.size > TOOL_ACTIVITY_LIMITS.retained) entries.delete(entries.keys().next().value);
        changed();return entry;
      }
      function output(value, protocol = "responses") {
        if (!value || typeof value !== "object") return;
        if (protocol === "messages") {
          const block = value.type === "content_block_start" ? value.content_block : value;
          if (["tool_use", "server_tool_use", "mcp_tool_use"].includes(block?.type)) record(block.id, block.name, value.index);
          else if (messageResult(block)) change(aliases.get(block.tool_use_id), block.is_error === true ? "failed" : "returned");
          else if (Array.isArray(value.content)) for (const item of value.content.slice(0, 64)) output(item, protocol);
          return;
        }
        if (protocol === "gemini") {
          if (value.functionCall) {
            const id = idOf(value.functionCall.id), name = nameOf(value.functionCall.name);
            if (!id && !name) return;
            const alias = id ? undefined : `gemini:${name}:${value.index ?? 0}`;
            const prior = alias === undefined ? null : aliases.get(alias);
            if (prior) prior.ambiguous = true;
            record(id, name, alias);
          }
          else for (const candidate of items((value.response || value).candidates)) for (const [index, part] of items(candidate?.content?.parts).entries()) {
            if (part?.functionCall) output({ functionCall: part.functionCall, index }, protocol);
          }
          return;
        }
        const item = value.item || value;
        if (toolTypes.has(item.type)) {
          const entry = record(item.call_id || item.id, item.name || item.type, value.output_index ?? item.id, item.call_id);
          if (["completed", "failed", "cancelled"].includes(item.status) && hostedTools.has(item.type)) {
            change(entry, item.status === "completed" ? "returned" : item.status);
          }
        } else if (value.response?.output || value.output) {
          for (const item of items(value.response?.output || value.output)) output(item, protocol);
        }
      }
      return {
        output,
        activity() {
          const time = now();let active = false;
          for (const entry of owned) if (entry.state === "preparing") { entry.updated = time;active = true; }
          if (active && time - lastNotice >= 1000) { lastNotice = time;changed(); }
        },
        input(body, protocol) {
          if (!entries.size || !metadata().session || !body || typeof body !== "object") return;
          const results = [];
          const inspect = part => {
            if (["function_call_output", "custom_tool_call_output", "computer_call_output", "shell_call_output"].includes(part?.type)) results.push({ id: part.call_id });
            else if (part?.type === "tool_result") results.push({ id: part.tool_use_id, error: part.is_error === true });
            else if (part?.role === "tool") results.push({ id: part.tool_call_id });
            else if (part?.functionResponse) results.push({ id: part.functionResponse.id, name: nameOf(part.functionResponse.name) });
          };
          if (Array.isArray(body.input)) for (const item of body.input.slice(-64)) inspect(item);
          else if (Array.isArray(body.messages)) for (const message of body.messages.slice(-8)) {
            inspect(message);if (Array.isArray(message?.content)) for (const part of message.content.slice(-64)) inspect(part);
          }
          else if (protocol === "gemini" && Array.isArray(body.contents)) for (const message of body.contents.slice(-8)) {
            for (const part of items(message?.parts)) inspect(part);
          }
          for (const result of results) {
            const resultKey = idOf(result.id) ? keyFor(result.id) : null;
            let entry = resultKey ? entries.get(resultKey) || [...entries.values()].find(item => item.result_key === resultKey) : null;
            if (!entry && result.name) {
              const matches = [...entries.values()].filter(item => pending(item.state) && item.scope === scope() && item.name === result.name);
              if (matches.length === 1) entry = matches[0];
            }
            change(entry, result.error ? "failed" : "returned");
          }
        },
        finish(outcome) {
          for (const entry of owned) {
            entry.scope = scope();
            change(entry, outcome === "completed" ? metadata().session && !entry.ambiguous ? "waiting" : "unknown" : ["failed", "cancelled"].includes(outcome) ? outcome : "unknown");
          }
        },
      };
    },
    snapshot() {
      sweep();const time = now(), all = [...entries.values()].reverse();
      all.sort((a, b) => Number(pending(b.state)) - Number(pending(a.state)));
      return { items: all.slice(0, TOOL_ACTIVITY_LIMITS.visible).map(({ key, scope, result_key, ambiguous, updated, ...entry }) => ({ ...entry,
        expires_in_ms: Math.max(0, (pending(entry.state) ? TOOL_ACTIVITY_LIMITS.stale_ms : entry.state === "unknown" ? TOOL_ACTIVITY_LIMITS.unknown_ms : TOOL_ACTIVITY_LIMITS.terminal_ms) - (time - updated)) })),
      omitted: Math.max(0, all.length - TOOL_ACTIVITY_LIMITS.visible), limits: TOOL_ACTIVITY_LIMITS };
    },
  };
}
