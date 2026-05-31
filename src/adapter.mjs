import http from "node:http";
import { randomUUID } from "node:crypto";
import { chatCompletions, listModels, responses as copilotResponses } from "./copilot.mjs";
import { webStreamLines } from "./stream.mjs";
import { anthropicToChat, chatToAnthropic, streamAnthropicFromLines, countTokens } from "./anthropic.mjs";

// Models that only support Responses API (not chat/completions)
const RESPONSES_ONLY = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
]);

// ── Direct Copilot Responses API proxy ──

async function proxyCopilotResponses(reqBody, req, res) {
  const resp = await copilotResponses(reqBody);

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

// ── Chat Completions conversion (for older models) ──

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

async function forwardToChat(chatReq, emitEvent, onDone, onError) {
  delete chatReq.max_tokens;
  let resp;
  try {
    resp = await chatCompletions({ ...chatReq, stream: true });
  } catch (e) {
    onError(502, e.message);
    return;
  }
  if (!resp.ok) {
    onError(resp.status, await resp.text());
    return;
  }
  const respId = `resp_${uid()}`, itemId = `item_${uid()}`;
  let actualModel = "unknown", fullText = "", toolCalls = {}, hasToolCalls = false;

  emitEvent("response.created", { response: { id: respId, object: "response", status: "in_progress", model: actualModel, output: [] } });
  emitEvent("response.output_item.added", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
  emitEvent("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });

  const emitCompleted = () => {
    if (!hasToolCalls) {
      emitEvent("response.output_text.done", { output_index: 0, content_index: 0, text: fullText });
      emitEvent("response.output_item.done", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] } });
    }
    const output = hasToolCalls
      ? Object.entries(toolCalls).map(([id, tc]) => ({ type: "function_call", id, call_id: id, name: tc.name, arguments: tc.arguments, status: "completed" }))
      : [{ type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] }];
    emitEvent("response.completed", { response: { id: respId, object: "response", status: "completed", model: actualModel, output, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  };

  try {
    for await (const line of webStreamLines(resp)) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { emitCompleted(); onDone(); return; }
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
  } catch (e) {
    onError(500, e?.message || "upstream stream error");
    return;
  }
  emitCompleted();
  onDone();
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
              try {
                const upstream = await chatCompletions({ ...chatReq, stream: false });
                const data = await upstream.text();
                const resp = chatToResponses(JSON.parse(data), model);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(resp));
              } catch (e) {
                if (!res.headersSent) res.writeHead(502);
                res.end("Bad Gateway");
              }
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

    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      listModels()
        .then(({ status, body }) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); })
        .catch((e) => { if (!res.headersSent) res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/v1/messages/count_tokens")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(countTokens(parsed)));
        } catch (e) {
          if (!res.headersSent) res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/messages") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const model = parsed.model || "unknown";
          console.log(`[codex-copilot-dx] messages ${model} stream=${!!parsed.stream}`);
          const chatReq = anthropicToChat(parsed);
          if (parsed.stream) {
            const upstream = await chatCompletions({ ...chatReq, stream: true });
            if (!upstream.ok) {
              if (!res.headersSent) res.writeHead(upstream.status);
              res.end(await upstream.text());
              return;
            }
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            await streamAnthropicFromLines(
              webStreamLines(upstream),
              (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              model,
            );
            if (!res.writableEnded) res.end();
          } else {
            const upstream = await chatCompletions({ ...chatReq, stream: false });
            const data = await upstream.text();
            const anthropicMsg = chatToAnthropic(JSON.parse(data), model);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(anthropicMsg));
          }
        } catch (e) {
          console.error("[codex-copilot-dx] messages error:", e.message);
          if (!res.headersSent) res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
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
