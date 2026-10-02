---
name: officecli
description: Create, inspect, validate, and edit Office documents (.docx, .xlsx, .pptx) with the Primary Runtime bundled OfficeCLI binary.
---

# OfficeCLI

Use this skill when a user asks to create, inspect, validate, convert, or edit Microsoft Office documents in the workspace: `.docx`, `.xlsx`, or `.pptx`.

## Runtime contract

1. Call `load_workspace_dependencies` first and read the absolute OfficeCLI binary path from the Primary Runtime dependency payload. In the examples below, replace `<OFFICECLI_PATH>` with that absolute path.
2. Invoke `<OFFICECLI_PATH>` directly. Do not call bare `officecli`, and do not rely on `PATH` fallback.
3. Set `OFFICECLI_SKIP_UPDATE=1` and `OFFICECLI_NO_AUTO_RESIDENT=1` for every command.
4. When creating a new file, choose an output path that does not already exist. Do not overwrite an existing user file with `create`.
5. When editing an existing user file, read it first, compute its SHA-256, copy it to a new output path, modify the copy, run `save`, run `validate --json`, read the changed copy back with `get --json`, and confirm the original SHA-256 is unchanged.
6. Treat exit code `0` as landed, `1` as failed, and `2` as caveats. For JSON commands, require `success: true` and no `warnings`; if warnings are present, report them and do not claim the edit is verified.
7. Prefer SVG preview output for slide verification. Browser-backed screenshot rendering is supplied by the desktop host.

## Shell setup

Set the environment once for the shell session.

POSIX shells:

```bash
export OFFICECLI_SKIP_UPDATE=1
export OFFICECLI_NO_AUTO_RESIDENT=1
```

PowerShell:

```powershell
$env:OFFICECLI_SKIP_UPDATE = "1"
$env:OFFICECLI_NO_AUTO_RESIDENT = "1"
```

Use the host shell's normal copy and SHA-256 commands. Examples:

- POSIX: `cp input.docx output.docx` and `shasum -a 256 input.docx`
- PowerShell: `Copy-Item input.docx output.docx` and `Get-FileHash input.docx -Algorithm SHA256`

## Reliable create flows

Before creating, check that the output path is unused. If it exists, choose a new file name.

Create DOCX:

```bash
test ! -e new.docx
"<OFFICECLI_PATH>" create new.docx --json
"<OFFICECLI_PATH>" add new.docx /body --type paragraph --prop text='Runtime 中文验证' --json
"<OFFICECLI_PATH>" save new.docx --json
"<OFFICECLI_PATH>" validate new.docx --json
"<OFFICECLI_PATH>" get new.docx /body --json
```

Create XLSX:

```bash
test ! -e new.xlsx
"<OFFICECLI_PATH>" create new.xlsx --json
"<OFFICECLI_PATH>" add new.xlsx /Sheet1 --type cell --prop address=A1 --prop value='Runtime 中文验证' --json
"<OFFICECLI_PATH>" save new.xlsx --json
"<OFFICECLI_PATH>" validate new.xlsx --json
"<OFFICECLI_PATH>" get new.xlsx /Sheet1/A1 --json
```

Create PPTX and SVG preview:

```bash
test ! -e new.pptx
"<OFFICECLI_PATH>" create new.pptx --json
"<OFFICECLI_PATH>" add new.pptx / --type slide --json
"<OFFICECLI_PATH>" add new.pptx '/slide[1]' --type shape --prop text='Runtime 中文验证' --prop x=1 --prop y=1 --prop w=8 --prop h=1 --json
"<OFFICECLI_PATH>" save new.pptx --json
"<OFFICECLI_PATH>" validate new.pptx --json
"<OFFICECLI_PATH>" get new.pptx '/slide[1]' --json
"<OFFICECLI_PATH>" view new.pptx svg --start 1 --max-lines 1 > new-slide-1.svg
```

`view ... svg` writes SVG to stdout on success. Do not parse successful SVG preview output as JSON.

PowerShell path-exists check equivalent:

```powershell
if (Test-Path new.docx) { throw "Refusing to overwrite new.docx" }
```

## Reliable edit-copy flows

The examples below use POSIX copy and SHA commands. On Windows, use the PowerShell equivalents listed above.

DOCX copy edit:

```bash
shasum -a 256 input.docx
cp input.docx output.docx
"<OFFICECLI_PATH>" get output.docx / --json
"<OFFICECLI_PATH>" add output.docx /body --type paragraph --prop text='Runtime 中文验证' --json
"<OFFICECLI_PATH>" save output.docx --json
"<OFFICECLI_PATH>" validate output.docx --json
"<OFFICECLI_PATH>" get output.docx /body --json
shasum -a 256 input.docx
```

XLSX copy edit:

```bash
shasum -a 256 input.xlsx
cp input.xlsx output.xlsx
"<OFFICECLI_PATH>" get output.xlsx / --json
"<OFFICECLI_PATH>" add output.xlsx /Sheet1 --type cell --prop address=A1 --prop value='Runtime 中文验证' --json
"<OFFICECLI_PATH>" save output.xlsx --json
"<OFFICECLI_PATH>" validate output.xlsx --json
"<OFFICECLI_PATH>" get output.xlsx /Sheet1/A1 --json
shasum -a 256 input.xlsx
```

PPTX copy edit and SVG preview:

```bash
shasum -a 256 input.pptx
cp input.pptx output.pptx
"<OFFICECLI_PATH>" get output.pptx / --json
"<OFFICECLI_PATH>" add output.pptx / --type slide --json
"<OFFICECLI_PATH>" add output.pptx '/slide[1]' --type shape --prop text='Runtime 中文验证' --prop x=1 --prop y=1 --prop w=8 --prop h=1 --json
"<OFFICECLI_PATH>" save output.pptx --json
"<OFFICECLI_PATH>" validate output.pptx --json
"<OFFICECLI_PATH>" get output.pptx '/slide[1]' --json
"<OFFICECLI_PATH>" view output.pptx svg --start 1 --max-lines 1 > output-slide-1.svg
shasum -a 256 input.pptx
```

## Reporting

Report the output file path, the validation command result, whether warnings were empty, and the before/after SHA-256 check for the original file when editing a copy.
