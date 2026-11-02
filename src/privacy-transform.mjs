import { createHash, createHmac } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { privacyFailure } from "./privacy-model.mjs";

const TOKEN_START = "{{CCDX_", tokenPattern = /\{\{CCDX_[a-f0-9]{24}\}\}/g;
const secretPatterns = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{25,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})\b/g,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
];
const secretField = /(?:["']?\b(?:password|passwd|api_key|apikey|access_token|refresh_token|client_secret|secret_key|auth_token|db_password)\b["']?\s*[:=]\s*)(?:"((?:\\.|[^"\\\r\n])+)"|'((?:\\.|[^'\\\r\n])+)'|([^\s,;\r\n}]+))/gdi;
const personalKinds = new Set(["email", "phone", "account", "payment_card", "private_address", "private_date", "private_person"]);
const kept = new Set(["model", "id", "type", "role", "name", "namespace", "server_label", "server_name", "call_id", "tool_use_id", "item_id", "signature", "encrypted_content", "thought_signature", "thoughtSignature", "data", "url", "file_id", "previous_response_id", "prompt_cache_key", "media_type", "mime_type", "stop_reason", "finish_reason", "status", "object", "event"]);
function leaves(value, add, inArguments = false) {
  if (typeof value === "string") return;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) typeof value[i] === "string" ? add(value, i, value[i], inArguments) : leaves(value[i], add, inArguments);return; }
  if (!value || typeof value !== "object") return;
  if (!inArguments && (value.encrypted_content || ["thinking", "redacted_thinking", "reasoning"].includes(value.type))) return;
  for (const [key, item] of Object.entries(value)) {
    if (!inArguments && kept.has(key)) continue;
    if (typeof item === "string") add(value, key, item, inArguments);
    else leaves(item, add, inArguments);
  }
}
function requestTexts(body, protocol) {
  const items = [], nested = [];
  const add = (parent, key, text) => { if (text && !text.startsWith("data:")) items.push({ parent, key, text, secret: /^(?:password|passwd|api_key|apikey|access_token|refresh_token|client_secret|secret_key|auth_token|db_password|credential|secret|token)$/i.test(String(key)) }); };
  const text = (parent, key) => { if (typeof parent?.[key] === "string") add(parent, key, parent[key]);else if (Array.isArray(parent?.[key])) for (const block of parent[key]) if (["text", "input_text", "output_text"].includes(block?.type)) add(block, "text", block.text); };
  const args = (parent, key) => {
    if (typeof parent[key] === "string") {
      try { const value = JSON.parse(parent[key]);leaves(value, add, true);nested.push({ parent, key, value }); }
      catch { throw privacyFailure("arguments_invalid"); }
    } else leaves(parent[key], add, true);
  };
  const descriptions = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) { if (key === "description" && typeof item === "string") add(value, key, item);else if (item && typeof item === "object") descriptions(item); }
  };
  descriptions(body.tools);
  if (protocol === "messages" || protocol === "chat") {
    text(body, "system");
    for (const message of body.messages || []) {
      text(message, "content");
      for (const call of message.tool_calls || []) if (call?.function?.arguments) args(call.function, "arguments");
      if (Array.isArray(message.content)) for (const block of message.content) {
        if (block?.type === "tool_use") args(block, "input");
        if (block?.type === "tool_result") text(block, "content");
      }
    }
  } else {
    text(body, "instructions");
    if (typeof body.input === "string") add(body, "input", body.input);
    else for (const item of body.input || []) {
      if (["additional_tools", "tool_search_output"].includes(item.type)) descriptions(item.tools);
      else if (item.type === "function_call") args(item, "arguments");
      else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) text(item, "output");
      else if (item.type === "custom_tool_call") text(item, "input");
      else text(item, "content");
    }
  }
  return { items, nested };
}
function ruleSpans(text, personal) {
  const spans = [];
  for (const pattern of secretPatterns) { pattern.lastIndex = 0;for (const m of text.matchAll(pattern)) spans.push({ start: m.index, end: m.index + m[0].length, kind: "secret" }); }
  secretField.lastIndex = 0;
  for (const m of text.matchAll(secretField)) { const at = m.indices[1] || m.indices[2] || m.indices[3];spans.push({ start: at[0], end: at[1], kind: "secret" }); }
  if (personal) for (const m of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    if (!/@(?:example\.(?:com|org|net)|[^@]*\.(?:test|invalid))$/i.test(m[0])) spans.push({ start: m.index, end: m.index + m[0].length, kind: "email" });
  }
  return spans;
}
export function createPrivacyRuleCache({ maxBytes = 1024 * 1024, maxEntries = 2048 } = {}) {
  const entries = new Map();let bytes = 0, hits = 0, scans = 0;
  return {
    find(text, personal) {
      if (text.length < 256) { scans++;return ruleSpans(text, personal); }
      const key = `${personal ? 1 : 0}:` + createHash("sha256").update(text).digest("hex");
      if (entries.has(key)) {
        const entry = entries.get(key);entries.delete(key);entries.set(key, entry);hits++;
        return entry.spans.map(span => ({ ...span }));
      }
      scans++;const spans = ruleSpans(text, personal), cost = Buffer.byteLength(JSON.stringify(spans)) + 128;
      if (cost <= maxBytes) {
        entries.set(key, { spans: spans.map(span => ({ ...span })), cost });bytes += cost;
        while (entries.size > maxEntries || bytes > maxBytes) { const oldest = entries.keys().next().value;bytes -= entries.get(oldest).cost;entries.delete(oldest); }
      }
      return spans;
    },
    clear() { entries.clear();bytes = 0; },
    stats: () => ({ entries: entries.size, bytes, hits, scans, max_bytes: maxBytes }),
  };
}
function modelSpanFits(text, start, end, label) {
  const value = text.slice(start, end);
  if (label === "common_secret" && /^\d+$/.test(value)) {
    return /(?:\b(?:api_key|apikey|access_token|refresh_token|client_secret|secret_key|auth_token|db_password|password|passwd|passcode|secret|token|pin)|密钥|密码|令牌|口令)["'`]?[\s:=：]*(?:(?:is|was|是|为|為)\s*)?["'`]?$/i.test(text.slice(Math.max(0, start - 96), start));
  }
  if (label === "private_person" && /^[A-Za-z_$][\w$]*$/.test(value)
    && /\b(?:function|class|const|let|var)\s+$/.test(text.slice(Math.max(0, start - 32), start))) return false;
  return true;
}
export function validatePrivacyFindings(texts, found) {
  if (!Array.isArray(found) || found.length !== texts.length) throw privacyFailure("engine_invalid");
  return found.map((items, index) => {
    if (items === null) return [];
    if (!Array.isArray(items)) throw privacyFailure("engine_invalid");
    const bytes = Buffer.byteLength(texts[index]);
    for (const span of items) {
      if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start
        || span.end > bytes || !Number.isFinite(span.score) || span.score < 0 || span.score > 1 || typeof span.label !== "string") throw privacyFailure("engine_invalid");
    }
    return items;
  });
}

