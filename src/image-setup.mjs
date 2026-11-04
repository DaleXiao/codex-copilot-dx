import { readAuthProfileCredentials } from "./auth-profile.mjs";
import { readAccessSettings } from "./access-settings.mjs";
import { servicePreferences } from "./user-settings.mjs";
import { nativeImageAccess } from "./native-images.mjs";
import { imageModelSelection } from "./image-models.mjs";

export function imageSetupSummary(options = {}) {
  const configured = readAuthProfileCredentials("codex", options).valid && nativeImageAccess(options);
  const selection = imageModelSelection(options.models || [], readAccessSettings(options).clients.codex.image_model);
  return { configured, native: true, provider: "github", ...selection, model: selection.selected_model,
    enabled: servicePreferences(options).image_enabled,
    availability: !configured ? "needs_github_access" : !selection.models.length ? "no_models" : !selection.selected_available ? "selected_unavailable" : "ready" };
}

export async function configureImageSetup(input, options = {}) {
  if (!input || input.operation !== "select" || typeof input.model !== "string") throw new Error("Choose an image model; manual image API setup is retired");
  if (!options.providerRuntime) throw new Error("Start CCDX to choose a model from its GitHub catalog");
  const client = options.providerRuntime.connections().clients.find(client => client.id === "codex");
  await options.providerRuntime.manageConnections({ operation: "image_model", id: "codex", model: input.model, client_revision: client.revision });
  return imageSetupSummary({ ...options, models: options.providerRuntime.imageModels().models });
}
