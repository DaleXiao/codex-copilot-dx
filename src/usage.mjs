import { cliOutputFormat, cliOutputWidth, formatResponsiveCliTable, terminalCell } from "./cli-table.mjs";
import { cacheReadTokens, summarizeUsageLogs, usageCacheHitRate, usageLogPath } from "./usage-store.mjs";

export {
  usageLoggingStats,
  usageLogPath,
  usageLogMaxBytes,
  buildResponsesUsageRecord,
  recordUsage,
  recordResponsesUsage,
  flushUsageWritesForTests,
  flushUsageWrites,
  readUsageRecords,
  summarizeUsage,
  summarizeUsageLogs,
  cacheReadTokens,
  usageCacheHitRate,
} from "./usage-store.mjs";

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

function tableNumber(n) {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : undefined;
}

function cacheHitPercent(usage) {
  const rate = usageCacheHitRate(usage);
  return rate === null ? "—" : `${usage.cache_hit_unknown_requests > 0 ? "~" : ""}${(rate * 100).toFixed(1)}%`;
}

function formatPlainUsageSummary(summary, filePath, { sanitize = false } = {}) {
  const lines = [`Usage log: ${filePath}`];
  if (summary.requests === 0) {
    lines.push("No usage records yet.");
    return (sanitize ? lines.map((line) => terminalCell(line, { fallback: "" })) : lines).join("\n");
  }
  lines.push(
    `Requests: ${fmt(summary.requests)}`,
    `Tokens: input=${fmt(summary.totals.input_tokens)} cache_read=${fmt(cacheReadTokens(summary.totals))} output=${fmt(summary.totals.output_tokens)} total=${fmt(summary.totals.total_tokens)}`,
    `Cache hit: ${cacheHitPercent(summary.totals)} (cached/input tokens)`,
    "",
    "By model:",
  );
  for (const [model, row] of Object.entries(summary.byModel)) {
    lines.push(`  ${model}: requests=${fmt(row.requests)} input=${fmt(row.input_tokens)} cache_read=${fmt(cacheReadTokens(row))} output=${fmt(row.output_tokens)} total=${fmt(row.total_tokens)} cache_hit=${cacheHitPercent(row)}`);
  }
  return (sanitize ? lines.map((line) => terminalCell(line, { fallback: "" })) : lines).join("\n");
}

function compareModelUsage(left, right) {
  const leftTotal = Number.isFinite(left.row.total_tokens) ? left.row.total_tokens : -Infinity;
  const rightTotal = Number.isFinite(right.row.total_tokens) ? right.row.total_tokens : -Infinity;
  if (leftTotal !== rightTotal) return rightTotal - leftTotal;
  return left.model < right.model ? -1 : left.model > right.model ? 1 : 0;
}

function usageTableRow(model, usage) {
  return {
    model,
    records: tableNumber(usage.requests),
    input: tableNumber(usage.input_tokens),
    cacheRead: tableNumber(cacheReadTokens(usage)),
    output: tableNumber(usage.output_tokens),
    total: tableNumber(usage.total_tokens),
    cacheHit: cacheHitPercent(usage),
  };
}

function usageDetailLine(model, usage) {
  return `${terminalCell(model)}: input=${fmt(usage.input_tokens)} cache_read=${fmt(cacheReadTokens(usage))} output=${fmt(usage.output_tokens)} cache_hit=${cacheHitPercent(usage)}`;
}

function formatTableUsageSummary(summary, filePath, output) {
  const safePath = terminalCell(filePath, { fallback: "" });
  if (summary.requests === 0) return { output: `Usage log: ${safePath}\nNo usage records yet.`, overflow: false };
  const columns = [
    { key: "model", label: "MODEL" },
    { key: "records", label: "RECORDS", align: "right" },
    { key: "input", label: "INPUT", align: "right" },
    { key: "cacheRead", label: "CACHE READ", align: "right" },
    { key: "output", label: "OUTPUT", align: "right" },
    { key: "total", label: "TOTAL", align: "right" },
  ];
  const compactColumns = [columns[0], columns[1], columns[5]];
  const modelUsage = Object.entries(summary.byModel)
    .map(([model, row]) => ({ model, row }))
    .sort(compareModelUsage);
  const totalUsage = { requests: summary.requests, ...summary.totals };
  const rows = [usageTableRow("TOTAL", totalUsage), ...modelUsage.map(({ model, row }) => usageTableRow(model, row))];
  let table = formatResponsiveCliTable({
    columns: [...columns, { key: "cacheHit", label: "HIT %", align: "right" }],
    compactColumns: columns,
    rows,
    width: cliOutputWidth(output),
    gap: 1,
  });
  const rateFits = !table.compact;
  if (table.overflow) {
    table = formatResponsiveCliTable({ columns, compactColumns, rows, width: cliOutputWidth(output), gap: 1 });
  } else {
    table.compact = false;
  }
  const lines = [`Usage log: ${safePath}`, "", table.output];
  if (table.compact) {
    lines.push(
      "",
      "Details:",
      usageDetailLine("TOTAL", totalUsage),
      ...modelUsage.map(({ model, row }) => usageDetailLine(model, row)),
    );
  } else if (!rateFits) {
    lines.push("", "Cache hit (cached/input tokens):",
      `TOTAL: ${cacheHitPercent(totalUsage)}`,
      ...modelUsage.map(({ model, row }) => `${terminalCell(model)}: ${cacheHitPercent(row)}`));
  }
  return { output: lines.join("\n"), overflow: table.overflow };
}

export function formatUsageSummary(summary, {
  filePath = usageLogPath(),
  format = "auto",
  output = process.stdout,
} = {}) {
  if (cliOutputFormat(format, output) === "plain") return formatPlainUsageSummary(summary, filePath);
  const table = formatTableUsageSummary(summary, filePath, output);
  return format === "auto" && table.overflow
    ? formatPlainUsageSummary(summary, filePath, { sanitize: true })
    : table.output;
}

export async function printUsageSummary({
  filePath = usageLogPath(),
  format = "auto",
  output = process.stdout,
  log = console.log,
  warn = console.error,
} = {}) {
  const summary = await summarizeUsageLogs(filePath, { warn });
  log(formatUsageSummary(summary, { filePath, format, output }));
}
