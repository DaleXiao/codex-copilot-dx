import assert from "node:assert/strict";
import { test } from "node:test";
import { createImageReferenceStore } from "../src/image-references.mjs";

const config = { endpoint: "https://images.example/v1/images/generations", model: "qwen-image-3.0-pro", protocol: "qwen-messages", api_key: "fixture-secret" };
const image = { data: "aW1hZ2U=", mimeType: "image/png", size: "1536x1024" };

test("image references are immutable explicit handles bound to the provider", () => {
  const store = createImageReferenceStore();
  const id = store.remember(config, image);
  assert.match(id, /^ccdx_img_/);
  const source = store.resolve(config, id);
  assert.deepEqual(source, { image: "data:image/png;base64,aW1hZ2U=", size: "1536x1024" });
  source.image = "mutated caller";
  assert.equal(store.resolve(config, id).image, "data:image/png;base64,aW1hZ2U=");
  for (const field of ["endpoint", "model", "protocol", "api_key"]) {
    assert.throws(() => store.resolve({ ...config, [field]: "changed" }, id), /unavailable/);
  }
  assert.throws(() => store.resolve(config, "../../private.png"), /exact image_id/);
  assert.throws(() => createImageReferenceStore().resolve(config, id), /unavailable/);
});

test("image references are byte-bounded and cannot replace another image on a miss", () => {
  const store = createImageReferenceStore({ maxBytes: 300 });
  const first = store.remember(config, image);
  const second = store.remember(config, { ...image, data: "c2Vjb25k" });
  assert.ok(first && second && first !== second);
  assert.ok(store.stats().bytes <= 300);
  assert.throws(() => store.resolve(config, first), /unavailable/);
  assert.equal(store.resolve(config, second).image, "data:image/png;base64,c2Vjb25k");
  store.clear();
  assert.equal(store.stats().bytes, 0);
  assert.throws(() => store.resolve(config, second), /unavailable/);
  assert.equal(createImageReferenceStore({ maxBytes: 1 }).remember(config, image), null);
  assert.equal(store.remember(config, { ...image, data: "A".repeat(14 * 1024 * 1024) }), null);
});
