import { claudeModelEntries } from "../claude-models.mjs";
import { claudeEffortsExpressible } from "../model-capabilities.mjs";

export function claudeDeploymentId(model, route, { desktopEffortAliases = false } = {}) {
  const number = route.slice("ccdx/model-".length);
  const native = /^claude-(?:opus|sonnet|haiku)-\d[\d.-]*(?:-latest)?$/.test(model.id);
  // This host alias is used only when its contiguous effort menu is supported.
  // Both spellings remain accepted routes when capability evidence changes.
  return native ? `ccdx-${number}.anthropic.${model.id.replace(/(\d)\.(\d)/g, "$1-$2")}`
    : desktopEffortAliases && claudeEffortsExpressible(model.capability?.values) ? `mythos-ccdx-${number}` : `ccdx/claude-compatible-${number}`;
}

export function claudeRouteAliases(model, route, desktop) {
  const aliases = [{ desktopAliases: false }, { desktopAliases: true }].map(options => claudeModelEntries([{ ...model, client_id: undefined }], options)[0].name);
  if (desktop) {
    const number = route.slice("ccdx/model-".length);
    aliases.push(`mythos-ccdx-${number}`, `ccdx/claude-compatible-${number}`);
  }
  return aliases;
}
