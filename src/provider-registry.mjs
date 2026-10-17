import { isProviderId } from "./provider-metadata.mjs";

// Internal composition metadata, never a loader for third-party code.
export const PROVIDER_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "github", name: "GitHub Copilot", codex: true, modelSelection: false }),
  Object.freeze({ id: "m365", name: "Microsoft 365", codex: true, modelSelection: true }),
]);

export function createProviderRegistry(definitions = PROVIDER_DEFINITIONS) {
  const entries = new Map();
  if (!Array.isArray(definitions) || definitions.length > 16) throw new Error("Invalid source registry");
  for (const definition of definitions) {
    if (!isProviderId(definition?.id) || entries.has(definition.id) || typeof definition.name !== "string" || !definition.name.trim()) throw new Error("Invalid or duplicate source");
    entries.set(definition.id, Object.freeze({ ...definition }));
  }
  return Object.freeze({ get: id => entries.get(id), list: () => [...entries.values()] });
}

export const providerRegistry = createProviderRegistry();
