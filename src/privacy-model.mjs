import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNpmReleaseFetch, releaseBytes, releaseChecksum, RELEASE_BASE } from "./release-install.mjs";

export const PRIVACY_MODEL_REVISION = "7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4";
export const PRIVACY_COMPONENT_RELEASE = "1.3.6";
export const PRIVACY_MODEL_FILES = Object.freeze([
  { name: "model_int8.onnx", bytes: 330781, sha256: "0a070d3113615e33ba3b84d6bd486f663a377c04c4b056e7381732179f51832a" },
  { name: "model_int8.onnx_data", bytes: 37124608, sha256: "0ba34216ceead01e0ae2dfd8e46d52b67e7aee80b04f722d9b758613a91c0067" },
  { name: "tokenizer.json", bytes: 1502881, sha256: "0cf3b235ef125658015a6c8026a5fe6f28088bf825101a990ec18a10200feef4" },
]);
export const PRIVACY_DOWNLOAD_BYTES = PRIVACY_MODEL_FILES.reduce((n, file) => n + file.bytes, 0);
export const privacyFailure = code => Object.assign(new Error("Local privacy check could not finish. Nothing was sent; review Settings."), {
  code: `ccdx_privacy_${code}`, statusCode: 503,
  jsonBody: { error: { type: "api_error", code: `ccdx_privacy_${code}`, message: "Local privacy check could not finish. Nothing was sent; review Settings." } },
});
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function privacyPaths({ home = os.homedir(), env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const root = path.join(env.XDG_CACHE_HOME || (platform === "win32" ? env.LOCALAPPDATA || path.join(home, "AppData", "Local") : path.join(home, ".cache")), "codex-copilot-dx", "privacy");
  const name = `ccdx-privacy-guard-1-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
  return { root, model: path.join(root, PRIVACY_MODEL_REVISION), name, runner: path.join(root, name), receipt: path.join(root, name + ".json") };
}
async function downloader(env) {
  const names = [env.npm_execpath];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    try { names.push(await fs.realpath(path.join(dir, process.platform === "win32" ? "npm.cmd" : "npm"))); } catch {}
  }
  names.push(path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), path.join(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"));
  for (let file of names.filter(Boolean)) {
    if (file.endsWith("npm.cmd")) file = path.join(path.dirname(file), "node_modules/npm/bin/npm-cli.js");
    try { await fs.access(file); } catch { continue; }
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [file, "config", "get", "--global", "https-proxy", "proxy", "noproxy", "cafile", "strict-ssl", "offline"], { env, encoding: "utf8", timeout: 5000, maxBuffer: 131072, windowsHide: true });
      return createNpmReleaseFetch(file, { env, exec: () => stdout });
    } catch { throw privacyFailure("download_unavailable"); }
  }
  throw privacyFailure("download_unavailable");
}
export function createPrivacyModel(options = {}) {
  const env = options.env || process.env, paths = privacyPaths(options), changed = options.changed || (() => {});
  let child, serial = 0, ready = null, install = null, downloadAbort, line = "", stopped = false;
  let state = { state: "not_downloaded", downloaded_bytes: 0, download_bytes: PRIVACY_DOWNLOAD_BYTES, backend: null, device: null, error: null };
  const jobs = new Map();
  const set = next => { state = { ...state, ...next };changed(); };
  async function installed() {
    try {
      const receipt = JSON.parse(await fs.readFile(paths.receipt, "utf8"));
      if (!/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.release !== PRIVACY_COMPONENT_RELEASE) return false;
      if (digest(await fs.readFile(paths.runner)) !== receipt.sha256) return false;
      for (const file of PRIVACY_MODEL_FILES) if (digest(await fs.readFile(path.join(paths.model, file.name))) !== file.sha256) return false;
      return true;
    } catch { return false; }
  }
  async function download() {
    if (install) return install;
    stopped = false;downloadAbort = new AbortController();const signal = downloadAbort.signal;
    install = (async () => {
      set({ state: "downloading", error: null, downloaded_bytes: 0 });
      const fetchImpl = options.fetchImpl || await downloader(env);
      await fs.mkdir(paths.model, { recursive: true, mode: 0o700 });
      const base = `${RELEASE_BASE}/v${PRIVACY_COMPONENT_RELEASE}`;
      const sums = await releaseBytes(`${base}/SHA256SUMS`, { fetchImpl, maxBytes: 65536, signal });
      const expected = releaseChecksum(sums, paths.name);
      const runner = await releaseBytes(`${base}/${paths.name}`, { fetchImpl, maxBytes: 16 * 1024 * 1024, signal });
      if (digest(runner) !== expected) throw privacyFailure("download_invalid");
      const tempRunner = paths.runner + "." + randomUUID();
      try { await fs.writeFile(tempRunner, runner, { mode: 0o700, flag: "wx" });await fs.rename(tempRunner, paths.runner); }
      finally { await fs.rm(tempRunner, { force: true }); }
      await fs.writeFile(paths.receipt, JSON.stringify({ release: PRIVACY_COMPONENT_RELEASE, sha256: expected }) + "\n", { mode: 0o600 });
      for (const file of PRIVACY_MODEL_FILES) {
        const target = path.join(paths.model, file.name);
        try { if (digest(await fs.readFile(target)) === file.sha256) { set({ downloaded_bytes: state.downloaded_bytes + file.bytes });continue; } } catch {}
        const response = await fetchImpl(`https://huggingface.co/QuantumNous/astrlink-guard/resolve/${PRIVACY_MODEL_REVISION}/int8/${file.name}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]), redirect: "follow" });
        const host = response.url && new URL(response.url);
        if (!response.ok || host && (host.protocol !== "https:" || !/^(?:huggingface\.co|[a-z0-9.-]+\.(?:huggingface\.co|hf\.co))$/.test(host.hostname))) { await response.body?.cancel();throw privacyFailure("download_unavailable"); }
        const temp = target + "." + randomUUID(), hash = createHash("sha256"), output = await fs.open(temp, "wx", 0o600);let total = 0;
        try {
          for await (const bytes of response.body || []) {
            if (signal.aborted) throw signal.reason;
            total += bytes.length;if (total > file.bytes) throw privacyFailure("download_invalid");
            hash.update(bytes);await output.write(bytes);set({ downloaded_bytes: state.downloaded_bytes + bytes.length });
          }
          if (total !== file.bytes || hash.digest("hex") !== file.sha256) throw privacyFailure("download_invalid");
          await output.sync();await output.close();await fs.rename(temp, target);
        } finally { await output.close().catch(() => {});await fs.rm(temp, { force: true }); }
      }
      if (signal.aborted || stopped) throw privacyFailure("cancelled");
      set({ state: "installed" });
    })().catch(error => { if (signal.aborted || stopped) { set({ state: "not_downloaded", error: null });throw privacyFailure("cancelled"); }set({ state: "error", error: error.code?.startsWith("ccdx_privacy_") ? error.code : "ccdx_privacy_download_unavailable" });throw privacyFailure("download_unavailable"); })
      .finally(() => { install = null;downloadAbort = null; });
    return install;
  }
  function fail() {
    child?.kill();child = null;ready = null;line = "";
    for (const job of jobs.values()) { clearTimeout(job.timer);job.reject(privacyFailure("engine_unavailable")); }
    jobs.clear();set({ state: stopped ? "installed" : "error", error: stopped ? null : "ccdx_privacy_engine_unavailable" });
  }
  function load() {
    stopped = false;
    if (ready) return ready;
    ready = (async () => {
      if (!await installed()) { set({ state: "not_downloaded" });throw privacyFailure("not_downloaded"); }
      if (stopped) throw privacyFailure("cancelled");
      set({ state: "loading", error: null });
      return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(privacyFailure("load_timeout"));fail(); }, 60000);
      const workerEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "GOMAXPROCS"].filter(key => typeof env[key] === "string").map(key => [key, env[key]]));
      const current = child = (options.spawnImpl || spawn)(paths.runner, [paths.model], { env: workerEnv, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      current.stdout.on("data", bytes => {
        if (current !== child) return;
        line += bytes.toString("utf8");if (Buffer.byteLength(line) > 8 * 1024 * 1024) { fail();return; }
        let end;
        while ((end = line.indexOf("\n")) >= 0) {
          const part = line.slice(0, end);line = line.slice(end + 1);
          try {
            const value = JSON.parse(part);
            if (value.ready === true) { clearTimeout(timer);set({ state: "ready", backend: value.backend === "CoreML" ? "CoreML" : "CPU", device: ["CPU", "GPU", "Neural Engine"].includes(value.device) ? value.device : null });resolve(); }
            else if (jobs.has(value.id)) { const job = jobs.get(value.id);jobs.delete(value.id);clearTimeout(job.timer);job.resolve(value.found);changed();if (stopped && !jobs.size) stop(); }
          } catch { fail(); }
        }
      });
      const ended = () => { clearTimeout(timer);reject(privacyFailure(stopped ? "cancelled" : "engine_unavailable"));if (current === child) fail(); };
      current.on("error", ended);current.on("exit", ended);current.stdin.on("error", ended);
      });
    })().catch(error => { ready = null;throw error; });
    return ready;
  }
  async function find(texts, { signal } = {}) {
    if (signal?.aborted) throw signal.reason;await load();if (signal?.aborted) throw signal.reason;
    if (jobs.size >= 8) throw privacyFailure("busy");
    const id = ++serial, input = JSON.stringify({ id, texts }) + "\n";
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw privacyFailure("request_too_large");
    if ([...jobs.values()].reduce((n, job) => n + job.bytes, Buffer.byteLength(input)) > 16 * 1024 * 1024) throw privacyFailure("busy");
    return new Promise((resolve, reject) => {
      const cancelled = () => { if (jobs.has(id)) { jobs.delete(id);clearTimeout(timer);reject(signal?.reason || privacyFailure("cancelled")); } };
      const finish = fn => value => { signal?.removeEventListener("abort", cancelled);fn(value); };
      const timer = setTimeout(() => { reject(privacyFailure("check_timeout"));fail(); }, 300000);
      jobs.set(id, { resolve: finish(resolve), reject: finish(reject), timer, bytes: Buffer.byteLength(input) });signal?.addEventListener("abort", cancelled, { once: true });changed();
      child.stdin.write(input, error => { if (error) fail(); });
    });
  }
  function stop() { stopped = true;downloadAbort?.abort();if (!jobs.size) { child?.kill();child = null;ready = null;line = "";set({ state: "installed", error: null }); } }
  function snapshot() {
    if (!child && !install && ["installed", "not_downloaded"].includes(state.state)) {
      try {
        const stat = fsSync.lstatSync(paths.runner);
        const cached = stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024 * 1024 && PRIVACY_MODEL_FILES.every(file => fsSync.lstatSync(path.join(paths.model, file.name)).size === file.bytes);
        state = { ...state, state: cached ? "installed" : "not_downloaded" };
      } catch { state = { ...state, state: "not_downloaded" }; }
    }
    return { ...state, pending_checks: jobs.size };
  }
  return { paths, snapshot, installed, download, load, find, stop,
    async remove() { stop();await install?.catch(() => {});if (jobs.size) throw privacyFailure("busy");await fs.rm(paths.root, { recursive: true, force: true });set({ state: "not_downloaded", downloaded_bytes: 0 }); },
    close() { stopped = true;downloadAbort?.abort();fail(); }, busy: () => Boolean(install || jobs.size || state.state === "loading") };
}
