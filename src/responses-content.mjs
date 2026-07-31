export function isResponsesToolOutputItem(item) {
  return item?.type === "function_call_output" || item?.type === "custom_tool_call_output";
}

const INLINE_IMAGE_DATA_URL = /^data:(image\/[a-z+.-]+);base64,(.+)$/i;

export function canonicalInlineImageIdentity(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = INLINE_IMAGE_DATA_URL.exec(dataUrl);
  if (!match) return null;
  const canonicalMime = match[1].toLowerCase();
  return match[1] === canonicalMime
    ? dataUrl
    : `data:${canonicalMime};base64,${match[2]}`;
}

function imageUrlAccessor(part) {
  if (!part || !["input_image", "image_url"].includes(part.type)) return null;
  if (typeof part.image_url === "string") return { owner: part, key: "image_url" };
  if (part.image_url && typeof part.image_url === "object" && typeof part.image_url.url === "string") {
    return { owner: part.image_url, key: "url" };
  }
  if (part.type === "image_url" && typeof part.url === "string") return { owner: part, key: "url" };
  if (part.type === "image_url" && part.url && typeof part.url === "object" && typeof part.url.url === "string") {
    return { owner: part.url, key: "url" };
  }
  return null;
}

export function readResponsesImagePart(part) {
  const accessor = imageUrlAccessor(part);
  if (accessor) {
    return {
      get dataUrl() {
        return accessor.owner[accessor.key];
      },
      get identity() {
        return canonicalInlineImageIdentity(accessor.owner[accessor.key]);
      },
      setDataUrl(value) {
        if (typeof value !== "string" || accessor.owner[accessor.key] === value) return false;
        accessor.owner[accessor.key] = value;
        return true;
      },
    };
  }

  if (part?.type !== "image" || part.source?.type !== "base64" || typeof part.source.data !== "string") {
    return null;
  }
  return {
    get dataUrl() {
      return `data:${part.source.media_type || "image/png"};base64,${part.source.data}`;
    },
    get identity() {
      return canonicalInlineImageIdentity(`data:${part.source.media_type || "image/png"};base64,${part.source.data}`);
    },
    setDataUrl(value) {
      const match = typeof value === "string" ? INLINE_IMAGE_DATA_URL.exec(value) : null;
      if (!match) return false;
      const mediaType = match[1].toLowerCase();
      const data = match[2];
      if (part.source.media_type === mediaType && part.source.data === data) return false;
      part.source.media_type = mediaType;
      part.source.data = data;
      return true;
    },
  };
}

export function readResponsesToolOutputParts(item) {
  if (!isResponsesToolOutputItem(item)) return null;
  if (Array.isArray(item.output)) return { parts: item.output, commit: null };
  if (typeof item.output !== "string" || !item.output.trim().startsWith("[")) return null;

  try {
    const parts = JSON.parse(item.output);
    if (!Array.isArray(parts)) return null;
    return {
      parts,
      commit: () => { item.output = JSON.stringify(parts); },
    };
  } catch {
    return null;
  }
}
