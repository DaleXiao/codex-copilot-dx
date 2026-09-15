import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
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
  const answers = ["wrong", "10", "2"];
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
  assert.deepEqual(events, ["answer:wrong", "answer:10", "answer:2", "preview:twin"]);

  const rendered = output.text();
  const plain = rendered.replace(ANSI_PATTERN, "");
  const rows = plain.split("\n").filter((line) => /^  \d\./.test(line));
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.map((line) => line.match(/^  \d\. (\w+)/)[1]),
    ["Comet", "Twin", "Shuttle", "Chase", "Mirror", "Pulse", "Stack", "Relay", "Split"]);
  assert.ok(rows.every((line) => /\[[ :]{20}\]$/.test(line)));
  assert.match(rendered, /1\. Comet.*\u001b\[97m:/);
  assert.doesNotMatch(rendered, /braille/i);
  assert.equal((plain.match(/Enter a number from 1 to 9/g) || []).length, 2);
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

test("animation selector: runs all-theme preview while awaiting input and stops before saving or cancelling", async (t) => {
  for (const answer of ["2", "q", ""]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-gallery-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const events = [];
    const result = await runAnimationCommand({
      env: {}, home, output: outputBuffer().stream,
      gallery: () => {
        events.push("gallery");
        return { enabled: true, stop: () => events.push("stop") };
      },
      prompt: async () => { events.push("input"); return answer; },
      preview: async () => { throw new Error("A live gallery needs no blocking confirmation cycle"); },
    });
    assert.deepEqual(events.slice(0, 3), ["gallery", "input", "stop"]);
    assert.equal(result.cancelled, answer === "q");
    assert.equal(savedTerminalAnimationTheme({ env: {}, home }), answer === "2" ? "twin" : "");
  }
});

test("animation selector: closes its gallery when the input stream ends", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-eof-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  let stopped = false;
  const result = runAnimationCommand({ env: {}, home, input, output,
    gallery: () => ({ enabled: true, stop: () => { stopped = true; } }),
  });
  input.end();
  assert.equal((await result).cancelled, true);
  assert.equal(stopped, true);
  assert.equal(fs.existsSync(userSettingsPath({ env: {}, home })), false);
});

test("animation selector: a wrapped invalid answer never restarts the gallery on stale row positions", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-wrapped-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let starts = 0;
  const result = runAnimationCommand({ env: {}, home, input, output,
    gallery: () => { starts += 1; return { enabled: true, stop() {} }; },
  });
  input.write(`${"x".repeat(95)}\r`);
  await new Promise(setImmediate);
  input.write("2\r");
  assert.equal((await result).theme, "twin");
  assert.equal(starts, 1);
});

test("animation selector: old Braille settings allow selecting and keeping each new theme", async (t) => {
  for (const [choice, theme] of [["7", "stack"], ["8", "relay"], ["9", "split"]]) {
    await t.test(theme, async (t) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-animation-upgrade-"));
      t.after(() => fs.rmSync(home, { recursive: true, force: true }));
      const filePath = userSettingsPath({ env: {}, home });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const original = JSON.stringify({ terminal_animation: "braille", untouched: { enabled: true } });
      fs.writeFileSync(filePath, original);
      const output = outputBuffer();
      const previews = [];
      const options = { env: {}, home, output: output.stream, preview: async (value) => previews.push(value) };

      const cancelled = await runAnimationCommand({ ...options, prompt: async () => "q" });
      assert.deepEqual(cancelled, { changed: false, cancelled: true, theme: "comet" });
      const keptDefault = await runAnimationCommand({ ...options, prompt: async () => "" });
      assert.equal(keptDefault.changed, false);
      assert.equal(keptDefault.theme, "comet");
      assert.equal(fs.readFileSync(filePath, "utf8"), original);

      const selected = await runAnimationCommand({ ...options, prompt: async () => choice });
      assert.equal(selected.changed, true);
      assert.equal(selected.theme, theme);
      assert.deepEqual(readUserSettings({ env: {}, home }), { terminal_animation: theme, untouched: { enabled: true } });
      const saved = fs.readFileSync(filePath, "utf8");
      const kept = await runAnimationCommand({ ...options, prompt: async () => "" });
      assert.equal(kept.changed, false);
      assert.equal(kept.theme, theme);
      assert.equal(fs.readFileSync(filePath, "utf8"), saved);
      assert.deepEqual(previews, ["comet", theme, theme]);
      assert.match(output.text(), /Current: Comet \(default\)/);
      assert.doesNotMatch(output.text(), /braille/i);
    });
  }
});
