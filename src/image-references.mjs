import { createHash, randomUUID } from "node:crypto";
import { createByteLruCache } from "./bounded-result-cache.mjs";
import { IMAGE_INPUT_MAX_BYTES } from "./image-provider.mjs";

const IMAGE_ID = /^ccdx_img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function providerScope(config) {
  return createHash("sha256").update(JSON.stringify([
    config.endpoint, config.model, config.protocol, config.api_key,
  ])).digest("hex");
}

export function createImageReferenceStore({ maxBytes = 64 * 1024 * 1024 } = {}) {
  const cache = createByteLruCache({ maxBytes });
  return {
    remember(config, image) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(image?.mimeType)
        || typeof image?.data !== "string" || !image.data
        || image.data.length > Math.ceil(IMAGE_INPUT_MAX_BYTES / 3) * 4
        || Buffer.byteLength(image.data, "base64") > IMAGE_INPUT_MAX_BYTES) return null;
      const imageId = `ccdx_img_${randomUUID()}`;
      const retained = cache.set(`${providerScope(config)}:${imageId}`, JSON.stringify({
        image: `data:${image.mimeType};base64,${image.data}`,
        size: image.size,
      }));
      return retained ? imageId : null;
    },
    resolve(config, imageId) {
      if (typeof imageId !== "string" || !IMAGE_ID.test(imageId)) {
        throw new Error("Provide the exact image_id returned by CCDX for the image to edit.");
      }
      const value = cache.get(`${providerScope(config)}:${imageId}`);
      if (value === undefined) {
        throw new Error("This image reference is unavailable: the adapter restarted, the image was evicted, or the provider changed. No edit was submitted.");
      }
      return JSON.parse(value);
    },
    clear() { cache.clear(); },
    stats() { return cache.stats(); },
  };
}
