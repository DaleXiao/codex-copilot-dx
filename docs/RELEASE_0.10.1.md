# CCDX 0.10.1 — keep the configured core port available

Date: 2026-10-17. Follow-up to [0.10.0](RELEASE_0.10.0.md).

The final port-isolation fixture reproduced a startup-order conflict when the
existing core service is configured with `ADAPTER_PORT=2027`, which is also the
new Claude gateway's fixed port. An early M365 setup could reserve it before the
core listener started. The fixture failed before this correction.

The composition root now passes its actual core port to provider setup. That port
always wins: only the optional Claude listener/configuration is skipped, with an
explicit `m365_gateway_core_port_conflict` reason. M365 GPT remains selectable.
Default port 2026, existing caller preferences, credentials, prediction routes,
image behavior and network policy are unchanged. No automatic port move, process
restart or new option/dependency is introduced.

This is a scoped follow-up, not another architecture pass. The M365 eligibility
and platform-validation limits in the 0.10.0 report still apply. Final verification
and publication receipts are appended below after completion.
