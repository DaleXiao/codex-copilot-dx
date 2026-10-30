export const TERMINAL_COLOR_THEMES = Object.freeze(["green", "klein", "pink", "mono", "orange"]);
export const isColorTheme = value => TERMINAL_COLOR_THEMES.includes(value);

export function terminalColorCode(theme, { output = process.stdout, env = process.env } = {}) {
  if (output.isTTY !== true || Object.hasOwn(env, "NO_COLOR") || env.TERM === "dumb") return "";
  if (theme === "mono") return "\x1b[39m";
  // Preserve the original green exactly. Other colors adapt to terminal depth.
  if (theme !== "klein" && theme !== "pink" && theme !== "orange") return "\x1b[38;2;166;245;168m";
  const depth = output.getColorDepth?.(env) || (/truecolor|24bit/i.test(env.COLORTERM || "") ? 24 : 4);
  const light = /^(7|15)$/.test(String(env.COLORFGBG || "").split(";").at(-1));
  if (theme === "orange") return depth >= 24 ? light ? "\x1b[38;2;173;77;0m" : "\x1b[38;2;255;154;61m"
    : depth >= 8 ? light ? "\x1b[38;5;130m" : "\x1b[38;5;208m" : light ? "\x1b[33m" : "\x1b[93m";
  if (theme === "pink") {
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
  if (!isColorTheme(theme) || theme === "green") return frame;
  const code = terminalColorCode(theme, options);
  return frame.replace(/\x1b\[(?:38;5;\d+|97)m/g, code);
}
