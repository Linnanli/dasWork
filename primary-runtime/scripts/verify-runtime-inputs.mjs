#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import { assertRuntimeInputsManifest } from "./runtime-inputs.mjs";
import { readRuntimeSourcesLock, sha256 } from "./source-lock.mjs";
import { assertNativeRuntimeTarget, parseRuntimeTargetOption } from "./runtime-target.mjs";

const options = parseArgs(process.argv.slice(2));
const target = assertNativeRuntimeTarget(options.target);
const { manifest } = await assertRuntimeInputsManifest({
  inputRoot: options.inputRoot,
  target,
  sourceLockPath: options.sourceLock,
  toolchainsLockPath: options.toolchainsLock,
});
const sourceLock = await readRuntimeSourcesLock(options.sourceLock);
const commands = [];
const extension = target.startsWith("win32") ? ".exe" : "";
const node = join(options.inputRoot, "dependencies/node/bin", `node${extension}`);
const python = join(options.inputRoot, "dependencies/python/bin", `python${extension}`);
const binaries = Object.fromEntries(
  [
    ["soffice", "libreoffice/program/soffice"],
    ["pdfinfo", "poppler/bin/pdfinfo"],
    ["pdftoppm", "poppler/bin/pdftoppm"],
  ].map(([name, relativePath]) => [
    name,
    join(options.inputRoot, "dependencies/native", `${relativePath}${extension}`),
  ]),
);

for (const [label, path] of Object.entries({ node, python, ...binaries })) {
  await assertTargetExecutable(path, target, label);
}
commands.push(
  await assertNativeDependencyClosure({
    target,
    nativeRoot: join(options.inputRoot, "dependencies/native"),
  }),
);
await assertNodeClosure({ inputRoot: options.inputRoot, components: sourceLock.components.node });
await assertPythonClosure({ inputRoot: options.inputRoot, components: sourceLock.components.python });
const font = await findLockedFont(join(options.inputRoot, "fonts"));

commands.push(await runCommand("node-version", node, ["--version"]));
commands.push(
  await runCommand(
    "node-pptxgenjs-load",
    node,
    ["--no-addons", "-e", "require('pptxgenjs'); require('jszip'); process.stdout.write('node-closure-ok\\n')"],
    { NODE_PATH: join(options.inputRoot, "dependencies/node/node_modules") },
  ),
);
commands.push(
  await runCommand(
    "python-closure-import",
    python,
    [
      "-c",
      "import pptx, PIL, lxml, xlsxwriter, typing_extensions; print('python-closure-ok')",
    ],
    { PYTHONPATH: join(options.inputRoot, "dependencies/python/packages"), PYTHONNOUSERSITE: "1" },
  ),
);
commands.push(await runCommand("libreoffice-version", binaries.soffice, ["--headless", "--version"]));
commands.push(await runCommand("poppler-pdfinfo-version", binaries.pdfinfo, ["-v"]));
commands.push(await runCommand("poppler-pdftoppm-version", binaries.pdftoppm, ["-v"]));

