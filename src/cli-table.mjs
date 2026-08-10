import { stripVTControlCharacters } from "node:util";

const DEFAULT_TERMINAL_COLUMNS = 120;
const COMBINING_MARK = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const SIMPLE_WIDTH = /^[\u0020-\u007e\u2014]*$/;
let graphemeSegmenter;

function wideCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(segment) {
  if (EMOJI.test(segment)) return 2;
  let width = 0;
  for (const character of segment) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || COMBINING_MARK.test(character)) continue;
    width += wideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function displayWidth(value) {
  if (SIMPLE_WIDTH.test(value)) return value.length;
  graphemeSegmenter ||= new Intl.Segmenter("en", { granularity: "grapheme" });
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) width += graphemeWidth(segment);
  return width;
}

function padding(length) {
  return length > 0 ? " ".repeat(length) : "";
}

function padded(value, width, align) {
  const spaces = padding(width - displayWidth(value));
  return align === "right" ? `${spaces}${value}` : `${value}${spaces}`;
}

export function terminalCell(value, { fallback = "—" } = {}) {
  if (value === undefined || value === null) return fallback;
  const text = stripVTControlCharacters(String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

export function cliOutputFormat(format = "auto", output = process.stdout) {
  if (format === "table" || format === "plain") return format;
  return output?.isTTY === true ? "table" : "plain";
}

export function cliOutputWidth(output = process.stdout) {
  const columns = Number(output?.columns);
  return Number.isSafeInteger(columns) && columns > 0 ? columns : DEFAULT_TERMINAL_COLUMNS;
}

export function formatCliTable({ columns, rows, gap = 2 }) {
  const normalizedColumns = columns.map((column) => ({
    ...column,
    label: terminalCell(column.label, { fallback: "" }),
  }));
  const normalizedRows = rows.map((row) => Object.fromEntries(normalizedColumns.map((column) => [
    column.key,
    terminalCell(row[column.key]),
  ])));
  const widths = normalizedColumns.map((column) => Math.max(
    displayWidth(column.label),
    ...normalizedRows.map((row) => displayWidth(row[column.key])),
  ));
  const line = (values) => normalizedColumns
    .map((column, index) => padded(values[column.key], widths[index], column.align))
    .join(" ".repeat(gap))
    .trimEnd();
  const header = Object.fromEntries(normalizedColumns.map((column) => [column.key, column.label]));
  const separator = Object.fromEntries(normalizedColumns.map((column, index) => [
    column.key,
    "-".repeat(widths[index]),
  ]));
  return [line(header), line(separator), ...normalizedRows.map(line)].join("\n");
}

export function cliTableWidth(table) {
  return Math.max(0, ...String(table).split("\n").map(displayWidth));
}

export function formatResponsiveCliTable({ columns, compactColumns, rows, width = DEFAULT_TERMINAL_COLUMNS, gap = 2 }) {
  const full = formatCliTable({ columns, rows, gap });
  const fullWidth = cliTableWidth(full);
  if (!compactColumns?.length || fullWidth <= width) {
    return { output: full, compact: false, overflow: fullWidth > width };
  }
  const compact = formatCliTable({ columns: compactColumns, rows, gap });
  return {
    output: compact,
    compact: true,
    overflow: cliTableWidth(compact) > width,
  };
}
