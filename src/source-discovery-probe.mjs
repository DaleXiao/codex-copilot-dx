// Explicit local import only. Read and parse outside the inference event loop.
import fs from "node:fs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { previewDiscoveredProviders } from "./source-discovery.mjs";

const [tool, file] = process.argv.slice(2);
const result = state => ({ format: tool, saved: false, drafts: [], discovery: { tool, state, skipped: 0, truncated: false } });
let db, value;
try {
  if (!["cc-switch", "magpie"].includes(tool) || !fs.statSync(file).isFile()) throw Error("unsupported");
  if (tool === "magpie") {
    const input = JSON.parse(readBoundedFileSync(file, { maxBytes: 2 * 1024 * 1024, encoding: "utf8" }));
    if (!Array.isArray(input.providers)) throw Error("unsupported");
    value = previewDiscoveredProviders(tool, input.providers.slice(0, 64), { truncated: input.providers.length > 64 });
  } else {
    // An orphaned WAL needs the owning application to recover it. Do not
    // create sidecars or copy a database containing foreign credentials.
    if (fs.existsSync(file + "-wal") && !fs.existsSync(file + "-shm")) throw Error("busy");
    const { DatabaseSync } = await import("node:sqlite");db = new DatabaseSync(file, { readOnly: true });db.exec("PRAGMA busy_timeout=500");
    const columns = db.prepare("PRAGMA table_info(providers)").all().map(row => row.name);
    if (!["id", "app_type", "name", "settings_config"].every(key => columns.includes(key))) throw Error("unsupported");
    const meta = columns.includes("meta") ? "CASE WHEN length(meta)<=65536 THEN meta ELSE '{}' END" : "'{}'";
    const rows = db.prepare(`SELECT id, app_type, substr(name,1,160) AS name,
      CASE WHEN length(settings_config)<=262144 THEN settings_config ELSE NULL END AS settings,
      ${meta} AS meta FROM providers WHERE app_type IN ('claude','claude-desktop','codex') ORDER BY app_type,id LIMIT 65`).all();
    value = previewDiscoveredProviders(tool, rows.slice(0, 64).map(row => {
      try { return { ...row, settings: JSON.parse(row.settings), meta: JSON.parse(row.meta) }; } catch { return { app_type: row.app_type }; }
    }), { truncated: rows.length > 64 });
  }
} catch (error) {
  const state = error.code === "ENOENT" ? "not_found" : [5, 6].includes(error.errcode) || error.message === "busy" ? "busy"
    : error.message === "unsupported" ? "unsupported" : "unreadable";
  value = result(state);
} finally { db?.close(); }
process.stdout.write(JSON.stringify(value));
