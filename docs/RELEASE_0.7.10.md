# CCDX 0.7.10 verification report

Date: 2026-09-15. Baseline: `d434a27` (0.7.9).

## Editing generated images

The configured `qwen-image-3.0-pro` service was verified with one real edit:
a synthetic blue circle was changed to red while the green rectangle, black
line and layout were retained. The call took about 11 seconds and returned a
1024x1024 PNG. Pixel checks found 70,878 red pixels, 85,498 green pixels and
zero blue pixels; the output was also visually inspected. The test credential
was not logged or saved in test files.

CCDX now advertises `edit_image` for `qwen-image-3.0-pro` and
`qwen-image-3.0` with the supported Qwen Messages or OpenAI Images JSON dialect.
An edit supplies the previous result's explicit `image_id`, prompt and optional
size. Each request includes the original image, returns a new ID and preserves
the source. The tool never selects a global last image, reads arbitrary paths,
imports URLs, changes providers, or automatically repeats a failed edit.

References are scoped to the configured endpoint, model, protocol and
credential identity. Sources up to 10 MiB are retained in a process-local
64 MiB byte LRU; references expire on eviction or adapter restart and are
unavailable after a provider change. Restarting or resuming Codex while CCDX
remains running preserves references. Missing IDs fail before upstream work.
Images are still delivered if an edit reference cannot be retained.

Generation and editing share the existing two-operation concurrency limit,
cancellation, timeouts and download checks. The generated-image request shape
is unchanged for text-only use. Editing is opt-in through the existing image
provider setting; default image generation remains disabled. Other models
retain generation support without an unverified edit tool. Arbitrary uploads,
masks and transparent output remain outside this CCDX edit surface.

Both the MCP instructions and managed skill/helper support edits. The helper
adds `--image-id`, keeps stdout as the saved absolute file path, emits the new
ID on stderr, and writes a new file rather than overwriting an earlier image.
An installed-Codex test caught that `structuredContent` caused the client to
prefer an ID-only JSON result and lose native image content. The release uses
MCP metadata plus text for IDs and retains the original image blocks.

## Simultaneous terminal previews

`ccdx animation` now previews all nine effects in their menu rows while the
user enters a number. One shared timer samples the original frame timings;
the theme frame bytes, color palette, order and runtime activity indicator are
unchanged. A live selection ends immediately without an extra blocking cycle.

Small/unsupported terminals and animation opt-out keep static previews. Live
updates stop on resizing, clearing, wrapped input, backpressure or output
closure. Ctrl-C/Ctrl-D settle the prompt and release the timer. Review found
and fixed stale row anchors after a wrapped invalid answer.

## Verification

- Full `npm run verify`: **724 tests, zero failures**, offline HTTP smoke,
  performance/resource gates and an 84-entry npm package dry run on Node
  22.20.0.
- Nine real PTY scenarios cover live rows, numeric selection, invalid input,
  wrapped input, wrapped invalid submission, resize, clear, Ctrl-C/Ctrl-D and
  small-terminal fallback. Temporary settings were isolated from user settings.
- Installed Codex CLI 0.154.0-alpha.6.2 offline replay covered deferred tool
  discovery, generation, editing, saved-task restart/resume and a second edit
  while preserving native image results and exact source handles.
- Real `gpt-5.6-sol` chose the correct source in a natural-language
  generate-to-red-to-green sequence on both MCP and missing-MCP helper paths.
  Each path made one generation and two edits, one image call per turn.
  These model-selection tests used synthetic image results to avoid repeated
  paid image requests; normal host approval handling stayed enabled.
- Tests cover source immutability, cache bounds/eviction, changed credentials,
  unsupported providers, malformed IDs/images, failed-edit recovery without
  source loss, shared concurrency, default-off behavior and original-file
  preservation. Existing Responses/Fast/Auto-review/compaction tests remain
  green; no ordinary model-request route was changed.

One bounded final review found no remaining blocking code issue. Results
describe the tested client/model/service versions, not a guarantee about every
future upstream or client release.
