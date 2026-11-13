import { cliOutputFormat, cliOutputWidth, formatResponsiveCliTable, terminalCell } from "./cli-table.mjs";
import { cacheReadTokens, summarizeUsageLogs, usageCacheHitRate, usageLogPath, usageModelGroups } from "./usage-store.mjs";

export {
  usageSummaryVersion,
  usageLoggingStats,
  runtimeUsageSnapshot,
  usageLogPath,
  usageLogMaxBytes,
  buildResponsesUsageRecord,
  buildMessagesUsageRecord,
  usageProvider,
  usageModelGroups,
  recordUsage,
  recordResponsesUsage,
  flushUsageWritesForTests,
  flushUsageWrites,
  readUsageRecords,
  summarizeUsage,
  summarizeUsageLogs,
  mergeUsageSummary,
  subscribeUsageAppends,
  cacheReadTokens,
  usageCacheHitRate,
} from "./usage-store.mjs";

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

const tokenCount = n => Number.isFinite(n) ? fmt(n) : "—";

function tableNumber(n) {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : undefined;
}

function cacheHitPercent(usage) {
  const rate = usageCacheHitRate(usage);
  return rate === null ? "—" : `${usage.cache_hit_unknown_requests > 0 ? "~" : ""}${(rate * 100).toFixed(1)}%`;
}

function providerSummaryLines(summary) {
  const filter = summary.filters, selection = filter ? [
    ...(filter.model ? [`Model: ${terminalCell(filter.model)}`] : []),
    ...(filter.from || filter.to ? [`Dates: ${filter.from || "earliest"} to ${filter.to || "latest"} (${terminalCell(filter.time_zone)})`] : []),
  ] : [];
  if (summary.provider_filter) return [`Provider: ${terminalCell(summary.provider_filter)}`, ...selection];
  const sources = Object.entries(summary.providers || {}).filter(([, count]) => count > 0);
  return [...(sources.some(([id]) => id !== "github")
    ? [`Providers: ${sources.map(([id, count]) => `${terminalCell(id)} ${fmt(count)}`).join(" / ")} (combined totals; use --provider to separate)`] : []), ...selection];
}

function formatPlainUsageSummary(summary, filePath, { sanitize = false } = {}) {
  const lines = [`Usage log: ${terminalCell(filePath)}`];
  lines.push(...providerSummaryLines(summary));
  if (summary.requests === 0) {
    lines.push("No usage records yet.");
    return (sanitize ? lines.map((line) => terminalCell(line, { fallback: "" })) : lines).join("\n");
  }
  lines.push(
    `Records: ${fmt(summary.requests)}`,
    `Tokens: input=${tokenCount(summary.totals.input_tokens)} cache_read=${tokenCount(cacheReadTokens(summary.totals))} cache_write=${tokenCount(summary.totals.cache_write_input_tokens)} output=${tokenCount(summary.totals.output_tokens)} total=${tokenCount(summary.totals.total_tokens)}`,
    `Cache hit: ${cacheHitPercent(summary.totals)} (cached/input tokens; valid paired records only)`,
    "",
    "By model:",
  );
  for (const [model, row] of Object.entries(usageModelGroups(summary))) {
    lines.push(`  ${terminalCell(model)}: records=${fmt(row.requests)} input=${tokenCount(row.input_tokens)} cache_read=${tokenCount(cacheReadTokens(row))} cache_write=${tokenCount(row.cache_write_input_tokens)} output=${tokenCount(row.output_tokens)} total=${tokenCount(row.total_tokens)} cache_hit=${cacheHitPercent(row)}`);
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
    cacheWrite: tableNumber(usage.cache_write_input_tokens),
    output: tableNumber(usage.output_tokens),
    total: tableNumber(usage.total_tokens),
    cacheHit: cacheHitPercent(usage),
  };
}

function usageDetailLine(model, usage) {
  return `${terminalCell(model)}: input=${tokenCount(usage.input_tokens)} cache_read=${tokenCount(cacheReadTokens(usage))} cache_write=${tokenCount(usage.cache_write_input_tokens)} output=${tokenCount(usage.output_tokens)} cache_hit=${cacheHitPercent(usage)}`;
}

function formatTableUsageSummary(summary, filePath, output) {
  const safePath = terminalCell(filePath, { fallback: "" });
  if (summary.requests === 0) return { output: `Usage log: ${safePath}\nNo usage records yet.`, overflow: false };
  const columns = [
    { key: "model", label: "MODEL" },
    { key: "records", label: "RECORDS", align: "right" },
    { key: "input", label: "INPUT", align: "right" },
    { key: "cacheRead", label: "CACHE READ", align: "right" },
    { key: "cacheWrite", label: "CACHE WRITE", align: "right" },
    { key: "output", label: "OUTPUT", align: "right" },
    { key: "total", label: "TOTAL", align: "right" },
  ];
  const compactColumns = [columns[0], columns[1], columns[6]];
  const modelUsage = Object.entries(usageModelGroups(summary))
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
  const writeOmitted = table.compact || table.overflow;
  if (writeOmitted) {
    columns.splice(columns.findIndex(column => column.key === "cacheWrite"), 1);
    table = formatResponsiveCliTable({ columns: [...columns, { key: "cacheHit", label: "HIT %", align: "right" }], compactColumns: columns, rows, width: cliOutputWidth(output), gap: 1 });
  }
  const rateFits = !table.compact;
  if (table.overflow) {
    table = formatResponsiveCliTable({ columns, compactColumns, rows, width: cliOutputWidth(output), gap: 1 });
  } else {
    table.compact = false;
  }
  const lines = [`Usage log: ${safePath}`, ...providerSummaryLines(summary), "", table.output];
  if (writeOmitted && !table.compact && Number.isFinite(totalUsage.cache_write_input_tokens)) {
    lines.push("", "Cache writes:", `TOTAL: ${tokenCount(totalUsage.cache_write_input_tokens)}`,
      ...modelUsage.filter(({ row }) => Number.isFinite(row.cache_write_input_tokens)).map(({ model, row }) => `${terminalCell(model)}: ${tokenCount(row.cache_write_input_tokens)}`));
  }
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
  provider = "",
} = {}) {
  const summary = await summarizeUsageLogs(filePath, { warn, provider });
  log(formatUsageSummary(summary, { filePath, format, output }));
}
