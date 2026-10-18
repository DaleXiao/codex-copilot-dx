export const isColorTheme = value => value === "green" || value === "klein";

export function terminalColorCode(theme, { output = process.stdout, env = process.env } = {}) {
  if (output.isTTY !== true || Object.hasOwn(env, "NO_COLOR") || env.TERM === "dumb") return "";
  // Preserve the original green exactly. Blue also supports ordinary ANSI terminals.
  if (theme !== "klein") return "\x1b[38;2;166;245;168m";
  const depth = output.getColorDepth?.(env) || (/truecolor|24bit/i.test(env.COLORTERM || "") ? 24 : 4);
  return depth >= 24 ? "\x1b[38;2;76;159;255m" : depth >= 8 ? "\x1b[38;5;75m" : "\x1b[94m";
}

export function colorTerminalText(text, theme, options) {
  const code = terminalColorCode(theme, options);
  return code ? `${code}${text}\x1b[0m` : text;
}

export function colorTerminalMotion(frame, theme, options) {
  if (theme !== "klein") return frame;
  const code = terminalColorCode(theme, options);
  return frame.replace(/\x1b\[(?:38;5;\d+|97)m/g, code);
}
