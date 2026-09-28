# CCDX 0.9.1 verification report

Date: 2026-09-28. Baseline: `63ead7e` (0.9.0).

## Scope

- Accept a provider-returned PNG, JPEG, or WebP base64 data URI as generated
  image bytes, including the observed Qwen `output.choices[].message.content[].image`
  response shape. Validate canonical encoding, size, and declared-versus-actual
  image type before delivery.
- Keep the existing HTTPS URL downloader and its SSRF, credential, deadline,
  and byte-limit safeguards unchanged. The original OpenAI base64 and edit
  input paths are unchanged.

## Verification

- Baseline `npm run verify` passed: 862 tests, offline HTTP smoke, benchmark
  gates, and package dry-run.
- A single pre-fix live request to the configured Qwen endpoint returned a
  `data:` URI in `content[0].image`; an offline fixture reproduced the exact
  `ccdx_image_url_unsafe` error. No returned image URL or API key was saved.
- Focused tests cover valid Qwen and standard data-URI fields, invalid and
  mismatched content, cancellation, existing HTTPS URL behavior, and unchanged
  rejection of unsafe URL schemes and embedded credentials.
- `npm run verify` passed: 865 tests, offline HTTP smoke, benchmark gates, and
  npm package dry-run. The package has 99 files, size 258,037 bytes, SHA-1
  `8a66f582011bfe02a5226f19e0ebb8488b33fd4f`.
- An isolated startup replay passed with zero real provider calls. One
  post-fix request to the configured Qwen provider returned a 1024×1024 PNG
  that CCDX accepted locally (407,569 bytes, one provider request, zero URL
  downloads); the returned image bytes were not saved or printed.

The benchmark gates show no detected regression in the existing probes, not a
claimed speed gain. The new validation runs only for `data:` image responses.

## Publication

- Release commit/tag: `32c8550` / `v0.9.1`.
- GitHub CI passed on Node 22.15.0 and 24.x, including configuration startup
  replay: https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36417971646.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.1.
- The one-shot npm workflow passed, including `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36418168361.
- npm accepted `codex-copilot-dx@0.9.1` under `latest`. The publish receipt's
  SHA-1 `8a66f582011bfe02a5226f19e0ebb8488b33fd4f`, 99 files, and 258.0 kB
  package match the local dry-run. Publication was not repeated.
- The configured Microsoft npm mirror still returned 404 immediately after
  publication; the official-registry publish receipt is the available
  publication evidence, not an independent download check from this machine.
