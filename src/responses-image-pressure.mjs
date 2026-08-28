import {
  responsesHistoricalImageStats,
  trimResponsesHistoricalImages,
} from "./responses-byte-budget.mjs";

const MIB = 1024 * 1024;

export const DEFAULT_RESPONSES_IMAGE_PRESSURE_POLICY = Object.freeze({
  triggerHistoricalImages: 24,
  triggerBodyBytes: 18 * MIB,
  pressureHistoricalImages: 16,
  pressureBodyBytes: 16 * MIB,
  recoveryHistoricalImages: 8,
  recoveryBodyBytes: 10 * MIB,
});

function normalizedPolicy(policy = {}) {
  return { ...DEFAULT_RESPONSES_IMAGE_PRESSURE_POLICY, ...policy };
}

function bodyPayload(body, assertActive) {
  assertActive?.();
  const bodyText = JSON.stringify(body);
  assertActive?.();
  return { bodyText, bodyBytes: Buffer.byteLength(bodyText) };
}

export function responsesImagePressureEligible(reqContext, {
  assertActive,
  policy: policyOverrides,
} = {}) {
  const policy = normalizedPolicy(policyOverrides);
  const currentInputStart = Number.isFinite(reqContext?.currentInputStart)
    ? reqContext.currentInputStart
    : 0;
  const images = responsesHistoricalImageStats(reqContext?.body?.input, currentInputStart, { assertActive });
  if (images.historicalImages === 0) return false;
  if (images.historicalImages > policy.triggerHistoricalImages) return true;
  return bodyPayload(reqContext?.body, assertActive).bodyBytes > policy.triggerBodyBytes;
}

export function applyResponsesImagePressure(reqContext, {
  assertActive,
  mode = "normal",
  policy: policyOverrides,
} = {}) {
  const policy = normalizedPolicy(policyOverrides);
  const body = reqContext?.body;
  const currentInputStart = Number.isFinite(reqContext?.currentInputStart)
    ? reqContext.currentInputStart
    : 0;
  assertActive?.();
  const initialImages = responsesHistoricalImageStats(body?.input, currentInputStart, { assertActive });
  if (initialImages.historicalImages === 0) {
    return {
      mode: "normal",
      pressureEligible: false,
      adapted: false,
      imagesOmitted: 0,
      initialBodyBytes: null,
      bodyBytes: null,
      initialHistoricalImages: 0,
      historicalImages: 0,
      currentImages: initialImages.currentImages,
      overBudget: false,
      overImageBudget: false,
    };
  }

  const initial = bodyPayload(body, assertActive);
  const pressureEligible = initialImages.historicalImages > 0 && (
    initialImages.historicalImages > policy.triggerHistoricalImages
      || initial.bodyBytes > policy.triggerBodyBytes
  );
  const recovery = mode === "recovery";
  const maxHistoricalImages = recovery
    ? policy.recoveryHistoricalImages
    : policy.pressureHistoricalImages;
  const targetBytes = recovery ? policy.recoveryBodyBytes : policy.pressureBodyBytes;
  const shouldAdapt = initialImages.historicalImages > 0 && (recovery
    ? initialImages.historicalImages > maxHistoricalImages || initial.bodyBytes > targetBytes
    : pressureEligible);

  if (!shouldAdapt) {
    return {
      mode: "normal",
      pressureEligible,
      adapted: false,
      imagesOmitted: 0,
      initialBodyBytes: initial.bodyBytes,
      bodyBytes: initial.bodyBytes,
      initialHistoricalImages: initialImages.historicalImages,
      historicalImages: initialImages.historicalImages,
      currentImages: initialImages.currentImages,
      overBudget: false,
      overImageBudget: false,
    };
  }

  const trimmed = trimResponsesHistoricalImages(body, {
    assertActive,
    currentInputStart,
    maxHistoricalImages,
    targetBytes,
    initialBodyText: initial.bodyText,
    initialBodyBytes: initial.bodyBytes,
  });
  const { bodyText: _bodyText, ...trimmedResult } = trimmed;
  return {
    mode: recovery ? "recovery" : "pressure",
    pressureEligible: pressureEligible || recovery,
    initialBodyBytes: initial.bodyBytes,
    initialHistoricalImages: initialImages.historicalImages,
    ...trimmedResult,
  };
}

export function createResponsesImagePressureController({
  now = Date.now,
  maxEntries = 256,
  recoveryTtlMs = 10 * 60 * 1000,
  successesToClear = 2,
  policy: policyOverrides,
} = {}) {
  const policy = normalizedPolicy(policyOverrides);
  const recovery = new Map();
  const counters = {
    adaptedRequests: 0,
    imagesOmitted: 0,
    recoveryActivations: 0,
    timeoutsRecorded: 0,
  };

  const prune = () => {
    const timestamp = now();
    for (const [rootId, state] of recovery) {
      if (state.expiresAt <= timestamp) recovery.delete(rootId);
    }
    while (recovery.size > maxEntries) recovery.delete(recovery.keys().next().value);
  };

  const modeFor = (rootId) => {
    prune();
    return rootId && recovery.has(rootId) ? "recovery" : "normal";
  };

  return Object.freeze({
    apply(reqContext, { assertActive } = {}) {
      const result = applyResponsesImagePressure(reqContext, {
        assertActive,
        mode: modeFor(reqContext?.historyRootId),
        policy,
      });
      if (result.adapted) {
        counters.adaptedRequests += 1;
        counters.imagesOmitted += result.imagesOmitted;
      }
      return result;
    },
    isEligible(reqContext, { assertActive } = {}) {
      return responsesImagePressureEligible(reqContext, { assertActive, policy });
    },
    applyRecovery(reqContext, { assertActive } = {}) {
      if (modeFor(reqContext?.historyRootId) !== "recovery") return null;
      const result = applyResponsesImagePressure(reqContext, {
        assertActive,
        mode: "recovery",
        policy,
      });
      if (result.adapted) {
        counters.adaptedRequests += 1;
        counters.imagesOmitted += result.imagesOmitted;
      }
      return result;
    },
    markTimeout(rootId, { eligible = false } = {}) {
      if (!rootId || !eligible) return false;
      prune();
      const existing = recovery.get(rootId);
      recovery.delete(rootId);
      recovery.set(rootId, { expiresAt: now() + recoveryTtlMs, successes: 0 });
      counters.timeoutsRecorded += 1;
      if (!existing) counters.recoveryActivations += 1;
      prune();
      return true;
    },
    markSuccess(rootId) {
      if (!rootId) return false;
      prune();
      const state = recovery.get(rootId);
      if (!state) return false;
      state.successes += 1;
      if (state.successes >= successesToClear) {
        recovery.delete(rootId);
        return true;
      }
      return false;
    },
    clear(rootId) {
      return rootId ? recovery.delete(rootId) : false;
    },
    snapshot() {
      prune();
      return {
        active_recovery_trees: recovery.size,
        adapted_requests: counters.adaptedRequests,
        historical_images_omitted: counters.imagesOmitted,
        recovery_activations: counters.recoveryActivations,
        timeouts_recorded: counters.timeoutsRecorded,
        recovery_ttl_ms: recoveryTtlMs,
        pressure_image_limit: policy.pressureHistoricalImages,
        recovery_image_limit: policy.recoveryHistoricalImages,
      };
    },
  });
}
