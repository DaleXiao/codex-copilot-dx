import { status } from "./status.mjs";
import {
  cliOutputFormat,
  cliOutputWidth,
  formatResponsiveCliTable,
  terminalCell,
} from "./cli-table.mjs";

export { fetchLiveCopilotModels, selectableCopilotModels } from "./live-models.mjs";

function safeText(value, fallback = "") {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function liveCatalogHeader(catalog, { commandName, models }) {
  const responses = models.filter((model) => model.endpoints.includes("responses")).length;
  const chat = models.filter((model) => model.endpoints.includes("chat")).length;
  return [
    `${commandName} models`,
    status("ok", `Live catalog from ${safeText(catalog?.upstreamHost, "GitHub Copilot")}: ${models.length} selectable GPT models of ${Number(catalog?.advertised) || 0} advertised`),
    status("info", `Responses: ${responses}; Chat: ${chat}`),
  ];
}

function formatLiveCopilotModelsPlain(catalog, { commandName, models }, { sanitize = false } = {}) {
  const lines = liveCatalogHeader(catalog, { commandName, models });
  if (!models.length) {
    lines.push(status("warn", "No selectable GPT models were advertised for this account"));
    return (sanitize ? lines.map((line) => terminalCell(line, { fallback: "" })) : lines).join("\n");
  }

  let vendor = "";
  for (const model of models) {
    if (model.vendor !== vendor) {
      vendor = model.vendor;
      lines.push("", `${vendor}:`);
    }
    const flags = [...model.endpoints, ...(model.preview ? ["preview"] : [])];
    lines.push(`  ${model.id} [${flags.join(", ")}]`);
  }
  return (sanitize ? lines.map((line) => terminalCell(line, { fallback: "" })) : lines).join("\n");
}

export function formatLiveCopilotModels(catalog, {
  commandName = "ccdx",
  format = "plain",
  output = process.stdout,
  width = cliOutputWidth(output),
} = {}) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const context = { commandName, models };
  if (cliOutputFormat(format, output) === "plain") {
    return formatLiveCopilotModelsPlain(catalog, context);
  }

  const lines = liveCatalogHeader(catalog, context);
  if (!models.length) {
    lines.push(status("warn", "No selectable GPT models were advertised for this account"));
    return lines.join("\n");
  }

  const rows = models.map((model) => ({
    vendor: model.vendor,
    model: model.id,
    vendorModel: `${model.vendor}/${model.id}`,
    apis: model.endpoints.join(", "),
    preview: model.preview ? "yes" : "no",
  }));
  const table = formatResponsiveCliTable({
    columns: [
      { key: "vendor", label: "VENDOR" },
      { key: "model", label: "MODEL" },
      { key: "apis", label: "APIS" },
      { key: "preview", label: "PREVIEW" },
    ],
    compactColumns: [
      { key: "vendorModel", label: "VENDOR/MODEL" },
      { key: "apis", label: "APIS" },
      { key: "preview", label: "PREVIEW" },
    ],
    rows,
    width,
  });
  if (format === "auto" && table.overflow) {
    return formatLiveCopilotModelsPlain(catalog, context, { sanitize: true });
  }
  lines.push("", table.output);
  return lines.join("\n");
}
