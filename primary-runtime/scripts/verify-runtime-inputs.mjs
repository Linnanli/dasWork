#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { copyFile, lstat, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRuntimeInputsManifest } from "./runtime-inputs.mjs";
import { sha256 } from "./source-lock.mjs";
import { assertNativeRuntimeTarget, parseRuntimeTargetOption } from "./runtime-target.mjs";
import {
  createOfficeCliIsolationContext,
  probeOfficeCliExecutionAudit,
  probeOfficeCliIsolation,
  runOfficeCliIsolated,
} from "./officecli-isolation.mjs";

const defaultCommandTimeoutMs = positiveIntegerEnv(
  "DASCOWORK_PRIMARY_RUNTIME_VERIFY_COMMAND_TIMEOUT_MS",
  5 * 60 * 1000,
);
const capturedCommandOutputBytes = 1024 * 1024;
const officeCliFixtureRoot = fileURLToPath(
  new URL("../fixtures/officecli/", import.meta.url),
);

const options = parseArgs(process.argv.slice(2));
const target = assertNativeRuntimeTarget(options.target);
const { manifest } = await assertRuntimeInputsManifest({
  inputRoot: options.inputRoot,
  target,
  sourceLockPath: options.sourceLock,
  toolchainsLockPath: options.toolchainsLock,
  expectedObservedBuilderImage:
    process.env.DASCOWORK_PRIMARY_RUNTIME_BUILDER_IMAGE,
});
const commands = [];
const nativeExecutableExtension = target.startsWith("win32") ? ".exe" : "";
const binaries = Object.fromEntries(
  [
    ["pdfinfo", "poppler/bin/pdfinfo"],
    ["pdftoppm", "poppler/bin/pdftoppm"],
    ["officecli", "officecli/officecli"],
  ].map(([name, relativePath]) => {
    const executableExtension =
      name === "officecli" && target.startsWith("win32")
        ? ".exe"
        : nativeExecutableExtension;
    return [
      name,
      join(options.inputRoot, "dependencies/native", `${relativePath}${executableExtension}`),
    ];
  }),
);
const nativeClosureEntrypoints = [
  binaries.pdfinfo,
  binaries.pdftoppm,
  binaries.officecli,
];

for (const [label, path] of Object.entries(binaries)) {
  await assertTargetExecutable(path, target, label);
}
for (const path of nativeClosureEntrypoints) {
  await assertTargetExecutable(path, target, "native-closure-entrypoint");
}
commands.push(
  await assertNativeDependencyClosure({
    target,
    nativeRoot: join(options.inputRoot, "dependencies/native"),
    entrypoints: nativeClosureEntrypoints,
  }),
);
const font = await findLockedFont(join(options.inputRoot, "fonts"));

commands.push(await runCommand("poppler-pdfinfo-version", binaries.pdfinfo, ["-v"]));
commands.push(await runCommand("poppler-pdftoppm-version", binaries.pdftoppm, ["-v"]));
const officeCliIsolationContext = await createOfficeCliIsolationContext({
  target,
  officecliPath: binaries.officecli,
});
try {
  await probeOfficeCliExecutionAudit({
    context: officeCliIsolationContext,
    timeoutMs: Math.min(defaultCommandTimeoutMs, 45_000),
  });
  const officeCliNetworkProbe = await probeOfficeCliIsolation({
    target,
    officecliPath: binaries.officecli,
    context: officeCliIsolationContext,
    timeoutMs: Math.min(defaultCommandTimeoutMs, 45_000),
  });
  const commandContext = createCommandExecutionContext({
    target,
    officecli: binaries.officecli,
    officeCliIsolationContext,
  });
  commands.push(
    await runCommand("officecli-version", binaries.officecli, ["--version"], {
      OFFICECLI_SKIP_UPDATE: "1",
      OFFICECLI_NO_AUTO_RESIDENT: "1",
    }, { commandContext }),
  );

  const render = await renderOfficeCliSmoke({
    target,
    officecli: binaries.officecli,
    commandContext,
  });
  commands.push(...render.commands);

  const receipt = {
    schemaVersion: "dascowork-primary-runtime-input-validation.v1",
    status: "verified",
    target,
    runner: process.env.RUNNER_IMAGE ?? manifest.builder.runner,
    inputManifestSha256: sha256(
      await readFile(join(options.inputRoot, "runtime-inputs.manifest.json")),
    ),
    sourceLockSha256: manifest.sourceLockSha256,
    toolchainsLockSha256: manifest.toolchainsLockSha256,
    font: {
      path: relative(options.inputRoot, font.path).split(sep).join("/"),
      sha256: sha256(await readFile(font.path)),
    },
    isolation: await officeCliIsolationReceipt({
      target,
      officecli: binaries.officecli,
      context: officeCliIsolationContext,
      networkProbe: officeCliNetworkProbe,
      commands,
    }),
    render,
    commands,
    productionTrust: false,
  };
  if (options.receiptPath) {
    await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await officeCliIsolationContext.cleanup();
}

async function assertTargetExecutable(path, target, label) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new Error(`AT-RT-INPUT-01 blocked: ${label} executable is missing.`);
  }
  if (!details.isFile() || details.isSymbolicLink() || details.size < 4) {
    throw new Error(`AT-RT-INPUT-01 blocked: ${label} is not a regular executable.`);
  }
  const header = await readFirstBytes(path, 4);
  if (!hasExpectedExecutableHeader(header, target, label)) {
    throw new Error(`AT-RT-INPUT-01 blocked: ${label} has the wrong executable format for ${target}.`);
  }
}

