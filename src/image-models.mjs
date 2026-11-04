import { modelDisplayName } from "./model-display.mjs";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-flare";
const paths = { generations: ["/images/generations", "/v1/images/generations"], edits: ["/images/edits", "/v1/images/edits"] };
export function isImageModel(model) {
  return model?.capabilities?.type === "image";
}
export function imageModelCatalog(value) {
  const models = Array.isArray(value) ? value : value?.data;
  if (!Array.isArray(models)) return [];
  return models.filter(model => isImageModel(model) && Array.isArray(model.supported_endpoints) && paths.generations.some(path => model.supported_endpoints?.includes(path)) && (!model.policy?.state || model.policy.state === "enabled")
    && typeof model.id === "string" && model.id.length > 0 && model.id.length <= 200 && !/[\x00-\x1f\x7f]/.test(model.id))
    .map(model => ({ id: model.id, name: modelDisplayName(model), source: "github", kind: "image",
      editing: paths.edits.some(path => model.supported_endpoints?.includes(path)) }));
}
export function imageModelSelection(models, saved) {
  const selected = saved || models.find(model => model.id === DEFAULT_IMAGE_MODEL)?.id || models[0]?.id || null;
  return { models, selected_model: selected, selection_source: saved ? "saved" : "default",
    selected_available: Boolean(selected && models.some(model => model.id === selected)) };
}
