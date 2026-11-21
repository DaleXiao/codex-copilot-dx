# CCDX 1.4.16

- Duplicate Claude App health checks can share a successful result for 250 milliseconds. Messages rate-limit responses retain their error type and retry guidance.
- Usage rotation preserves verified compressed archives. The usage page shows actual retained dates and reports possible gaps in stored records.
- WebUI adds Grid paper, fits table columns to their content, and starts trend charts at the first retained date. WebUI and terminal labels use consistent wording for apps, sources, and request status.
- Antigravity records why incomplete replies ended. Restoring a model source ignores stale limit feedback, and a privacy status error no longer stops activity updates.

Unverified: native Claude startup against a live rate-limited source.
