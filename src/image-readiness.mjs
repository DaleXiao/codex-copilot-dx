import os from "node:os";
import { parse } from "smol-toml";
import { readBoundedResponseText } from "./http-transport.mjs";

export async function probeImageTool(codexContent, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  let server;
  let url;
  try {
    server = parse(codexContent).mcp_servers?.ccdx_image;
    if (!server || server.enabled === false) return { ready: false, reason: "not_configured" };
    url = new URL(server.url);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const local = ["localhost", "127.0.0.1", "::1", ...Object.values(os.networkInterfaces())
      .flat().filter(Boolean).map((entry) => entry.address)];
    if (url.protocol !== "http:" || !local.includes(host) || url.username || url.password
      || url.pathname !== "/mcp/image" || url.search || url.hash) {
      return { ready: false, reason: "invalid_local_endpoint" };
    }
  } catch {
    return { ready: false, reason: "invalid_config" };
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  async function rpc(id, method, params) {
    const response = await fetchImpl(url.href, {
      method: "POST", headers, signal, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    if (id === undefined) {
      await response.body?.cancel?.().catch(() => {});
      return;
    }
    const text = await readBoundedResponseText(response, { maxBytes: 64 * 1024, signal, label: "Image tool catalog" });
    const message = JSON.parse(text);
    if (message.jsonrpc !== "2.0" || message.id !== id || message.error) throw new Error("invalid MCP response");
    return message.result;
  }
  try {
    const initialized = await rpc(1, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ccdx-image-status", version: "1" },
    });
    if (initialized?.serverInfo?.name !== "ccdx-image") return { ready: false, reason: "unexpected_server" };
    await rpc(undefined, "notifications/initialized", {});
    const result = await rpc(2, "tools/list", {});
    return result?.tools?.some((tool) => tool.name === "generate_image")
      ? { ready: true }
      : { ready: false, reason: "tool_unavailable" };
  } catch (error) {
    return { ready: false, reason: signal.aborted ? "timeout" : /^HTTP \d+$/.test(error.message) ? error.message : "unreachable" };
  }
}
