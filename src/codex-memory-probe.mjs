// Read-only, bounded native task metadata. This helper never reads memories or
// invokes Codex. It runs separately so unavailable/locked databases stay optional.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

let db;
try {
  const [directory, base, since] = process.argv.slice(2);
  db = new DatabaseSync(path.join(directory, "logs_2.sqlite"), { readOnly: true });
  const jobs = db.prepare("SELECT ts, process_uuid, substr(feedback_log_body,1,8192) AS body FROM logs WHERE ts>=? AND target='codex_memories_write::phase1::job::result' ORDER BY ts DESC LIMIT 8").all(Number(since));
  let result = null;
  for (const job of jobs) {
    if (!job.body?.includes("ccdx_api_model_unavailable")) continue;
    const calls = db.prepare("SELECT ts, substr(feedback_log_body,1,8192) AS body FROM logs WHERE ts BETWEEN ? AND ? AND process_uuid=? AND target='codex_http_client::client' ORDER BY ts DESC LIMIT 16").all(job.ts - 2, job.ts + 1, job.process_uuid);
    const models = new Set();
    for (const call of calls) {
      if (!call.body?.includes("url=" + base + "/responses ") || !call.body.includes("status=400 ")) continue;
      const model = /model_client\.stream_responses_api\{model=([\w./:@+-]{1,160})(?:\s|\})/.exec(call.body)?.[1];
      if (model) models.add(model);
    }
    if (models.size === 1) { result = { model: [...models][0], at: job.ts * 1000 };break; }
  }
  console.log(JSON.stringify(result));
} catch { console.log("null"); }
finally { db?.close(); }
