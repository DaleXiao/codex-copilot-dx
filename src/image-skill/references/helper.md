# MCP-unavailable fallback

Use only when MCP is unavailable, never after a failed, timed-out, or unsupported image operation. The helper calls the same local CCDX service at most once per execution.

## Invoke

Generate:

```sh
{{NODE}} {{HELPER}} --prompt 'A complete image prompt' --size 1024x1024
```

Edit an identified CCDX result:

```sh
{{NODE}} {{HELPER}} --image-id 'EXACT_SOURCE_IMAGE_ID' --prompt 'Requested changes and what to preserve'
```

For edits, follow [editing.md](editing.md); omitting `--size` preserves source dimensions. Replace the examples and quote actual arguments safely. Optional `--out` selects a new file; existing files are never overwritten.

Loopback HTTP can be restricted. If networking is restricted, request normal execution permission for this exact command before running it. Keep the host's approval policy unchanged.

## Interpret the result

- **Success:** stdout is the saved absolute path; stderr includes `CCDX image_id` when retained. Embed an absolute-path Markdown image in the final reply and retain its ID.
- **Explicitly not started:** No image operation was submitted. Resolve the reported connection/permission issue before another attempt.
- **Other failure or timeout:** Dispatch may have completed. Report without retrying, switching providers, or installing dependencies. Saving/display failure must not trigger regeneration.
