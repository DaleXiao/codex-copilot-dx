import test from "node:test";
import assert from "node:assert/strict";
import {
  cliOutputFormat,
  cliOutputWidth,
  formatCliTable,
  formatResponsiveCliTable,
  cliTableWidth,
  terminalCell,
} from "../src/cli-table.mjs";

const COLUMNS = [
  { key: "name", label: "NAME" },
  { key: "count", label: "COUNT", align: "right" },
];

test("cli table aligns text and numbers without borders", () => {
  assert.equal(formatCliTable({
    columns: COLUMNS,
    rows: [
      { name: "short", count: 2 },
      { name: "longer", count: 10 },
    ],
  }), [
    "NAME    COUNT",
    "------  -----",
    "short       2",
    "longer     10",
  ].join("\n"));
});

test("cli table sanitizes terminal controls and represents missing cells", () => {
  assert.equal(terminalCell("model\u001b[2J\nname"), "model name");
  assert.equal(terminalCell("safe\u202eevil"), "safeevil");
  assert.equal(formatCliTable({
    columns: COLUMNS,
    rows: [{ name: "model\u001b[2J", count: undefined }],
  }), [
    "NAME   COUNT",
    "-----  -----",
    "model      —",
  ].join("\n"));
});

test("responsive cli table uses compact columns only when needed", () => {
  const wide = formatResponsiveCliTable({
    columns: COLUMNS,
    compactColumns: [COLUMNS[0]],
    rows: [{ name: "model", count: 1000 }],
    width: 80,
  });
  const narrow = formatResponsiveCliTable({
    columns: COLUMNS,
    compactColumns: [COLUMNS[0]],
    rows: [{ name: "model", count: 1000 }],
    width: 8,
  });
  assert.equal(wide.compact, false);
  assert.equal(wide.overflow, false);
  assert.equal(narrow.compact, true);
  assert.equal(narrow.overflow, false);
  assert.doesNotMatch(narrow.output, /COUNT/);
});

test("cli table measures CJK and emoji by terminal display width", () => {
  const table = formatCliTable({
    columns: COLUMNS,
    rows: [
      { name: "模型", count: 2 },
      { name: "👨‍👩‍👧‍👦", count: 10 },
    ],
  });
  assert.equal(cliTableWidth(table), 11);
  assert.equal(formatResponsiveCliTable({
    columns: COLUMNS,
    compactColumns: [COLUMNS[0]],
    rows: [{ name: "long-model-name", count: 1 }],
    width: 8,
  }).overflow, true);
});

test("cli output defaults to tables only for interactive terminals", () => {
  assert.equal(cliOutputFormat("auto", { isTTY: true }), "table");
  assert.equal(cliOutputFormat("auto", { isTTY: false }), "plain");
  assert.equal(cliOutputFormat("table", { isTTY: false }), "table");
  assert.equal(cliOutputFormat("plain", { isTTY: true }), "plain");
  assert.equal(cliOutputWidth({ columns: 88 }), 88);
  assert.equal(cliOutputWidth({}), 120);
});
