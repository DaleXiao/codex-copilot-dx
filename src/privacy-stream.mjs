import { StringDecoder } from "node:string_decoder";
import { privacyFailure } from "./privacy-model.mjs";

const START = "{{CCDX_", token = /^\{\{CCDX_[a-f0-9]{24}\}\}/;
const possible = value => START.startsWith(value)
  || value.startsWith(START) && /^[a-f0-9]{0,24}\}?$/.test(value.slice(START.length));

// Validate streamed JSON without retaining its values. Only container states,
// a literal position and a number state survive between deltas.
function jsonState(onRetained) {
  const stack = [];let root = "value", quoted = false, role = "", escape = false, unicode = 0, literal = "", at = 0, number = "", invalid = false;
  const state = () => stack.at(-1)?.state || root;
  const consumeValue = () => {
    const top = stack.at(-1), current = state();
    if (!["value", "array-first", "array-value", "object-value"].includes(current)) { invalid = true;return; }
    if (top) top.state = top.type === "object" ? "object-comma" : "array-comma";else root = "end";
  };
  const numberComplete = () => ["zero", "integer", "fraction", "exponent"].includes(number);
  function read(c) {
    if (invalid) return;
    if (quoted) {
      if (unicode) { if (!/[a-fA-F0-9]/.test(c)) invalid = true;unicode--;return; }
      if (escape) {
        escape = false;if (c === "u") unicode = 4;
        else if (!'"\\/bfnrt'.includes(c)) invalid = true;
        return;
      }
      if (c === "\\") { escape = true;return; }
      if (c === '"') { quoted = false;if (role === "key") stack.at(-1).state = "object-colon";return; }
      if (c.charCodeAt(0) < 32) invalid = true;
      return;
    }
    if (literal) {
      if (c !== literal[at++]) invalid = true;
      if (at === literal.length) { literal = "";at = 0; }
      return;
    }
    if (number) {
      if (/\d/.test(c)) {
        if (number === "zero") invalid = true;
        else if (number === "minus") number = c === "0" ? "zero" : "integer";
        else if (number === "dot") number = "fraction";
        else if (number === "e" || number === "sign") number = "exponent";
        return;
      }
      if (c === "." && ["zero", "integer"].includes(number)) { number = "dot";return; }
      if (/[eE]/.test(c) && ["zero", "integer", "fraction"].includes(number)) { number = "e";return; }
      if (/[+-]/.test(c) && number === "e") { number = "sign";return; }
      if (!numberComplete()) invalid = true;
      number = "";if (invalid) return;
    }
    if (/\s/.test(c)) { if (!" \t\r\n".includes(c)) invalid = true;return; }
    const current = state(), top = stack.at(-1);
    if (c === '"') {
      role = current === "object-first" || current === "object-key" ? "key" : "value";
      if (role === "value") consumeValue();quoted = true;return;
    }
    if (c === "{" || c === "[") {
      consumeValue();onRetained((stack.length + 1) * 64);
      stack.push({ type: c === "{" ? "object" : "array", state: c === "{" ? "object-first" : "array-first" });return;
    }
    if (c === "}" || c === "]") {
      if (!top || top.type !== (c === "}" ? "object" : "array")
        || ![top.type + "-first", top.type + "-comma"].includes(current)) invalid = true;
      else { stack.pop();onRetained(stack.length * 64); }
      return;
    }
    if (c === ":") { if (current !== "object-colon") invalid = true;else top.state = "object-value";return; }
    if (c === ",") {
      if (current === "object-comma") top.state = "object-key";
      else if (current === "array-comma") top.state = "array-value";
      else invalid = true;
      return;
    }
    if (c === "-" || /\d/.test(c)) { consumeValue();number = c === "-" ? "minus" : c === "0" ? "zero" : "integer";return; }
    if ("tfn".includes(c)) { consumeValue();literal = c === "t" ? "true" : c === "f" ? "false" : "null";at = 1;return; }
    invalid = true;
  }
  return {
    read,
    valueString: () => quoted && role === "value" && !escape && !unicode,
    complete: () => !invalid && !quoted && !literal && (!number || numberComplete()) && !stack.length && root === "end",
  };
}

// A JSON delta is deliberately not a complete JSON document. Track string
// boundaries so restored values are escaped once, without buffering arguments.
function fragments(session, json, onRetained) {
  let tail = "";const parser = json ? jsonState(onRetained) : null;
  return {
    push(delta) {
      const value = tail + delta;tail = "";let output = "";
      for (let at = 0; at < value.length;) {
        const c = value[at];
        if ((!json || parser.valueString()) && c === "{") {
          const rest = value.slice(at), match = token.exec(rest);
          if (match) {
            const restored = session.restoreText ? session.restoreText(match[0]) : match[0];
            output += json ? JSON.stringify(restored).slice(1, -1) : restored;
            at += match[0].length;continue;
          }
          if (possible(rest)) { tail = rest;break; }
        }
        output += c;at++;
        parser?.read(c);
      }
      return output;
    },
    finish() { const value = tail;tail = "";return value; },
    held: () => Boolean(tail),
    complete: () => !json || parser.complete(),
  };
}

