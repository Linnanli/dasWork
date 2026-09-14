#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRuntimeInputsManifest } from "./runtime-inputs.mjs";
import { readRuntimeSourcesLock, sha256 } from "./source-lock.mjs";
import { assertNativeRuntimeTarget, parseRuntimeTargetOption } from "./runtime-target.mjs";

const defaultCommandTimeoutMs = positiveIntegerEnv(
  "DASCOWORK_PRIMARY_RUNTIME_VERIFY_COMMAND_TIMEOUT_MS",
  5 * 60 * 1000,
);
const capturedCommandOutputBytes = 1024 * 1024;

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
const node = target.startsWith("win32")
  ? join(options.inputRoot, "dependencies/node/node.exe")
  : join(options.inputRoot, "dependencies/node/bin/node");
const python = target.startsWith("win32")
  ? join(options.inputRoot, "dependencies/python/python.exe")
  : join(options.inputRoot, "dependencies/python/bin/python");
const libreofficeRuntimePath = target.startsWith("darwin")
  ? "libreoffice/LibreOffice.app/Contents/MacOS/soffice"
  : "libreoffice/program/soffice";
const binaries = Object.fromEntries(
  [
    ["soffice", libreofficeRuntimePath],
    ["pdfinfo", "poppler/bin/pdfinfo"],
    ["pdftoppm", "poppler/bin/pdftoppm"],
  ].map(([name, relativePath]) => [
    name,
    join(options.inputRoot, "dependencies/native", `${relativePath}${extension}`),
  ]),
);
const nativeClosureEntrypoints = [
  target === "linux-x64"
    ? join(options.inputRoot, "dependencies/native/libreoffice/program/soffice.bin")
    : binaries.soffice,
  binaries.pdfinfo,
  binaries.pdftoppm,
];

