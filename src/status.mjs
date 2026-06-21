const LABELS = {
  info: "[INFO]",
  ok: "[OK]",
  wait: "[WAIT]",
  warn: "[WARN]",
  err: "[ERR]",
};

export function status(kind, message) {
  return `${LABELS[kind] || LABELS.info} ${message}`;
}