function rewrite(wire, event, named = false) {
  let written = false;
  const output = wire.split(/(?<=\n)/).map(line => {
    if (!line.startsWith("data:")) return line;
    if (written) return "";written = true;
    return "data: " + JSON.stringify(event) + (line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "");
  }).join("");
  return named && !/^event:/m.test(output) ? "event: " + event.type + "\n" + output : output;
}

export function createPrivacyStream(session, { maxBufferedBytes = 32 * 1024 * 1024, maxChannels = 1024 } = {}) {
  const decoder = new StringDecoder("utf8"), channels = new Map(), aliases = new Map();
  let pending = "", pendingBytes = 0, bufferedBytes = 0, ended = false, completed = false, lastSequence = -1;
  let eventType = "", channelType = null;
  function fail(code) {
    return Object.assign(privacyFailure(code, "response"), { privacyDiagnostic: {
      privacy_error: "ccdx_privacy_" + code,
      privacy_event_type: /^[a-z0-9_.]{1,80}$/.test(eventType) ? eventType : "unknown",
      privacy_channel_type: channelType || "event",
      privacy_buffered_bytes: bufferedBytes + pendingBytes,
      privacy_terminal_seen: ended ? 1 : 0,
    } });
  }
  function clear() { channels.clear();aliases.clear();bufferedBytes = 0; }
  function baseKey(event) {
    const id = event.item_id ?? event.item?.id;
    if (Number.isSafeInteger(event.output_index) && event.output_index >= 0) {
      const value = "r:i:" + event.output_index;
      if (eventType === "response.output_item.added" && typeof id === "string" && !aliases.has(id)) {
        const bytes = Buffer.byteLength(id) + 128;bufferedBytes += bytes;aliases.set(id, { key: value, bytes });
        if (aliases.size > maxChannels || bufferedBytes > maxBufferedBytes) throw fail("stream_limit");
      }
      return value;
    }
    return aliases.get(id)?.key || "r:id:" + (id || event.call_id || "unknown");
  }
  function key(event) {
    return baseKey(event) + ":c:" + (Number.isSafeInteger(event.content_index) && event.content_index >= 0 ? event.content_index : 0);
  }
  function releaseAliases(base) {
    for (const [alias, entry] of aliases) if (entry.key === base) { bufferedBytes -= entry.bytes;aliases.delete(alias); }
  }
  function forget(id) {
    const channel = channels.get(id);bufferedBytes -= (channel?.bytes || 0) + (channel?.stateBytes || 0);channels.delete(id);
  }
  function emit(wire, event, changed = false, named = false) {
    // Added tail deltas must not repeat a prior sequence number. Without an
    // inserted event the upstream's numbers and frame bytes remain unchanged.
    if (Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0) {
      const sequence = Math.max(lastSequence + 1, event.sequence_number);
      if (sequence !== event.sequence_number) { event.sequence_number = sequence;changed = true; }
      lastSequence = sequence;
    }
    return changed ? rewrite(wire, event, named) : wire;
  }
  function release(id, snapshot) {
    const channel = channels.get(id);if (!channel) return "";
    channelType = channel.kind;
    if (channel.kind === "json") {
      if (typeof snapshot === "string") {
        try { JSON.parse(snapshot); } catch { throw fail("stream_arguments_invalid"); }
      } else if (!channel.reader.complete()) throw fail("stream_arguments_incomplete");
    }
    let output = "";
    if (channel.template) {
      const event = structuredClone(channel.template), target = event.type === "content_block_delta" ? event.delta : event.item || event;
      target[channel.field] = channel.reader.finish();
      output = emit(channel.wire, event, true, true);
    }
    forget(id);return output;
  }
  function transform(wire) {
    const lines = wire.split(/\r?\n/), data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return wire;
    let event;
    try { event = JSON.parse(data); } catch { throw fail("stream_invalid"); }
    eventType = typeof event.type === "string" ? event.type : lines.find(line => line.startsWith("event:"))?.slice(6).trim() || "";
    channelType = null;
    if (["thinking_delta", "signature_delta"].includes(event.delta?.type) || /\.reasoning(?:_|\.)/.test(eventType)) return emit(wire, event);
    if (["error", "response.failed", "response.incomplete"].includes(eventType)) {
      ended = true;clear();
      return data.includes(START) ? emit(wire, session.restoreValue(event), true) : emit(wire, event);
    }
    const id = eventType.startsWith("content_block_") ? "m:" + event.index : key(event);
    let target, field, kind, changed = false, before = "";
    if (eventType === "content_block_delta" && event.delta?.type === "input_json_delta") { target = event.delta;field = "partial_json";kind = "json"; }
    else if (eventType === "response.function_call_arguments.delta") { target = event;field = "delta";kind = "json"; }
    else if (eventType === "content_block_delta" && event.delta?.type === "text_delta") { target = event.delta;field = "text";kind = "text"; }
    else if (eventType === "response.output_text.delta" || eventType === "response.custom_tool_call_input.delta") { target = event;field = "delta";kind = "text"; }
    else if (eventType === "response.output_item.added" && event.item?.type === "function_call" && typeof event.item.arguments === "string") { target = event.item;field = "arguments";kind = "json"; }
    else if (eventType === "response.output_item.added" && event.item?.type === "custom_tool_call" && typeof event.item.input === "string") { target = event.item;field = "input";kind = "text"; }
    if (target) {
      channelType = kind;
      if (typeof target[field] !== "string") throw fail("stream_invalid");
      let channel = channels.get(id);
      if (!channel) {
        channel = { kind, rawBytes: 0, last: 0, stateBytes: 0 };
        channel.reader = fragments(session, kind === "json", retained => {
          bufferedBytes += retained - channel.stateBytes;channel.stateBytes = retained;
          if (bufferedBytes > maxBufferedBytes) throw fail("stream_limit");
        });
        channels.set(id, channel);
        if (channels.size > maxChannels) throw fail("stream_limit");
      }
      if (channel.kind !== kind) throw fail("stream_channel_invalid");
      const original = target[field], first = original.charCodeAt(0);
      const joins = channel.last >= 0xD800 && channel.last <= 0xDBFF && first >= 0xDC00 && first <= 0xDFFF;
      channel.rawBytes += Buffer.byteLength(original) - (joins ? 2 : 0);
      if (original.length) channel.last = original.charCodeAt(original.length - 1);
      if (kind === "json" && channel.rawBytes > 8 * 1024 * 1024) throw fail("stream_limit");
      target[field] = channel.reader.push(original);changed = target[field] !== original;
      bufferedBytes -= channel.bytes || 0;channel.bytes = 0;channel.template = null;
      if (channel.reader.held()) {
        let template = eventType === "content_block_delta" ? { ...event, delta: { ...target, [field]: "" } }
          : target === event.item ? { ...event, item: { ...target, [field]: "" } } : { ...event, [field]: "" };
        if (target === event.item) {
          template = { type: kind === "json" ? "response.function_call_arguments.delta" : "response.custom_tool_call_input.delta",
            item_id: event.item.id, output_index: event.output_index, sequence_number: event.sequence_number, delta: "" };
          field = "delta";
        }
        if (!template.type) template.type = eventType;
        channel.template = template;channel.field = field;
        channel.wire = rewrite(wire.replace(/^event:[^\r\n]*/m, "event: " + template.type), template);
        channel.bytes = 128 + Buffer.byteLength(channel.wire) + Buffer.byteLength(JSON.stringify(template));
        bufferedBytes += channel.bytes;if (bufferedBytes > maxBufferedBytes) throw fail("stream_limit");
      } else if (kind === "text") forget(id);
    } else {
      if (eventType === "response.function_call_arguments.done") before += release(id, event.arguments);
      else if (eventType === "response.output_item.done") {
        const base = baseKey(event);
        for (const [activeId] of channels) if (activeId.startsWith(base + ":c:")) before += release(activeId, event.item?.arguments);
        releaseAliases(base);
      } else if (eventType === "content_block_stop" || eventType === "response.content_part.done"
        || eventType === "response.output_text.done" || eventType === "response.custom_tool_call_input.done") before += release(id, undefined);
      if (["message_stop", "response.completed"].includes(eventType)) {
        ended = true;completed = true;
        for (const [activeId] of channels) {
          const match = /^r:i:(\d+):c:/.exec(activeId), index = match ? Number(match[1]) : null;
          const item = index !== null ? event.response?.output?.[index] : event.response?.output?.find(value => activeId.startsWith("r:id:" + value.id + ":c:"));
          before += release(activeId, item?.type === "function_call" ? item.arguments : undefined);
        }
        for (const entry of aliases.values()) bufferedBytes -= entry.bytes;aliases.clear();
      }
      if (data.includes(START)) {
        const restored = session.restoreValue(event);
        if (JSON.stringify(restored) !== JSON.stringify(event)) { event = restored;changed = true; }
      }
    }
    return before + emit(wire, event, changed);
  }
  return {
    completed: () => completed,
    push(chunk) {
      try {
        pending += decoder.write(chunk);pendingBytes += chunk.length;
        if (pendingBytes > 8 * 1024 * 1024) throw fail("stream_limit");
        let output = "", match;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
          const end = match.index + match[0].length, wire = pending.slice(0, end);pending = pending.slice(end);
          pendingBytes = Buffer.byteLength(pending);output += transform(wire);
        }
        return output;
      } catch (error) { completed = false;clear();pending = "";pendingBytes = 0;throw error; }
    },
    finish() {
      try {
        pending += decoder.end();const output = pending ? transform(pending + "\n\n") : "";pending = "";
        if (channels.size) throw fail("stream_incomplete");return output;
      } catch (error) { completed = false;throw error; }
      finally { clear();pending = "";pendingBytes = 0; }
    },
  };
}
