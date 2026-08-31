import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCliError } from "../src/cli-error.mjs";

test("formatCliError bounds and sanitizes top-level messages and structured details", () => {
  const details = Array.from({ length: 20 }, (_, index) => (
    index === 0
      ? "first\u001b[2J\n[OK] injected\u202esecret"
      : `${index}: ${"x".repeat(2048)}`
  ));
  details[1] = "Authorization: Bearer bearer_test_value_123456";
  details[2] = "token github_pat_FAKE_VALUE_123456789";
  const output = formatCliError({
    message: `restore failed\u001b[31m\n[OK] forged sk-fake-secret-value ${"m".repeat(2048)}`,
    details,
  });
  const lines = output.split("\n");

  assert.equal(lines.length, 18);
  assert.match(lines[0], /^\[ERR\] restore failed \[OK\] forged/);
  assert.match(lines[1], /^\[INFO\] first \[OK\] injectedsecret$/);
  assert.equal(lines[0].length <= "[ERR] ".length + 1024, true);
  assert.equal(lines.slice(1, 17).every((line) => line.length <= "[INFO] ".length + 512), true);
  assert.equal(lines[17], "[INFO] 4 additional detail(s) omitted");
  assert.doesNotMatch(output, /\u001b|\u202e|\n\[OK\]/);
  assert.doesNotMatch(output, /bearer_test_value|github_pat_|sk-fake-secret-value/);
});

test("formatCliError tolerates hostile message and details getters", () => {
  const output = formatCliError({
    get message() { throw new Error("message getter failed"); },
    get details() { throw new Error("details getter failed"); },
  });
  assert.equal(output, "[ERR] Command failed");
});
