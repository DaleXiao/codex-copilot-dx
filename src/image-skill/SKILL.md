---
name: ccdx-image
description: Generate raster images with the user's enabled CCDX provider, edit earlier CCDX results, or redisplay their saved images. Not for arbitrary uploaded-image edits, masks, transparent output, or code-native SVG/HTML assets.
---

# CCDX image generation

Use the user's enabled CCDX provider for supported image requests. Respect an explicitly requested different provider. CCDX supplies credentials and execution; no additional API key, Python, or SDK setup is needed.

## Select the operation

- **Generate:** Call `ccdx_image.generate_image` with a complete prompt. Supported sizes are `1024x1024`, `1536x1024`, and `1024x1536`; the default is square.
- **Edit:** Read [editing.md](references/editing.md) before calling `ccdx_image.edit_image`. Use the exact source `image_id` from this conversation; never substitute a different image or a fresh generation.
- **Redisplay:** Reuse the requested image's existing Markdown. Do not call generation or editing tools.

Use the MCP tool directly when callable. Otherwise, if tool search is available, make one targeted search for the relevant `ccdx_image` tool. Only if the MCP tool remains unavailable, read [helper.md](references/helper.md) for the bundled fallback. An explicitly unsupported edit or a failed tool call is not a reason to use the fallback.

## Deliver the result

Embed the returned saved-image Markdown unchanged in the final chat reply to display a clickable thumbnail. Image content in a tool result or a viewer call alone is not final delivery. Do not use a code block or replace the image with a download-only link.

Retain the image's Markdown/path together with its returned `image_id`, when present. Reuse that artifact for later redisplay. If saving failed, distinguish generation success from delivery failure: do not invent a path, claim display succeeded, or generate/edit again to repair delivery.

## Execution boundaries

- Do not automatically retry a failed or timed-out image request, switch providers, or run the helper afterward; the request may already have been processed.
- Preserve the host's approval policy. A user request to generate an image does not bypass execution permissions.
- Arbitrary uploaded-image edits, masks, reference-image inputs, and transparent output are outside this integration. Explain the limitation without substituting a different operation. Use another available workflow only when consistent with the user's request.
