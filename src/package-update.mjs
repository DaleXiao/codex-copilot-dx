import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

const PACKAGE_NAME = "codex-copilot-dx";
const UPDATE_SPECS = {
  npm: `${PACKAGE_NAME}@latest`,
  github: "github:DaleXiao/codex-copilot-dx#main",
};

export function normalizeUpdateSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source === "gh") return "github";
  return Object.hasOwn(UPDATE_SPECS, source) ? source : "";
}

export function globalUpdateCommand(source, { platform = process.platform } = {}) {
  const normalized = normalizeUpdateSource(source);
  if (!normalized) throw new Error(`Update source must be npm or github: ${source}`);
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: ["install", "--global", UPDATE_SPECS[normalized]],
    source: normalized,
  };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (signal) finish(reject, new Error(`npm update was interrupted by ${signal}`));
      else if (code !== 0) finish(reject, new Error(`npm update exited with status ${code}`));
      else finish(resolve);
    });
  });
}

export async function runPackageUpdateCommand({
  commandName = "ccdx",
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  platform = process.platform,
  prompt,
  source,
  spawnImpl = spawn,
} = {}) {
  let selectedSource = normalizeUpdateSource(source);
  if (source && !selectedSource) throw new Error(`Update source must be npm or github: ${source}`);

  if (!selectedSource) {
    if (!prompt && (!input.isTTY || !output.isTTY)) {
      throw new Error(`Choose a source with ${commandName} update npm or ${commandName} update github`);
    }

    output.write(`${commandName} update\n`);
    output.write("  1. npm registry [default]\n");
    output.write("  2. GitHub main\n");

    let readline;
    const ask = prompt || (async (question) => {
      readline ||= createInterface({ input, output });
      return readline.question(question);
    });
    try {
      while (!selectedSource) {
        const answer = String(await ask("Select update source [1], or q to cancel: ") || "").trim().toLowerCase();
        if (answer === "q" || answer === "quit") {
          output.write("No changes made.\n");
          return { cancelled: true, source: "" };
        }
        if (answer === "" || answer === "1" || answer === "npm") selectedSource = "npm";
        else if (answer === "2" || answer === "github" || answer === "gh") selectedSource = "github";
        else output.write("Enter 1 for npm, 2 for GitHub, or q to cancel.\n");
      }
    } finally {
      readline?.close();
    }
  }

  const update = globalUpdateCommand(selectedSource, { platform });
  const sourceLabel = selectedSource === "npm" ? "npm registry" : "GitHub main";
  output.write(`Updating ${PACKAGE_NAME} from ${sourceLabel}...\n`);
  const child = spawnImpl(update.command, update.args, {
    env,
    shell: false,
    stdio: "inherit",
  });
  await waitForExit(child);
  output.write(`Updated ${PACKAGE_NAME} from ${sourceLabel}. Restart the running adapter to use the new version.\n`);
  return { cancelled: false, source: selectedSource };
}
