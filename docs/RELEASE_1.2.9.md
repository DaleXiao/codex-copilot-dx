# CCDX 1.2.9

This report records the WebUI layout and information-architecture release. All
account, model and browser replay data is synthetic; passing checks do not prove
every enterprise account's access or every physical device's behavior.

## Changes

- Keeps the existing eight navigation entries, SVG icons, atom logo, Classic
  green/Klein blue/Soft pink palettes and independent terminal appearance.
- Fixes header movement between modules: explicit grid tracks reserve the header
  height, body content receives spare space, and scrollbar space stays stable.
  The opaque themed header sticks after reaching the viewport top. Narrow
  screens use a deliberate two-row toolbar. Navigation resets scroll and focuses
  main content; refreshes preserve the user's position.
- Gives each page a purpose description and associates update times with their
  own data resources. Automatic data refresh is labeled separately from software
  updates. Failed settings actions report beside the affected controls.
- Groups Overview by application and its explicitly selected source, while the
  source card still lists every registered source, including disabled ones. An
  unavailable selected source is not silently replaced by another source.
- Separates Codex buffer maintenance from request performance. Prediction keeps
  its normal switch visible and detailed evidence/repair together. Image setup,
  pause behavior, buffer cleanup confirmation and limits remain available.
- Shows Claude App/Code setup separately and labels combined Messages metrics.
  A local gateway running is not reported as proof that an app is open.
- Keeps account controls, catalogs and access details scoped to the selected
  source. Management shortcuts browse the existing source page without changing
  routing or starting sign-in/account discovery.
- Places usage controls beside their actual scope: source for the whole page,
  model for both charts, range/view for daily trends and measure for the annual
  calendar. Retained-history totals and selected-day totals remain distinct.
  Trends still load on demand; bar/line animation and partial/unknown counts stay
  intact.
- Opens recent requests by default, shows time/source/model/outcome/input, and
  folds the original payload/image/window observations into bounded row details.
  Expanded observations survive unchanged reads and new retained requests. Hidden
  request views defer row rebuilding.
- Moves memory, queues, notices, raw HTTP traffic and body caps into Checks &
  repairs. Settings contains appearance, startup and version/update guidance.
  Existing local checks, network inspection, repair previews and report export
  remain available with their original security boundaries.

No inference, authentication, provider-routing or installer implementation is
changed. There is no new runtime dependency, endpoint, model probe or log scan.
The version is a patch increment from 1.2.8; both bootstrap scripts pin 1.2.9.

## Verification

A static layout replay using the verified 1.2.8 package assets reproduced the
bug at 1280×900: header heights ranged from 76 to 202.52 px between modules. With
the candidate assets, all eight header heights were 76 px, controls began at
21.5 px and page titles at 108 px. This isolates layout behavior, not a real
account/service session.

Local `npm run verify` passed **1,456 tests: 1,447 passed, 9 platform/optional
skips, zero failures**, plus HTTP smoke, SSE idle, performance/resource gates and
package checks. Its first pass caught the README's existing 130-line limit;
the documentation was shortened without relaxing the check.

Chromium/WebKit passed **48** palette/mode/language/viewport cases. Regression
coverage includes long/short module transitions, header stickiness, scroll
preservation, selected-source access rows, grouped app rows, account recovery,
repair, scoped usage controls, chart motion, failed-save rollback, last-good
data and hidden-page scheduling. A focused final replay additionally checks
that arriving requests retain expanded details and save errors stay local.
Browser fixtures were updated to open the newly folded performance groups and
select the intended source explicitly; existing access and network checks remain.
The first CI pass exposed a test race in the new rejected-save check: WebKit saw
the intended immediate rollback before Playwright's `setChecked` postcondition.
The test now clicks the switch and asserts the refusal, restored value and local
error scope directly. The production rollback and assertions were not relaxed.

The isolated **1.2.8 → 1.2.9** real npm upgrade used the verified prior tarball
(`5867eeb4f83d05bd516c2a958dcddf551183d37e036b29635b0dfedebd2a8648`).
The installed CLI version, sharp and supported Microsoft broker loaded on
macOS arm64. No-Git installation with existing/missing Node and corrupt-download
retention passed; configured CONNECT proxy/private CA replay kept TLS strict,
offline behavior and registry credentials unchanged.

Cross-platform CI and publication receipts are added after delivery. The local
checks above do not substitute for Windows/Linux execution or real model calls.
