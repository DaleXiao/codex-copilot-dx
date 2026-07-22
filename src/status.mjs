import { currentRequestContext } from "./request-context.mjs";

const LABELS = {
  info: "[INFO]",
  ok: "[OK]",
  wait: "[WAIT]",
  warn: "[WARN]",
  err: "[ERR]",
  debug: "[DEBUG]",
};

export function status(kind, message) {
  const requestId = currentRequestContext()?.requestId;
  const context = requestId ? ` request_id=${requestId}` : "";
  return `${LABELS[kind] || LABELS.info}${context} ${message}`;
}
