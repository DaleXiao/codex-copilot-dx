import { inspectWindowsCommand } from "../src/windows-command.mjs";

// Never make installation fail because an optional command convenience failed.
try {
  const result = inspectWindowsCommand({ repair: true });
  if (["preserved", "repairable"].includes(result.status)) {
    console.warn("CCDX command setup preserved an existing launcher. Use ccdx.cmd doctor --fix to inspect it; no PowerShell policy was changed.");
  }
} catch {
  console.warn("CCDX command setup could not finish. Use ccdx.cmd doctor --fix; no PowerShell policy was changed.");
}
