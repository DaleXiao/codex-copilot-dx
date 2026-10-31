# Local privacy component

The `guard` implementation is adapted from Magpie commit
`64aaf421ac39fb2a2dab8c9df1f7729c8e39b4e8`, copyright 2026 yetone,
under the MIT license in `LICENSE.magpie`. The only import-path change is
the local CoreML package path. Magpie is not a runtime dependency.

The optional AstrLink Guard 0.1.3 model is published by QuantumNous under
Apache-2.0. Model files are downloaded separately, at a fixed revision and
with their published SHA256 values. They are not included in the npm package.

The grapheme tokenizer dependency is `github.com/clipperhouse/uax29/v2`
v2.5.0. Its license is retained by Go's vendor directory.

This executable communicates only through its standard input and output.
It does not open network listeners, read application credentials or send
text to a remote service.
