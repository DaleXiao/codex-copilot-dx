import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAnimationCommand } from "../src/cli-animation.mjs";
import {
  readUserSettings,
  savedTerminalAnimationTheme,
  userSettingsPath,
  writeTerminalAnimationTheme,
} from "../src/user-settings.mjs";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function outputBuffer({ isTTY = true } = {}) {
  let value = "";
  return {
    stream: {
      isTTY,
      columns: 80,
      write(chunk) {
        value += String(chunk);
        return true;
      },
    },
    text: () => value,
  };
}

test("animation selector: shows the fixed ordered menu and persists a numeric selection", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-selector-"));
  const output = outputBuffer();
  const answers = ["wrong", "8", "2"];
  const events = [];

  const result = await runAnimationCommand({
    env: {},
    home,
    output: output.stream,
    prompt: async () => {
      const answer = answers.shift();
      events.push(`answer:${answer}`);
      return answer;
    },
    preview: async (theme, options) => {
      assert.equal(options.output, output.stream);
      events.push(`preview:${theme}`);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.theme, "twin");
  assert.equal(savedTerminalAnimationTheme({ env: {}, home }), "twin");
  assert.deepEqual(events, ["answer:wrong", "answer:8", "answer:2", "preview:twin"]);

  const rendered = output.text();
  const plain = rendered.replace(ANSI_PATTERN, "");
  assert.match(plain, /1\. Comet \[default, current\].*\n  2\. Twin\n  3\. Shuttle\n  4\. Chase\n  5\. Mirror\n  6\. Pulse\n  7\. Braille\n/);
  assert.match(rendered, /1\. Comet.*\u001b\[97m:/);
  assert.doesNotMatch(rendered, /Braille Comet/i);
  assert.equal((plain.match(/Enter a number from 1 to 7/g) || []).length, 2);
  assert.match(plain, /Saved terminal animation: Twin/);
  assert.match(plain, /The next ccdx start will use this animation/);
});

test("animation selector: Enter keeps the saved choice and its current marker", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-keep-"));
  writeTerminalAnimationTheme("mirror", { env: {}, home });
  const output = outputBuffer({ isTTY: false });
  const previews = [];

  const result = await runAnimationCommand({
    env: {},
    home,
    input: { isTTY: false },
    output: output.stream,
    prompt: async (question) => {
      assert.match(question, /Select \[5\]/);
      return "";
    },
    preview: async (theme) => previews.push(theme),
  });

  assert.deepEqual(result, { changed: false, cancelled: false, theme: "mirror" });
  assert.deepEqual(previews, ["mirror"]);
  assert.equal(savedTerminalAnimationTheme({ env: {}, home }), "mirror");
  assert.match(output.text().replace(ANSI_PATTERN, ""), /5\. Mirror \[current\]/);
  assert.match(output.text(), /Kept terminal animation: Mirror/);
});

test("animation selector: q cancels without writing or playing a preview", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-cancel-"));
  const filePath = userSettingsPath({ env: {}, home });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ terminal_animation: "shuttle", untouched: 42 }, null, 2)}\n`);
  const before = fs.readFileSync(filePath, "utf8");
  const output = outputBuffer();
  let previewed = false;

  const result = await runAnimationCommand({
    env: {},
    home,
    output: output.stream,
    prompt: async () => "q",
    preview: async () => { previewed = true; },
  });

  assert.deepEqual(result, { changed: false, cancelled: true, theme: "shuttle" });
  assert.equal(previewed, false);
  assert.equal(fs.readFileSync(filePath, "utf8"), before);
  assert.match(output.text(), /No changes made/);
});

test("animation selector: choosing Comet removes only the animation override", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-default-"));
  const filePath = userSettingsPath({ env: {}, home });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ terminal_animation: "twin", untouched: 42 }, null, 2)}\n`);

  await runAnimationCommand({
    env: {},
    home,
    output: outputBuffer().stream,
    prompt: async () => "1",
    preview: async () => {},
  });

  assert.deepEqual(readUserSettings({ env: {}, home }), { untouched: 42 });
});

test("animation selector: reports every disabled environment spelling", async (t) => {
  for (const value of ["0", "false", "no", "off"]) {
    await t.test(value, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-env-"));
      const output = outputBuffer();
      let previewed = false;
      await runAnimationCommand({
        env: { CCDX_TERMINAL_ANIMATION: value },
        home,
        output: output.stream,
        prompt: async () => "3",
        preview: async () => { previewed = true; },
      });

      assert.equal(previewed, false);
      assert.equal(savedTerminalAnimationTheme({ env: {}, home }), "shuttle");
      assert.match(
        output.text(),
        new RegExp(`CCDX_TERMINAL_ANIMATION=${value} remains effective until it is unset`),
      );
      assert.match(output.text(), /next ccdx start after the override is unset/);
    });
  }
});

test("animation selector: preview failure does not hide or undo a saved choice", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-preview-failure-"));
  const output = outputBuffer();

  const result = await runAnimationCommand({
    env: {},
    home,
    output: output.stream,
    prompt: async () => "6",
    preview: async () => { throw new Error("preview failed"); },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.theme, "pulse");
  assert.equal(savedTerminalAnimationTheme({ env: {}, home }), "pulse");
  assert.match(output.text(), /\[WARN\] Preview unavailable/);
  assert.match(output.text(), /Saved terminal animation: Pulse/);
  assert.match(output.text(), /The next ccdx start will use this animation/);
});

test("animation selector: rejects non-interactive use without an injected prompt", async () => {
  await assert.rejects(
    runAnimationCommand({ input: { isTTY: false }, output: { isTTY: false } }),
    /ccdx animation requires an interactive terminal/,
  );
});
