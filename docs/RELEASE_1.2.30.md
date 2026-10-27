# CCDX 1.2.30 candidate

## Changes

- GitHub directory reads in Model sources publish into the running model registry
  used by Codex candidates, endpoint routing and caches. New upstream models do
  not need a name whitelist. The UI refreshes candidates without discarding drafts.
- Catalog browsing never writes client configuration or changes selected models,
  defaults, grants or native sign-in. Failed reads retain the last-good directory
  and remain errors; account changes during a read prevent stale publication.
- A confirmed npm `EALLOWREMOTE` during a GitHub update restores the first
  installation, then permits one verified same-version platform-complete package
  attempt with offline dependency resolution and scripts disabled. Integrity,
  permission and other failures are not retried. npm-source updates keep their
  selected source. No registry, CA, proxy or persistent permission is changed.
- Nightly updates use the same complete-package validation in the candidate
  preparation phase, retaining existing idle/handoff/rollback checks and opt-in.
- Complete assets cover macOS/Windows ARM64/x64 and Linux ARM64/x64 glibc/musl.
  The normal npm/GitHub source tarball remains lightweight. The current bootstrap
  prefers a manifest-listed complete asset; old source-only releases keep the
  registry path. An old updater does not acquire new fallback behavior until
  updated; a blocked old installation can use the current verified bootstrap.

## Verification status

Candidate work is not published. Final exact-commit CI, platform package sizes,
isolated prior-version upgrade, native-client protections and publication receipts
will be recorded here after their gates pass. Existing local directory tests and
the policy-specific update tests pass; the Mac ARM64 packaging study is about
11.05 MiB compressed /28.28 MiB unpacked. Local strict npm12 fixture checks ran on
Node22.20 (below npm12's supported engine); supported Node24 platform CI remains
required and is not inferred from that local result.

No live model inference or current user-service replacement is part of these
checks. M365 admission/model-count differences remain separate investigations;
this release does not infer a cause or alter Microsoft authorization policy.
