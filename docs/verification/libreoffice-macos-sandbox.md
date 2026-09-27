# macOS LibreOffice sandbox verification

Date: 2026-09-27. This record belongs to the execution of
`.omx/plans/2026-09-27-libreoffice-macos-sandbox.md`. A conversion outside a
sandbox, a Codex tool sandbox, and a real app-server restricted turn are three
different test environments. Results below must not be transferred between
them.

## Baseline

The working tree had pre-existing edits at the start of this task. The initial
`git status --short` was saved outside the repository at
`/private/tmp/dascowork-lo-worktree-status-20260927.txt`; no reset or stash was
performed.

The repository fixture is
`desktop-app/tests/e2e/fixtures/artifact-presentation.pptx`, SHA-256
`b4b895254bf6173f6f0186d3030d9273808c8d530a1e15f4218af98918253103`.
Its OOXML has **one slide**, containing `Artifact PPTX`. This is the public CI
input; the separate user PPTX under `../test2` is local-only and must not be
uploaded to CI artifacts.

Prior local observations are preserved at
`/private/tmp/dascowork-lo-26.8-verify/`. Its `RESULT.md`,
`sandbox-results.json`, and `sandbox-denials.txt` report:

| Binary | Test environment | Fixture result | Local 10-slide result |
| --- | --- | --- | --- |
| Existing official 26.2.6 | Codex tool default restricted sandbox | SIGABRT (-6), no PDF | SIGABRT (-6), no PDF |
| Official 26.8.0.3 x86_64 DMG, SHA-256 `2dcbce4894e01bc1ecd594658e2cbda70ff7bfcd0b310f35d38887797172d09e` | Codex tool default restricted sandbox | Exit 1, no PDF | Exit 1, no PDF |
| Same official 26.8.0.3 DMG | Outside sandbox | Not recorded | Exit 0, 10-page PDF with extracted text |

The observed restricted `soffice` process was denied `network-bind` for
`/private/tmp/OSL_PIPE_501_SingleOfficeIPC_*`. This is evidence of an IPC
obstacle, **not** proof that it is the only obstacle. These historical runs
did not include an explicit AF_UNIX denial probe. No real app-server restricted
turn has been verified yet. Apple Silicon has not been tested.

The host is x86_64 and `xcode-select -p` points to Command Line Tools;
`xcodebuild -version` fails because full Xcode is not selected. The installed
Codex CLI exposes `codex sandbox [OPTIONS] [COMMAND]...` and supports
`--sandbox-state-json`; its precise effective state must be recorded for each
future strict test.

## Required per-run report

Store one JSON report per conversion, including failures:

- Host OS/architecture; LibreOffice source tag, immutable commit, source
  archive SHA-256, patch SHA-256, binary SHA-256, and Runtime archive SHA-256.
- Environment class (`outside`, `codex-tool-restricted`, or
  `app-server-restricted`), effective sandbox configuration and origin, AF_UNIX
  probe result, whether any command was elevated, and any sandbox denials.
- Exact executable and argument array, relevant environment, input SHA-256,
  fresh output/profile paths, start/end timestamps, duration, exit code or
  signal, stdout, stderr, and timeout/cancellation state.
- Expected/actual slide or PDF page count, `pdfinfo` output, expected text and
  `pdftotext` result, `pdftoppm` page count, visual review outcome, output
  SHA-256 and size, remaining processes, and temp cleanup result.

An unrun field must say `not tested`; an unavailable signal must say
`unavailable`. Exit zero or a nonempty PDF alone is insufficient.

## Current acceptance status

The baseline above is established. The proposed patch is recorded in
`primary-runtime/patches/libreoffice-macos-headless-no-ipc.patch`, bound by
`primary-runtime/libreoffice-build.lock.json` to the immutable upstream tag
commit `cf55f45554a356e77e7977c6a28679069017157f` and source archive
SHA-256 `10cf530dcbf171ff40c34c9c2a32d43d0bd8a7fa00150b99667ac820b40e9aa5`.
The archive was downloaded to `/private/tmp/dascowork-lo-source-26.8.0.3/`.

Source inspection at that tag found the following control flow:

1. `Desktop::Init` reads `CommandLineArgs::IsHeadless()` and calls
   `RequestHandler::Enable(true)` in `desktop/source/app/app.cxx`.
2. `RequestHandler::Enable(false)` in
   `desktop/source/app/officeipcthread.cxx` creates `pGlobal` and returns OK
   without creating `PipeIpcThread`.
3. Later `Desktop::Main` calls `RequestHandler::EnableRequests()`, fills
   `ProcessDocumentsRequest` from command-line conversion arguments, then
   calls `ExecuteCmdLineRequests`; the latter dispatches conversion requests
   using `pGlobal`. This is the same branch upstream uses for its
   `HAVE_FEATURE_MACOSX_SANDBOX` build, without enabling that global feature.

The patch reads the confirmed `rtl::Bootstrap::get` API and only passes
`Enable(false)` on macOS when both `--headless` and
`-env:DASCOWORK_HEADLESS_NO_IPC=1` are present. On an unmodified source tree,
`git apply --check primary-runtime/patches/libreoffice-macos-headless-no-ipc.patch`
passed. The source-level branch review covers the three intended cases:

