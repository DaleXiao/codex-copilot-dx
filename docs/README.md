# Documentation index

The [root README](../README.md) describes current behavior. `ccdx --help` and
`ccdx <command> --help` describe the installed package's CLI. Code and tests
resolve any discrepancy; CLI version and running-adapter version can differ.

`ccdx doctor config` performs local, read-only configuration diagnostics and
previews the current startup writer. It does not claim to resolve the complete
effective Codex configuration or validate every field against the installed app.

## Historical release evidence

These reports record a specific release and test environment. Their version,
test counts, timings, live-provider observations, and limitations remain
historical facts rather than current guarantees.

- [0.7.7: terminal animation additions and Braille retirement](RELEASE_0.7.7.md)
- [0.7.6: configuration doctor and documentation audit](RELEASE_0.7.6.md)
- [0.7.5: context-management default](RELEASE_0.7.5.md)
- [0.7.4: preparation timing and performance checks](RELEASE_0.7.4.md)
- [0.7.3: native Responses message identity](RELEASE_0.7.3.md)

The [benchmark-fixture provenance](../scripts/fixtures/README.md) documents the
photo source and distinguishes it from the generated screenshot fixture.
