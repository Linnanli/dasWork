# ADR: Primary Runtime reference delivery

## Status

Accepted for implementation. P0 selected the immutable `siril9/presentation-skill`
`v0.8.0` source snapshot recorded in
[`runtime-sources.lock.json`](../../primary-runtime/runtime-sources.lock.json).
P1 remains responsible for creating and clean-runner validating the four target
Runtime archives. Engineering metadata is signed only with a runner-temporary test
key; production signing is outside this ADR's delivery scope.

## Decision

Primary Runtime is delivered through a signed remote config/feed, installed into
an immutable local version directory, and selected through an atomic active
pointer. Electron does not embed the complete Runtime. Electron Main owns
discovery, installation, activation, plugin reconciliation, and capability
publication; the Renderer receives only business status and never a Runtime
root, feed URL, keyring, certificate, or archive path.

The Runtime-owned PPT plugin is the sole product-specific difference from the
reference delivery contract. Its source snapshot is patched to permit only
**new PPTX creation + automated QA + workspace preview**. It runs by the normal
app-server command path after `load_workspace_dependencies` returns the
allowlisted Runtime paths. It does not introduce a PPT-specific Main-process
tool or execution service.

The release pipeline may write an engineering config endpoint, allowed origins, and
role-scoped public keyrings into a test package resource. Packaged Main reads only that
resource and ignores Primary Runtime environment overrides; the checked-in resource is
explicitly disabled so local packages cannot silently point at any feed. Production
signing, canonical config promotion and public feed deployment are excluded.

The reference delivery establishes the remote configuration/feed/update/loader
shape. This project additionally requires separate config/manifest signing
roles, client-held public-key trust roots, exact-origin HTTPS, tuple-based
anti-rollback/equivocation state, activation journaling, and native platform-validation
receipts marked `productionTrust=false`. These are project supply-chain hardening measures, not claims about the
reference implementation.

## Rejected alternatives

- Embedding the complete Runtime in Electron: too large and prevents
  independent Runtime rollout.
- Development-root-only operation: not reproducible and bypasses provenance.
- Runtime-time package installation, virtual-environment creation, or system
  Office/Python/Node discovery: changes the trusted toolchain and prevents
  reproducible validation.
- Direct model HTTP, model-key access, online asset download, or existing-PPTX
  editing inside the Runtime: outside the product boundary and its security
  model.

## Consequences

`AT-RT-PROVENANCE-01` requires a complete v2 source lock: the upstream tag,
40-character commit, archive and plugin-tree digests, project patch digest, and
every Node, Python, native, and font component's exact source, version, digest,
license, and four-target coverage. `source-lock.mjs` rejects placeholders,
floating references, credentials, query strings, fragments, incomplete target
coverage, and unknown fields.

`AT-RT-BUILD-01` remains closed until P1 turns that approved source record into
four actual archives with target-specific dependency receipts, SBOM/notices,
offline diagnostics, and native render evidence. No fixture, personal cache, or
system toolchain can satisfy that release gate.
