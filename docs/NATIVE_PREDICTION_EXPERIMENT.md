# Native prediction experiment — 2026-10-11

**2026-10-12 update:** this is the historical prototype record. The subsequent
0.9.24 candidate now implements the optional bridge, on/off lifecycle and legacy
MCP retirement. Real-account configuration forwarding, successful live refresh,
real Copilot inference, private profile trust and bounded regression checks are
recorded in [the release report](RELEASE_0.9.24.md). Earlier statements below
about missing production code refer to the earlier experiments, not that candidate.

Latest result: the domain-limited bridge and the native composer now passed the
same isolated end-to-end test, including disabling the overlay. This is a
synthetic-account/model prototype, not a production integration or release gate.
See **Joined native MVP verification** below.

## Verified result

The installed, signed desktop App 26.1007.30912 displayed its native Show
predictions setting and native grey composer suggestion in an isolated profile.
The user confirmed all three UI checks:

1. Show predictions appeared in Settings → General.
2. A completed local test reply automatically produced the grey suggestion
   `帮我列出具体步骤。` in the native composer.
3. Adopting and sending it produced an ordinary user message and test reply.

The test service observed the App initiate a prediction request after the parent
reply, using `gpt-6.1-sol`. A further prediction request followed the adopted
message's reply. No CCDX suggestion MCP or Hook was registered in this profile.
The model endpoint used the current CCDX request handler with a synthetic upstream.
All inference and account/config responses were test fixtures, not live account
entitlements or user conversations. The App's unrelated built-in connector requests
were not implemented by the fixture; those are not part of this success claim.

## Mechanism

- `CODEX_HOME` and `CODEX_ELECTRON_USER_DATA_PATH` selected fresh disposable data
  directories. The installed App executable and packaged assets were used as-is.
- `CODEX_API_BASE_URL` selected the localhost desktop API fixture.
- The fixture provided the ordinary post-login `/wham/statsig/bootstrap` response
  and `/wham/predictions/config` response. The bootstrap carried the prediction
  gate and the exact synthetic identity used by the isolated runtime.
- The runtime required an HTTPS workspace backend. A test CA with localhost-only
  name constraints was supplied to the CLI via its process CA configuration.
- Chromium's profile-scoped `ServerCertificate` store held the same constrained
  test CA in the fresh experimental profile. This allowed the App's actual desktop
  HTTPS requests to reach the fixture without installing an OS/keychain root or
  disabling certificate validation.
- Native App code performed prediction generation, grey-text rendering, adoption
  and sending. No renderer injection, client package patch or MCP draft write was
  used.

Chromium's storage format and profile ownership were checked against its official
source and the installed framework's schema strings:

- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/server_certificate_database/server_certificate_database.cc
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/server_certificate_database/server_certificate_database.proto
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/net/server_certificate_database_service_factory.cc

No permission to change the real user's certificate store or proxy settings was
inferred from this disposable-profile experiment. Production use would require a
separate configuration/migration design.

## Corrected findings

An earlier conclusion that Statsig could only initialize from `ab.chatgpt.com` was
incomplete: authenticated desktop startup also loads a payload from
`/wham/statsig/bootstrap` through the desktop API route.

The earlier live-refresh fixture omitted `experiments` from `live_entity_names`,
causing the real SDK to reject the overlay. With the complete shape, bundled
Statsig 3.34.0 successfully replaces a true bootstrap prediction gate with a false
live value while leaving an unrelated gate unchanged. Thus bootstrap-only control
does not establish persistent enablement under normal successful remote refresh.

An HTTP localhost development endpoint still failed the current runtime's HTTPS
workspace-routing requirement. Separate desktop/CLI base URLs also do not avoid
workspace URL rewriting. CLI-only CA trust was insufficient for desktop Chromium;
profile-scoped Chromium trust is the newly verified path.

## Scope and remaining gates

This is a successful native UI prototype, not a released native prediction feature.
External traffic was deliberately denied in the disposable environment. Consequently
it does not prove compatibility with normal successful Statsig refresh, real login,
account switching, connectors, device registration, remote/cloud tasks, App updates,
or existing user profiles. The fixture also did not preserve a full real bootstrap
payload because it never accessed one.

