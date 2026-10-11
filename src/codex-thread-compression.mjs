import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_APP_BINARY_PATHS } from "./codex-model-catalog.mjs";
import { parseCodexToml, codexTomlStatements, validateManagedConfigEdit } from "./config-toml.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { status } from "./status.mjs";

const FEATURE = "local_thread_store_compression";
const FEATURE_PATH = ["features", FEATURE];

function configured(config) {
  if (Object.hasOwn(config, FEATURE) || Object.hasOwn(config.features || {}, FEATURE)) return true;
  return Object.values(config.profiles || {}).some(profile => Object.hasOwn(profile?.features || {}, FEATURE));
}

export function computeThreadCompressionDefault(content) {
  const config = parseCodexToml(content);
  if (configured(config)) return { content, changed: false };
  const statements = codexTomlStatements(content);
  // Only append to an explicit features table or create an absent one. Preserve
  // inline/dotted/nested declarations rather than risking a conflicting table.
  const table = statements.find(item => item.kind === "table"
    && item.keys.length === 1 && item.keys[0] === "features");
  if (!table && Object.hasOwn(config, "features")) return { content, changed: false };
  const lines = content.split("\n");
  if (table) {
    const end = statements.find(item => item.kind === "table" && item.start > table.start)?.line ?? lines.length;
    lines.splice(end, 0, `${FEATURE} = true`);
  } else {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    if (lines.length) lines.push("");
    lines.push("[features]", `${FEATURE} = true`, "");
  }
  const joined = lines.join("\n");
  const updated = joined + (content.endsWith("\n") && !joined.endsWith("\n") ? "\n" : "");
  validateManagedConfigEdit(config, updated, [FEATURE_PATH]);
  return { content: updated, changed: true };
}

export async function codexNeedsThreadCompressionDefault({
  binaryPaths = CODEX_APP_BINARY_PATHS,
  execFileFn = promisify(execFile),
} = {}) {
  const binaries = new Set();
  for (const binary of binaryPaths) {
    try {
      if (path.isAbsolute(binary) && fs.statSync(binary).isFile()) binaries.add(fs.realpathSync(binary));
    } catch {}
  }
  if (!binaries.size) return false;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccdx-compression-probe-"));
  try {
    const defaults = await Promise.all([...binaries].map(async binary => {
      try {
        const { stdout } = await execFileFn(binary, ["features", "list"], {
          cwd: home,
          env: { CODEX_HOME: home, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter) },
          encoding: "utf8", timeout: 1500, maxBuffer: 128 * 1024, windowsHide: true,
        });
        const rows = String(stdout).split("\n").filter(line => line.trim().split(/\s+/)[0] === FEATURE);
        return rows.length === 1
          && /^local_thread_store_compression\s+(?:under development|experimental|beta|stable)\s+false\s*$/i.test(rows[0].trim());
      } catch { return false; }
    }));
    return defaults.every(Boolean);
  } finally { await fs.promises.rm(home, { recursive: true, force: true }); }
}

export async function ensureCodexThreadCompression({
  filePath = path.join(os.homedir(), ".codex", "config.toml"),
  probe = codexNeedsThreadCompressionDefault,
} = {}) {
  try {
    const read = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(filePath));
    if (configured(parseCodexToml(read()))) return;
    if (!await probe()) return;
    // The client/user may edit the shared file while the asynchronous probe runs.
    // Recompute against its current bytes; explicit opt-outs always win.
    const updated = computeThreadCompressionDefault(read());
    if (updated.changed) {
      atomicWriteFileIfChangedSync(filePath, updated.content);
      console.log(status("ok", "Enabled Codex local history compression (experimental)"));
    }
  } catch {
    console.warn(status("warn", "Optional Codex history compression setup was skipped; core proxy remains available"));
  }
}
