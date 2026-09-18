# Primary Runtime feed

This is a read-only HTTPS implementation of the Runtime feed protocol. In this plan it
is assembled only as a test-signed engineering artifact; it is not a production feed.
It serves signed `config.json`, signed channel manifests, and immutable ZIP archives;
it never accepts uploads or holds model credentials or signing keys.
Publication checks every retained release tree before advancing `current`, so a
previously used version/target URL cannot later be rebound to different archive
bytes. Missing assets return `404`, and internal failures never echo repository
paths to clients.

The server requires an exact allowlist of HTTP `Host` values in addition to TLS.
Set `PRIMARY_RUNTIME_FEED_ALLOWED_HOSTS` to comma-separated host[:port] values in
standalone deployments. The development launcher derives this list from its single
loopback host/port and rejects any other request host before it reads a feed file.

Generate development TLS material under the ignored `var/tls/` directory, publish a
fully validated staging tree with `npm run publish-release`, then run `npm start`.
The desktop client must be configured only with the feed config endpoint and a
Main-owned local test CA policy. Do not disable TLS verification or use this service
to distribute unprovenanced Runtime inputs.

For an end-to-end local desktop run, use
`npm --prefix desktop-app run dev:with-primary-runtime-feed`. It requires a fully
signed staging release, local TLS key/certificate/CA paths, and the public config
and manifest keyrings. The command publishes the staging tree atomically, starts
this service on a loopback HTTPS origin, and starts Electron with only the signed
product-config settings. It deliberately removes `DASCOWORK_PRIMARY_RUNTIME_ROOT`
and all direct archive/manifest overrides from the Electron environment.

During development, `npm --prefix desktop-app run dev:primary-runtime` prepares those
inputs automatically from the four immutable staging artifacts of a successful final
workflow for the current commit. It caches the source artifacts locally, creates
ephemeral loopback TLS, signs new local metadata with a persistent ignored development
key, validates the resulting feed tree, and then invokes the launcher above. It does
not change production feed configuration or make the client trust a local Runtime root.
The downloader and local feed assembler live in the repository-level
`scripts/dev-primary-runtime.mjs`, outside the desktop client source tree.

For the deterministic signed-Feed E2E, run
`DASCOWORK_PRIMARY_RUNTIME_FEED_E2E=1 npm --prefix desktop-app run test:e2e:primary-runtime-feed`
with exactly those same inputs. The dedicated runner atomically publishes the staging
tree, starts the loopback Feed, and launches Electron with only product-config settings.
The test waits for an empty Runtime cache to activate, then verifies that a real
`load_workspace_dependencies` call supplies only the Runtime's allowlisted Node,
Python, binary, module, and font paths to a subsequent ordinary command. It
never accepts a local Runtime root, direct archive override, synthetic product
plugin, system dependency fallback, or app-server replacement.

Before the atomic publish, the staging tree must contain one archive for each
`darwin-x64`, `darwin-arm64`, `win32-x64`, and `linux-x64` target. Each archive
has an adjacent `provenance.json` binding its SHA-256 to the locked source/toolchain,
input/file manifests, SBOM/notices, component smoke, reviewed budget and P3b
performance report. The staged evidence also includes native `platform-validation.json`
with `productionTrust=false`. The feed process never treats this as production trust;
it rejects staging trees missing the declared engineering evidence.

The release pipeline stores each native target as an immutable artifact containing its
ZIP, provenance, and declared engineering evidence. A runner-temporary test-signing
lane creates metadata containing only `config.json` and
`channels/<channel>/manifest.json`. The publish gate receives the exact source
run ID, downloads those five artifacts with read-only Actions access, and runs
`npm run assemble-release-staging` before the atomic repository swap. The
assembler and publisher receive only the two public keyrings, verify the config
and manifest against their separate key IDs, then call the same feed-tree
validator. They never copy a signing key, certificate, or arbitrary artifact file
into the GitHub artifact repository. It never deploys, promotes a canonical config, or
claims `production_ready`.
