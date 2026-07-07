const LABELS = {
  info: "[INFO]",
  ok: "[OK]",
  wait: "[WAIT]",
  warn: "[WARN]",
  err: "[ERR]",
  debug: "[DEBUG]",
};

export function status(kind, message) {
  return `${LABELS[kind] || LABELS.info} ${message}`;
}
