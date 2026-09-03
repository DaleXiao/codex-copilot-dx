import os from "node:os";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_TERMINAL_ANIMATION_THEME,
  playTerminalAnimationPreview,
  renderTerminalAnimationFrame,
  TERMINAL_ANIMATION_THEMES,
} from "./terminal-animation.mjs";
import {
  readUserSettings,
  terminalAnimationPreference,
  writeTerminalAnimationTheme,
} from "./user-settings.mjs";

const DISABLED_ENV_VALUES = new Set(["0", "false", "no", "off"]);

function markers(theme, currentTheme) {
  const values = [];
  if (theme.id === DEFAULT_TERMINAL_ANIMATION_THEME) values.push("default");
  if (theme.id === currentTheme) values.push("current");
  return values.length ? ` [${values.join(", ")}]` : "";
}

function disabledEnvironmentValue(env) {
  const value = String(env.CCDX_TERMINAL_ANIMATION || "").trim();
  return DISABLED_ENV_VALUES.has(value.toLowerCase()) ? value : "";
}

export async function runAnimationCommand({
  commandName = "ccdx",
  env = process.env,
  home = os.homedir(),
  input = process.stdin,
  output = process.stdout,
  prompt,
  preview = playTerminalAnimationPreview,
} = {}) {
  if (!prompt && (!input.isTTY || !output.isTTY)) {
    throw new Error(`${commandName} animation requires an interactive terminal`);
  }

  readUserSettings({ env, home, strict: true });
  const current = terminalAnimationPreference({ env, home });
  const currentIndex = TERMINAL_ANIMATION_THEMES.findIndex(({ id }) => id === current.theme);

  output.write(`${commandName} animation\n`);
  output.write(`Current: ${TERMINAL_ANIMATION_THEMES[currentIndex].label} (${current.source})\n\n`);
  TERMINAL_ANIMATION_THEMES.forEach((theme, index) => {
    const staticPreview = theme.id === DEFAULT_TERMINAL_ANIMATION_THEME
      ? `  ${renderTerminalAnimationFrame(theme.id, 10)}`
      : "";
    output.write(`  ${index + 1}. ${theme.label}${markers(theme, current.theme)}${staticPreview}\n`);
  });

  let readline;
  const ask = prompt || (async (question) => {
    readline ||= createInterface({ input, output });
    return readline.question(question);
  });

  let selectedTheme = current.theme;
  let keepCurrent = false;
  try {
    while (true) {
      const answer = String(await ask(`Select [${currentIndex + 1}], or q to cancel: `) || "").trim();
      if (answer.toLowerCase() === "q") {
        output.write("No changes made.\n");
        return { changed: false, cancelled: true, theme: current.theme };
      }
      if (answer === "") {
        keepCurrent = true;
        break;
      }
      const selectedIndex = Number(answer) - 1;
      if (Number.isInteger(selectedIndex)
          && selectedIndex >= 0
          && selectedIndex < TERMINAL_ANIMATION_THEMES.length) {
        selectedTheme = TERMINAL_ANIMATION_THEMES[selectedIndex].id;
        break;
      }
      output.write(`Enter a number from 1 to ${TERMINAL_ANIMATION_THEMES.length}, or q to cancel.\n`);
    }
  } finally {
    readline?.close();
  }

  const result = keepCurrent
    ? { changed: false, theme: current.theme }
    : writeTerminalAnimationTheme(selectedTheme, { env, home });
  const disabledValue = disabledEnvironmentValue(env);
  if (!disabledValue) {
    try {
      await preview(selectedTheme, { output });
    } catch {
      output.write("[WARN] Preview unavailable; the terminal animation setting was still applied.\n");
    }
  }

  const selected = TERMINAL_ANIMATION_THEMES.find(({ id }) => id === selectedTheme);
  output.write(`${result.changed ? "Saved" : "Kept"} terminal animation: ${selected.label}\n`);
  if (disabledValue) {
    output.write(`CCDX_TERMINAL_ANIMATION=${disabledValue} remains effective until it is unset; terminal animation stays disabled.\n`);
    output.write("The saved animation will be used on the next ccdx start after the override is unset.\n");
  } else {
    output.write("The next ccdx start will use this animation.\n");
  }
  return { ...result, cancelled: false, theme: selectedTheme };
}
