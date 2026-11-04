import { configureImageSetup, imageSetupSummary } from "./image-setup.mjs";

export async function runImageCommand({ action, output = process.stdout, ...options } = {}) {
  if (!["status", "enable", "disable"].includes(action)) throw new Error("Unknown image command action");
  const result = action === "status" ? imageSetupSummary(options)
    : await configureImageSetup({ operation: action === "enable" ? "setup" : "remove" }, options);
  output.write(`Native Codex images: ${!result.enabled ? "paused" : result.configured ? "enabled" : "needs GitHub access"}\nProvider: GitHub Copilot\nModel: ${result.model}\n`);
  output.write(result.configured ? "Existing GitHub account configured; upstream access is verified when an image is requested.\n"
    : "Connect GitHub Copilot and allow Codex access.\n");
  output.write("Uses Codex's built-in image tool; no image API key, MCP or CCDX image skill is required.\n");
  if (result.retirement?.preserved) output.write("User-modified legacy image files were preserved; review them manually. The old image service is retired.\n");
  return { ...result, enabled: result.enabled && result.configured };
}
