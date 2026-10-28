# CCDX 1.2.32

## Changes

- Request-flow applications, counts and statuses share a right edge; source/model
  nodes keep their left edge. Mixed request counts use consistent wire anchors.
  Narrow screens retain the below-name counts, aligned to the application text.
- Chinese WebUI text has explicit sans-serif system fallbacks, including Microsoft
  YaHei on Windows. Latin monospace styling remains. Controls inherit the family;
  code and terminal samples use the same stack. No font downloads or dependencies.
- Settings adds the WebUI-only **Pure white** palette: pure white with black text
  and icons in light mode, inverted black in dark mode, with grayscale supporting
  tokens. Alerts keep their labels/icons. Existing persistence, cross-tab updates,
  automatic/manual save and pre-reset backup/restore include the new palette.
  The default green palette and independent terminal palettes remain.
- No changes to provider routing, model identity, credentials or client sync.
  Verification and publication leave the active local service untouched.

## Verification

Verification receipts will be completed before release.
