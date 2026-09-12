# desktop-app

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

The desktop chat runtime requires the Codex CLI on the machine running the app:

```bash
$ codex --version
$ codex login
```

The installed app starts `codex app-server --listen stdio://` from the GUI process `PATH`.
It does not compile, bundle, download, or scan for a repository-local `codex-app-server`.
If the CLI is missing, chat shows: `未找到 Codex CLI。请安装 Codex CLI、将 codex 加入 PATH 并完成登录后重试。`

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

Build scripts only package the Electron app. GitHub prereleases upload installer files as
release attachments, but the generic auto-update URL in `electron-builder.yml` stays unchanged.
Release CI uses the exact `@openai/codex` version locked in `package-lock.json`; it does not
execute a remote install script. Before publishing, CI mounts, installs, or extracts every
published package from local media and launches its packaged executable. It also rejects missing,
empty, stale, or unexpectedly named assets and publishes a `SHA256SUMS` manifest with them.

## Primary Runtime and Presentation Skill

Primary Runtime supplies the controlled Node/Python runtimes, native binaries,
approved Node packages such as `pptxgenjs`, and Runtime-owned bundled plugins used
by Main-owned desktop tools. It is not the Codex app server and it never makes model
requests. Normal chat remains available when Runtime is missing, updating, or blocked.

For a new task on a host where the product feature is enabled,
`load_workspace_dependencies` is always published as a native dynamic tool. Before a
healthy Runtime is active, it returns structured Main-process diagnostics and recovery
guidance instead of a private directory path. The Runtime-owned `presentation-skill`
marketplace and its skills are synchronized after the Runtime activates, then the skill
catalog is reloaded. Existing threads keep their original tool snapshot; newly created
local threads receive the loader when the product feature is enabled.

Packaged applications trust only the signed, public
`primary-runtime-product-config.json` resource. They ignore all
`DASCOWORK_PRIMARY_RUNTIME_*` environment overrides, including custom development CAs.
Release CI writes the public config endpoint, allowed origins, channel, and separate
config/manifest public keyrings before the installer is signed, then restores the
checked-in disabled configuration. Private signing keys, archive credentials, Runtime
roots, and feed locations are never exposed to the renderer.

For an end-to-end local feed run, use `npm run dev:with-primary-runtime-feed` only with
a fully signed staging tree and loopback TLS material. See
[`services/primary-runtime-feed/README.md`](../services/primary-runtime-feed/README.md)
for the required inputs and immutable-artifact handoff. Do not substitute a local root,
temporary `npm`/`pip` install, `officecli`, or `python-pptx` for the Runtime chain.

The deterministic Feed gate is separate from ordinary Mock E2E: set
`DASCOWORK_PRIMARY_RUNTIME_FEED_E2E=1` and run
`npm run test:e2e:primary-runtime-feed` only after supplying the same signed staging
tree, loopback TLS paths, channel, and public keyrings required by the development
launcher. It starts the Feed, clears every direct Runtime override, and verifies the
production app-server → native registry → loader → Runtime Node → authorized
`presentation-skill` command chain.
It intentionally cannot run from a directory fixture or an unsigned archive.

Until the authorized source lock, four native-runner P1a/P3b receipts, reviewed
engineering budget, and deterministic presentation evidence exist, Runtime engineering
gates intentionally remain closed. GitHub artifact evidence is not a production release.

## Admin Backend Model Catalog

The desktop app can load the model selector list from `admin-backend` through Electron main process.

Set `ADMIN_BACKEND_URL` before starting the app:

```bash
export ADMIN_BACKEND_URL="http://127.0.0.1:3000"
export ADMIN_BACKEND_MODEL_USER_ID="00000000-0000-0000-0000-000000000001"
export ADMIN_BACKEND_MODEL_CACHE_TTL_MS="60000"
npm run dev
```

For local development, you can also put it in `desktop-app/.env` or `desktop-app/.env.local`:

```bash
ADMIN_BACKEND_URL="http://127.0.0.1:3000"
ADMIN_BACKEND_MODEL_USER_ID="00000000-0000-0000-0000-000000000001"
ADMIN_BACKEND_MODEL_CACHE_TTL_MS="60000"
```

`ADMIN_BACKEND_URL` enables the backend-backed model catalog. When it is not set, the app keeps using the Codex provider model list fallback. A real process environment variable takes precedence over `.env.local`.

`ADMIN_BACKEND_MODEL_USER_ID` is optional. When present, it is sent as `user_id` to `GET /api/client-models` so admin-backend can apply user or department filtering.

`ADMIN_BACKEND_MODEL_CACHE_TTL_MS` is optional and defaults to `60000`.

After one successful catalog load, the main process reuses the stale cached catalog during transient backend failures so an active desktop session can continue validating previously loaded model ids.

The backend response includes provider credentials for main-process use. Renderer IPC responses only receive the safe `CodexModelList` summary defined in `src/shared/codexIpcApi.ts`.

This integration is Phase 1. It controls the model selector list and validates selected/requested model ids. It does not route inference through backend-provided `provider`, `api_base_url`, `api_key`, or `api_format`; chat still uses the existing Codex ASP provider.

For production, `ADMIN_BACKEND_URL` must use HTTPS and `/api/client-models` must be protected by a client/device/JWT/mTLS/signature mechanism before credentials are distributed to desktop clients.
