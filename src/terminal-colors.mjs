export const isColorTheme = value => value === "green" || value === "klein" || value === "pink";

export function terminalColorCode(theme, { output = process.stdout, env = process.env } = {}) {
  if (output.isTTY !== true || Object.hasOwn(env, "NO_COLOR") || env.TERM === "dumb") return "";
  // Preserve the original green exactly. Blue also supports ordinary ANSI terminals.
  if (theme !== "klein" && theme !== "pink") return "\x1b[38;2;166;245;168m";
  const depth = output.getColorDepth?.(env) || (/truecolor|24bit/i.test(env.COLORTERM || "") ? 24 : 4);
  if (theme === "pink") {
    const light = /^(7|15)$/.test(String(env.COLORFGBG || "").split(";").at(-1));
    return depth >= 24 ? light ? "\x1b[38;2;168;62;104m" : "\x1b[38;2;243;168;200m"
      : depth >= 8 ? light ? "\x1b[38;5;132m" : "\x1b[38;5;218m" : "\x1b[95m";
  }
  return depth >= 24 ? "\x1b[38;2;76;159;255m" : depth >= 8 ? "\x1b[38;5;75m" : "\x1b[94m";
}

export function colorTerminalText(text, theme, options) {
  const code = terminalColorCode(theme, options);
  return code ? `${code}${text}\x1b[0m` : text;
}

export function colorTerminalMotion(frame, theme, options) {
  if (theme !== "klein" && theme !== "pink") return frame;
  const code = terminalColorCode(theme, options);
  return frame.replace(/\x1b\[(?:38;5;\d+|97)m/g, code);
}
