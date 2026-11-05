import { terminalCell } from "./cli-table.mjs";
import { imageSetupSummary } from "./image-setup.mjs";
import { dashboardToolRequest, pauseServiceFeature } from "./cli-tools.mjs";
import { createImageDockControl } from "./codex-image-dock.mjs";

export async function runImageCommand({ action, model, output = process.stdout, home, env = process.env,
  adapterPort = 2026, adapterHost = "127.0.0.1", request = dashboardToolRequest } = {}) {
  const dockAction = ["dock-status", "dock-enable", "dock-disable", "dock-repair"].includes(action);
  if (!dockAction && !["status", "models", "enable", "disable", "select"].includes(action)) throw new Error("Choose image status, models, enable, disable, select or dock");
  const local = { home, env }, address = { port: adapterPort, host: adapterHost };
  if (["enable", "disable"].includes(action)) output.write(await pauseServiceFeature({ ...local, ...address, feature: "image", action: action === "enable" ? "resume" : "pause", request }) + "\n");
  let result;
  try {
    if (action === "select" && !model) throw new Error("Supply --id with an available image model ID");
    const data = await request({ ...address, path: "settings", timeoutMs: action === "status" ? 1000 : 5000,
      ...(dockAction ? { body: { action: "image", operation: action } } : action === "select" ? { body: { action: "image", operation: "select", model } } : {}) });
    result = data.features.image;
  } catch (error) {
    if (dockAction || ["models", "select"].includes(action)) throw error;
    result = { ...imageSetupSummary(local), dock: createImageDockControl(local).snapshot() };
  }
  output.write(`Native Codex images: ${!result.enabled ? "disabled" : result.configured ? "enabled" : "needs GitHub access"}\n`);
  output.write(`Image model: ${terminalCell(result.selected_model || "Automatic; catalog unavailable")}\n`);
  if (result.dock) output.write(`Dock automatic host: ${terminalCell(result.dock.state)}; chat tool loading is unconfirmed.\n`);
  if (dockAction) output.write("Affects this graphical login session, including other processes reading CODEX_CLI_PATH. Fully quit and reopen Codex, then use a new chat.\n");
  if (result.availability === "selected_unavailable") output.write("Saved image model is unavailable; choose an available model.\n");
  for (const item of result.models || []) output.write(`${item.id === result.selected_model ? "*" : " "} ${terminalCell(item.name || item.id)} (${terminalCell(item.id)})\n`);
  if (!result.models?.length) output.write("Read the GitHub catalog in Model sources or use source github models --refresh.\n");
  output.write("Uses Codex native host tools and the existing GitHub account. Start Codex through CCDX, then use a new chat.\n");
  return result;
}
