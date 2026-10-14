# CCDX 0.9.33: six improvements with publication-environment compatibility

This stable delivery includes all six optimizations and bounded verification
described in [the six-batch audit](RELEASE_0.9.32.md).

The 0.9.32 npm prepublish gate exposed an additional environment-specific issue:
setup-node's npm authentication configuration emits an `always-auth` warning
with current npm. `execFileSync`'s implicit stderr handling let that readonly
prefix-probe warning escape into the main CLI, breaking three existing quiet
doctor assertions. The 0.9.32 npm package was never uploaded; its GitHub release
is retained as a prerelease rather than rewriting a published tag.

The correction explicitly captures stdout and stderr for the prefix probe only.
Probe errors still yield unavailable diagnostic evidence; install failures and
the real installer's inherited output remain unchanged. The regression test
asserts this process boundary. No inference, prediction, image or network-routing
policy is changed by the correction.

## Final verification

Candidate commit `76a81ce3b45b921d3ac1cb2c39c8b6ee3318bb57` passed all eight
[CI jobs](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38494082387).
Linux and macOS Node 22.15/24 each passed 1,168 tests with eight Windows-only
skips; Windows Node 22.15/24 each passed 229 tests, including actual NTFS and
updater-process assertions. Every platform installed 0.9.31 and upgraded to
0.9.33 in an owned temporary prefix; installed sharp worked on Linux/Windows
x64 and macOS arm64. Official Codex synthetic replays passed. All 16
Chromium/WebKit, English/Chinese, light/dark, 420/1280-width browser cases passed.
No live provider calls were used for these proofs. The three targeted quiet
doctor regressions also passed locally after the process-stream fix.

Existing performance/resource gates passed in candidate CI and npm prepublish
verification. The six-batch baseline report documents sample variation instead
of claiming a universal speedup. Existing prediction App/PAC route and visible
candidate behavior were not reclassified as manually live-tested by these jobs.

## Publication receipts

- Stable [GitHub release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.33)
  and tag `v0.9.33` target the candidate commit above. GitHub latest returned
  `v0.9.33`; the release is neither draft nor prerelease.
- [npm publication](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38494268138)
  succeeded with `+ codex-copilot-dx@0.9.33` and tag `latest` after 1,168 passing
  tests, zero failures and all offline/performance/package gates.
- GitHub asset and npm artifact: `codex-copilot-dx-0.9.33.tgz`, 359,178 bytes,
  141 files, SHA-1 `4e9ec582f05f842820ed75e77938e90b44c5dd95`.
  The local package and npm's publish receipt have the same hash.
- GitHub operations used the previously provided PAT, with no credential bytes
  printed or written to files. npm used the existing repository publish secret.

The publication receipt commit changes only this report; runtime/package bytes
remain identical to the validated tag. Cleanup removes only this task's
temporary packages/logs/helper and merged candidate branches. Existing user
configuration, running services and working dependencies are preserved.
