import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesHistoricalImageStats } from "../src/responses-byte-budget.mjs";
import {
  applyResponsesImagePressure,
  createResponsesImagePressureController,
  responsesImagePressureEligible,
} from "../src/responses-image-pressure.mjs";

function imageMessage(index, size = 128) {
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_image",
      image_url: `data:image/png;base64,${Buffer.alloc(size, index + 1).toString("base64")}`,
    }],
  };
}

function requestContext(historicalImages, current = [{ type: "message", role: "user", content: "continue" }]) {
  return {
    body: {
      model: "gpt-5.6-sol",
      stream: true,
      input: [
        ...Array.from({ length: historicalImages }, (_, index) => imageMessage(index)),
        ...structuredClone(current),
      ],
    },
    currentInputStart: historicalImages,
    historyRootId: "resp_root",
  };
}

test("adaptive image history skips serialization when no historical images exist", () => {
  const context = requestContext(0);
  const serializable = context.body;
  let serializations = 0;
  context.body = {
    ...serializable,
    toJSON() {
      serializations += 1;
      return serializable;
    },
  };

  const result = applyResponsesImagePressure(context);

  assert.equal(serializations, 0);
  assert.equal(result.adapted, false);
  assert.equal(result.initialBodyBytes, null);
  assert.equal(result.bodyBytes, null);
});

test("adaptive image history leaves the normal 24-image window byte-for-byte unchanged", () => {
  const context = requestContext(24);
  const before = JSON.stringify(context.body);

  const result = applyResponsesImagePressure(context);

  assert.equal(result.adapted, false);
  assert.equal(result.pressureEligible, false);
  assert.equal(JSON.stringify(context.body), before);
});

test("adaptive image history keeps current images and at most 16 recent historical images", () => {
  const current = [imageMessage(30), { type: "message", role: "user", content: "current text" }];
  const currentImage = current[0].content[0].image_url;
  const context = requestContext(25, current);

  const result = applyResponsesImagePressure(context);
  const stats = responsesHistoricalImageStats(context.body.input, context.currentInputStart);

  assert.equal(result.mode, "pressure");
  assert.equal(result.imagesOmitted, 9);
  assert.equal(Object.hasOwn(result, "bodyText"), false);
  assert.equal(stats.historicalImages, 16);
  assert.equal(stats.currentImages, 1);
  assert.equal(context.body.input.at(-2).content[0].image_url, currentImage);
  assert.equal(context.body.input.at(-1).content, "current text");
});

test("adaptive image history recovery mode uses the stricter 8-image window", () => {
  const context = requestContext(20);

  const result = applyResponsesImagePressure(context, { mode: "recovery" });

  assert.equal(result.mode, "recovery");
  assert.equal(result.imagesOmitted, 12);
  assert.equal(result.historicalImages, 8);
  assert.equal(result.currentImages, 0);
});

test("adaptive image history can trigger on body bytes without dropping current input", () => {
  const current = [imageMessage(20, 1024)];
  const currentImage = current[0].content[0].image_url;
  const context = requestContext(2, current);

  const result = applyResponsesImagePressure(context, {
    policy: {
      triggerHistoricalImages: 99,
      triggerBodyBytes: 1000,
      pressureHistoricalImages: 16,
      pressureBodyBytes: 1800,
    },
  });

  assert.equal(result.pressureEligible, true);
  assert.ok(result.imagesOmitted > 0);
  assert.equal(responsesHistoricalImageStats(context.body.input, context.currentInputStart).currentImages, 1);
  assert.equal(context.body.input.at(-1).content[0].image_url, currentImage);
});

test("image pressure eligibility is read-only and recovery-only application is a no-op before timeout", () => {
  const context = requestContext(25);
  const before = JSON.stringify(context.body);
  const controller = createResponsesImagePressureController();

  assert.equal(responsesImagePressureEligible(context), true);
  assert.equal(controller.isEligible(context), true);
  assert.equal(controller.applyRecovery(context), null);
  assert.equal(JSON.stringify(context.body), before);

  controller.markTimeout(context.historyRootId, { eligible: true });
  const recovery = controller.applyRecovery(context);
  assert.equal(recovery.mode, "recovery");
  assert.equal(recovery.historicalImages, 8);
});

test("image pressure recovery is isolated per history tree and clears after two successes", () => {
  const controller = createResponsesImagePressureController();
  assert.equal(controller.markTimeout("resp_a", { eligible: true }), true);

  const treeA = requestContext(10);
  treeA.historyRootId = "resp_a";
  const treeB = requestContext(10);
  treeB.historyRootId = "resp_b";

  assert.equal(controller.apply(treeA).historicalImages, 8);
  assert.equal(controller.apply(treeB).adapted, false);
  assert.equal(controller.snapshot().active_recovery_trees, 1);
  assert.equal(controller.markSuccess("resp_a"), false);
  assert.equal(controller.markSuccess("resp_a"), true);
  assert.equal(controller.snapshot().active_recovery_trees, 0);
});

test("image pressure recovery expires and remains bounded", () => {
  let timestamp = 0;
  const controller = createResponsesImagePressureController({
    now: () => timestamp,
    maxEntries: 2,
    recoveryTtlMs: 100,
  });
  controller.markTimeout("resp_a", { eligible: true });
  controller.markTimeout("resp_b", { eligible: true });
  controller.markTimeout("resp_c", { eligible: true });
  assert.equal(controller.snapshot().active_recovery_trees, 2);

  timestamp = 101;
  assert.equal(controller.snapshot().active_recovery_trees, 0);
});

test("image pressure cooperatively stops long synchronous scans", () => {
  const context = requestContext(256);
  const deadline = new Error("prepare deadline exceeded");
  let checks = 0;

  assert.throws(() => applyResponsesImagePressure(context, {
    assertActive() {
      checks += 1;
      if (checks === 4) throw deadline;
    },
  }), (error) => error === deadline);
  assert.equal(checks, 4);
});
