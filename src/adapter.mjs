import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";

const COPILOT_API_PORT = parseInt(process.env.COPILOT_API_PORT || "4141");
const COPILOT_API = "https://api.githubcopilot.com";
const GITHUB_API = "https://api.github.com";

// Models that only support Responses API (not chat/completions)
const RESPONSES_ONLY = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
]);

// ── Copilot Token ──

let copilotToken = null;
let copilotTokenExpiry = 0;

function getGithubToken() {
  const p = path.join(os.homedir(), ".local", "share", "copilot-api", "github_token");
  if (!fs.existsSync(p)) throw new Error("GitHub token not found. Run: npx copilot-api auth");
  return fs.readFileSync(p, "utf-8").trim();
}

async function getCopilotToken() {
  if (copilotToken && Date.now() < copilotTokenExpiry - 60000) return copilotToken;
  const ghToken = getGithubToken();
  const resp = await fetch(`${GITHUB_API}/copilot_internal/v2/token`, {
    headers: { Authorization: `token ${ghToken}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Failed to get Copilot token: ${resp.status}`);
  const data = await resp.json();
  copilotToken = data.token;
  copilotTokenExpiry = data.expires_at * 1000;
  console.log("[codex-copilot-dx] Copilot token refreshed");
  return copilotToken;
}

// ── Direct Copilot Responses API proxy ──

async function proxyCopilotResponses(reqBody, req, res) {
  const token = await getCopilotToken();
  const resp = await fetch(`${COPILOT_API}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Editor-Version": "vscode/1.90.0",
      "Copilot-Integration-Id": "vscode-chat",
    },
    body: JSON.stringify(reqBody),
  });

  if (reqBody.stream) {
    res.writeHead(resp.status, {
      "Content-Type": resp.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(value);
    }
  } else {
    const data = await resp.text();
    res.writeHead(resp.status, { "Content-Type": "application/json" });
    res.end(data);
  }
}

async function proxyCopilotResponsesWS(reqBody, wsSend, onDone) {
  const token = await getCopilotToken();
  const resp = await fetch(`${COPILOT_API}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Editor-Version": "vscode/1.90.0",
      "Copilot-Integration-Id": "vscode-chat",
    },
    body: JSON.stringify({ ...reqBody, stream: true }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    wsSend(JSON.stringify({ type: "error", error: { message: err, code: resp.status } }));
    onDone();
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let currentEvent = null;
  let sawCompleted = false;
  let lastResponseId = `resp_${uid()}`;
  let lastModel = reqBody.model || "unknown";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith("event: ")) { currentEvent = line.slice(7).trim(); continue; }
        if (!line.startsWith("data: ")) { if (line === "") currentEvent = null; continue; }
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (!parsed.type && currentEvent) parsed.type = currentEvent;
        if (!parsed.type) continue;
        if (parsed.response?.id) lastResponseId = parsed.response.id;
        if (parsed.response?.model) lastModel = parsed.response.model;
        if (parsed.type === "response.completed") sawCompleted = true;
        wsSend(JSON.stringify(parsed));
      }
    }
  } catch (e) {
    wsSend(JSON.stringify({ type: "error", error: { message: e.message || String(e), code: 500 } }));
    onDone();
    return;
  }
  if (!sawCompleted) {
    wsSend(JSON.stringify({
      type: "response.completed",
      response: { id: lastResponseId, object: "response", status: "completed", model: lastModel, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    }));
  }
  onDone();
}

// ── Chat Completions conversion (for older models via copilot-api) ──

function responsesToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item.type === "message") {
        const content =
          typeof item.content === "string"
            ? item.content
            : Array.isArray(item.content)
              ? item.content.map((p) => (p.type === "input_text" || p.type === "text" ? p.text : JSON.stringify(p))).join("")
              : JSON.stringify(item.content);
        messages.push({ role: item.role, content });
      } else if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: item.call_id || randomUUID(), type: "function", function: { name: item.name, arguments: item.arguments } }],
        });
      } else if (item.type === "function_call_output") {
        messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
      }
    }
  }

  const chatReq = { model: body.model, messages, stream: true };
  for (const k of ["temperature", "top_p", "stop", "presence_penalty", "frequency_penalty"]) {
    if (body[k] !== undefined) chatReq[k] = body[k];
  }
  const maxTok = body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens;
  if (maxTok !== undefined) chatReq.max_completion_tokens = maxTok;

  if (body.tools?.length) {
    chatReq.tools = body.tools
      .map((t) => (t.type === "function" ? t : { type: "function", function: t }))
      .filter((t) => t.function?.name);
    if (!chatReq.tools.length) delete chatReq.tools;
  }
  return chatReq;
}