/**
 * A successful smoke test alone is not enough evidence that the archive is
 * self-contained: a hosted runner can happen to provide a developer-library
 * dependency.  Inspect every native ELF/Mach-O object and reject dependency
 * paths outside the Runtime or the platform's documented system locations.
 * PE imports are parsed directly so this check does not depend on a mutable
 * Visual Studio installation on the Windows runner.
 */
async function assertNativeDependencyClosure({ target, nativeRoot, entrypoints }) {
  if (target.startsWith("win32")) {
    return inspectPeDependencyClosure({ nativeRoot, entrypoints });
  }
  const objects = [...new Set(entrypoints)].sort((left, right) => left.localeCompare(right));
  const inspected = [];
  for (const object of objects) {
    const result = target.startsWith("darwin")
      ? await inspectMachODependencies({ object, nativeRoot })
      : await inspectElfDependencies({ object, nativeRoot });
    inspected.push(`${relative(nativeRoot, object)}\n${result}`);
  }
  return {
    name: "native-dependency-closure",
    executable: target.startsWith("darwin") ? "otool" : "ldd",
    args: [String(objects.length), "native-entrypoints"],
    resultSha256: sha256(inspected.join("\n")),
  };
}

async function inspectPeDependencyClosure({ nativeRoot, entrypoints }) {
  const nativeFiles = [];
  await walk(nativeRoot, async (path) => {
    if (/\.(?:exe|dll)$/iu.test(path)) nativeFiles.push(path);
  });
  if (nativeFiles.length === 0 || entrypoints.length === 0) {
    throw new Error("AT-RT-INPUT-01 blocked: native PE dependency closure has no executable or DLL payload.");
  }
  const bundledLibraries = new Set(
    nativeFiles.map((path) => basename(path).toLowerCase()),
  );
  const inspected = [];
  for (const path of [...new Set(entrypoints)].sort((left, right) => left.localeCompare(right))) {
    const imports = readPeImports(await readFile(path));
    for (const imported of imports) {
      if (bundledLibraries.has(imported) || isWindowsSystemLibrary(imported)) {
        continue;
      }
      throw new Error(
        `AT-RT-INPUT-01 blocked: ${relative(nativeRoot, path)} imports unbundled ${imported}.`,
      );
    }
    inspected.push(`${relative(nativeRoot, path)}\n${imports.join("\n")}`);
  }
  return {
    name: "native-dependency-closure",
    executable: "internal-pe-import-parser",
    args: [String(entrypoints.length), "native-pe-entrypoints"],
    resultSha256: sha256(inspected.join("\n")),
  };
}