Before a production change: preserve all unrelated configuration and upstream
responses; establish a bounded prediction-only mechanism across successful refresh;
test certificate-store lifecycle with the App closed; verify rollback, multiple
profiles and supported platforms; measure startup/foreground overhead. Do not ship
global refresh blocking, TLS-error-ignore flags, broad trust, or blanket upstream
response replacement as the solution.

## Productization preflight

A further bounded replay used the installed App's bundled Statsig 3.34.0, with
synthetic responses and no network access. All three checks passed:

1. A successful live refresh changes a true bootstrap prediction gate to false.
2. Changing only the prediction gate in the refresh response keeps predictions on
   while unrelated gates and dynamic configuration adopt their new upstream values.
3. Passing the next response through unchanged restores the upstream prediction
   state, without stopping other refreshes.

This verifies the response-overlay boundary, not the production transport.
Delta-response checksums, identity changes and full initialization still need their
own transport/replay coverage before shipping.

Chromium's `net/base/host_mapping_rules.cc` supports mapping a single hostname and
port to a different address and port. This offers a possible alternative to a
global proxy. A 30-second launch of the unmodified App in another empty disposable
profile produced no configuration requests, so that launch is **inconclusive** for
actual App routing. It is not evidence that the hostname route works or fails.

The remaining design decision is security-sensitive: stable native enablement
needs to affect desktop configuration traffic outside the existing CCDX model API.
An application-scoped network mount would terminate and forward the selected HTTPS
traffic locally and require profile-scoped certificate trust. It must not silently
replace existing proxy/PAC settings, intercept unrelated domains, retain account
credentials, or change OS trust. The disposable-profile authorization does not
authorize those changes to the real profile. User approval of that boundary and
real-account compatibility/rollback validation remain pending. No production native
prediction command or startup hook has been added, and no release is ready yet.

## Minimal routing verification

The next bounded experiment tested routing instead of assuming that all traffic
must be proxied. Installed Chrome and the installed Codex Framework both report
Chromium **155.0.8059.40**. Two headless Chrome runs used empty disposable profiles,
profile-scoped trust for synthetic `.test` hosts, and localhost fixture services.
No real account or credentials were used, no certificate verification was disabled,
and the installed Codex files and real user configuration were not changed.

The final runs covered 18 browser request cases (8 path-routing cases and 10
domain-routing/fallback cases), with assertions for expected success and failure.

| Check | Observed result |
| --- | --- |
| HTTPS path-based PAC selection | Cannot select the configuration paths: PAC receives `https://ccdx-config.test:<port>/`, with the path removed. |
| HTTP control for the same PAC | The full HTTP path reaches PAC and the selected request reaches the proxy. This rules out a PAC that never loaded. |
| Domain-limited PAC selection | Only the two selected synthetic hosts establish proxy tunnels. The unrelated third host stays direct. |
| Configuration overlay | Bootstrap, prediction configuration, and refresh carry the prediction override; unrelated gate/config fields retain their upstream values. |
| Non-configuration request on a selected host | Reaches the bridge and is forwarded unchanged, including its synthetic Authorization header. It does not stay direct. |
| Cross-origin 307 redirect | The followed request loses Authorization and the fixture returns 401. With `redirect: "error"`, the request fails instead. |
| Bridge stopped, PAC fallback `PROXY ...; DIRECT` | Subsequent ordinary GET succeeds directly with Authorization intact. Prediction configuration returns its original disabled state. |

The current App's actual bundled `performDesktopFetch` method was also extracted
and executed with synthetic dependency stubs. It explicitly sets `redirect: "error"`
when authenticated workspace routing is active. This independently rejects the
idea of using a local configuration server plus redirects for other authenticated
requests. The stubs do not establish real-account compatibility.

The first browser attempt accidentally included `127.0.0.1` in the fixture's DNS
deny rule and never loaded the test page or PAC. After excluding the local fixture
addresses, the path/domain tests completed. That harness failure is not a product
failure or evidence about PAC routing.

**Conclusion:** a domain-limited bridge with a configuration-path rewrite allowlist
is a demonstrated network-layer MVP; system-wide or all-domain forwarding is not
required. Strict HTTPS path-only routing before TLS termination is not provided by
the tested PAC mechanism. Selected hosts' other requests still pass through the
bridge. This is a routing proof in the same Chromium version, not a new end-to-end
Codex/real-account UI test. Existing corporate proxy composition, in-flight failure
recovery, full/delta refresh protocol behavior, and real-profile enable/disable
remain outside this test's proof. Direct fallback was verified only for subsequent
new GET requests after the bridge stopped, not interrupted streams or POST retries.

