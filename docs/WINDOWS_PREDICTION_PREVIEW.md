# Windows prediction candidate

`0.9.26-windows.3` is an unpublished test candidate, not a validated stable
Windows release. The existing macOS implementation remains covered by regression
tests. Prediction is still off by default and images retain their separate opt-in.

## Implemented boundary

- A Windows-specific module owns PowerShell/current-user process checks, official
  MSIX registration discovery, static system proxy lookup, OpenSSL discovery and
  NTFS private-key ACL validation.
- Transport, overlays, conversation-model selection, on/off, trust ownership,
  rollback and optional main-service isolation remain shared with macOS.
- Windows uses no MCP, Hook, renderer injection, client-program edit, system
  certificate installation, forced process exit or TLS-verification bypass.
- Unknown registration, archive protocol, profiles, ACLs, dynamic PAC/WPAD or
  unsupported routes fail safely. Automatic PAC/WPAD now has a candidate native
  WinHTTP worker; conflicting explicit proxy environment rules remain unsupported.
  Neither the existing network route nor core
  inference should be replaced by an unverified fallback.

## Evidence collected

- Windows user supplied official `OpenAI.Codex` version `26.1007.2314.0`, current
  Store signature kind `3` and status `0`. Its publisher is
  `CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B`; package family is
  `OpenAI.Codex_2p2nqsd0c76g0`. These identify the official package, not a user.
- Its manifest launches `app/ChatGPT.exe`; `codex-command-runner.exe` is a
  separate application and must not receive the composer route.
- The Windows read-only diagnostic confirmed the installed ASAR, product name
  `Codex`, package version `26.1007.21434` and both prediction protocol markers.
  Two package-local Codex directories exist under `LocalCache/Roaming` and
  `LocalCache/Local`; neither reported Chromium profile markers. No conclusion
  about active profile location or login state is drawn from their absence.
- The first diagnostic missed program path references because it searched only
  the main chunk and single/double-quoted string calls. Version 2 includes split
  startup chunks and template literals, with bounded, priority-ranked excerpts.
  Active profile/trust location and native UI behavior remain to be verified;
  a ready bridge is not assumed to mean a visible candidate.
- Version 2 confirmed the Windows bootstrap's explicit user-data override and
  default `appData/Codex` path helper. The roaming directory has a `web` child;
  the local directory has `Logs`, matching the separate Windows log-path helper.
  This does not establish where the running browser stores trust. A separate
  read-only runtime diagnostic checks related process names and bounded nested
  profile-marker locations without reading file contents or full command lines.
  The subsequent Windows diagnostic found `Local State` in
  `LocalCache/Roaming/Codex/web/Codex` and `Preferences`/`ServerCertificate` in
  its `Default` child. The candidate now checks this known nested layout as well
  as existing direct layouts, without recursively scanning user data. Multiple
  initialized profiles still fail safely instead of selecting one arbitrarily.
  Chromium runtime files exist; no WebView2 loader was found. The process report
  was empty, which is not proof that the App was closed or unable to run.
- Unchanged baseline: 1,086 tests passed, HTTP/SSE smoke, performance/resource
  gates and package checks passed.
- Candidate: 1,095 tests passed, zero failures, one Windows-only real ACL test
  explicitly skipped on this macOS host. Full HTTP/SSE, resource/performance,
  package and nine-scenario isolated startup replay passed. Default-off Windows
  tests prove no Windows probe or configuration write on that path.
- Real cryptography/SQLite lifecycle tests use Windows OS-check fixtures on
  macOS; they are not claimed as native Windows verification.
- Windows installation initially failed because the offline source tarball did
  not contain dependencies. Normal installation through the user's configured
  company registry succeeded. The current candidate requires OpenSSL; the user
  subsequently reached enabled preferences and a running bridge.
- The user confirmed App login. Live status reported the Windows candidate and
  an enabled/running bridge, but no configuration responses, modifications, TLS
  errors or upstream errors. The process check reported no prediction PAC
  parameter in any readable ChatGPT/Codex process. A subsequent complete App
  exit/relaunch still reported an unknown client route; process parameters have
  not yet been collected again after that relaunch. This does not distinguish
  a reused/forwarded launch from an App that received but ignored the route.
- The current Windows launcher treats the OS spawn event as successful launch;
  it does not verify the App's effective prediction route. A focused read-only
  diagnostic collects registered entry/dependencies, actual process paths,
  parent relationships, route flags, local PAC availability and error counters.
  It reads no full command lines into its output, credentials or transcripts.
- The subsequent launch report confirmed the registered App main process was
  created by the live CCDX PID and carried the exact live PAC URL. Its renderer,
  utility and crash handler children are not required to repeat that switch.
  The bridge then recorded 359 TLS client errors, zero configuration responses
  and zero upstream errors. Launch parameter delivery is now observed; the
  remaining failure is before a configuration HTTP response. The diagnostic
  shell was elevated, but neither service elevation nor its causal role is
  inferred from that shell flag. No official OpenAI documentation establishes
  an App-profile prediction trust integration on Windows.
- Chromium's current certificate metadata schema agrees with CCDX's trusted
  value and DNS constraint encoding. A matching schema does not prove the App
  loaded the record. A focused read-only trust check compares only the owned
  record in known certificate-store locations and exposes the already-redacted,
  bounded TLS error message. It does not read private keys or account content.
- The trust report found a matching owned CA in the saved MSIX profile, but no
  owned CA in the separately initialized ordinary roaming `Codex/web/Codex`
  profile. The latter's `Local State` was modified after the former's. The
  client reported TLS alert 46 (certificate unknown), with 610 TLS failures and
  zero configuration responses. The candidate now binds both native user data
  and Chromium storage to the verified existing profile on cold and reuse
  launches. It preserves explicit conflicting overrides and unrelated profiles.
  Windows off removes owned trust while retaining that verified profile binding,
  so reactivation does not guess between the two initialized directories.

## Remaining release gate

After profile binding, the user observed bootstrap HTTP 200 and the native
settings switch, but no gray candidate. The next runtime snapshot was a different
startup: bridge unavailable, with PAC/WPAD rejection and zero configuration
responses. The current candidate retains company PAC decisions and uses Windows
automatic upstream routing. A native-worker compilation/session test is included
in Windows CI; simulated protocol tests are not native Windows evidence.

The user has agreed to a Windows-machine check. Normal App login, profile discovery,
bridge startup and delivery of the live PAC to the registered main process have
been observed. Verify TLS after binding the original trusted profile, then test
native gray text, adoption,
normal reply, explicit off and preserved ordinary replies. Also confirm Windows
ACLs and upstream TLS with the actual runtime. Only then consider a stable release.

The temporary local preview and rollback tarballs do not represent an npm or
GitHub publication. Do not downgrade before disabling the preview's App trust.
Use the supplied exact stable rollback package; stable version checks do not
downgrade a preview automatically.

## Primary references

- [Official Windows app documentation](https://learn.chatgpt.com/docs/windows/windows-app)
- [Official MSIX deployment documentation](https://learn.chatgpt.com/docs/enterprise/windows-deployment)
- [Electron application data paths](https://www.electronjs.org/docs/latest/api/app#appgetpathname)
- [Chromium certificate database service](https://chromium.googlesource.com/chromium/src/+/main/components/server_certificate_database/server_certificate_database_service.cc)

Documentation and shared-component source establish implementation direction;
they do not prove that this Windows App displays a native prediction.