for (const [label, path] of Object.entries({ node, python, ...binaries })) {
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
const libreOfficeVersionDirectory = target.startsWith("win32")
  ? await mkdtemp(join(tmpdir(), "primary-runtime-lo-version-"))
  : undefined;
try {
  commands.push(
    await runCommand(
      "libreoffice-version",
      binaries.soffice,
      ["--headless", "--version"],
      libreOfficeVersionDirectory
        ? libreOfficeProfileEnvironment({ target, directory: libreOfficeVersionDirectory })
        : undefined,
    ),
  );
} finally {
  if (libreOfficeVersionDirectory) {
    await rm(libreOfficeVersionDirectory, { recursive: true, force: true });
  }
}
commands.push(await runCommand("poppler-pdfinfo-version", binaries.pdfinfo, ["-v"]));
commands.push(await runCommand("poppler-pdftoppm-version", binaries.pdftoppm, ["-v"]));

const render = await renderChineseDeck({
  target,
  node,
  python,
  soffice: binaries.soffice,
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

async function renderChineseDeck({ target, node, python, soffice, pdftoppm, inputRoot, font }) {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-render-"));
  const pptx = join(directory, "runtime-input-smoke.pptx");
  const outline = join(directory, "runtime-input-outline.json");
  const image = join(directory, "runtime-input-image.png");
  const layoutReceipt = join(directory, "runtime-input-layout.json");
  const renderedSlides = join(directory, "rendered-slides");
  const fontConfig = join(directory, "fonts.conf");
  const pluginRoot = join(
    inputRoot,
    "plugins/presentation-skill/plugins/presentation-skill/skills/presentation-skill",
  );
  const buildDeck = join(pluginRoot, "scripts/build_deck_pptxgenjs.js");
  const layoutLint = join(pluginRoot, "scripts/layout_lint.py");
  const renderSlides = join(pluginRoot, "scripts/render_slides.py");
  const nodeModules = join(inputRoot, "dependencies/node/node_modules");
  const pythonPackages = join(inputRoot, "dependencies/python/packages");
  const commands = [];
  try {
    await writeFile(
      outline,
      `${JSON.stringify(pluginSmokeOutline(), null, 2)}\n`,
    );
    await writeFile(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await writeFile(
      fontConfig,
      `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${escapeXml(resolve(inputRoot, "fonts"))}</dir></fontconfig>`,
    );
    commands.push(
      await runCommand(
        "presentation-plugin-create-chinese-deck",
        node,
        [buildDeck, "--outline", outline, "--output", pptx, "--asset-root", directory],
        { PPTX_NODE_MODULES: nodeModules, NODE_PATH: nodeModules },
      ),
    );
    commands.push(
      await runCommand(
        "presentation-plugin-layout-lint",
        python,
        [layoutLint, "--input", pptx, "--outline", outline, "--output", layoutReceipt, "--fail-on-error"],
        {
          PYTHONPATH: [join(pluginRoot, "scripts"), pythonPackages].join(delimiter),
          PYTHONNOUSERSITE: "1",
        },
      ),
    );
    commands.push(
      await runCommand(
        "presentation-plugin-render-slides",
        python,
        [renderSlides, "--input", pptx, "--outdir", renderedSlides, "--format", "png", "--dpi", "72"],
        {
          ...fontEnvironment({ font, fontConfig }),
          ...libreOfficeProfileEnvironment({ target, directory }),
          PYTHONPATH: [join(pluginRoot, "scripts"), pythonPackages].join(delimiter),
          PYTHONNOUSERSITE: "1",
          PPTX_RUNTIME_SOFFICE: soffice,
          PPTX_RUNTIME_PDFTOPPM: pdftoppm,
          PATH: [
            dirname(soffice),
            dirname(pdftoppm),
            ...runtimeUtilityPaths(target),
          ].join(delimiter),
        },
      ),
    );
    const [pptxBytes, layoutReceiptBytes, imageNames] = await Promise.all([
      readFile(pptx),
      readFile(layoutReceipt),
      readdir(renderedSlides),
    ]);
    const layout = JSON.parse(layoutReceiptBytes.toString("utf8"));
    const rendered = imageNames.filter((name) => /^slide-\d+\.png$/u.test(name)).sort();
    if (layout?.summary?.slide_count < 3 || rendered.length < 3) {
      throw new Error(
        "AT-RT-INPUT-01 blocked: Runtime presentation plugin did not create and render at least three slides.",
      );
    }
    const renderedPngBytes = await readFile(join(renderedSlides, rendered[0]));
    return {
      target,
      pptxSha256: sha256(pptxBytes),
      layoutReceiptSha256: sha256(layoutReceiptBytes),
      renderedSlideCount: rendered.length,
      renderedFirstPngSha256: sha256(renderedPngBytes),
      commands,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pluginSmokeOutline() {
  return {
    title: "运行时演示文稿验证",
    subtitle: "从非 PPTX 工作区输入创建并自动 QA",
    slides: [
      {
        type: "title",
        title: "运行时中文封面",
        subtitle: "插件脚本创建的新演示文稿",
      },
      {
        type: "content",
        variant: "table",
        title: "数据表验证",
        subtitle: "来自 outline.json 的非 PPTX 数据",
        headers: ["项目", "数值"],
        rows: [["中文指标", "100"], ["验证状态", "通过"]],
        interpretation: "表格由 Runtime 内 presentation-skill 生成。",
      },
      {
        type: "content",
        variant: "chart",
        title: "图表验证",
        subtitle: "来自 outline.json 的内联数据",
        chart: {
          type: "bar",
          series: [{ name: "数据", labels: ["甲", "乙", "丙"], values: [10, 20, 30] }],
          options: { catAxisTitle: "类别", valAxisTitle: "数值", showValue: true },
        },
        message: "图表由 Runtime 内 presentation-skill 生成。",
      },
      {
        type: "content",
        variant: "image-sidebar",
        title: "工作区图片验证",
        subtitle: "图片来自受控的非 PPTX 工作区文件",
        assets: { image: "runtime-input-image.png" },
        sidebar_sections: [{ title: "图片", body: "由插件从工作区图片输入创建。" }],
      },
    ],
  };
}

function fontEnvironment({ font, fontConfig }) {
  return {
    FONTCONFIG_FILE: fontConfig,
    FONTCONFIG_PATH: resolve(font.path, ".."),
  };
}

function libreOfficeProfileEnvironment({ target, directory }) {
  if (!target.startsWith("win32")) return {};
  const profile = join(directory, "libreoffice-profile");
  return {
    APPDATA: join(profile, "AppData", "Roaming"),
    LOCALAPPDATA: join(profile, "AppData", "Local"),
    USERPROFILE: profile,
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

async function runCommand(name, file, args, environment = undefined) {
  process.stderr.write(
    `[primary-runtime:verify-inputs] start ${name} (timeout ${defaultCommandTimeoutMs}ms)\n`,
  );
  const { output, elapsedMs } = await runRawCommand({ file, args, environment, name });
  process.stderr.write(`[primary-runtime:verify-inputs] ok ${name} (${elapsedMs}ms)\n`);
  return { name, executable: basename(file), args, resultSha256: createHash("sha256").update(output).digest("hex") };
}

async function runRawCommand({ file, args, environment = undefined, name }) {
  return new Promise((resolveCommand, rejectCommand) => {
    const startedAt = Date.now();
    const child = spawn(file, args, {
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        ...environment,
        NO_PROXY: "*",
      },
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
        if (code === 0 && !timedOut) {
          resolveCommand({ output: outputBytes, elapsedMs });
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