export async function maskPrivacyRequest(body, { protocol, client = "api", personal = false, secret, find, signal, rules = ruleSpans }) {
  const copy = structuredClone(body), { items, nested } = requestTexts(copy, protocol), texts = items.map(item => item.text);
  if (items.length > 8192 || texts.reduce((n, text) => n + Buffer.byteLength(text), 0) > 8 * 1024 * 1024) throw privacyFailure("request_too_large");
  const found = texts.length ? await find(texts, { signal }) : [], values = new Map(), kinds = {}, total = { count: 0, bytes: 0 };
  if (!Array.isArray(found) || found.length !== texts.length) throw privacyFailure("engine_invalid");
  for (let i = 0; i < items.length; i++) {
    const item = items[i], bytes = Buffer.from(item.text), spans = rules(item.text, personal);
    if (item.secret) spans.push({ start: 0, end: item.text.length, kind: "secret" });
    for (const span of found[i] || []) {
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > bytes.length || !Number.isFinite(span.score)) throw privacyFailure("engine_invalid");
      if (span.score < 0.8 || span.label !== "common_secret" && !(personal && personalKinds.has(span.label))) continue;
      const start = bytes.subarray(0, span.start).toString("utf8").length, end = bytes.subarray(0, span.end).toString("utf8").length;
      if (!modelSpanFits(item.text, start, end, span.label)) continue;
      spans.push({ start, end, kind: span.label === "common_secret" ? "secret" : span.label });
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = 0, output = "";
    for (const span of spans) {
      if (span.start < end) continue;
      const value = item.text.slice(span.start, span.end);
      if (!value || tokenPattern.test(value)) { tokenPattern.lastIndex = 0;continue; }
      tokenPattern.lastIndex = 0;
      const token = `{{CCDX_${createHmac("sha256", secret).update(client + "\0" + value).digest("hex").slice(0, 24)}}}`;
      if (!values.has(token)) { total.bytes += Buffer.byteLength(value);if (values.size >= 8192 || total.bytes > 4 * 1024 * 1024) throw privacyFailure("mapping_limit");values.set(token, value); }
      output += item.text.slice(end, span.start) + token;end = span.end;total.count++;kinds[span.kind] = (kinds[span.kind] || 0) + 1;
    }
    if (end) item.parent[item.key] = output + item.text.slice(end);
  }
  if (total.count) for (const item of nested) item.parent[item.key] = JSON.stringify(item.value);
  const restoreText = text => text.replace(tokenPattern, token => values.get(token) ?? token);
  function restoreValue(value, inToolData = false) {
    if (typeof value === "string") return restoreText(value);
    if (Array.isArray(value)) return value.map(item => restoreValue(item, inToolData));
    if (!value || typeof value !== "object") return value;
    if (!inToolData && (value.encrypted_content || ["thinking", "redacted_thinking", "reasoning"].includes(value.type))) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, !inToolData && kept.has(key) ? item
      : !inToolData && key === "arguments" && typeof item === "string" && item ? restoreArguments(item)
        : restoreValue(item, inToolData || key === "input" && ["tool_use", "server_tool_use", "mcp_tool_use"].includes(value.type))]));
  }
  function restoreArguments(text) { try { return JSON.stringify(restoreValue(JSON.parse(text), true)); } catch { return restoreText(text); } }
  return { body: total.count ? copy : body, count: total.count, kinds, restoreText, restoreValue,
    restoreToolValue: value => restoreValue(value, true), release: () => values.clear() };
}

