import { terminalCell } from "./cli-table.mjs";
import { status } from "./status.mjs";

const MAX_MESSAGE_CHARACTERS = 1024;
const MAX_DETAIL_CHARACTERS = 512;
const MAX_DETAILS = 16;

function redactSensitiveValues(value) {
  return value
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
}

function boundedTerminalText(value, fallback, maxCharacters) {
  try {
    return redactSensitiveValues(terminalCell(value, { fallback })).slice(0, maxCharacters);
  } catch {
    return fallback;
  }
}

export function formatCliError(error) {
  let rawMessage;
  try {
    rawMessage = error?.message;
  } catch {
    rawMessage = undefined;
  }
  const message = boundedTerminalText(rawMessage, "Command failed", MAX_MESSAGE_CHARACTERS);
  let details;
  try {
    details = error?.details;
  } catch {
    details = undefined;
  }
  const values = details === undefined
    ? []
    : Array.isArray(details) ? details : [details];
  const visible = values.slice(0, MAX_DETAILS);
  const lines = [status("err", message)];
  for (const detail of visible) {
    lines.push(status("info", boundedTerminalText(detail, "Detail unavailable", MAX_DETAIL_CHARACTERS)));
  }
  if (values.length > visible.length) {
    lines.push(status("info", `${values.length - visible.length} additional detail(s) omitted`));
  }
  return lines.join("\n");
}
