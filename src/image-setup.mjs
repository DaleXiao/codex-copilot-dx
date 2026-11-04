import { readAuthProfileCredentials } from "./auth-profile.mjs";
import { servicePreferences, writeServicePreference } from "./user-settings.mjs";
import { NATIVE_IMAGE_MODEL, nativeImageAccess } from "./native-images.mjs";
import { retireLegacyImages } from "./image-retirement.mjs";

export function imageSetupSummary(options = {}) {
  const configured = readAuthProfileCredentials("codex", options).valid && nativeImageAccess(options);
  return { configured, native: true, provider: "github", model: NATIVE_IMAGE_MODEL,
    enabled: servicePreferences(options).image_enabled, availability: configured ? "upstream_authoritative" : "needs_github_access" };
}

export async function configureImageSetup(input, options = {}) {
  if (!input || Object.keys(input).some(key => !["action", "operation"].includes(key))) throw new Error("Native images use the existing GitHub account; image API addresses and keys are retired");
  if (!["setup", "remove"].includes(input.operation)) throw new Error("Choose image setup or remove");
  const retirement = retireLegacyImages(options);
  writeServicePreference("image_enabled", input.operation === "setup", options);
  return { ...imageSetupSummary(options), retirement };
}
