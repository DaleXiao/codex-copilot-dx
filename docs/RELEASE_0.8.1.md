# CCDX 0.8.1 verification report

Date: 2026-09-17. Baseline: `5f9b867` (0.8.0).

## Bounded scope

This patch addresses only chat image delivery and image-provider URL input.
It adds no image tools, commands, resource server, provider fallback, or model
routing changes. Image generation remains opt-in and disabled by default.

### Chat image delivery

The reported task had received valid image bytes, but its final replies did not
embed a usable image. Attempts to redisplay through editing dispatched new image
requests. A separate successful task demonstrated the desired existing Codex
UI path: a saved local image embedded as Markdown in the chat message.

Direct MCP generation/edit results now save the exact returned bytes and include
ready-to-use Markdown for the final chat reply. Original image content and edit
IDs remain present; no `structuredContent` is added. Output files use unique
names, exclusive creation, mode 0600, and asynchronous writes in a private image
directory. There is no image re-encoding or overwriting of earlier outputs.

Only successful writes produce file references. A failed write retains the
original image content and clearly distinguishes generation success from chat
delivery failure; it never retries the provider or invents a path. The updated
guidance requires an embedded chat thumbnail and reuses its existing Markdown
when asked to show the image again. Editing remains for actual requested changes.

The helper retains its stdout path/stderr image-ID contract and caller-selected
output location. It marks client-side saving in MCP request metadata so that
the adapter does not also write a duplicate image. Older clients remain accepted.

### Image API base URLs

`ccdx enable-image` accepts an HTTPS base URL as well as the existing complete
generation endpoint. A bare origin defaults to `/v1/images/generations`; a
specified base path is preserved and receives `/images/generations`. Existing
full endpoints remain unchanged. GET models and POST generation/protocol checks
are unchanged, including the one selected-model, prompt-free validation request.

Credentials, query strings, fragments, HTTP URLs, and known non-generation
operation endpoints are still rejected. There is no network endpoint search,
extra probe, automatic retry, or API protocol/model substitution.

## Review and tests

- One bounded independent source review found no blocking issue. Its duplicate
  helper-output observation was fixed, with focused format/cancellation tests
  added; no unrelated optimization or repeated review expansion followed.
- Complete `npm run verify` passed on Node 22.20.0: **765 tests, zero failures**,
  offline HTTP smoke, all existing performance/resource gates, and package
  dry-run. The first sandboxed invocation passed the same unit tests but could
  not bind the smoke-test loopback port; the full gate then passed with normal
  execution permission. No access policy was weakened.
- Installed `codex-cli 0.155.0-alpha.2.6` offline replay passed generation,
  editing, MCP discovery/reload, and saved-task restart/resume. Final messages
  must contain Markdown referencing the real saved image, not only image input
  in a tool result. An original-redisplay turn makes zero image tool calls and
  preserves both the image handle and file bytes.
- Real `gpt-5.6-sol` replay through the existing local adapter passed one
  generation, two edits, and original redisplay. Each actual image operation
  made exactly one fixture-provider call; redisplay made none. All final replies
  embedded the delivered image. Pixels were synthetic: no real image API used.
- A separate real-model missing-MCP replay passed helper generation and original
  redisplay. It saved exactly one file, created no duplicate adapter output,
  retained normal helper approval, and did not install SDKs or switch endpoints.
- Chat UI acceptance reused the reported task's already-generated 1024x1536 PNG
  through the patched delivery handler. Source and saved SHA-256 matched; no
  external image request was made. The user confirmed that the thumbnail was
  visible in this chat and could be opened at full size. Direct UI automation
  cannot control the Codex app on this host, so this final check is explicitly
  user-confirmed rather than claimed as an automated click assertion.

Generation-only providers, PNG/JPEG/WebP preservation, editing handles and source
sizes, concurrency limits, same-device sockets, browser-Origin rejection,
disabled/stale tools, secret redaction, helper failures, immutable originals,
directory symlinks, and cancelled delivery retain regression coverage. Existing
Fast/Auto-review, Responses/compaction, image-input, and animation checks remain
in the full gate; their implementation files were not changed.

## Performance and remaining boundaries

The existing gates measured adapter import at 37.9 ms / 58.1 MiB RSS, zero
reads while downstream was blocked, about 59 KiB retained image-optimization
heap growth, and zero retained ArrayBuffer growth. These are local measurements,
not latency guarantees. No image disk work is added to ordinary Responses or
disabled-image requests. One 1,560,620-byte local delivery sample took 15.4 ms
including the handler's save/serialization work, with no upstream generation.

Saved chat images persist locally across adapter restarts; they are not an
editing-reference cache or an additional read-image service. Existing edit IDs
retain their prior in-memory lifetime. Actual image generation is unchanged and
was not charged again for this release's validation. Base-path normalization
cannot discover arbitrary vendor-specific routes: users with a nonstandard API
prefix must include that prefix or keep supplying their existing full endpoint.
