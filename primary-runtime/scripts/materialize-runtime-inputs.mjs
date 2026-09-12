#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertApprovedSources,
  assertRepositoryPatchMatchesLock,
  readRuntimeSourcesLock,
  sha256,
} from "./source-lock.mjs";
import {
  artifactsForTarget,
  assertCachedArtifact,
  contentAddressedCachePath,
  readRuntimeToolchainsLock,
  writeRuntimeInputsManifest,
} from "./runtime-inputs.mjs";
import {
  assertNativeRuntimeTarget,
  parseRuntimeTargetOption,
} from "./runtime-target.mjs";

const run = promisify((file, args, options, callback) => {
  const child = spawn(file, args, { ...options, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", callback);
  child.once("exit", (code) => {
    if (code === 0) callback(null, { stdout, stderr });
    else
      callback(
        new Error(
          `${file} exited ${code ?? "unknown"}: ${(stderr.trim() || stdout.trim() || "no command output")}`,
        ),
      );
  });
});

const options = parseArgs(process.argv.slice(2));
const target = assertNativeRuntimeTarget(options.target);
const resolveLockedBuilderCommand = (command) => {
  // Use the Windows image's tar.exe so the selected archive reader and its
  // version receipt are stable; extraction below deliberately passes it only
  // relative paths because Windows tar variants treat drive prefixes specially.
  if (target === "win32-x64" && command === "tar") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    return join(systemRoot, "System32", "tar.exe");
  }
  return command;
};
const [sourceLock, toolchainsLock] = await Promise.all([
  readRuntimeSourcesLock(options.sourceLock),
  readRuntimeToolchainsLock(options.toolchainsLock),
]);
assertApprovedSources(sourceLock);
const targetToolchain = toolchainsLock.targets[target];
const artifacts = artifactsForTarget({ sourceLock, toolchainsLock, target });
const artifactsByName = new Map(
  artifacts.map((artifact) => [artifact.name, artifact]),
);
const componentsByName = new Map(
  Object.values(sourceLock.components)
    .flat()
    .map((component) => [component.name, component]),
);

const builderTools = await verifyLockedBuilderToolchain({
  target,
  builder: targetToolchain.builder,
});

for (const artifact of artifacts)
  await assertCachedArtifact(options.sourceCache, artifact);
await assertRepositoryPatchMatchesLock({
  lockPath: options.sourceLock,
  repositoryRoot: resolve(options.sourceLock, ".."),
});

await rm(options.outputRoot, { recursive: true, force: true });
await mkdir(options.outputRoot, { recursive: true });
const workRoot = join(options.outputRoot, ".materialize-work");
await mkdir(workRoot, { recursive: true });

try {
  await extractLockedArtifact({
    artifact: artifactsByName.get("node-runtime"),
    output: join(options.outputRoot, "dependencies/node"),
    cacheRoot: options.sourceCache,
  });
  await extractLockedArtifact({
    artifact: artifactsByName.get("cpython-runtime"),
    output: join(options.outputRoot, "dependencies/python"),
    cacheRoot: options.sourceCache,
  });
  await dereferenceInternalSymlinks(
    join(options.outputRoot, "dependencies/node"),
  );
  await dereferenceInternalSymlinks(
    join(options.outputRoot, "dependencies/python"),
  );
  await materializeNodePackages({
    sourceLock,
    artifactsByName,
    cacheRoot: options.sourceCache,
    outputRoot: options.outputRoot,
  });
  await materializePythonPackages({
    targetToolchain,
    artifactsByName,
    cacheRoot: options.sourceCache,
    outputRoot: options.outputRoot,
    workRoot,
    target,
  });
  await materializePlugin({
    sourceLock,
    artifact: artifactsByName.get("presentation-skill-source"),
    cacheRoot: options.sourceCache,
    outputRoot: options.outputRoot,
    workRoot,
    patchPath: resolve(
      options.sourceLock,
      "..",
      sourceLock.candidate.patch.path,
    ),
  });
  await materializeFonts({
    sourceLock,
    artifactsByName,
    cacheRoot: options.sourceCache,
    outputRoot: options.outputRoot,
    workRoot,
    python: runtimePythonExecutable({ outputRoot: options.outputRoot, target }),
  });
  await materializeNativeRecipes({
    targetToolchain,
    componentsByName,
    artifactsByName,
    cacheRoot: options.sourceCache,
    outputRoot: options.outputRoot,
    workRoot,
    allowSourceBuild: options.allowSourceBuild,
  });

  const patchSha256 = sha256(
    await readFile(
      resolve(options.sourceLock, "..", sourceLock.candidate.patch.path),
    ),
  );
  const { manifestPath } = await writeRuntimeInputsManifest({
    inputRoot: options.outputRoot,
    target,
    sourceLockPath: options.sourceLock,
    toolchainsLockPath: options.toolchainsLock,
    artifacts,
    patches: [{ path: sourceLock.candidate.patch.path, sha256: patchSha256 }],
    builder: {
      name: "@dascowork/primary-runtime-materializer",
      version: toolchainsLock.materializerVersion,
      runner: targetToolchain.runner,
      identity: targetToolchain.builder.identity,
      observedImage:
        process.env.DASCOWORK_PRIMARY_RUNTIME_BUILDER_IMAGE ??
        targetToolchain.builder.identity,
      observedImageSha256: sha256(
        process.env.DASCOWORK_PRIMARY_RUNTIME_BUILDER_IMAGE ??
          targetToolchain.builder.identity,
      ),
      tools: builderTools,
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: "dascowork-primary-runtime-materialization-receipt.v1",
        target,
        inputRoot: options.outputRoot,
        inputManifest: manifestPath,
        sourceCache: options.sourceCache,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

async function extractLockedArtifact({ artifact, output, cacheRoot, python }) {
  if (!artifact)
    throw new Error("AT-RT-INPUT-01 blocked: locked artifact is missing.");
  await mkdir(output, { recursive: true });
  const archive = contentAddressedCachePath(cacheRoot, artifact);
  await extractArchive({
    archive,
    output,
    stripComponents: artifact.stripComponents,
    archiveFormat: artifact.archiveFormat,
    python,
  });
}

async function verifyLockedBuilderToolchain({ target, builder }) {
  const tools = [];
  const msysScriptTools = new Set(["aclocal", "autoconf", "automake"]);
  for (const command of builder.tools) {
    let result;
    const executable = resolveLockedBuilderCommand(command);
    const versionArgs = command === "cl" ? [] : ["--version"];
    const useMsysShell =
      target === "win32-x64" &&
      process.env.MSYSTEM === "MSYS" &&
      msysScriptTools.has(command);
    try {
      result = useMsysShell
        ? await run(
            "bash",
            ["-lc", 'exec "$@"', "bash", command, ...versionArgs],
            { env: process.env },
          )
        : await run(executable, versionArgs, { env: process.env });
    } catch (error) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: ${target} requires locked builder tool ${command}: ${String(error.message ?? error)}`,
      );
    }
    const output = `${result.stdout}${result.stderr}`.trim();
    if (!output) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: ${target} builder tool ${command} did not report a version.`,
      );
    }
    tools.push({ command, versionSha256: sha256(output) });
  }
  return tools;
}

async function materializeNodePackages({
  sourceLock,
  artifactsByName,
  cacheRoot,
  outputRoot,
}) {
  for (const component of sourceLock.components.node) {
    const artifact = artifactsByName.get(component.name);
    await extractArchive({
      archive: contentAddressedCachePath(cacheRoot, artifact),
      output: join(
        outputRoot,
        "dependencies/node/node_modules",
        component.name,
      ),
      stripComponents: 1,
    });
  }
}

async function materializePythonPackages({
  targetToolchain,
  artifactsByName,
  cacheRoot,
  outputRoot,
  workRoot,
  target,
}) {
  const python = runtimePythonExecutable({ outputRoot, target });
  await assertRegularFile(python, "Runtime-owned Python executable");
  const wheelhouse = join(workRoot, "python-wheelhouse");
  await mkdir(wheelhouse, { recursive: true });
  const sources = [];
  for (const artifact of targetToolchain.pythonWheels) {
    const source = contentAddressedCachePath(cacheRoot, artifact);
    const destination = join(
      wheelhouse,
      decodeURIComponent(basename(new URL(artifact.url).pathname)),
    );
    await copyFile(source, destination);
    sources.push(destination);
  }
  await mkdir(join(outputRoot, "dependencies/python/packages"), {
    recursive: true,
  });
  await run(
    python,
    [
      "-m",
      "pip",
      "install",
      "--no-index",
      "--no-deps",
      "--no-cache-dir",
      "--no-build-isolation",
      "--target",
      join(outputRoot, "dependencies/python/packages"),
      ...sources,
    ],
    {
      cwd: wheelhouse,
      env: {
        ...process.env,
        PIP_NO_INDEX: "1",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PYTHONNOUSERSITE: "1",
      },
    },
  );
}

async function materializePlugin({
  sourceLock,
  artifact,
  cacheRoot,
  outputRoot,
  workRoot,
  patchPath,
}) {
  const sourceRoot = join(workRoot, "plugin-source");
  await extractLockedArtifact({ artifact, output: sourceRoot, cacheRoot });
  await run("git", ["apply", "--whitespace=error", patchPath], {
    cwd: sourceRoot,
  });
  const source = join(sourceRoot, sourceLock.candidate.pluginDirectory.path);
  const marketplaceRoot = join(outputRoot, "plugins/presentation-skill");
  const destination = join(marketplaceRoot, "plugins/presentation-skill");
  await assertRegularDirectory(source, "authorized presentation plugin source");
  const files = await copyRuntimePluginPayload({
    source,
    destination,
    sourceLock,
  });
  await writeRuntimePluginMarketplace({
    marketplaceRoot,
    sourceLock,
    files,
  });
  await assertPluginPayload(marketplaceRoot);
}

/**
 * The selected upstream repository is an auditable source input, not the
 * Runtime payload.  Copying its plugin root wholesale would carry unrelated
 * network, image-generation, installer, and existing-PPTX workflows into the
 * archive.  The locked patch supplies the Runtime-facing metadata and skill
 * text; this explicit map is the only file surface that reaches the Runtime.
 */
async function copyRuntimePluginPayload({ source, destination, sourceLock }) {
  const requiredEntryPoints = [
    "skills/presentation-skill/scripts/build_deck_pptxgenjs.js",
    "skills/presentation-skill/scripts/layout_lint.py",
    "skills/presentation-skill/scripts/render_slides.py",
  ];
  const lockedEntryPoints = sourceLock.candidate.runtimeScope.entryPoints;
  if (
    lockedEntryPoints.length !== requiredEntryPoints.length ||
    requiredEntryPoints.some((entry) => !lockedEntryPoints.includes(entry))
  ) {
    throw new Error(
      "AT-RT-INPUT-01 blocked: presentation Runtime entry-point allowlist does not match the source lock.",
    );
  }
  const files = [
    {
      source: ".codex-plugin/DASCOWORK_RUNTIME_PLUGIN.json",
      destination: ".codex-plugin/plugin.json",
    },
    {
      source:
        "skills/presentation-skill/DASCOWORK_RUNTIME_SKILL.md",
      destination: "skills/presentation-skill/SKILL.md",
    },
    {
      source: "skills/presentation-skill/DASCOWORK_RUNTIME_POLICY.md",
      destination: "skills/presentation-skill/DASCOWORK_RUNTIME_POLICY.md",
    },
    ...requiredEntryPoints.map((path) => ({ source: path, destination: path })),
    {
      source: "skills/presentation-skill/templates/pptxgenjs/presets.js",
      destination: "skills/presentation-skill/templates/pptxgenjs/presets.js",
    },
    {
      source: "skills/presentation-skill/templates/pptxgenjs/slides.js",
      destination: "skills/presentation-skill/templates/pptxgenjs/slides.js",
    },
  ];
  const copied = [];
  for (const file of files) {
    const input = await safeChild(source, file.source);
    const output = await safeChild(destination, file.destination);
    await assertRegularFile(
      input,
      `authorized presentation plugin file ${file.source}`,
    );
    await mkdir(dirname(output), { recursive: true });
    await copyFile(input, output);
    copied.push({
      path: file.destination,
      sha256: sha256(await readFile(output)),
    });
  }
  return copied;
}

async function writeRuntimePluginMarketplace({
  marketplaceRoot,
  sourceLock,
  files,
}) {
  const name = "presentation-skill";
  await writeJson(join(marketplaceRoot, ".agents/plugins/marketplace.json"), {
    name,
    plugins: [
      {
        name,
        source: { source: "local", path: `./plugins/${name}` },
      },
    ],
  });
  await writeJson(join(marketplaceRoot, "bundle-lock.json"), {
    bundleFormatVersion: 2,
    marketplace: { name, pluginRoot: "plugins" },
    plugins: [
      {
        name,
        version: sourceLock.candidate.tag,
        installWhenMissing: true,
        internal: true,
        provenance: {
          kind: "locked-source",
          sourceLock: "primary-runtime/runtime-sources.lock.json",
          sourceCommit: sourceLock.candidate.commit,
          sourceArchiveSha256: sourceLock.candidate.sourceArchive.sha256,
          licensePath: sourceLock.candidate.license.path,
          reviewStatus: "approved",
        },
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
      },
    ],
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function materializeFonts({
  sourceLock,
  artifactsByName,
  cacheRoot,
  outputRoot,
  workRoot,
  python,
}) {
  for (const component of sourceLock.components.fonts) {
    const artifact = artifactsByName.get(component.name);
    const destination = join(outputRoot, "fonts", component.name);
    const extracted = join(workRoot, "fonts", component.name);
    await extractLockedArtifact({
      artifact,
      output: extracted,
      cacheRoot,
      python,
    });
    await cp(extracted, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}

async function materializeNativeRecipes({
  targetToolchain,
  componentsByName,
  artifactsByName,
  cacheRoot,
  outputRoot,
  workRoot,
  allowSourceBuild,
}) {
  if (!allowSourceBuild) {
    throw new Error(
      "AT-RT-INPUT-01 blocked: native source build requires explicit --allow-source-build on the target-native runner.",
    );
  }
  for (const recipe of targetToolchain.nativeRecipes) {
    const component = componentsByName.get(recipe.sourceComponent);
    const artifact = artifactsByName.get(recipe.sourceComponent);
    if (
      !component ||
      !artifact ||
      artifact.archiveFormat !== recipe.sourceArchiveFormat
    ) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: native recipe ${recipe.name} is not bound to a locked source.`,
      );
    }
    const sourceRoot = join(workRoot, "native", recipe.name);
    await extractLockedArtifact({ artifact, output: sourceRoot, cacheRoot });
    const buildRoot = await safeChild(sourceRoot, recipe.sourceDirectory);
    await assertRegularDirectory(
      buildRoot,
      `${recipe.name} locked source directory`,
    );
    for (const [file, ...args] of recipe.commands) {
      await run(file, args, {
        cwd: buildRoot,
        env: {
          ...process.env,
          ...recipe.environment,
          MAKEFLAGS: "-j2",
        },
      });
    }
    for (const output of recipe.outputs) {
      const source = await safeChild(buildRoot, output.source);
      const destination = await safeChild(outputRoot, output.destination);
      await mkdir(resolve(destination, ".."), { recursive: true });
      if (output.kind === "directory") {
        await assertRegularDirectory(source, `${recipe.name} output directory`);
        await assertInternalDirectorySymlinks({ root: source, directory: source });
        await cp(source, destination, {
          recursive: true,
          dereference: true,
          force: false,
          errorOnExist: true,
        });
        await visit(destination, async () => {});
      } else {
        await assertRegularFile(source, `${recipe.name} output`);
        await copyFile(source, destination);
        if (output.mode === "0755") await chmod(destination, 0o755);
      }
    }
    await assertRecipeClosure({ recipe, outputRoot });
  }
}

async function assertRecipeClosure({ recipe, outputRoot }) {
  for (const entrypoint of recipe.closure.entrypoints) {
    const path = await safeChild(outputRoot, entrypoint);
    await assertRegularFile(path, `${recipe.name} closure entrypoint`);
  }
}

async function extractArchive({
  archive,
  output,
  stripComponents = 0,
  archiveFormat,
  python,
}) {
  if (archiveFormat === "zip") {
    if (!python) {
      await extractZipWithLockedTar({ archive, output, stripComponents });
      return;
    }
    await extractZipArchive({ archive, output, stripComponents, python });
    return;
  }
  await extractWithLockedTar({ archive, output, stripComponents });
}

/**
 * The Windows Node archive is a ZIP and is intentionally materialized before
 * the locked Runtime Python executable exists. `tar` is already a required,
 * version-recorded builder tool on every target, so use it only for this
 * bootstrap extraction rather than falling back to a runner Python runtime.
 */
async function extractZipWithLockedTar({ archive, output, stripComponents }) {
  await extractWithLockedTar({ archive, output, stripComponents });
}

async function extractWithLockedTar({ archive, output, stripComponents }) {
  await mkdir(output, { recursive: true });
  // Both the MSYS and inbox Windows tar implementations treat an absolute
  // drive-qualified path as a remote archive specifier.  Extract from the
  // destination and address the locked cache object relatively instead.
  const archiveArgument =
    target === "win32-x64"
      ? relative(output, archive).split(sep).join("/")
      : archive;
  const args = ["-xf", archiveArgument];
  if (target !== "win32-x64") args.push("-C", output);
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`);
  await run(resolveLockedBuilderCommand("tar"), args, { cwd: output });
}

async function extractZipArchive({ archive, output, stripComponents, python }) {
  const extractor = [
    "import pathlib, stat, sys, zipfile",
    "archive, output, strip = sys.argv[1], pathlib.Path(sys.argv[2]), int(sys.argv[3])",
    "with zipfile.ZipFile(archive) as payload:",
    "    for member in payload.infolist():",
    "        raw = member.filename.replace('\\\\', '/')",
    "        if raw.startswith('/') or raw.startswith('\\\\'):",
    "            raise RuntimeError(f'absolute ZIP entry: {member.filename}')",
    "        parts = [part for part in raw.split('/') if part not in ('', '.')]",
    "        if any(part == '..' for part in parts):",
    "            raise RuntimeError(f'escaping ZIP entry: {member.filename}')",
    "        if len(parts) <= strip:",
    "            continue",
    "        mode = member.external_attr >> 16",
    "        if stat.S_ISLNK(mode):",
    "            raise RuntimeError(f'symlink ZIP entry: {member.filename}')",
    "        target = output.joinpath(*parts[strip:])",
    "        if not target.is_relative_to(output):",
    "            raise RuntimeError(f'escaping ZIP target: {member.filename}')",
    "        if member.is_dir() or raw.endswith('/'):",
    "            target.mkdir(parents=True, exist_ok=True)",
    "            continue",
    "        target.parent.mkdir(parents=True, exist_ok=True)",
    "        with payload.open(member) as source, target.open('xb') as destination:",
    "            destination.write(source.read())",
  ].join("\n");
  await mkdir(output, { recursive: true });
  await run(python, ["-c", extractor, archive, output, String(stripComponents)], {
    cwd: output,
    env: {
      ...process.env,
      PYTHONNOUSERSITE: "1",
    },
  });
}

function runtimePythonExecutable({ outputRoot, target }) {
  return join(
    outputRoot,
    target.startsWith("win32")
      ? "dependencies/python/python.exe"
      : "dependencies/python/bin/python",
  );
}

async function assertPluginPayload(root) {
  const forbidden =
    /(?:generate_openai_image|fetch_wikimedia|bootstrap|setup(?:\.py|\.sh)?|package-lock\.json|node_modules)/iu;
  await visit(root, async (path) => {
    if (forbidden.test(path)) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: unauthorized plugin payload entry ${path}.`,
      );
    }
  });
}

async function visit(root, onFile) {
  for (const child of await readdir(root, { withFileTypes: true })) {
    const path = join(root, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: materialized payload contains symbolic link ${path}.`,
      );
    }
    if (child.isDirectory()) await visit(path, onFile);
    else if (child.isFile()) await onFile(path);
    else
      throw new Error(
        `AT-RT-INPUT-01 blocked: materialized payload contains unsupported entry ${path}.`,
      );
  }
}

/**
 * Input manifests reject symbolic links so the Runtime archive has no
 * host-dependent resolution at install time. Official Node and CPython
 * bundles use convenience links (for example `python` → `python3.13`), so
 * copy only internally-resolved regular-file targets before manifesting.
 */
async function dereferenceInternalSymlinks(root, directory = root) {
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) {
      await dereferenceInternalSymlinks(root, path);
      continue;
    }
    if (!child.isSymbolicLink()) continue;
    const source = await resolveInternalRegularFile({ root, path });
    const details = await stat(source);
    await unlink(path);
    await copyFile(source, path);
    await chmod(path, details.mode & 0o777);
  }
}

/**
 * Directory recipe outputs may contain build-system convenience links.  They
 * are permitted only when their complete chain remains inside the locked
 * output tree, then `cp(..., { dereference: true })` turns them into regular
 * archive files.  Host-path links are never allowed into Runtime inputs.
 */
async function assertInternalDirectorySymlinks({
  root,
  directory,
  visitedDirectories = new Set(),
}) {
  const canonicalDirectory = resolve(directory);
  if (visitedDirectories.has(canonicalDirectory)) return;
  visitedDirectories.add(canonicalDirectory);
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) {
      await assertInternalDirectorySymlinks({
        root,
        directory: path,
        visitedDirectories,
      });
      continue;
    }
    if (!child.isSymbolicLink()) continue;
    const target = await resolveInternalPath({ root, path });
    const details = await lstat(target);
    if (details.isDirectory()) {
      await assertInternalDirectorySymlinks({
        root,
        directory: target,
        visitedDirectories,
      });
    }
  }
}

async function resolveInternalPath({ root, path }) {
  const seen = new Set();
  let candidate = path;
  while (true) {
    if (seen.has(candidate)) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: Runtime input symbolic-link cycle at ${path}.`,
      );
    }
    seen.add(candidate);
    const details = await lstat(candidate);
    if (!details.isSymbolicLink()) {
      if (!details.isFile() && !details.isDirectory()) {
        throw new Error(
          `AT-RT-INPUT-01 blocked: Runtime input symbolic link ${path} does not resolve to a file or directory.`,
        );
      }
      return candidate;
    }
    const next = resolve(resolve(candidate, ".."), await readlink(candidate));
    const diff = relative(root, next);
    if (
      diff.startsWith("..") ||
      diff === "" ||
      diff.split(sep).includes("..")
    ) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: Runtime input symbolic link ${path} escapes its extraction root.`,
      );
    }
    candidate = next;
  }
}

async function resolveInternalRegularFile({ root, path }) {
  const candidate = await resolveInternalPath({ root, path });
  const details = await lstat(candidate);
  if (!details.isFile()) {
    throw new Error(
      `AT-RT-INPUT-01 blocked: Runtime input symbolic link ${path} does not resolve to a regular file.`,
    );
  }
  return candidate;
}

async function safeChild(root, child) {
  const candidate = resolve(root, child);
  const diff = relative(root, candidate);
  if (diff.startsWith("..") || diff === "" || diff.split(sep).includes("..")) {
    throw new Error(
      "AT-RT-INPUT-01 blocked: materializer output escapes its root.",
    );
  }
  return candidate;
}

async function assertRegularFile(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new Error(`AT-RT-INPUT-01 blocked: ${label} is missing: ${path}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`AT-RT-INPUT-01 blocked: ${label} is not a regular file.`);
  }
}

async function assertRegularDirectory(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new Error(`AT-RT-INPUT-01 blocked: ${label} is missing: ${path}`);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`AT-RT-INPUT-01 blocked: ${label} is not a directory.`);
  }
}

function parseArgs(argv) {
  const target = parseRuntimeTargetOption(argv);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-source-build") continue;
    if (!argument.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (
      !new Set([
        "--target",
        "--source-cache",
        "--output",
        "--source-lock",
        "--toolchains-lock",
      ]).has(name)
    ) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--"))
      throw new Error(`Expected a value for ${name}.`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  const required = (name) => {
    const value = values.get(name);
    if (!value) throw new Error(`Expected ${name} <path>.`);
    return resolve(value);
  };
  return {
    target,
    sourceCache: required("--source-cache"),
    outputRoot: required("--output"),
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
    allowSourceBuild: argv.includes("--allow-source-build"),
  };
}
