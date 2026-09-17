# Edit a CCDX result

## Select the source

Use the specific image's returned `image_id` from this conversation, not a global last image. Resolve an ambiguous source before submitting the edit.

A file path is not an edit ID. Handles can expire after cache eviction, provider changes, or adapter restart while saved files remain viewable. For missing or expired handles, explain that this source is unavailable for editing; do not replace it.

## Submit and deliver

Call `ccdx_image.edit_image` with the exact ID and a prompt specifying changes and what to preserve. Omit `size` to preserve source dimensions unless another supported size was requested.

An explicitly unsupported edit must stop. Only an unavailable MCP tool may use [helper.md](helper.md), not a failed or timed-out edit.

Each edit preserves the source. Keep the new image/ID mapping alongside the original, and apply `SKILL.md`'s final-image delivery rules.