function readPeImports(bytes) {
  if (bytes.length < 0x40) {
    throw new Error("AT-RT-INPUT-01 blocked: native PE dependency payload is truncated.");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    bytes.subarray(0, 2).toString("ascii") !== "MZ" ||
    peOffset + 24 > bytes.length ||
    bytes.subarray(peOffset, peOffset + 4).toString("ascii") !== "PE\u0000\u0000"
  ) {
    throw new Error("AT-RT-INPUT-01 blocked: native PE dependency payload is malformed.");
  }
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const optionalMagic = bytes.readUInt16LE(optionalOffset);
  const directoryOffset =
    optionalMagic === 0x10b
      ? optionalOffset + 96
      : optionalMagic === 0x20b
        ? optionalOffset + 112
        : -1;
  if (directoryOffset < 0 || directoryOffset + 16 > bytes.length) {
    throw new Error("AT-RT-INPUT-01 blocked: native PE optional header is malformed.");
  }
  const importRva = bytes.readUInt32LE(directoryOffset + 8);
  if (importRva === 0) return [];
  const sectionOffset = optionalOffset + optionalSize;
  const rvaToOffset = (rva) => {
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sectionOffset + index * 40;
      if (section + 40 > bytes.length) break;
      const virtualSize = bytes.readUInt32LE(section + 8);
      const virtualAddress = bytes.readUInt32LE(section + 12);
      const rawSize = bytes.readUInt32LE(section + 16);
      const rawOffset = bytes.readUInt32LE(section + 20);
      if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
        return rawOffset + rva - virtualAddress;
      }
    }
    throw new Error("AT-RT-INPUT-01 blocked: native PE import RVA is outside its sections.");
  };
  const imports = [];
  for (let descriptor = rvaToOffset(importRva); descriptor + 20 <= bytes.length; descriptor += 20) {
    const nameRva = bytes.readUInt32LE(descriptor + 12);
    if (nameRva === 0) break;
    const nameOffset = rvaToOffset(nameRva);
    const end = bytes.indexOf(0, nameOffset);
    if (end < nameOffset) {
      throw new Error("AT-RT-INPUT-01 blocked: native PE import name is malformed.");
    }
    imports.push(bytes.subarray(nameOffset, end).toString("ascii").toLowerCase());
  }
  return [...new Set(imports)].sort((left, right) => left.localeCompare(right));
}

function isWindowsSystemLibrary(name) {
  return (
    /^api-ms-win-[a-z0-9-]+\.dll$/u.test(name) ||
    /^ext-ms-win-[a-z0-9-]+\.dll$/u.test(name) ||
    new Set([
      "advapi32.dll",
      "bcrypt.dll",
      "comctl32.dll",
      "comdlg32.dll",
      "crypt32.dll",
      "dwmapi.dll",
      "gdi32.dll",
      "gdiplus.dll",
      "imm32.dll",
      "kernel32.dll",
      "kernelbase.dll",
      "mpr.dll",
      "msimg32.dll",
      "netapi32.dll",
      "ntdll.dll",
      "ole32.dll",
      "oleacc.dll",
      "oleaut32.dll",
      "propsys.dll",
      "psapi.dll",
      "rpcrt4.dll",
      "secur32.dll",
      "setupapi.dll",
      "shell32.dll",
      "shlwapi.dll",
      "ucrtbase.dll",
      "user32.dll",
      "userenv.dll",
      "version.dll",
      "winhttp.dll",
      "winmm.dll",
      "winspool.drv",
      "wintrust.dll",
      "ws2_32.dll",
    ]).has(name)
  );
}