The temporary browsers/services were stopped and their disposable profiles,
synthetic certificate keys, network logs and scripts were removed. This report is
the retained result; no production native prediction integration was added.

## Joined native MVP verification

The installed, unmodified App 26.1007.30912 was launched with a fresh experimental
`CODEX_HOME` and profile. The previous model fixture reused the current checkout's
`createAdapterHandler`; inference responses remained deterministic local fixtures,
not real Copilot calls. The identity was a synthetic free-account fixture. No real
ChatGPT token or account was copied into this experiment.

The synthetic upstream returned the prediction gate and `is_enabled` as **false**.
The separate bridge changed only the three configuration response paths:

- initial `/wham/statsig/bootstrap`;
- `/wham/predictions/config`;
- Statsig `/v1/initialize`, including successful live overlays.

The upstream fixture requested a five-second refresh interval through its own
`sdk_configs`. The bridge preserved that setting; it did not change the installed
client or suppress other refreshes. The finished run observed 115 initialization/
refresh requests, 56 modified configuration responses, and 227 unchanged bridge
responses. Requests on other paths were forwarded, not counted as configuration
overrides. As in the network-only test, this is domain-limited routing, not strict
pre-TLS URL-path isolation.

The initial localhost route was bypassed by the actual App's networking behavior.
The disposable test was corrected to use the clearly synthetic hostname
`ccdx-native-fixture.chatgpt.com`, intercepted locally by the allowlisted proxy;
no request was sent to a server at that hostname. A nonstandard port was rejected
by the desktop's authenticated-URL check, so the fixture used standard HTTPS and
the proxy delivered it to the local server. CLI model requests retained their
separate localhost endpoint. The profile-only CA was constrained to the required
test names/loopback. TLS verification stayed enabled. No OS trust or production
client settings were changed.

The user confirmed all UI checks in the same independent window:

1. After an ordinary test reply, native grey text appeared automatically.
2. Adopting and sending it produced a normal user message and response.
3. A subsequent native prediction appeared normally.
4. After the bridge overlay was disabled and the App received an unmodified live
   refresh, a manually entered ordinary message still received a normal response,
   with no new grey prediction.

The model handler recorded ten streamed model requests: six ordinary requests and
four native prediction requests. All four predictions used `gpt-6.1-sol`; the last
request, after disabling the overlay, was ordinary. The native model inherited the
parent thread selection. This did not validate a separate prediction-model picker.

Computer Use access to Codex was unavailable, so the user supplied the UI
confirmations; no alternate UI-automation route or renderer injection was used.
No CCDX prediction MCP or Hook was registered. The App's unrelated built-in
connector/device-registration calls encountered fixture 404s; this test does not
claim those real services were validated or that all existing features are proven
regression-free.

**Outcome:** the minimal native end-to-end prototype passed. Release discussion can
now use a demonstrated mechanism, rather than two unconnected prototypes. However,
real-account forwarding, real inference in this combined path, delta-checksum
compatibility, existing corporate proxies, production certificate/config rollback,
and packaged on/off lifecycle are not established by this run. No native-prediction
code has been added to the product CLI/startup path; the package remains 0.9.23 and
was not published. These are release-readiness boundaries, not additional claims
about this successful isolated UI test.

The experimental service and App were stopped. Signature verification passed, and
the packaged ASAR SHA-256 still matched the value below. Temporary test identities,
private keys, profiles, logs and scripts were removed after recording these results.

## Integrity and cleanup

`codesign --verify --deep --strict --verbose=4 /Applications/ChatGPT.app` succeeded
outside the restricted check environment: valid on disk and designated requirement
satisfied. The initial restricted verification failure was not evidence of a client
patch. Packaged `app.asar` SHA-256 at verification:
`75e397e2280dde93b70a85aa926f4282c728eacc84dfeb15ba7fb6ddd84628af`.

The isolated App and fixture services were stopped. Temporary profile data,
synthetic credentials, local test certificate keys and scripts were removed.
The real App, real account, OS certificate trust and running CCDX were not changed.
Existing prediction-retirement edits remain uncommitted; this experiment was not
published to GitHub or npm.
