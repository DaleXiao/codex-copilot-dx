import { createHash } from "node:crypto";

const DISPOSITIONS = new Set(["native", "relay", "reject"]);
const MAX_AFFINITY_MODEL_BYTES = 512;

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Route plan ${name} is required`);
  return normalized;
}

export function createRoutePlan({
  disposition = "relay",
  model,
  origin,
  profile,
  protocol,
  surface,
} = {}) {
  if (!DISPOSITIONS.has(disposition)) {
    throw new Error(`Unsupported route disposition: ${disposition}`);
  }
  return Object.freeze({
    disposition,
    origin: requiredString(origin, "origin"),
    profile: requiredString(profile, "profile"),
    protocol: requiredString(protocol, "protocol"),
    model: requiredString(model, "model"),
    surface: requiredString(surface, "surface"),
  });
}

export function routePlanAffinity(plan) {
  if (!plan || typeof plan !== "object") return null;
  const { origin, profile, protocol, model } = plan;
  if (![origin, profile, protocol, model].every((value) => typeof value === "string" && value.length > 0)) {
    return null;
  }
  const boundedModel = Buffer.byteLength(model) <= MAX_AFFINITY_MODEL_BYTES
    ? model
    : `sha256:${createHash("sha256").update(model).digest("hex")}`;
  return Object.freeze({ origin, profile, protocol, model: boundedModel });
}

export function sameRoutePlanAffinity(left, right) {
  return Boolean(left && right)
    && left.origin === right.origin
    && left.profile === right.profile
    && left.protocol === right.protocol
    && left.model === right.model;
}
