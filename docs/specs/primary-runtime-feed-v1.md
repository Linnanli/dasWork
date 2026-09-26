# Primary Runtime feed v1

The feed is read-only HTTPS and has three endpoints:

| Path                                                                   | Producer                | Consumer                               | Failure behavior                                                                                              |
| ---------------------------------------------------------------------- | ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/v1/runtime/config.json`                                              | offline config signer   | `PrimaryRuntimeProductConfigClient`    | reject unknown config key, expired metadata, wrong channel/origin, rollback or equivocation                   |
| `/v1/runtime/channels/<channel>/manifest.json`                         | offline manifest signer | `SignedPrimaryRuntimeReleaseProvider`  | reject unknown manifest key, wrong role, invalid signature/target, expired metadata, rollback or equivocation |
| `/v1/runtime/archives/<version>/<platform>-<arch>/primary-runtime.zip` | release publisher       | `PrimaryRuntimeHttpClient` + installer | reject redirect, wrong origin/length/SHA, unsafe ZIP or diagnostics failure                                   |

Metadata canonicalization is recursively sorted JSON with the top-level
`signature` member omitted. Config and manifest keys have distinct IDs and roles.
The client stores `{sequence,payloadHash,keyId,acceptedAt,origin,channel,role}`
for each role. Higher sequence is accepted; an equal sequence is only accepted
when hash and key ID match; a lower sequence is rollback; an equal sequence with
a different hash or key is equivocation. When config and manifest are fetched as
a pair, both must verify and have the same sequence before either trust record
is advanced; the pair is committed in one atomic trust-state write.

Config fields are `schemaVersion`, `sequence`, `channel`, `manifestUrl`,
`pollIntervalMs`, `issuedAt`, `expiresAt`, `keyId`, `signature`. Manifest fields
are the existing signed Runtime release contract with target-specific archive
descriptors. Config can select a manifest only from the application's
manifest-origin allowlist, established before the request (compiled for packaged
builds or supplied by the local development launcher); neither config nor
manifest can add a new key or archive origin. Metadata is bounded to 1 MiB;
archive size is bounded by the installer. Metadata is `no-cache`; archives
carry immutable caching and ETags.
Before advancing `current`, the publisher rejects any attempt to reuse an
already published immutable archive URL for different bytes. The existing
complete-tree publisher compares retained release-history manifests. The
development publisher keeps a cumulative archive index beside each metadata
snapshot and stores archives separately; only entries in the current index
are served. Missing valid asset routes return `404`; unexpected server failures
use a generic body and never reflect repository paths.

Key rotation overlaps an old and new public key in the application's role-specific
keyring. For packaged builds, revocation removes the old key in a subsequent
desktop release; a key cannot cross from the config role to the manifest role.

The publisher only atomically advances a staging tree after it has exactly the
four supported targets (`darwin-x64`, `darwin-arm64`, `win32-x64`, `linux-x64`).
For every target, the archive's declared size and SHA-256 must match the staged
file and its adjacent, non-served `provenance.json` must bind the archive to the
source/toolchain locks, input/file manifests, runtime manifest, SBOM/notices,
component smoke, reviewed budget and P3b performance report. Native
`platform-validation.json` remains explicit engineering evidence with
`productionTrust=false`; it is not a platform-signing or trust receipt. The read-only
server does not receive private keys and cannot mint this evidence.

The release-contract delivery publishes a GitHub Actions engineering artifact with
a runner-temporary test key. The local development Feed described in
`docs/superpowers/plans/2026-09-26-primary-runtime-local-feed.md` instead keeps a
development signing key and serves validated engineering artifacts from a loopback
HTTPS origin. Both forms remain `releaseClass=engineering` and
`publiclyDeployable=false`. Real signing custody, public origins and production
channel promotion belong to a separate Production Readiness plan.

New release manifests use the generic Runtime format v2. They are bound to the
validated v2 source lock and may describe Runtime-owned Node, Python, native,
font, and plugin paths without adding a presentation-specific feed format or
executor. Legacy manifest fields are read only for migration diagnostics and are
never emitted by a new feed release.
