import { currentRequestContext } from "./request-context.mjs";
import { terminalCell } from "./terminal-text.mjs";

const LABELS = {
  info: "[INFO]",
  ok: "[OK]",
  wait: "[WAIT]",
  warn: "[WARN]",
  err: "[ERR]",
  debug: "[DEBUG]",
};

export function status(kind, message) {
  const requestContext = currentRequestContext();
  const requestId = requestContext?.showRequestId ? requestContext.requestId : "";
  const context = requestId ? ` request_id=${requestId}` : "";
  return `${(LABELS[kind] || LABELS.info).padEnd(8)}${context ? `${terminalCell(context.trimStart())} ` : ""}${terminalCell(message, { fallback: "" })}`;
}