function rewritePrivacyFrame(wire, value, named = false) {
  let written = false;
  const lines = wire.split(/(?<=\n)/).map(line => {
    if (!line.startsWith("data:")) return line;
    if (written) return "";
    written = true;
    return `data: ${JSON.stringify(value)}${line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""}`;
  }).join("");
  return named && !/^event:/m.test(wire) ? `event: ${value.type}\n${lines}` : lines;
}

export function createPrivacyStream(session, { maxBufferedBytes = 32 * 1024 * 1024, maxChannels = 1024 } = {}) {
  const fail = code => privacyFailure(code, "response");
  let pending = "", bytes = 0, bufferedBytes = 0;const channels = new Map(), decoder = new StringDecoder("utf8");
  const forget = id => { bufferedBytes -= channels.get(id)?.bytes || 0;channels.delete(id); };
  const clear = () => { channels.clear();bufferedBytes = 0; };
  function transform(wire) {
    const data = wire.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return wire;
    let event;try { event = JSON.parse(data); } catch { throw fail("stream_invalid"); }
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) { clear();return rewritePrivacyFrame(wire, session.restoreValue(event)); }
    if (["thinking_delta", "signature_delta"].includes(event.delta?.type) || /\.reasoning(?:_|\.)/.test(event.type || "")) return wire;
    const isMessages = event.type === "content_block_delta", delta = isMessages ? event.delta : event;
    const tool = delta?.type === "input_json_delta" || event.type === "response.function_call_arguments.delta";
    const text = delta?.type === "text_delta" || ["response.output_text.delta", "response.custom_tool_call_input.delta"].includes(event.type);
    let before = "";
    const key = isMessages ? `m:${event.index}` : `r:${event.item_id || event.item?.id || event.output_index}:${event.content_index || 0}`;
    if (tool || text) {
      const field = tool ? isMessages ? "partial_json" : "delta" : isMessages ? "text" : "delta";
      if (typeof delta[field] !== "string") throw fail("stream_invalid");
      const channel = channels.get(key) || { tail: "", tool, field };
      let value = channel.tail + delta[field];
      if (Buffer.byteLength(value) > 8 * 1024 * 1024) throw fail("stream_limit");
      if (tool) channel.tail = value;
      else {
        let cut = value.length;
        const at = value.lastIndexOf("{{CCDX_");
        if (at >= 0 && !value.slice(at).includes("}}")) cut = at;
        else for (let n = 1; n < TOKEN_START.length; n++) if (value.endsWith(TOKEN_START.slice(0, n))) cut = value.length - n;
        channel.tail = value.slice(cut);delta[field] = session.restoreText(value.slice(0, cut));
      }
      if (tool || channel.tail) {
        // Retain metadata and the unfinished value once, rather than retaining
        // the full latest delta in both the template and its original frame.
        channel.template = isMessages ? { ...event, delta: { ...delta, [field]: "" } } : { ...event, [field]: "" };
        channel.wire = rewritePrivacyFrame(wire, channel.template);
        const cost = Buffer.byteLength(channel.tail) + Buffer.byteLength(channel.wire) + Buffer.byteLength(JSON.stringify(channel.template));
        bufferedBytes += cost - (channel.bytes || 0);channel.bytes = cost;channels.set(key, channel);
        if (bufferedBytes > maxBufferedBytes || channels.size > maxChannels) throw fail("stream_limit");
      } else forget(key);
      if (tool) return "";
    }
    const stopKey = event.type === "content_block_stop" ? `m:${event.index}` : /\.done$/.test(event.type || "") ? key : null;
    const terminal = ["message_stop", "response.completed", "response.incomplete", "error", "response.failed"].includes(event.type);
    for (const [id, channel] of channels) if (terminal || id === stopKey) {
      if (channel.tail) {
        const value = structuredClone(channel.template), target = value.type === "content_block_delta" ? value.delta : value;
        try { target[channel.field] = channel.tool ? JSON.stringify(session.restoreToolValue(JSON.parse(channel.tail))) : session.restoreText(channel.tail); }
        catch { throw fail("stream_invalid"); }
        before += rewritePrivacyFrame(channel.wire, value, true);
      }
      forget(id);
    }
    event = session.restoreValue(event);
    return before + rewritePrivacyFrame(wire, event);
  }
  return {
    push(chunk) {
      try {
      pending += decoder.write(chunk);bytes += chunk.length;if (bytes > 8 * 1024 * 1024) throw fail("stream_limit");
      let output = "", match;
      while ((match = /\r?\n\r?\n/.exec(pending))) { const end = match.index + match[0].length;output += transform(pending.slice(0, end));pending = pending.slice(end);bytes = Buffer.byteLength(pending); }
      return output;
      } catch (error) { clear();pending = "";bytes = 0;throw error; }
    },
    finish() {
      try {
        pending += decoder.end();const output = pending ? transform(pending + "\n\n") : "";pending = "";
        if (channels.size) throw fail("stream_incomplete");return output;
      } finally { clear();pending = "";bytes = 0; }
    },
  };
}