function uid() { return randomUUID().replace(/-/g, ""); }

function chatToResponses(chatResp, model) {
  const id = `resp_${uid()}`, choice = chatResp.choices?.[0], msg = choice?.message, output = [];
  if (msg?.content) output.push({ type: "message", id: `msg_${uid()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.content }] });
  if (msg?.tool_calls) for (const tc of msg.tool_calls) output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
  return { id, object: "response", status: "completed", model: chatResp.model || model, output, usage: chatResp.usage ? { input_tokens: chatResp.usage.prompt_tokens || 0, output_tokens: chatResp.usage.completion_tokens || 0, total_tokens: chatResp.usage.total_tokens || 0 } : undefined };
}

function processStream(upstreamRes, emitEvent, onDone) {
  const respId = `resp_${uid()}`, itemId = `item_${uid()}`;
  let actualModel = "unknown";

  emitEvent("response.created", { response: { id: respId, object: "response", status: "in_progress", model: actualModel, output: [] } });
  emitEvent("response.output_item.added", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
  emitEvent("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });

  let buf = "", fullText = "", toolCalls = {}, hasToolCalls = false, finished = false;

  const finish = (errMsg) => {
    if (finished) return;
    finished = true;
    if (errMsg) {
      emitEvent("error", { error: { message: errMsg, code: 500 } });
    } else {
      emitEvent("response.output_text.done", { output_index: 0, content_index: 0, text: fullText });
      emitEvent("response.output_item.done", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] } });
      const output = hasToolCalls
        ? Object.entries(toolCalls).map(([id, tc]) => ({ type: "function_call", id, call_id: id, name: tc.name, arguments: tc.arguments, status: "completed" }))
        : [{ type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] }];
      emitEvent("response.completed", { response: { id: respId, object: "response", status: "completed", model: actualModel, output, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
    }
    onDone();
  };

  upstreamRes.on("data", (chunk) => {
    buf += chunk.toString();
    let lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        if (!hasToolCalls) {
          emitEvent("response.output_text.done", { output_index: 0, content_index: 0, text: fullText });
          emitEvent("response.output_item.done", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] } });
        }
        const output = hasToolCalls
          ? Object.entries(toolCalls).map(([id, tc]) => ({ type: "function_call", id, call_id: id, name: tc.name, arguments: tc.arguments, status: "completed" }))
          : [{ type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] }];
        emitEvent("response.completed", { response: { id: respId, object: "response", status: "completed", model: actualModel, output, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
        finished = true;
        onDone();
        return;
      }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.model) actualModel = parsed.model;
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { fullText += delta.content; emitEvent("response.output_text.delta", { output_index: 0, content_index: 0, delta: delta.content }); }
      if (delta.tool_calls) {
        hasToolCalls = true;
        for (const tc of delta.tool_calls) {
          const id = tc.id || Object.keys(toolCalls)[tc.index] || `call_${tc.index}`;
          if (!toolCalls[id]) { toolCalls[id] = { name: "", arguments: "" }; emitEvent("response.output_item.added", { output_index: Object.keys(toolCalls).length - 1, item: { type: "function_call", id, call_id: id, name: tc.function?.name || "", arguments: "", status: "in_progress" } }); }
          if (tc.function?.name) toolCalls[id].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[id].arguments += tc.function.arguments;
        }
      }
    }
  });
  upstreamRes.on("end", () => finish());
  upstreamRes.on("error", (e) => finish(e?.message || "upstream stream error"));
}

function forwardToChat(chatReq, emitEvent, onDone, onError) {
  delete chatReq.max_tokens;
  const body = JSON.stringify(chatReq);
  const opts = { hostname: "localhost", port: COPILOT_API_PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
  const proxy = http.request(opts, (upRes) => {
    if (upRes.statusCode !== 200) { let d = ""; upRes.on("data", c => d += c); upRes.on("end", () => onError(upRes.statusCode, d)); return; }
    processStream(upRes, emitEvent, onDone);
  });
  proxy.on("error", (e) => onError(502, e.message));
  proxy.write(body);
  proxy.end();
}

// ── WebSocket (RFC 6455 minimal) ──

function wsRead(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (data) => {
      chunks.push(data);
      const buf = Buffer.concat(chunks);
      if (buf.length < 2) return;
      const masked = (buf[1] & 0x80) !== 0;
      let payloadLen = buf[1] & 0x7f, offset = 2;
      if (payloadLen === 126) { if (buf.length < 4) return; payloadLen = buf.readUInt16BE(2); offset = 4; }
      else if (payloadLen === 127) { if (buf.length < 10) return; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + payloadLen) return;
      let payload = buf.slice(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) { const mask = buf.slice(offset, offset + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
      socket.removeListener("data", onData);
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) resolve(null);
      else if (opcode === 0x9) { wsSend(socket, "", 0xa); chunks.length = 0; socket.on("data", onData); }
      else resolve(payload.toString("utf-8"));
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => resolve(null));
  });
}

function wsSend(socket, data, opcode = 0x1) {
  const payload = typeof data === "string" ? Buffer.from(data) : data;
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[0] = 0x80 | opcode; header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}

async function handleWebSocket(req, socket) {
  let rawKey = req.headers["sec-websocket-key"];
  if (Array.isArray(rawKey)) rawKey = rawKey[0];
  const key = (rawKey || "").trim();
  const upgrade = String(req.headers["upgrade"] || "").toLowerCase();
  const connection = String(req.headers["connection"] || "").toLowerCase();
  if (!key || upgrade !== "websocket" || !connection.includes("upgrade")) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-5AB9FC6AB199").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");

  while (true) {
    const msg = await wsRead(socket);
    if (msg === null) break;
    let parsed;
    try { parsed = JSON.parse(msg); } catch { continue; }
    let reqBody = parsed;
    if (parsed.type === "response.create" && parsed.response) reqBody = parsed.response;
    const model = reqBody.model || "unknown";

    if (RESPONSES_ONLY.has(model)) {
      proxyCopilotResponsesWS(reqBody, (d) => wsSend(socket, d), () => {}).catch((e) => {
        wsSend(socket, JSON.stringify({ type: "error", error: { message: e.message, code: 500 } }));
      });
    } else {
      const chatReq = responsesToChat(reqBody);
      chatReq.stream = true;
      forwardToChat(chatReq, (event, data) => wsSend(socket, JSON.stringify({ type: event, ...data })), () => {}, (status, errMsg) => {
        wsSend(socket, JSON.stringify({ type: "error", error: { message: errMsg, code: status } }));
      });
    }
  }
}

// ── HTTP passthrough ──

function proxyPassthrough(req, res) {
  const opts = { hostname: "localhost", port: COPILOT_API_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${COPILOT_API_PORT}` } };
  const proxy = http.request(opts, (upRes) => { res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res); });
  proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Bad Gateway"); });
  req.pipe(proxy);
}

