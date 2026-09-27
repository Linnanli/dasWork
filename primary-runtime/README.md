# Primary Runtime builder

This package is deliberately fail-closed. It builds from the immutable source
record in `runtime-sources.lock.json`, never from a reference extraction,
developer-global Node/Python, user plugin cache, or a placeholder package.

## P0 source record

The selected Office input is `iOfficeAI/OfficeCLI` `v1.0.152` at commit
`ffa8a0a`. The lock records the Apache-2.0 release plus four exact native
release assets for `darwin-x64`, `darwin-arm64`, `win32-x64`, and `linux-x64`,
each bound by SHA-256. OfficeCLI is materialized as
`dependencies/native/officecli/officecli(.exe)` and exposed as a Runtime binary,
not as a bundled plugin.

The source lock also records the existing Node/Python/native/font artifacts used
by the surrounding Runtime and PDF path. Every entry has an exact version,
immutable HTTPS source, SHA-256, SPDX license, and target coverage. Runtime input
smoke verifies OfficeCLI can create Office documents and emit PPTX SVG output;
browser-backed screenshot preview is deliberately excluded from this Runtime
bundle and handled by the host.

Run `npm test` to prove the lock parser rejects a missing hash, short commit,
floating version/ref, placeholder, credential-bearing URL, unknown field, or
incomplete target coverage. `npm run create-provenance` emits a receipt bound to
the exact source-lock bytes.

## Remaining release work

P1 must create the actual four target archives from these sources. Each archive
will contain Runtime-owned Node/Python/native/font paths plus OfficeCLI; it must
not execute `npm`, `pip`, setup/bootstrap code, or system dependency fallbacks.
P3 and later phases add archive budgets, signing, component/native smoke
evidence, and live product gates. Until then the build and verify commands
correctly stop at `AT-RT-BUILD-01` rather than fabricating a release artifact.
