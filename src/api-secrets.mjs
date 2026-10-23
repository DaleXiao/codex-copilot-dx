import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { accessSettingsPath, accessError } from "./access-settings.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { windowsPowerShellEnvironment } from "./windows-process.mjs";
import { privateHelperEnvironment } from "./private-helper-environment.mjs";

const SERVICE = "codex-copilot-dx.manual-api";
export function secretProcess(command, args, input = "", env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: privateHelperEnvironment(env), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", settled = false;
    const finish = (error, value) => { if (settled) return;settled = true;clearTimeout(timer);error ? reject(accessError("ccdx_api_secret_unavailable", 503)) : resolve(value); };
    const timer = setTimeout(() => { child.kill();finish(true); }, 10000);
    child.on("error", () => finish(true));child.stderr.resume();child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");child.stdout.on("data", chunk => { output += chunk;if (output.length > 65536) { child.kill();finish(true); } });
    child.on("close", code => finish(code !== 0, output.trim()));child.stdin.end(input);
  });
}
export function checkedApiKey(key) {
  if (typeof key !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(key)) throw accessError("ccdx_api_key_invalid");return key;
}
export function createApiSecretStore({ platform = process.platform, env = process.env, run = secretProcess, ...options } = {}) {
  const cache = new Map(), folder = path.join(path.dirname(accessSettingsPath({ ...options, env })), "api-secrets");
  const ref = id => { if (!/^[a-f0-9]{32}$/.test(id)) throw accessError("ccdx_api_key_invalid");return id; };
  const powershell = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const ps = async (script, input) => run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop';" + script], input + "\n", windowsPowerShellEnvironment(env));
  return {
    async get(id) {
      ref(id);if (cache.has(id)) return cache.get(id);
      let key;
      if (platform === "darwin") key = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", id, "-w"], "", env);
      else if (platform === "win32") {
        let encrypted;try { encrypted = readBoundedFileSync(path.join(folder, id), { encoding: "utf8", maxBytes: 65536 }); } catch { throw accessError("ccdx_api_secret_unavailable", 503); }
        key = await ps("$s=ConvertTo-SecureString ([Console]::In.ReadLine());[Console]::Write(([System.Net.NetworkCredential]::new('', $s)).Password)", encrypted);
      } else key = await run("/usr/bin/secret-tool", ["lookup", "service", SERVICE, "reference", id], "", env);
      checkedApiKey(key);cache.set(id, key);return key;
    },
    async set(id, key) {
      ref(id);checkedApiKey(key);
      if (platform === "darwin") {
        const quote = value => '"' + value.replace(/[\\"]/g, "\\$&") + '"';
        await run("/usr/bin/security", ["-i"], `add-generic-password -a ${quote(id)} -s ${quote(SERVICE)} -w ${quote(key)}\n`, env);
        // Interactive security commands can exit zero after an individual failure.
        const saved = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", id, "-w"], "", env);
        if (saved !== key) throw accessError("ccdx_api_secret_unavailable", 503);
      } else if (platform === "win32") {
        const encrypted = await ps("$s=ConvertTo-SecureString ([Console]::In.ReadLine()) -AsPlainText -Force;[Console]::Write((ConvertFrom-SecureString $s))", key);
        if (!/^[a-f0-9]{64,65536}$/i.test(encrypted)) throw accessError("ccdx_api_secret_unavailable", 503);
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });atomicWriteFileSync(path.join(folder, id), encrypted, { mode: 0o600 });
      } else await run("/usr/bin/secret-tool", ["store", "--label=CCDX API", "service", SERVICE, "reference", id], key, env);
      cache.set(id, key);
    },
    async remove(id) {
      ref(id);cache.delete(id);
      if (platform === "darwin") await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", id], "", env);
      else if (platform === "win32") fs.rmSync(path.join(folder, id), { force: true });
      else await run("/usr/bin/secret-tool", ["clear", "service", SERVICE, "reference", id], "", env);
    },
    close() { cache.clear(); },
  };
}