async function inspectMachODependencies({ object, nativeRoot }) {
  const { output: outputBytes } = await runRawCommand({
    file: "otool",
    args: ["-L", object],
    name: `otool ${relative(nativeRoot, object)}`,
  });
  const output = outputBytes.toString("utf8");
  for (const line of output.split(/\r?\n/u).slice(1)) {
    const match = line.trim().match(/^(.+?)\s+\(/u);
    if (!match) continue;
    const dependency = match[1];
    if (basename(dependency) === basename(object)) continue;
    if (
      dependency.startsWith("@") ||
      dependency.startsWith("/usr/lib/") ||
      dependency.startsWith("/System/Library/")
    ) {
      continue;
    }
    if (!isPathInside(nativeRoot, dependency)) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: ${relative(nativeRoot, object)} links host dependency ${dependency}.`,
      );
    }
  }
  return output;
}

async function inspectElfDependencies({ object, nativeRoot }) {
  const { output: outputBytes } = await runRawCommand({
    file: "ldd",
    args: [object],
    name: `ldd ${relative(nativeRoot, object)}`,
  });
  const output = outputBytes.toString("utf8");
  for (const line of output.split(/\r?\n/u)) {
    if (/not found/iu.test(line)) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: ${relative(nativeRoot, object)} has an unresolved ELF dependency: ${line.trim()}.`,
      );
    }
    const match = line.match(/=>\s+(\/[^\s(]+)/u) ?? line.match(/^\s*(\/[^\s(]+)/u);
    if (!match) continue;
    const dependency = match[1];
    if (
      dependency.startsWith("/lib/") ||
      dependency.startsWith("/lib64/") ||
      dependency.startsWith("/usr/lib/") ||
      isPathInside(nativeRoot, dependency)
    ) {
      continue;
    }
    throw new Error(
      `AT-RT-INPUT-01 blocked: ${relative(nativeRoot, object)} links host dependency ${dependency}.`,
    );
  }
  return output;
}

function isPathInside(root, candidate) {
  const diff = relative(resolve(root), resolve(candidate));
  return diff !== "" && !diff.startsWith("..") && !diff.split(sep).includes("..");
}

function hasExpectedExecutableHeader(header, target, label) {
  if (label === "soffice" && header.subarray(0, 2).toString("ascii") === "#!") return true;
  if (header.length < 4) return false;
  if (target.startsWith("win32")) return header.subarray(0, 2).toString("ascii") === "MZ";
  if (target.startsWith("linux")) return header[0] === 0x7f && header.subarray(1, 4).toString("ascii") === "ELF";
  const magic = header.readUInt32BE(0);
  return magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xcafebabe || magic === 0xbebafeca;
}




async function findLockedFont(root) {
  const fonts = [];
  await walk(root, async (path) => {
    if (/\.(?:ttf|otf)$/iu.test(path)) fonts.push(path);
  });
  if (fonts.length === 0) {
    throw new Error("AT-RT-INPUT-01 blocked: no locked Chinese font was materialized.");
  }
  const path = fonts.sort((left, right) => left.localeCompare(right))[0];
  const header = await readFirstBytes(path, 4);
  const signature = header.toString("ascii");
  if (!["\u0000\u0001\u0000\u0000", "OTTO", "true", "typ1"].includes(signature)) {
    throw new Error("AT-RT-INPUT-01 blocked: locked font is not a supported OpenType payload.");
  }
  return { path };
}

async function walk(root, onFile) {
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch {
    throw new Error(`AT-RT-INPUT-01 blocked: required Runtime directory is missing: ${root}`);
  }
  for (const child of children) {
    const path = join(root, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(`AT-RT-INPUT-01 blocked: Runtime input has symbolic link ${path}.`);
    }
    if (child.isDirectory()) await walk(path, onFile);
    else if (child.isFile()) await onFile(path);
    else throw new Error(`AT-RT-INPUT-01 blocked: Runtime input has unsupported entry ${path}.`);
  }
}

async function readFirstBytes(path, length) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function renderOfficeCliSmoke({ target, officecli, commandContext }) {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-officecli-"));
  const created = {
    docx: join(directory, "runtime-created.docx"),
    xlsx: join(directory, "runtime-created.xlsx"),
    pptx: join(directory, "runtime-created.pptx"),
  };
  const originals = {
    docx: join(directory, "runtime-complex-original.docx"),
    xlsx: join(directory, "runtime-complex-original.xlsx"),
    pptx: created.pptx,
  };
  const edited = {
    docx: join(directory, "runtime-edited.docx"),
    xlsx: join(directory, "runtime-edited.xlsx"),
    pptx: join(directory, "runtime-edited.pptx"),
  };
  const svg = join(directory, "runtime-edited.svg");
  const commands = [];
  const officeCliEnvironment = {
    OFFICECLI_SKIP_UPDATE: "1",
    OFFICECLI_NO_AUTO_RESIDENT: "1",
  };
  try {
    await copyFile(join(officeCliFixtureRoot, "complex-existing.docx"), originals.docx);
    await copyFile(join(officeCliFixtureRoot, "complex-existing.xlsx"), originals.xlsx);
    await assertComplexDocxFixture(originals.docx, { edited: false });
    await assertComplexXlsxFixture(originals.xlsx);
    commands.push(
      await runJsonCommand(
        "officecli-read-complex-docx-original",
        officecli,
        ["get", originals.docx, "/body", "--depth", "4", "--json"],
        officeCliEnvironment,
        {
          commandContext,
          expectedTextIncludes: ["既有DOCX中文段落", "table"],
        },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-read-complex-xlsx-original",
        officecli,
        ["get", originals.xlsx, "/Sheet1", "--depth", "2", "--json"],
        officeCliEnvironment,
        {
          commandContext,
          expectedTextIncludes: ["SUM(B2:B3)", "chart"],
        },
      ),
    );

    for (const [kind, path] of Object.entries(created)) {
      commands.push(
        await runJsonCommand(
          `officecli-create-${kind}-original`,
          officecli,
          ["create", path, "--json"],
          officeCliEnvironment,
          { commandContext, expectedTextIncludes: ["Created:"] },
        ),
      );
      commands.push(
        await runJsonCommand(
          `officecli-read-${kind}-original`,
          officecli,
          ["get", path, "/", "--json"],
          officeCliEnvironment,
          { commandContext },
        ),
      );
    }
    await copyFile(originals.docx, edited.docx);
    await copyFile(originals.xlsx, edited.xlsx);
    await copyFile(originals.pptx, edited.pptx);

    const originalSha256 = Object.fromEntries(
      await Promise.all(
        Object.entries(originals).map(async ([kind, path]) => [
          kind,
          sha256(await readFile(path)),
        ]),
      ),
    );

    commands.push(
      await runJsonCommand(
        "officecli-add-docx-paragraph-copy",
        officecli,
        [
          "add",
          edited.docx,
          "/body",
          "--type",
          "paragraph",
          "--prop",
          "text=Runtime 中文验证",
          "--json",
        ],
        officeCliEnvironment,
        { commandContext },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-save-docx-copy",
        officecli,
        ["save", edited.docx, "--json"],
        officeCliEnvironment,
        { commandContext },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-validate-docx-copy",
        officecli,
        ["validate", edited.docx, "--json"],
        officeCliEnvironment,
        { commandContext, validateNoErrors: true },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-reread-docx-copy",
        officecli,
        ["get", edited.docx, "/body", "--depth", "4", "--json"],
        officeCliEnvironment,
        {
          commandContext,
          expectedTextIncludes: ["Runtime 中文验证", "既有DOCX中文段落", "第一季"],
        },
      ),
    );
    await assertComplexDocxFixture(edited.docx, { edited: true });

    commands.push(
      await runJsonCommand(
        "officecli-add-xlsx-cell-copy",
        officecli,
        [
          "add",
          edited.xlsx,
          "/Sheet1",
          "--type",
          "cell",
          "--prop",
          "address=C1",
          "--prop",
          "value=Runtime 中文验证",
          "--json",
        ],
        officeCliEnvironment,
        { commandContext },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-save-xlsx-copy",
        officecli,
        ["save", edited.xlsx, "--json"],
        officeCliEnvironment,
        { commandContext },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-validate-xlsx-copy",
        officecli,
        ["validate", edited.xlsx, "--json"],
        officeCliEnvironment,
        { commandContext, validateNoErrors: true },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-reread-xlsx-copy",
        officecli,
        ["get", edited.xlsx, "/Sheet1/C1", "--json"],
        officeCliEnvironment,
        {
          commandContext,
          expectedTextIncludes: ["Runtime 中文验证"],
        },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-reread-xlsx-formula-copy",
        officecli,
        ["get", edited.xlsx, "/Sheet1/B4", "--json"],
        officeCliEnvironment,
        {
          commandContext,
          expectedTextIncludes: ["SUM(B2:B3)", "25"],
        },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-reread-xlsx-chart-copy",
        officecli,
        ["get", edited.xlsx, "/Sheet1/chart[1]", "--json"],
        officeCliEnvironment,
        {
          commandContext,
          expectedTextIncludes: ["seriesCount", "categoriesRef"],
        },
      ),
    );
    await assertComplexXlsxFixture(edited.xlsx);

    commands.push(
      await runJsonCommand(
        "officecli-add-pptx-slide-copy",
        officecli,
        ["add", edited.pptx, "/", "--type", "slide", "--json"],
        officeCliEnvironment,
        { commandContext },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-add-pptx-text-copy",
        officecli,
        [
          "add",
          edited.pptx,
          "/slide[1]",
          "--type",
          "shape",
          "--prop",
          "text=Runtime 中文验证",
          "--prop",
          "x=1",
          "--prop",
          "y=1",
          "--prop",
          "w=8",
          "--prop",
          "h=1",
          "--json",
        ],
        officeCliEnvironment,
        { commandContext },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-save-pptx-copy",
        officecli,
        ["save", edited.pptx, "--json"],
        officeCliEnvironment,
        { commandContext },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-validate-pptx-copy",
        officecli,
        ["validate", edited.pptx, "--json"],
        officeCliEnvironment,
        { commandContext, validateNoErrors: true },
      ),
    );
    commands.push(
      await runJsonCommand(
        "officecli-reread-pptx-copy",
        officecli,
        ["get", edited.pptx, "/slide[1]", "--json"],
        officeCliEnvironment,
        { commandContext, expectedTextIncludes: ["Runtime 中文验证"] },
      ),
    );

    const svgResult = await runCommand(
      "officecli-view-pptx-svg-copy",
      officecli,
      ["view", edited.pptx, "svg", "--start", "1", "--max-lines", "1"],
      officeCliEnvironment,
      { commandContext, captureOutput: true },
    );
    await writeFile(svg, svgResult.output);
    commands.push(stripCommandOutput(svgResult));

    const [docxBytes, xlsxBytes, pptxBytes, svgBytes] = await Promise.all([
      readFile(edited.docx),
      readFile(edited.xlsx),
      readFile(edited.pptx),
      readFile(svg),
    ]);
    if (!svgBytes.toString("utf8").includes("<svg")) {
      throw new Error("AT-RT-INPUT-01 blocked: OfficeCLI did not emit SVG preview output.");
    }
    for (const [kind, path] of Object.entries(originals)) {
      const current = sha256(await readFile(path));
      if (current !== originalSha256[kind]) {
        throw new Error(`AT-RT-INPUT-01 blocked: OfficeCLI smoke modified original ${kind}.`);
      }
    }
    return {
      target,
      engine: "officecli",
      originalSha256,
      docxSha256: sha256(docxBytes),
      xlsxSha256: sha256(xlsxBytes),
      pptxSha256: sha256(pptxBytes),
      svgSha256: sha256(svgBytes),
      commands,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runJsonCommand(name, file, args, environment = undefined, options = {}) {
  const command = await runCommand(name, file, args, environment, {
    captureOutput: true,
    allowedExitCodes: [0, 2],
    commandContext: options.commandContext,
  });
  let parsed;
  try {
    parsed = JSON.parse(command.output.toString("utf8"));
  } catch (error) {
    throw new Error(`AT-RT-INPUT-01 blocked: ${name} did not emit JSON: ${String(error.message ?? error)}`);
  }
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  if (command.exitCode !== 0 || parsed.success !== true || warnings.length > 0) {
    throw new Error(
      `AT-RT-INPUT-01 blocked: ${name} reported OfficeCLI caveats or failure.`,
    );
  }
  if (options.validateNoErrors && Number(parsed.data?.count ?? 0) !== 0) {
    throw new Error(`AT-RT-INPUT-01 blocked: ${name} reported validation errors.`);
  }
  const parsedText = JSON.stringify(parsed);
  for (const expected of options.expectedTextIncludes ?? []) {
    if (!parsedText.includes(expected)) {
      throw new Error(`AT-RT-INPUT-01 blocked: ${name} did not report expected ${expected}.`);
    }
  }
  return {
    ...stripCommandOutput(command),
    jsonSuccess: parsed.success,
    warningCount: warnings.length,
  };
}

function stripCommandOutput(command) {
  const { output, ...withoutOutput } = command;
  return withoutOutput;
}

async function assertComplexDocxFixture(path, { edited }) {
  const entries = await readZipEntries(path);
  const documentXml = requiredZipText(entries, "word/document.xml", path);
  for (const expected of [
    "既有DOCX中文段落",
    "<w:tbl>",
    "季度",
    "收入",
    "第一季",
    "128",
  ]) {
    assertTextIncludes(documentXml, expected, `${path}: complex DOCX fixture`);
  }
  if (edited) {
    assertTextIncludes(documentXml, "Runtime 中文验证", `${path}: edited DOCX copy`);
  } else if (documentXml.includes("Runtime 中文验证")) {
    throw new Error(`AT-RT-INPUT-01 blocked: original DOCX fixture already contains edit marker.`);
  }
}

async function assertComplexXlsxFixture(path) {
  const entries = await readZipEntries(path);
  for (const entry of [
    "xl/worksheets/sheet1.xml",
    "xl/worksheets/_rels/sheet1.xml.rels",
    "xl/drawings/drawing1.xml",
    "xl/drawings/_rels/drawing1.xml.rels",
    "xl/drawings/charts/chart1.xml",
  ]) {
    requiredZipText(entries, entry, path);
  }
  const sheetXml = requiredZipText(entries, "xl/worksheets/sheet1.xml", path);
  const chartXml = requiredZipText(entries, "xl/drawings/charts/chart1.xml", path);
  const sheetRelsXml = requiredZipText(entries, "xl/worksheets/_rels/sheet1.xml.rels", path);
  const drawingRelsXml = requiredZipText(entries, "xl/drawings/_rels/drawing1.xml.rels", path);
  const workbookText = [...entries.values()].map((entry) => entry.toString("utf8")).join("\n");
  for (const expected of ["项目", "收入", "甲", "乙"]) {
    assertTextIncludes(workbookText, expected, `${path}: complex XLSX text`);
  }
  for (const expected of ["SUM(B2:B3)", "<x:v>25</x:v>"]) {
    assertTextIncludes(sheetXml, expected, `${path}: complex XLSX worksheet`);
  }
  for (const expected of ["Sheet1!$A$2:$A$3", "Sheet1!$B$2:$B$3", "<c:barChart>"]) {
    assertTextIncludes(chartXml, expected, `${path}: complex XLSX chart`);
  }
  assertTextIncludes(sheetRelsXml, "drawing1.xml", `${path}: worksheet relationships`);
  assertTextIncludes(drawingRelsXml, "chart1.xml", `${path}: drawing relationships`);
}

async function readZipEntries(path) {
  const bytes = await readFile(path);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new Error(`AT-RT-INPUT-01 blocked: ${path} is not a readable ZIP Office file.`);
  }
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`AT-RT-INPUT-01 blocked: ${path} has a malformed ZIP central directory.`);
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const fileNameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    entries.set(name, inflateZipEntry(method, compressed, path, name));
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function inflateZipEntry(method, compressed, path, name) {
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`AT-RT-INPUT-01 blocked: ${path} entry ${name} uses unsupported ZIP method ${method}.`);
}

function requiredZipText(entries, name, path) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`AT-RT-INPUT-01 blocked: ${path} is missing ${name}.`);
  return entry.toString("utf8");
}

