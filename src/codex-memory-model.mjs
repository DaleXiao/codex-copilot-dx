import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { codexPaths } from "./codex-paths.mjs";
import { accessSettingsPath } from "./access-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { privateHelperEnvironment } from "./private-helper-environment.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

const modelId = value => typeof value === "string" && /^[\w][\w./:@+-]{0,159}$/.test(value) && redactDiagnosticText(value) === value;
export function createCodexMemoryModel({ corePort = 2026, probe, now = Date.now, ...options } = {}) {
  const paths = codexPaths(options), file = path.join(path.dirname(accessSettingsPath(options)), "codex-memory-observed.json");
  const profile = createHash("sha256").update(paths.directory).digest("hex"), controller = new AbortController();
  let observation, state = { model: null, basis: "unknown", enabled: null }, flight, lastRead = -Infinity;
  try {
    const saved = JSON.parse(readBoundedFileSync(file, { encoding: "utf8", maxBytes: 4096 }));
    if (saved.version === 1 && saved.profile === profile && modelId(saved.model) && Number.isFinite(saved.at) && now() - saved.at >= 0 && now() - saved.at < 86400000) observation = { model: saved.model, at: saved.at };
  } catch {}
  const inspect = probe || (async directory => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./codex-memory-probe.mjs", import.meta.url)), directory,
      `http://127.0.0.1:${corePort}/v1`, String(Math.floor((now() - 86400000) / 1000))],
    { env: privateHelperEnvironment(options.env || process.env), signal: controller.signal, timeout: 2500, maxBuffer: 16384, windowsHide: true });
    return JSON.parse(stdout);
  });
  return {
    snapshot: () => ({ ...state }),
    refresh() {
      if (flight) return flight;
      if (controller.signal.aborted || now() - lastRead < 60000) return Promise.resolve();
      lastRead = now();
      if (observation && (now() - observation.at < 0 || now() - observation.at >= 86400000)) observation = null;
      flight = (async () => {
        let config = {};
        try { config = parse(readBoundedFileSync(paths.config, { encoding: "utf8", maxBytes: 1024 * 1024 })); }
        catch (error) { if (error.code !== "ENOENT") { state = { model: null, basis: "unavailable", enabled: null };return; } }
        const enabled = config.features?.memories === false || config.memories?.generate_memories === false ? false
          : config.features?.memories === true ? true : null;
        const configured = config.memories?.extract_model;
        if (configured !== undefined && !modelId(configured)) { state = { model: null, basis: "unavailable", enabled };return; }
        if (modelId(configured)) { state = { model: configured, basis: "configured", enabled };return; }
        state = { model: observation?.model || null, basis: observation ? "observed" : "unknown", enabled,
          ...(observation ? { observed_at: new Date(observation.at).toISOString() } : {}) };
        const directory = typeof config.sqlite_home === "string" ? path.resolve(config.sqlite_home) : paths.directory;
        if (enabled === false || !probe && !fs.existsSync(path.join(directory, "logs_2.sqlite"))) return;
        try {
          const seen = await inspect(directory);
          if (!modelId(seen?.model) || !Number.isFinite(seen.at) || now() - seen.at < 0 || now() - seen.at >= 86400000 || controller.signal.aborted) return;
          const changed = observation?.model !== seen.model || observation?.at !== seen.at;
          observation = { model: seen.model, at: seen.at };state = { model: seen.model, basis: "observed", enabled, observed_at: new Date(seen.at).toISOString() };
          if (changed && !options.preserveClientConfiguration?.()) {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });atomicWriteFileSync(file, JSON.stringify({ version: 1, profile, ...observation }) + "\n", { mode: 0o600 });
          }
        } catch {}
      })().finally(() => { flight = null; });
      return flight;
    },
    async close() { controller.abort();await flight; },
  };
}
