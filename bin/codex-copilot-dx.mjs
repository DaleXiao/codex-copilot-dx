#!/usr/bin/env node

const configDoctor = ["doctor", "--doctor"].includes(process.argv[2]) && process.argv[3] === "config";
if (process.stderr.isTTY === true && !configDoctor) {
  const {
    LEGACY_COMMAND_WARNING,
    shouldShowLegacyCommandWarning,
  } = await import("../src/legacy-command-warning.mjs");
  if (shouldShowLegacyCommandWarning({ interactive: true })) console.warn(LEGACY_COMMAND_WARNING);
}
await import("./cli.mjs");
