# Codex App Server Native Runtime

Status: Accepted for the migration beginning at `282baf16f9b7d2c839db429ff1f4a1c2afff861f`.

## Decision

The Electron main process will own the Codex App Server connection, canonical
`initialize` handshake, thread/turn lifecycle, server-request routing, and
recovery. Renderer, preload, and shared IPC remain a narrow, business-level
API; they will not expose an arbitrary app-server method/params bridge.

The production chat path will move from the AI SDK provider to a main-owned
`CodexRunDriver` backed by an AI-free `@dascowork/codex-app-server-client`.
The provider is an independently tested compatibility package only and is not
in the desktop production dependency graph. `UIMessage` and `UIMessageChunk`
remain the renderer contract, while input and output adapters live at the
desktop-main boundary.

## Invariants

- Do not modify `codex/codex-rs/app-server/` anywhere in this migration.
- A host connection performs one canonical `initialize`/`initialized` per
  connection generation before issuing thread or turn requests.
- A run selects its driver at creation. It never falls back from native to
  legacy after a turn may have had side effects.
- Renderer reattach only subscribes to the existing runtime journal; it never
  sends an app-server request.
- Provider credentials, authorization headers, raw server requests, and
  arbitrary tool arguments remain main-process-only.
- Generated protocol types have one owner: the AI-free client package.

## Compatibility policy

The initial supported runtime is the exact version locked by
`desktop-app/package.json` and `desktop-app/package-lock.json`:
`@openai/codex` `0.148.0-alpha.21`. Runtime compatibility is proven against the
same executable by a launch-time `--version` probe parsed as
`codex-cli <exact-version>`, plus the generated-schema and real app-server
contract checks. A missing, unparseable, cross-executable, or unsupported
version is a renderer-safe `codex_app_server_version_unsupported` failure; it
must not issue `thread/*` or `turn/*` requests or silently use legacy.

Adding a version requires regenerating the protocol tree with that exact
generator, updating the manifest hash, and passing initialize, model list,
thread/turn, stream, server-request, interrupt/recovery, and packaged smoke
checks against the real binary.

The required upgrade workflow is: update the exact `@openai/codex` lock,
regenerate the sole tree under
`vendors/codex-app-server-client/src/protocol/app-server-protocol`, update
`protocol-manifest.json` including its version-probe evidence, then run both
protocol-contract and native-boundary verifiers, plus
`npm --prefix desktop-app run verify:real-codex-app-server-contract`, before
accepting the new runtime version. The real-binary smoke covers
`initialize`/`initialized`, `model/list`, and an ephemeral `thread/start`
through the core transport; credential-gated Dev/Release suites cover actual
turns, streaming, approvals, interruption, and recovery.

## Rejected alternatives

- Exposing a generic renderer JSON-RPC bus enlarges the renderer authority
  boundary.
- Keeping the provider as the permanent runtime owner retains AI SDK and
  protocol lifecycle coupling.
- Embedding JSON-RPC directly in `CodexChatRuntimeService` would make its
  existing run journal and approval ownership harder to reason about.
- A separate local sidecar creates a second control plane for approvals,
  recovery, and credentials without improving the current Electron-main trust
  boundary.

## Rollback

Until legacy removal, rollback changes the driver selected by *new* runs only.
An active run stays with its original driver and converges through its normal
terminal/recovery path. After legacy removal, rollback is a release-version
rollback rather than a hidden in-process fallback.