export function protectPrivacyResponse(res, session) {
  if (!session.count) return;
  const write = res.write.bind(res), end = res.end.bind(res), writeHead = res.writeHead.bind(res), stream = createPrivacyStream(session);
  let mode = null, parts = [], size = 0;
  const detach = () => { res.write = write;res.end = end;res.writeHead = writeHead;parts = [];session.release(); };
  res.writeHead = (code, ...args) => {
    const headers = args.find(value => value && typeof value === "object" && !Array.isArray(value));
    if (headers) { const copy = { ...headers };for (const key of Object.keys(copy)) if (key.toLowerCase() === "content-length") delete copy[key];args[args.indexOf(headers)] = copy; }
    res.removeHeader("Content-Length");mode = String(headers?.["Content-Type"] || headers?.["content-type"] || res.getHeader("Content-Type") || "").includes("text/event-stream") ? "stream" : "json";
    return writeHead(code, ...args);
  };
  res.write = (value, encoding, callback) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, typeof encoding === "string" ? encoding : undefined);
    if (mode === "stream") { try { const output = stream.push(bytes);return output ? write(output, typeof encoding === "function" ? encoding : callback) : true; }catch (error) { detach();throw error; } }
    size += bytes.length;if (size > 16 * 1024 * 1024) throw privacyFailure("response_limit", "response");parts.push(bytes);return true;
  };
  res.end = (value, encoding, callback) => {
    if (value !== undefined && value !== null) res.write(value, encoding);
    let output;
    if (mode === "stream") { try { output = stream.finish(); }catch (error) { detach();throw error; } }
    else if (parts.length) { const text = Buffer.concat(parts).toString("utf8");try { output = JSON.stringify(session.restoreValue(JSON.parse(text))); }catch { output = session.restoreText(text); }parts = []; }
    return end(output || undefined, typeof encoding === "function" ? encoding : callback);
  };
  const release = () => { session.release();parts = []; };
  res.once("finish", release);res.once("close", release);
}
