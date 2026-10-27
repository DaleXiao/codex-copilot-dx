import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { accessSettingsPath, accessError } from "./access-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";

// Correlation only: retain hashes, never prompts, session IDs or credentials.
export function createConversationSourceGuard(options = {}) {
  const file = path.join(path.dirname(accessSettingsPath(options)), "conversation-sources.json");let cache;
  return (client, profile, body, headers = {}, salt, transfer) => {
    const hash = value => createHmac("sha256", salt).update(value).digest("hex");
    const items = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
    const hasHistory = Boolean(body.previous_response_id) || items.filter(item => item?.role === "user").length > 1
      || items.some(item => item?.role === "assistant" || item?.role === "tool" || /(?:call|output|reasoning|compaction)/.test(item?.type || "")
        || Array.isArray(item?.content) && item.content.some(part => part?.type === "tool_result" || part?.type === "thinking" || part?.type === "redacted_thinking"));
    let session = headers.session_id || headers["session-id"] || headers["x-conversation-id"] || headers["x-claude-code-session-id"];
    if (!session && typeof body.metadata?.user_id === "string") {
      try { session = JSON.parse(body.metadata.user_id)?.session_id; } catch { session = /(?:^|_)session_([\w-]{8,128})$/.exec(body.metadata.user_id)?.[1]; }
    }
    const identified = typeof session === "string" && session.length > 0 && session.length <= 512 && !/[\u0000-\u001f\u007f]/.test(session);
    const first = items.find(item => item?.role === "user"), input = identified ? `session\0${session}` : first ? `first\0${JSON.stringify(first)}` : typeof body.input === "string" ? `first\0${body.input}` : null;
    if (!input) return;
    const agent = headers["x-claude-code-agent-id"];
    const child = identified && ["claude_app", "claude_code"].includes(client) && typeof agent === "string" && /^[\w-]{1,128}$/.test(agent) ? `\0agent\0${agent}` : "";
    const key = hash(client + "\0" + input + child), owner = hash(profile);
    const prepare = previousOwner => transfer?.prepare({ key, owner, previousOwner, profile, body,
      knownOwners: transfer.profiles?.map(hash) || [] });
    let prepared;
    if (cache?.[key]) {
      prepared = prepare(cache[key]);
      if (prepared?.handled || cache[key] === owner) return prepared;
      prepared?.release();
      if (identified || hasHistory) throw accessError("ccdx_conversation_source_changed", 409);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { return withFileLockSync(`${file}.lock`, () => {
      let owners = {};
      try { owners = JSON.parse(readBoundedFileSync(file, { encoding: "utf8", maxBytes: 256 * 1024 })); } catch (error) { if (error.code !== "ENOENT") throw accessError("ccdx_conversation_state_invalid", 409); }
      if (!owners || typeof owners !== "object" || Array.isArray(owners) || Object.keys(owners).length > 1024
        || Object.entries(owners).some(([key, owner]) => !/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(owner))) throw accessError("ccdx_conversation_state_invalid", 409);
      prepared = prepare(owners[key]);
      if (prepared?.handled) { cache = owners;return prepared; }
      if (owners[key] && owners[key] !== owner && (identified || hasHistory)) throw accessError("ccdx_conversation_source_changed", 409);
      if (owners[key] !== owner) {
        owners[key] = owner;while (Object.keys(owners).length > 1024) delete owners[Object.keys(owners)[0]];
        atomicWriteFileSync(file, JSON.stringify(owners) + "\n", { mode: 0o600 });
      }
      cache = owners;
      return prepared;
    }); } catch (error) { prepared?.release();throw error; }
  };
}
