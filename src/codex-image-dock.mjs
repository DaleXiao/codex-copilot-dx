import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { imageHostLauncherPath, prepareImageHostLaunch } from "./codex-image-host-launch.mjs";

const execute = promisify(execFile), label = "com.ccdx.image-host", key = "CODEX_CLI_PATH";
const hash = text => createHash("sha256").update(text).digest("hex");
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function imageDockPaths(options = {}) {
  const directory = path.dirname(imageHostLauncherPath(options));
  return { wrapper: imageHostLauncherPath(options), state: path.join(directory, "dock.json"), script: path.join(directory, "restore-dock.sh"),
    agent: path.join(options.home || os.homedir(), "Library", "LaunchAgents", label + ".plist") };
}

export function createImageDockControl({ platform = process.platform, exec = execute, prepare = prepareImageHostLaunch, uid = () => process.getuid(), ...options } = {}) {
  const paths = imageDockPaths(options);let observed = null, serial = Promise.resolve();
  const read = () => {
    if (!fs.existsSync(paths.state)) return null;
    const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
    if (state.version !== 1 || state.wrapper !== paths.wrapper || state.previous !== null
      || typeof state.agentHash !== "string" || typeof state.scriptHash !== "string") throw new Error("Dock setup ownership is unreadable; existing settings were preserved");
    return state;
  };
  const owned = state => [ [paths.agent, state.agentHash], [paths.script, state.scriptHash] ].every(([file, digest]) => !fs.existsSync(file) || hash(fs.readFileSync(file, "utf8")) === digest);
  const launchctl = async args => {
    const result = await exec("/bin/launchctl", args, { encoding: "utf8", timeout: 3000, maxBuffer: 65536 });return String(result?.stdout ?? result).trim();
  };
  async function current() {
    try { return await launchctl(["getenv", key]); }
    catch (error) { if (error.code === 1 && !String(error.stderr || "").trim()) return "";throw new Error("Could not read the GUI session environment"); }
  }
  async function context() {
    if (await launchctl(["managername"]) !== "Aqua" || await launchctl(["manageruid"]) !== String(uid())) throw new Error("Dock setup requires this user's graphical login session");
  }
  function snapshot() {
    if (platform !== "darwin") return { supported: false, saved: false, state: "unsupported", tool_registration: "unconfirmed" };
    try {
      const state = read();
      return { supported: true, saved: Boolean(state), state: !state ? observed || "disabled" : !owned(state) ? "conflict" : !fs.existsSync(paths.wrapper) || !fs.existsSync(paths.agent) || !fs.existsSync(paths.script) ? "needs_repair" : observed || "unconfirmed",
        tool_registration: "unconfirmed" };
    } catch { return { supported: true, saved: true, state: "unreadable", tool_registration: "unconfirmed" }; }
  }
  async function apply(operation) {
    if (platform !== "darwin") throw new Error("Dock image setup is available on macOS only");
    if (!["status", "enable", "disable", "repair"].includes(operation)) throw new Error("Unknown Dock image operation");
    await context();const state = read(), value = await current();
    if (operation === "status") {
      observed = !state ? value ? "conflict" : "disabled" : value && value !== paths.wrapper ? "conflict" : value === paths.wrapper ? "pending_reopen" : "needs_repair";
      if (state && owned(state) && observed === "pending_reopen") {
        try { await exec(paths.wrapper, ["--ccdx-host-check"], { timeout: 3000, maxBuffer: 4096 }); }
        catch { observed = "needs_repair"; }
      }
      return snapshot();
    }
    if (state && !owned(state)) throw new Error("Dock setup files were changed externally; they were preserved");
    if (operation === "disable") {
      if (!state) return snapshot();
      // RunAtLoad is one-shot. Unload a job restored by an earlier login before removing its files.
      let loaded = false;
      try { await launchctl(["print", `gui/${uid()}/${label}`]);loaded = true; }
      catch (error) { if (error.code !== 113 && error.code !== 3) throw new Error("Could not check the saved login agent"); }
      if (loaded) await launchctl(["bootout", `gui/${uid()}/${label}`]);
      if (value === paths.wrapper && await current() === paths.wrapper) { await launchctl(["unsetenv", key]);if (await current()) throw new Error("Could not restore the GUI session environment"); }
      for (const file of [paths.agent, paths.script, paths.state]) fs.rmSync(file, { force: true });
      observed = null;return { ...snapshot(), external_value_preserved: Boolean(value && value !== paths.wrapper) };
    }
    if (operation === "repair" && !state) throw new Error("Enable Dock image setup before repairing it");
    if (value && value !== paths.wrapper || !state && value) throw new Error("A custom Codex CLI path is already set in the GUI session; it was preserved");
    if (!state && (fs.existsSync(paths.agent) || fs.existsSync(paths.script))) throw new Error("Dock setup file ownership conflict; existing files were preserved");
    const launch = await prepare({ ...options, platform, persistent: true });
    if (!launch || launch.env.CODEX_CLI_PATH !== paths.wrapper) throw new Error("The image host launcher could not be prepared");
    const script = '#!/bin/sh\n# CCDX Dock image host\n' + `current=$(/bin/launchctl getenv ${key} 2>/dev/null || :)\n`
      + `if [ -n "$current" ] && [ "$current" != ${quote(paths.wrapper)} ]; then exit 0; fi\n`
      + `if ${quote(paths.wrapper)} --ccdx-host-check >/dev/null 2>&1; then\n /bin/launchctl setenv ${key} ${quote(paths.wrapper)}\n`
      + `elif [ "$current" = ${quote(paths.wrapper)} ]; then\n /bin/launchctl unsetenv ${key}\nfi\n`;
    const agent = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
      + `<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(paths.script)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`;
    const originals = new Map([paths.agent, paths.script, paths.state].map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
    for (const file of [paths.script, paths.agent]) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (await current() !== value) throw new Error("The GUI session environment changed during setup");
      atomicWriteFileSync(paths.script, script, { mode: 0o700 });atomicWriteFileSync(paths.agent, agent, { mode: 0o600 });
      atomicWriteFileSync(paths.state, JSON.stringify({ version: 1, wrapper: paths.wrapper, previous: null, agentHash: hash(agent), scriptHash: hash(script) }) + "\n", { mode: 0o600 });
      await launchctl(["setenv", key, paths.wrapper]);
      if (await current() !== paths.wrapper) throw new Error("Dock session environment did not retain the image host path");
    } catch (error) {
      try {
        if (await current() === paths.wrapper && value !== paths.wrapper) await launchctl(["unsetenv", key]);
        for (const [file, bytes] of originals) if (bytes === null) fs.rmSync(file, { force: true });else atomicWriteFileSync(file, bytes, { mode: file === paths.script ? 0o700 : 0o600 });
      } catch { throw new Error("Dock setup failed and rollback needs repair; inspect Dock image status"); }
      throw new Error("Dock setup failed; previous settings were restored");
    }
    observed = "pending_reopen";return snapshot();
  }
  return { snapshot, action(operation) { const result = serial.then(() => apply(operation));serial = result.catch(() => {});return result; } };
}
