#!/usr/bin/env node

if (process.stderr.isTTY === true) {
  const {
    LEGACY_COMMAND_WARNING,
    shouldShowLegacyCommandWarning,
  } = await import("../src/legacy-command-warning.mjs");
  if (shouldShowLegacyCommandWarning({ interactive: true })) console.warn(LEGACY_COMMAND_WARNING);
}
await import("./cli.mjs");