// ── Export ──

export function startAdapter(port = 4142) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/v1/responses")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const model = parsed.model || "unknown";
          console.log(`[codex-copilot-dx] ${model} stream=${!!parsed.stream}`);
          if (RESPONSES_ONLY.has(model)) {
            await proxyCopilotResponses(parsed, req, res);
          } else {
            const chatReq = responsesToChat(parsed);
            if (parsed.stream) {
              forwardToChat(chatReq, (event, data) => {
                if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
              }, () => { if (!res.writableEnded) res.end(); }, (status, errMsg) => { if (!res.headersSent) res.writeHead(status || 500); res.end(errMsg); });
            } else {
              chatReq.stream = false;
              delete chatReq.max_tokens;
              const reqBody = JSON.stringify(chatReq);
              const opts = { hostname: "localhost", port: COPILOT_API_PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reqBody) } };
              const proxy = http.request(opts, (upRes) => {
                let data = ""; upRes.on("data", (c) => (data += c));
                upRes.on("end", () => { try { const resp = chatToResponses(JSON.parse(data), model); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(resp)); } catch { res.writeHead(500).end("Parse error"); } });
              });
              proxy.on("error", () => res.writeHead(502).end("Bad Gateway"));
              proxy.write(reqBody);
              proxy.end();
            }
          }
        } catch (e) {
          console.error("[codex-copilot-dx] error:", e.message);
          if (!res.headersSent) res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    proxyPassthrough(req, res);
  });

  server.on("upgrade", (req, socket) => {
    // Codex Desktop 0.130+ negotiates a "responses_websockets" server-push
    // protocol on WS upgrade. We don't implement that protocol; accepting the
    // upgrade and waiting for a client request just hangs and triggers a
    // 5-attempt reconnect storm. Refuse the upgrade so Codex falls back to
    // plain HTTP SSE, which this adapter handles correctly.
    socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[codex-copilot-dx] Adapter listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}
