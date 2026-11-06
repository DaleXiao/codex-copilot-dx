import { terminalCell } from "./cli-table.mjs";
import { imageSetupSummary } from "./image-setup.mjs";
import { dashboardToolRequest, pauseServiceFeature } from "./cli-tools.mjs";

export async function runImageCommand({ action, model, output = process.stdout, home, env = process.env,
  adapterPort = 2026, adapterHost = "127.0.0.1", request = dashboardToolRequest } = {}) {
  if (!["status", "models", "enable", "disable", "select", "check", "repair", "open"].includes(action)) throw new Error("Choose image status, models, enable, disable, check, repair, open or select --id MODEL");
  const local = { home, env }, address = { port: adapterPort, host: adapterHost };
  if (["enable", "disable"].includes(action)) output.write(await pauseServiceFeature({ ...local, ...address, feature: "image", action: action === "enable" ? "resume" : "pause", request }) + "\n");
  let result;
  try {
    if (action === "select" && !model) throw new Error("Supply --id with an available image model ID");
    const data = await request({ ...address, path: "settings", timeoutMs: action === "open" ? 210000 : action === "repair" ? 15000 : action === "status" ? 1000 : 5000,
      ...(["check", "repair", "open"].includes(action) ? { body: { action: "image", operation: action } } : {}),
      ...(action === "select" ? { body: { action: "image", operation: "select", model } } : {}) });
    result = data.features.image;
    if (data.last_operation?.feature === "image") output.write(JSON.stringify(data.last_operation.result, null, 2) + "\n");
  } catch (error) {
    if (["models", "select", "check", "repair", "open"].includes(action)) throw error;
    result = imageSetupSummary(local);
  }
  output.write(`Native Codex images: ${!result.enabled ? "disabled" : result.configured ? "enabled" : "needs GitHub access"}\n`);
  if (result.runtime) output.write(`App host: ${result.runtime.connected ? "connected" : "unconfirmed"}; chat tool: ${result.runtime.tool_registration}\n`);
  output.write(`Image model: ${terminalCell(result.selected_model || "Automatic; catalog unavailable")}\n`);
  if (result.availability === "selected_unavailable") output.write("Saved image model is unavailable; choose an available model.\n");
  for (const item of result.models || []) output.write(`${item.id === result.selected_model ? "*" : " "} ${terminalCell(item.name || item.id)} (${terminalCell(item.id)})\n`);
  if (!result.models?.length) output.write("Read the GitHub catalog in Model sources or use source github models --refresh.\n");
  output.write("Uses Codex native host tools and the existing GitHub account. Start Codex through CCDX, then use a new chat.\n");
  return result;
}