| Arguments | IPC argument on macOS | Runtime result |
| --- | --- | --- |
| No opt-in | `true` | Not tested |
| Opt-in and `--headless` | `false` | Not tested |
| Opt-in without `--headless` | `true` | Not tested |

This patch is project-owned, not an inferred Codex patch. It has **not** been
successfully compiled or behaviorally tested. Both architecture artifacts, strict
conversions, app-server E2E, and Runtime integration remain **not tested**. No
new Runtime source lock is published. The previous official macOS package
remains the locked source and retains its known sandbox failure.

## P2 experiment handoff

`primary-runtime/scripts/build-libreoffice-headless.mjs` accepts a native
`--target`, the pinned source `--source-archive`, a new empty `--output`
directory, and optional `--jobs`. Example on an Intel Mac with full Xcode
16.4, GNU Make 4+, autoconf, aclocal, and pkg-config:

```sh
node primary-runtime/scripts/build-libreoffice-headless.mjs \
  --target=darwin-x64 \
  --source-archive=/private/tmp/dascowork-lo-source-26.8.0.3/core-libreoffice-26.8.0.3.tar.gz \
  --output=/private/tmp/dascowork-lo-intel-build \
  --jobs=3
```

The script checks the archive, patch, upstream configuration, and
`download.lst` hashes before building. It generates `sources.ver` from the
locked tag because the GitHub tag archive has neither `.git` nor the
release-tarball file, while LibreOffice's `Makefile.fetch` reads that file
unconditionally. It disables help, dictionaries, translations, and the
developer kit to avoid unneeded build inputs. Online update and crash reporting
are disabled because this conversion-only build has neither a release update
service nor a privacy-policy URL. JUnit-based Java tests are disabled at
configure time; Impress and the PPTX/PDF paths remain in the
upstream macOS distribution configuration. `make fetch` is followed by a
second SHA-256 check of each fetched external archive against the pinned
`download.lst`. On success it emits `LibreOffice.app` and
`source-build-report.json`.

`.github/workflows/libreoffice-headless-build.yml` is a manual Intel build
experiment and does not publish a Release or change Runtime locks. Running
the local build command on this host failed at the Xcode preflight:
`xcrun: missing DEVELOPER_DIR path: /Applications/Xcode_16.4.app/Contents/Developer`.
The host has only Command Line Tools. GitHub CLI authentication succeeded
when checked outside the local network sandbox; the earlier in-sandbox
"invalid token" message was a network-sandbox artifact.

The isolated branch `codex/libreoffice-macos-sandbox` has run the manual
experiment without publishing any user document or replacing a Runtime lock:

| GitHub Actions run | Result | Build evidence |
| --- | --- | --- |
| [36301249414](https://github.com/Linnanli/dasWork/actions/runs/36301249414) | Failed | Intel runner has no GNU Make 4+ by default. |
| [36301519394](https://github.com/Linnanli/dasWork/actions/runs/36301519394) | Failed | Homebrew bottle fetch used an invalid flag. |
| [36301675516](https://github.com/Linnanli/dasWork/actions/runs/36301675516) | Failed | Pinned GNU Make installed; `aclocal` was absent. |
| [36301890885](https://github.com/Linnanli/dasWork/actions/runs/36301890885) | Failed | Runner Automake metadata had not been refreshed. |
| [36302016187](https://github.com/Linnanli/dasWork/actions/runs/36302016187) | Failed | Locked Automake installed; direct `spawn` of upstream `autogen.sh` returned `ENOEXEC`. |
| [36302233032](https://github.com/Linnanli/dasWork/actions/runs/36302233032) | Failed | Upstream rejected runner-selected `/usr/local/bin/pkgconf`; it accepts the Homebrew `pkg-config` symlink. |
| [36302542386](https://github.com/Linnanli/dasWork/actions/runs/36302542386) | Failed | `pkg-config` accepted; runner `gperf 3.0.3` is below upstream's minimum. |
| [36302901288](https://github.com/Linnanli/dasWork/actions/runs/36302901288) | Failed | `gperf 3.3` passed; upstream macOS configuration enabled the developer kit and then required absent Doxygen. The experiment now disables the unused developer kit. |
| [36303378766](https://github.com/Linnanli/dasWork/actions/runs/36303378766) | Failed | The unused developer kit was disabled. Configuration then required a privacy-policy URL because upstream's macOS distribution enables online update; the conversion build now disables online update and Breakpad instead of inventing a policy URL. |
| [36303937942](https://github.com/Linnanli/dasWork/actions/runs/36303937942) | Failed | Configuration accepted disabled update/crash reporting, then required absent JUnit 4 for Java tests; the build now uses upstream `--without-junit`. |

No build artifact or restricted candidate conversion has been recorded yet.

The repeatable strict comparison driver is
`primary-runtime/scripts/verify-libreoffice-sandbox.mjs`. It first confirms an
AF_UNIX bind is denied, then runs the selected binary with a fresh profile and
output directory, retaining exit status, PDF page/text/render checks, hashes,
and stdout/stderr in `report.json`. A local control run of the official 26.8
binary with the repository fixture produced
`/private/tmp/dascowork-lo-p2-comparison/official-26.8-default-5PMt8d/report.json`:
the probe was denied with `EPERM`, conversion exited 1, and no PDF appeared.
This is a Codex tool restricted result, not app-server restricted evidence.
