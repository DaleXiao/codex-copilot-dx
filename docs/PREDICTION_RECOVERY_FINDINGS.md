# Prediction recovery investigation (unreleased)

Date: 2026-10-15. Baseline: 0.9.39 / `ab9e294`.

## Acceptance boundary

The requested outcome is recovery of native composer predictions after an
already-running App has fallen back, without restarting that App, introducing a
prediction MCP, or modifying client program files. Listener health, an HTTP 200,
a synthetic response, and a recovered browser route are not sufficient evidence
of a visible native suggestion.

## Observed behavior

The installed macOS client's prediction controller caches its configuration query
for 300,000 ms. A failed fetch becomes a successful query result containing null;
there is no query retry. A prediction setting change clears the controller's
queries. These are observations of this installed build, not an official API
contract or a guarantee about other versions. No program files were changed.

Three isolated headless Chrome experiments used only loopback HTTP servers,
a fresh browser profile, a synthetic target and no real account. Each restored
the proxy while leaving the browser process running:

| PAC loaded before failure | After proxy restoration | Observation window |
| --- | --- | --- |
| Fixed `127.0.0.1` proxy, DIRECT fallback | Continued DIRECT | About 8 seconds |
| Time-varying `.localhost` proxy name, same listener/port | Returned to proxy after about 2 seconds | About 8 seconds |
| Fixed PAC initially; server changed its content to the varying form | No new PAC fetch; continued DIRECT | About 20 seconds |

The second result is browser routing evidence only. The third distinguishes
future recovery with a newly loaded PAC from hot migration of an old cached PAC.
It does not show that an old App can never recover later. It also does not prove
that a prediction configuration already cached as null is refreshed immediately.
The candidate now keeps the fixed primary and adds a time-varying secondary name
on the same port. The format revision URL is stable across package updates. A
second real Chrome 155.0.8059.40 replay of this production expression recovered
twice with direct fallback (7,722 / 10,009 ms) and twice with a synthetic company
proxy fallback (9,275 / 10,002 ms). The legacy control stayed on fallback during
its 2,052 ms observation window. These are routing observations, not native UI
verification or performance speedup claims.

## Remaining publication gate

No verified external interface was found in the inspected client JavaScript for
reloading its active proxy configuration or invalidating its prediction controller
cache. The public App Server API overview does not document such an interface.
This is a negative finding from a bounded investigation, not proof that no native
interface can exist.

Before claiming this fix complete, reproduce the user's failure state, verify
configuration traffic returning to the bridge, then observe native gray text,
adoption/sending, ordinary replies and disabled predictions in the same App
process. The user explicitly accepted one normal App quit to load the revised
route, with later hot recovery still requiring native-gray-text verification.
The candidate package version is 0.9.40. A partial network-layer result alone
does not satisfy the publication gate.

## Separate authentication correction

The candidate preserves the default saved GitHub credential when Copilot returns
401/403, distinguishes a separately confirmed GitHub identity 401, and prevents
HTTP-403-blocked discovery from starting a second Device Flow. Successful startup
and token-cache fast paths gain no discovery or validation calls. Denials never
reuse an unexpired cached Copilot token to conceal revoked access. Custom isolated
client recovery contracts remain unchanged. No real credential was read or changed
for these tests.
