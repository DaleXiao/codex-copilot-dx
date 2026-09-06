# CCDX 0.7.7 verification report

Date: 2026-09-06. Baseline: `38cb8c4` (0.7.6).

## Terminal animations

The selector retains Comet, Twin, Shuttle, Chase, Mirror, and Pulse in their
original order, followed by Stack, Relay, and Split. All nine themes use the
same 20-column colon track and white/cyan/blue palette.

- Stack accumulates three short incoming trails, then releases the bundle.
- Relay passes a short trail between three fixed nodes, lighting each receiver.
- Split brings one trail to the center, then sends two trails outward.

The three additions match the user-approved previews frame for frame, including
color and per-frame delay. Their cycles take 4,655 ms, 3,760 ms, and 2,135 ms
respectively. The renderer calculates the requested frame without precomputing
frame tables or introducing dependencies, persistent animation state, or timers.

The original six themes retain their exact frame bytes, timing, order, and
start frames. The shared activity controller retains its 800 ms idle threshold,
TTY/CI/width/opt-out gates, log interruption, concurrent-request handling, and
cursor cleanup. Animations indicate activity rather than progress percentage.

## Braille upgrade behavior

Braille is removed from the catalog and cannot be selected or newly saved.
Reading an existing `terminal_animation: "braille"` uses the default Comet
without rewriting the settings file. Recognizing this retired value also
allows strict settings reads and unrelated model-setting writes to continue.

Selecting a new theme replaces the retired value; explicitly selecting Comet
removes the animation override. Enter keeps the effective default and q cancels,
both without editing the file. Unrelated settings remain intact. Other invalid
values still block writes as before.

## Verification

Playback snapshots independently captured from 0.7.6 and the accepted previews
are compared against complete ANSI frame and timing sequences. Tests also cover
numeric selection, persistence, old Braille settings, full activity cycles,
concurrent requests, log interruption, cursor restoration, and menu/documentation
agreement.

- Full `npm run verify` passed locally on Node 26.3.0: **662 tests, 0 failures**,
  offline HTTP smoke, performance/resource checks, and a 74-entry npm package
  dry run.
- Real PTY subprocess checks selected each new theme from an old Braille
  configuration, played every preview frame, saved the selected value, and
  exited successfully while preserving the unrelated setting. These checks
  used isolated temporary homes and did not launch Codex or the adapter.
- A local rendering sample of 10,000 frames per theme measured about 3
  microseconds per frame for the additions, including delay lookup and excluding
  terminal I/O. This is a local observation, not a cross-platform performance
  guarantee. No live Copilot inference was required for this animation change.
- Publishing is gated on the existing GitHub CI matrix for Node 22.15.0 and
  24.x, followed by the existing npm publishing workflow.
