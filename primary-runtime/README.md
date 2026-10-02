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

The source lock also records Poppler, its native build dependencies, and fonts
for the independent PDF path. The Node and Python component lists are empty.
Every entry has an exact version,
immutable HTTPS source, SHA-256, SPDX license, and target coverage. Runtime input
smoke verifies OfficeCLI can create Office documents and emit PPTX SVG output;
browser-backed screenshot preview is deliberately excluded from this Runtime
bundle and handled by the host.

Run `npm test` to prove the lock parser rejects a missing hash, short commit,
floating version/ref, placeholder, credential-bearing URL, unknown field, or
incomplete target coverage. `npm run create-provenance` emits a receipt bound to
the exact source-lock bytes.

## Delivery and verification

The builder creates v3 archives for all four targets containing OfficeCLI,
Poppler, fonts, and the Runtime-owned `officecli` skill. The v3 archives do not
bundle Node, Python, LibreOffice, or `presentation-skill`. Installation uses
verified immutable archives and does not execute `npm`, `pip`, bootstrap code,
or system dependency fallbacks.

The GitHub workflow separates calibration, independent budget review, and final
builds. It verifies component smoke, archive/platform integrity, unpacked size,
reviewed budgets, real desktop installation, and sampled installation RSS. Each
final target staging artifact preserves `install-stress-memory.json`. The final
aggregate tests signed Feed installation and the desktop Office command/preview
path in development and Linux packaged builds.

The aggregate is engineering-only. Production trust and the existing desktop
release gates still govern public delivery. Legacy v1/v2 manifest decoding and
preview support remain in the desktop app for compatibility and rollback.
