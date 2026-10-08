import { stripVTControlCharacters } from "node:util";

export function terminalCell(value, { fallback = "—" } = {}) {
  if (value === undefined || value === null) return fallback;
  const text = stripVTControlCharacters(String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}
