import { createHash } from "node:crypto";
import { m365Paths, m365AccountKey } from "../m365-settings.mjs";
import { withFileLock } from "../lock.mjs";
import fs from "node:fs/promises";
import { readBoundedFile } from "../bounded-file.mjs";
import { atomicWriteFile } from "../atomic-file.mjs";
import { messagesHistoryTransferGrant } from "../messages-history-transfer.mjs";

const changed = () => Object.assign(new Error("This conversation belongs to another company account. Start a new conversation."),
  { code: "m365_account_changed", statusCode: 409 });
const hash = value => createHash("sha256").update(value).digest("hex");

export function createM365ConversationGuard({ home } = {}) {
  const { directory, conversations: file } = m365Paths({ home });
  let cached;
  return (account, body, headers = {}, options = {}) => {
    options.signal?.throwIfAborted();
    const items = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
    let session = headers["session_id"] || headers["session-id"] || headers["x-conversation-id"] || headers["x-claude-code-session-id"];
    if (!session && typeof body.metadata?.user_id === "string") {
      try { session = JSON.parse(body.metadata.user_id)?.session_id; } catch { session = /(?:^|_)session_([\w-]{8,128})$/.exec(body.metadata.user_id)?.[1]; }
    }
    const first = items.find(item => item?.role === "user");
    const key = typeof session === "string" && session.length > 0 && session.length <= 512 && !/[\u0000-\u001f\u007f]/.test(session)
      ? hash(`session\0${session}`) : first ? hash(`first\0${JSON.stringify(first)}`) : typeof body.input === "string" ? hash(`first\0${body.input}`) : null;
    const hasHistory = Boolean(body.previous_response_id) || items.filter(item => item?.role === "user").length > 1
      || items.some(item => item?.role === "assistant" || item?.role === "tool" || /(?:call|output|reasoning|compaction)/.test(item?.type || "")
        || Array.isArray(item?.content) && item.content.some(part => part?.type === "tool_result"));
    if (!key) { if (account.history_isolation && hasHistory) throw changed();return; }
    const owner = m365AccountKey(account);
    const grant = messagesHistoryTransferGrant(body), authorized = Boolean(grant && grant.profile === options.profile);
    const noncommitting = options.countTokens || authorized && grant.noncommitting;
    if (noncommitting && !hasHistory) return;
    if (cached?.[key] === owner) return;
    if (cached?.[key] && cached[key] !== owner) throw changed();
    return (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await withFileLock(`${file}.lock`, async () => {
        let saved;
        try {
          if (!(await fs.lstat(file)).isFile()) throw Error("Expected a regular file");
          saved = JSON.parse(await readBoundedFile(file, { encoding: "utf8", maxBytes: 4 * 1024 * 1024 }));
          if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw Error("Expected an object");
        } catch (error) {
          if (error.code === "ENOENT") saved = { owners: {} };
          else throw Object.assign(new Error("M365 local configuration could not be read; existing files were preserved"), { code: "m365_config_invalid" });
        }
        if (!saved.owners || typeof saved.owners !== "object" || Array.isArray(saved.owners)
          || Object.keys(saved.owners).length > 1024 || Object.entries(saved.owners).some(([id, value]) => !/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(value))) throw changed();
        const owners = saved.owners;
        if (owners[key] && owners[key] !== owner || !owners[key] && account.history_isolation && hasHistory && !(authorized && grant.initial)) throw changed();
        if (noncommitting) return;
        if (owners[key]) { cached = owners;return; }
        owners[key] = owner;
        while (Object.keys(owners).length > 1024) delete owners[Object.keys(owners)[0]];
        await atomicWriteFile(file, `${JSON.stringify({ owners }, null, 2)}\n`, { mode: 0o600, preserveMode: false });cached = owners;
      }, { timeoutMs: 1000, staleMs: 60_000, pollMs: 10, signal: options.signal });
    })();
  };
}
