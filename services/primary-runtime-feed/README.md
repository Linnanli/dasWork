# Primary Runtime feed

This is a read-only HTTPS implementation of the Runtime feed protocol. The release
contract produces a test-signed GitHub engineering artifact; local desktop development
uses a persistent loopback Feed. Neither is a production feed.
It serves signed `config.json`, signed channel manifests, and immutable ZIP archives;
the serving process never accepts uploads or holds model credentials or signing keys.
Publication rejects rebinding a previously used version/target URL to different
archive bytes. The release publisher checks retained release trees; the local
development publisher uses a cumulative archive index. Missing assets return
`404`, and internal failures never echo repository paths to clients.

The server requires an exact allowlist of HTTP `Host` values in addition to TLS.
Set `PRIMARY_RUNTIME_FEED_ALLOWED_HOSTS` to comma-separated host[:port] values in
standalone deployments. The development launcher derives this list from its single
loopback host/port and rejects any other request host before it reads a feed file.

For the release-contract fixture, generate TLS material under the ignored `var/tls/`
directory, publish a fully validated staging tree with `npm run publish-release`,
then run `npm start`.
The desktop client must be configured only with the feed config endpoint and a
Main-owned local test CA policy. Do not disable TLS verification or use this service
to distribute unprovenanced Runtime inputs.

For local desktop development, the Feed project owns artifact import and service
lifetime. Run these commands from the repository root:

```bash
npm --prefix services/primary-runtime-feed run dev:import
npm --prefix services/primary-runtime-feed run dev:serve
npm --prefix desktop-app run dev:local-feed
```

The import writes `var/development/client-profile.json`. After its signed metadata
expires, run `npm --prefix services/primary-runtime-feed run dev:refresh` while the
server stays up. The client command reads only the
public profile: exact loopback HTTPS origin, channel, config public keyring, manifest
public keyring, and absolute CA certificate path. The profile must never contain
private signing keys, TLS private keys, archive roots, direct archive URLs, or Runtime
install paths.

The desktop launcher does not publish releases or start this service. It validates
the profile and Feed reachability, clears inherited direct Runtime overrides, and
passes only signed product-config settings to Electron. The launcher also uses a
dedicated ignored user data directory through
`DASCOWORK_DEV_LOCAL_FEED_USER_DATA_DIR`, so local Feed trust state is separate from
ordinary development and packaged app state.

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
