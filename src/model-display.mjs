// Presentation never changes a model's upstream or client routing identity.
export function modelDisplayName(model) {
  for (const key of ["display_name", "name", "id"]) {
    const value = model?.[key];
    if (typeof value === "string" && value.trim() && value.length <= (key === "display_name" ? 400 : 160)
      && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) return value.trim();
  }
  return model?.id || "";
}