function assertTextIncludes(text, expected, context) {
  if (!text.includes(expected)) {
    throw new Error(`AT-RT-INPUT-01 blocked: ${context} does not preserve ${expected}.`);
  }
}

function createCommandExecutionContext({
  target,
  officecli,
  officeCliIsolationContext,
} = {}) {
  return {
    baseEnvironment: process.env,
    async run({ file, args, name, allowedExitCodes }) {
      if (!officecli || resolve(file) !== resolve(officecli)) return null;
      const isolated = await runOfficeCliIsolated({
        target,
        officecliPath: officecli,
        executable: file,
        args,
        name,
        allowedExitCodes,
        context: officeCliIsolationContext,
        timeoutMs: defaultCommandTimeoutMs,
        probeNetwork: false,
      });
      return {
        output: isolated.command.stdout ?? isolated.command.output,
        stderr: isolated.command.stderr,
        elapsedMs: isolated.command.elapsedMs,
        exitCode: isolated.command.exitCode,
        signal: isolated.command.signal,
      };
    },
    resolveInvocation({ file, args, environment, cwd }) {
      return { file, args, environment, cwd };
    },
  };
}

async function officeCliIsolationReceipt({ target, officecli, context, networkProbe, commands }) {
  const officeCommands = commands.filter((command) => command.executable === basename(officecli));
  if (
    context.executionProbeReceipt?.passed !== true ||
    officeCommands.length === 0 ||
    context.executionCommandReceipts.length !== officeCommands.length ||
    context.executionCommandReceipts.some((command, index) =>
      command.passed !== true ||
      command.name !== officeCommands[index].name ||
      command.exitCode !== officeCommands[index].exitCode ||
      JSON.stringify(command.args) !== JSON.stringify(officeCommands[index].args)
    )
  ) {
    throw new Error("OfficeCLI input validation has no complete executable exclusion evidence.");
  }
  return {
    schemaVersion: context.schemaVersion,
    target,
    officecliSha256: sha256(await readFile(officecli)),
    strategy: context.strategy.kind,
    host: context.host,
    envReceipt: {
      pathEntries: String(context.env.PATH ?? "").split(delimiter).filter(Boolean),
      home: context.env.HOME,
      userProfile: context.env.USERPROFILE,
      xdgCacheHome: context.env.XDG_CACHE_HOME,
      xdgConfigHome: context.env.XDG_CONFIG_HOME,
      dotnetCliHome: context.env.DOTNET_CLI_HOME,
      officeCliSkipUpdate: context.env.OFFICECLI_SKIP_UPDATE,
      officeCliNoAutoResident: context.env.OFFICECLI_NO_AUTO_RESIDENT,
    },
    networkProbe,
    executionAudit: {
      probe: context.executionProbeReceipt,
      commands: context.executionCommandReceipts,
    },
  };
}



