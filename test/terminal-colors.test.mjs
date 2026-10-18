import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { colorTerminalText, colorTerminalMotion } from "../src/terminal-colors.mjs";
import { startupBanner } from "../src/startup-ui.mjs";

test("blue supports truecolor, 256-color, ANSI and plain output without changing visible width", () => {
  const table = "│ Input      1.7M │";
  for (const [depth, prefix] of [[24, "\x1b[38;2;76;159;255m"], [8,"\x1b[38;5;75m"], [4,"\x1b[94m"]]) {
    const options = { output: { isTTY: true, getColorDepth: () => depth }, env: {} };
    const colored = colorTerminalText(table,"klein", options);
    assert.ok(colored.startsWith(prefix));assert.ok(colored.endsWith("\x1b[0m"));assert.equal(stripVTControlCharacters(colored),table);
    const banner = startupBanner({ version:"test", colorTheme:"klein", stream:{...options.output,columns:80},env:{} });
    assert.ok(banner.includes(prefix));assert.equal(stripVTControlCharacters(banner).split("\n").length,6);
  }
  for (const options of [{output:{isTTY:false},env:{}},{output:{isTTY:true},env:{NO_COLOR:""}},{output:{isTTY:true},env:{TERM:"dumb"}}]) assert.equal(colorTerminalText(table,"klein",options),table);
});

test("recoloring motion preserves glyphs and existing green frames", () => {
  const frame="[\x1b[38;5;159m:\x1b[0m\x1b[97m:\x1b[0m]";
  const options={output:{isTTY:true},env:{}};
  assert.equal(colorTerminalMotion(frame,"green",options),frame);
  assert.equal(stripVTControlCharacters(colorTerminalMotion(frame,"klein",options)),"[::]");
});
