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

Final CI and publication receipts will be recorded after completion.