const render = await renderChineseDeck({
  target,
  node,
  soffice: binaries.soffice,
  pdfinfo: binaries.pdfinfo,
  pdftoppm: binaries.pdftoppm,
  inputRoot: options.inputRoot,
  font,
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
  render,
  commands,
  productionTrust: false,
};
if (options.receiptPath) {
  await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

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
async function assertNativeDependencyClosure({ target, nativeRoot }) {
  if (target.startsWith("win32")) {
    return inspectPeDependencyClosure(nativeRoot);
  }
  const objects = [];
  await walk(nativeRoot, async (path) => {
    const header = await readFirstBytes(path, 4);
    if (hasExpectedExecutableHeader(header, target, "native-object")) {
      objects.push(path);
    }
  });
  if (objects.length === 0) {
    throw new Error("AT-RT-INPUT-01 blocked: native dependency closure has no inspectable objects.");
  }
  const inspected = [];
  for (const object of objects.sort((left, right) => left.localeCompare(right))) {
    const result = target.startsWith("darwin")
      ? await inspectMachODependencies({ object, nativeRoot })
      : await inspectElfDependencies({ object, nativeRoot });
    inspected.push(`${relative(nativeRoot, object)}\n${result}`);
  }
  return {
    name: "native-dependency-closure",
    executable: target.startsWith("darwin") ? "otool" : "ldd",
    args: [String(objects.length), "native-objects"],
    resultSha256: sha256(inspected.join("\n")),
  };
}

async function inspectPeDependencyClosure(nativeRoot) {
  const nativeFiles = [];
  await walk(nativeRoot, async (path) => {
    if (/\.(?:exe|dll)$/iu.test(path)) nativeFiles.push(path);
  });
  if (nativeFiles.length === 0) {
    throw new Error("AT-RT-INPUT-01 blocked: native PE dependency closure has no executable or DLL payload.");
  }
  const bundledLibraries = new Set(
    nativeFiles.map((path) => basename(path).toLowerCase()),
  );
  const inspected = [];
  for (const path of nativeFiles.sort((left, right) => left.localeCompare(right))) {
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
    args: [String(nativeFiles.length), "native-pe-objects"],
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
  const output = (await runRawCommand("otool", ["-L", object])).toString("utf8");
  for (const line of output.split(/\r?\n/u).slice(1)) {
    const match = line.trim().match(/^(.+?)\s+\(/u);
    if (!match) continue;
    const dependency = match[1];
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
  const output = (await runRawCommand("ldd", [object])).toString("utf8");
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
  if (target.startsWith("win32")) return header.subarray(0, 2).toString("ascii") === "MZ";
  if (target.startsWith("linux")) return header[0] === 0x7f && header.subarray(1, 4).toString("ascii") === "ELF";
  const magic = header.readUInt32BE(0);
  return magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xcafebabe || magic === 0xbebafeca;
}

async function assertNodeClosure({ inputRoot, components }) {
  for (const component of components) {
    const packagePath = join(inputRoot, "dependencies/node/node_modules", component.name, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    if (packageJson.name !== component.name || packageJson.version !== component.version) {
      throw new Error(`AT-RT-INPUT-01 blocked: Node package ${component.name} does not match the source lock.`);
    }
  }
}

async function assertPythonClosure({ inputRoot, components }) {
  const metadata = await findMetadataFiles(join(inputRoot, "dependencies/python/packages"));
  for (const component of components) {
    const expectedName = normalizeDistributionName(component.name);
    const match = metadata.some(({ text }) => {
      const fields = Object.fromEntries(
        text
          .split(/\r?\n/u)
          .filter((line) => line.includes(":"))
          .map((line) => line.split(/:\s*/u, 2)),
      );
      return normalizeDistributionName(fields.Name) === expectedName && fields.Version === component.version;
    });
    if (!match) {
      throw new Error(`AT-RT-INPUT-01 blocked: Python distribution ${component.name} does not match the source lock.`);
    }
  }
}

async function findMetadataFiles(root) {
  const paths = [];
  await walk(root, async (path) => {
    if (basename(path) === "METADATA") paths.push({ path, text: await readFile(path, "utf8") });
  });
  return paths;
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

async function renderChineseDeck({ target, node, soffice, pdfinfo, pdftoppm, inputRoot, font }) {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-render-"));
  const pptx = join(directory, "runtime-input-smoke.pptx");
  const pdf = join(directory, "runtime-input-smoke.pdf");
  const png = join(directory, "runtime-input-smoke.png");
  const script = join(directory, "create-smoke.cjs");
  const fontConfig = join(directory, "fonts.conf");
  const commands = [];
  try {
    await writeFile(
      script,
      [
        "const pptxgen = require('pptxgenjs');",
        "(async () => {",
        "  const pptx = new pptxgen(); pptx.layout = 'LAYOUT_WIDE';",
        "  const cover = pptx.addSlide(); cover.addText('运行时中文封面', { x: 0.7, y: 0.6, w: 10.8, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 28 });",
        "  const table = pptx.addSlide(); table.addText('数据表验证', { x: 0.7, y: 0.6, w: 10.8, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 28 }); table.addTable([[{text:'项目'},{text:'数值'}],[{text:'中文'},{text:'100'}]], { x: 0.7, y: 1.5, w: 6, h: 1 });",
        "  const chart = pptx.addSlide(); chart.addText('图表与图片验证', { x: 0.7, y: 0.6, w: 10.8, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 28 }); chart.addChart(pptx.ChartType.bar, [{ name: '数据', labels: ['甲', '乙'], values: [10, 20] }], { x: 0.7, y: 1.5, w: 5, h: 3 }); chart.addImage({ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', x: 7, y: 1.5, w: 1, h: 1, altText: 'runtime image' });",
        "  await pptx.writeFile({ fileName: process.argv[2] });",
        "})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });",
      ].join("\n"),
    );
    await writeFile(
      fontConfig,
      `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${escapeXml(resolve(inputRoot, "fonts"))}</dir></fontconfig>`,
    );
    commands.push(
      await runCommand(
        "pptxgenjs-create-chinese-deck",
        node,
        [script, pptx],
        { NODE_PATH: join(inputRoot, "dependencies/node/node_modules") },
      ),
    );
    commands.push(
      await runCommand(
        "libreoffice-render-chinese-deck",
        soffice,
        ["--headless", "--convert-to", "pdf", "--outdir", directory, pptx],
        fontEnvironment({ font, fontConfig }),
      ),
    );
    commands.push(await runCommand("pdfinfo-rendered-deck", pdfinfo, [pdf]));
    commands.push(await runCommand("pdftoppm-rendered-deck", pdftoppm, ["-png", "-singlefile", pdf, join(directory, "runtime-input-smoke")]));
    const [pptxBytes, pdfBytes, pngBytes] = await Promise.all([readFile(pptx), readFile(pdf), readFile(png)]);
    return {
      target,
      pptxSha256: sha256(pptxBytes),
      pdfSha256: sha256(pdfBytes),
      renderedPngSha256: sha256(pngBytes),
      commands,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fontEnvironment({ font, fontConfig }) {
  return {
    FONTCONFIG_FILE: fontConfig,
    FONTCONFIG_PATH: resolve(font.path, ".."),
  };
}

function escapeXml(value) {
  return value.replace(/[<>&"']/gu, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);
}

async function runCommand(name, file, args, environment = undefined) {
  const output = await runRawCommand(file, args, environment);
  return { name, executable: basename(file), args, resultSha256: createHash("sha256").update(output).digest("hex") };
}

async function runRawCommand(file, args, environment = undefined) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(file, args, {
      env: { ...process.env, ...environment, NO_PROXY: "*" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveCommand(Buffer.concat(output));
      else rejectCommand(new Error(`${file} ${args.join(" ")} failed with ${code ?? signal ?? "unknown"}: ${Buffer.concat(output).toString("utf8").slice(0, 500)}`));
    });
  });
}

function normalizeDistributionName(value) {
  return String(value ?? "").toLowerCase().replace(/[-_.]+/gu, "-");
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
    sourceLock: resolve(values.get("--source-lock") ?? new URL("../runtime-sources.lock.json", import.meta.url).pathname),
    toolchainsLock: resolve(values.get("--toolchains-lock") ?? new URL("../runtime-toolchains.lock.json", import.meta.url).pathname),
  };
}