function runtimeUtilityPaths(target) {
  if (target.startsWith("win32")) {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    return [`${systemRoot}\\System32`, systemRoot];
  }
  return target.startsWith("darwin")
    ? ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    : ["/usr/bin", "/bin"];
}

function escapeXml(value) {
  return value.replace(/[<>&"']/gu, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);
}

async function runCommand(name, file, args, environment = undefined, options = {}) {
  process.stderr.write(
    `[primary-runtime:verify-inputs] start ${name} (timeout ${defaultCommandTimeoutMs}ms)\n`,
  );
  const { output, elapsedMs, exitCode } = await runRawCommand({
    file,
    args,
    environment,
    name,
    allowedExitCodes: options.allowedExitCodes,
    commandContext: options.commandContext,
  });
  process.stderr.write(`[primary-runtime:verify-inputs] ok ${name} (${elapsedMs}ms)\n`);
  return {
    name,
    executable: basename(file),
    args,
    exitCode,
    resultSha256: createHash("sha256").update(output).digest("hex"),
    ...(options.captureOutput ? { output } : {}),
  };
}

async function runRawCommand({
  file,
  args,
  environment = undefined,
  name,
  allowedExitCodes = [0],
  commandContext = createCommandExecutionContext(),
}) {
  const delegated = await commandContext.run?.({
    file,
    args,
    environment,
    name,
    allowedExitCodes,
  });
  if (delegated) return delegated;
  const invocation = await commandContext.resolveInvocation({
    file,
    args,
    environment,
    cwd: commandContext.cwd,
    name,
  });
  return new Promise((resolveCommand, rejectCommand) => {
    const startedAt = Date.now();
    const child = spawn(invocation.file, invocation.args, {
      env: invocation.env ?? {
        ...commandContext.baseEnvironment,
        PYTHONDONTWRITEBYTECODE: "1",
        ...(invocation.environment ?? environment),
        NO_PROXY: "*",
      },
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let settled = false;
    let timedOut = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
    }, defaultCommandTimeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", (error) => finish(() => rejectCommand(error)));
    child.once("exit", (code, signal) => {
      finish(() => {
        const elapsedMs = Date.now() - startedAt;
        const outputBytes = Buffer.concat(output);
        const capturedOutput = outputBytes.toString("utf8").slice(-capturedCommandOutputBytes);
        if (allowedExitCodes.includes(code) && !timedOut) {
          resolveCommand({ output: outputBytes, elapsedMs, exitCode: code });
          return;
        }
        const reason = timedOut
          ? `timed out after ${defaultCommandTimeoutMs}ms`
          : `failed with ${code ?? signal ?? "unknown"}`;
        rejectCommand(
          new Error(`${name} ${reason}: ${capturedOutput.slice(-500) || "no command output"}`),
        );
      });
    });
  });
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds.`);
  }
  return value;
}


function parseArgs(argv) {
  const target = parseRuntimeTargetOption(argv);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (!new Set(["--target", "--input-root", "--receipt", "--source-lock", "--toolchains-lock"]).has(name)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`Expected a value for ${name}.`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  const required = (name) => {
    const value = values.get(name);
    if (!value) throw new Error(`Expected ${name} <path>.`);
    return resolve(value);
  };
  return {
    target: target ?? required("--target"),
    inputRoot: required("--input-root"),
    receiptPath: values.has("--receipt") ? resolve(values.get("--receipt")) : undefined,
    sourceLock: resolve(
      values.get("--source-lock") ??
        fileURLToPath(new URL("../runtime-sources.lock.json", import.meta.url)),
    ),
    toolchainsLock: resolve(
      values.get("--toolchains-lock") ??
        fileURLToPath(
          new URL("../runtime-toolchains.lock.json", import.meta.url),
        ),
    ),
  };
}
