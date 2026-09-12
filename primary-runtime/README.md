# Primary Runtime builder

This package is deliberately fail-closed. It builds from the immutable source
record in `runtime-sources.lock.json`, never from a reference extraction,
developer-global Node/Python, user plugin cache, or a placeholder package.

## P0 source record

The selected input is `siril9/presentation-skill` `v0.8.0` at commit
`a25708686160a13a4cdcb9cc1cc206fa9cb86219`. The lock records its source archive,
plugin directory tree, MIT license, and the SHA-256 of the project-owned patch.
That patch limits the Runtime distribution to new PPTX creation, automated QA,
and preview; it removes online installs, system dependency discovery, direct
model access, network asset collection, React/sharp icon rendering, and all
existing-PPTX editing paths.

The source lock also records the full audited Node closure plus the required
Python, native-rendering, and font source artifacts. Every entry has an exact
version, immutable HTTPS source, SHA-256, SPDX license, and all four release
targets. `v0.11.0` is recorded as `candidate_rejected`: its pinned
`Pillow==12.3.0` package is not published, so that graph cannot be reproduced.

Run `npm test` to prove the lock parser rejects a missing hash, short commit,
floating version/ref, placeholder, credential-bearing URL, unknown field, or
incomplete target coverage. `npm run create-provenance` emits a receipt bound to
the exact source-lock bytes.

## Remaining release work

P1 must create the actual four target archives from these sources. Each archive
will contain Runtime-owned Node/Python/native/font paths and the patched,
allowlisted plugin only; it must not execute `npm`, `pip`, setup/bootstrap code,
or system dependency fallbacks. P3 and later phases add archive budgets, signing,
component/native smoke evidence, and live product gates. Until then the build and
verify commands correctly stop at `AT-RT-BUILD-01` rather than fabricating a
release artifact.
