import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  readRuntimeSourcesLock,
  sha256,
  supportedRuntimeTargets,
} from "./source-lock.mjs";

export const runtimeToolchainsSchema =
  "dascowork-primary-runtime-toolchains.v1";
export const runtimeInputsManifestSchema =
  "dascowork-primary-runtime-inputs.v1";

const targetSet = new Set(supportedRuntimeTargets);
const targetKeys = new Set([
  "runner",
  "builder",
  "node",
  "python",
  "pythonWheels",
  "nativeRecipes",
]);
const builderKeys = new Set(["identity", "tools"]);
const artifactKeys = new Set([
  "name",
  "version",
  "url",
  "sha256",
  "sizeBytes",
  "license",
  "archiveFormat",
  "stripComponents",
]);
const recipeKeys = new Set([
  "name",
  "materialization",
  "sourceComponent",
  "sourceArchiveFormat",
  "sourceDirectory",
  "toolchain",
  "environment",
  "commands",
  "outputs",
  "closure",
]);
const recipeOutputKeys = new Set(["kind", "source", "destination", "mode"]);
const recipeClosureKeys = new Set(["mode", "entrypoints"]);
const allowedArchiveFormats = new Set(["tar.gz", "tar.xz", "zip", "msi"]);
const nativeMaterializations = new Set(["source-build", "prebuilt"]);
const executableModes = new Set(["0755", "100755"]);

/**
 * Reads the immutable target-toolchain lock.  It intentionally contains only
 * source locations and build recipes: downloaded bytes live in an external,
 * SHA-addressed cache and are never committed as Runtime inputs.
 */
export async function readRuntimeToolchainsLock(path) {
  return validateRuntimeToolchainsLock(
    JSON.parse(await readFile(path, "utf8")),
  );
}

export function validateRuntimeToolchainsLock(value) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== runtimeToolchainsSchema ||
    !isNonEmptyString(value.materializerVersion) ||
    hasUnexpectedKeys(
      value,
      new Set(["schemaVersion", "materializerVersion", "targets"]),
    ) ||
    !isPlainObject(value.targets) ||
    Object.keys(value.targets).length !== supportedRuntimeTargets.length ||
    Object.keys(value.targets).some((target) => !targetSet.has(target))
  ) {
    throw new Error("Primary Runtime toolchain lock has an invalid schema.");
  }

  for (const target of supportedRuntimeTargets) {
    if (!isTargetToolchain(value.targets[target])) {
      throw new Error(
        `Primary Runtime toolchain lock has an invalid ${target} entry.`,
      );
    }
  }
  return value;
}

export function artifactsForTarget({ sourceLock, toolchainsLock, target }) {
  if (!targetSet.has(target)) {
    throw new Error(
      `Primary Runtime toolchain lock does not support ${target}.`,
    );
  }
  const sources = sourceLock ?? undefined;
  const toolchains = toolchainsLock ?? undefined;
  if (!sources || !toolchains) {
    throw new Error("Primary Runtime source and toolchain locks are required.");
  }

  const deduplicated = new Map();
  const add = (artifact) => {
    const key = artifact.sha256;
    const previous = deduplicated.get(key);
    if (previous && previous.url !== artifact.url) {
      throw new Error(
        `Primary Runtime source lock assigns digest ${key} to multiple URLs.`,
      );
    }
    deduplicated.set(key, artifact);
  };

  add({
    name: "presentation-skill-source",
    version: sources.candidate.tag,
    url: sources.candidate.sourceArchive.url,
    sha256: sources.candidate.sourceArchive.sha256,
    license: sources.candidate.license.spdx,
    archiveFormat: archiveFormatForUrl(sources.candidate.sourceArchive.url),
    // GitHub tag archives add one repository-name root. Materialization must
    // remove that wrapper before applying the lock-bound patch and selecting
    // the audited plugin directory.
    stripComponents: 1,
    kind: "plugin-source",
  });
  for (const [group, components] of Object.entries(sources.components)) {
    if (group === "python") continue;
    for (const component of components) {
      if (!component.platforms.includes(target)) continue;
      add({
        ...component,
        url: component.source,
        archiveFormat: archiveFormatForUrl(component.source),
        kind: `component:${group}`,
      });
    }
  }
  const targetToolchain = toolchains.targets[target];
  const lockedPythonPackages = new Map(
    sources.components.python.map((component) => [component.name, component]),
  );
  if (
    targetToolchain.pythonWheels.length !== lockedPythonPackages.size ||
    targetToolchain.pythonWheels.some((wheel) => {
      const source = lockedPythonPackages.get(wheel.name);
      return (
        !source ||
        source.version !== wheel.version ||
        source.license !== wheel.license
      );
    })
  ) {
    throw new Error(
      "Primary Runtime Python wheel lock is not bound to the audited dependency closure.",
    );
  }
  add({ ...targetToolchain.node, kind: "toolchain:node" });
  add({ ...targetToolchain.python, kind: "toolchain:python" });
  for (const wheel of targetToolchain.pythonWheels) {
    add({ ...wheel, kind: "toolchain:python-wheel" });
  }
  return [...deduplicated.values()].sort((left, right) =>
    left.sha256.localeCompare(right.sha256),
  );
}

export function contentAddressedCachePath(cacheRoot, artifact) {
  return join(resolve(cacheRoot), "sha256", artifact.sha256);
}

export async function assertCachedArtifact(cacheRoot, artifact) {
  const path = contentAddressedCachePath(cacheRoot, artifact);
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new Error(
      `AT-RT-INPUT-01 blocked: cache is missing locked ${artifact.name} (${artifact.sha256}).`,
    );
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(
      `AT-RT-INPUT-01 blocked: cached ${artifact.name} is not a regular file.`,
    );
  }
  if (
    Number.isSafeInteger(artifact.sizeBytes) &&
    details.size !== artifact.sizeBytes
  ) {
    throw new Error(
      `AT-RT-INPUT-01 blocked: cached ${artifact.name} size does not match lock.`,
    );
  }
  const digest = sha256(await readFile(path));
  if (digest !== artifact.sha256) {
    throw new Error(
      `AT-RT-INPUT-01 blocked: cached ${artifact.name} digest does not match lock.`,
    );
  }
  return path;
}

export async function collectRuntimeInputFiles(inputRoot) {
  const root = resolve(inputRoot);
  const entries = [];
  await collectDirectory({ root, directory: root, entries });
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeRuntimeInputsManifest({
  inputRoot,
  target,
  sourceLockPath,
  toolchainsLockPath,
  artifacts,
  patches,
  builder,
}) {
  const root = resolve(inputRoot);
  const manifestPath = join(root, "runtime-inputs.manifest.json");
  const files = await collectRuntimeInputFiles(root);
  const manifest = {
    schemaVersion: runtimeInputsManifestSchema,
    target,
    sourceLockSha256: sha256(await readFile(sourceLockPath)),
    toolchainsLockSha256: sha256(await readFile(toolchainsLockPath)),
    builder,
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      version: artifact.version,
      sha256: artifact.sha256,
      license: artifact.license,
      kind: artifact.kind,
    })),
    patches,
    files,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath };
}

export async function assertRuntimeInputsManifest({
  inputRoot,
  target,
  sourceLockPath,
  toolchainsLockPath,
}) {
  const root = resolve(inputRoot);
  const manifestPath = join(root, "runtime-inputs.manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(
      "AT-RT-INPUT-01 blocked: Runtime input manifest is missing or invalid.",
    );
  }
  if (
    !isPlainObject(manifest) ||
    manifest.schemaVersion !== runtimeInputsManifestSchema ||
    manifest.target !== target ||
    manifest.sourceLockSha256 !== sha256(await readFile(sourceLockPath)) ||
    manifest.toolchainsLockSha256 !==
      sha256(await readFile(toolchainsLockPath)) ||
    !isPlainObject(manifest.builder) ||
    hasUnexpectedKeys(
      manifest.builder,
      new Set([
        "name",
        "version",
        "runner",
        "identity",
        "observedImage",
        "observedImageSha256",
        "tools",
      ]),
    ) ||
    !isNonEmptyString(manifest.builder.name) ||
    !isNonEmptyString(manifest.builder.version) ||
    !isNonEmptyString(manifest.builder.runner) ||
    !isNonEmptyString(manifest.builder.identity) ||
    !isNonEmptyString(manifest.builder.observedImage) ||
    !isSha256(manifest.builder.observedImageSha256) ||
    manifest.builder.observedImageSha256 !==
      sha256(manifest.builder.observedImage) ||
    !Array.isArray(manifest.builder.tools) ||
    manifest.builder.tools.length === 0 ||
    manifest.builder.tools.some(
      (tool) =>
        !isPlainObject(tool) ||
        hasUnexpectedKeys(tool, new Set(["command", "versionSha256"])) ||
        !isBuilderTool(tool.command) ||
        !isSha256(tool.versionSha256),
    ) ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0 ||
    !Array.isArray(manifest.patches) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error(
      "AT-RT-INPUT-01 blocked: Runtime input manifest does not bind this build.",
    );
  }

  const [sourceLock, toolchainsLock] = await Promise.all([
    readRuntimeSourcesLock(sourceLockPath),
    readRuntimeToolchainsLock(toolchainsLockPath),
  ]);
  const expectedArtifacts = artifactsForTarget({
    sourceLock,
    toolchainsLock,
    target,
  }).map((artifact) => ({
    name: artifact.name,
    version: artifact.version,
    sha256: artifact.sha256,
    license: artifact.license,
    kind: artifact.kind,
  }));
  if (
    JSON.stringify(manifest.artifacts) !== JSON.stringify(expectedArtifacts) ||
    manifest.builder.runner !== toolchainsLock.targets[target].runner ||
    manifest.builder.identity !== toolchainsLock.targets[target].builder.identity ||
    JSON.stringify(manifest.builder.tools.map((tool) => tool.command)) !==
      JSON.stringify(toolchainsLock.targets[target].builder.tools) ||
    manifest.patches.length !== 1 ||
    manifest.patches[0]?.path !== sourceLock.candidate.patch.path ||
    manifest.patches[0]?.sha256 !== sourceLock.candidate.patch.sha256
  ) {
    throw new Error(
      "AT-RT-INPUT-01 blocked: Runtime input manifest source binding is invalid.",
    );
  }

  const files = await collectRuntimeInputFiles(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) {
    throw new Error(
      "AT-RT-INPUT-01 blocked: Runtime input files differ from the verified manifest.",
    );
  }
  return { manifest, manifestPath, files };
}

export async function assertSafeOutputPath(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const diff = relative(resolvedRoot, resolvedCandidate);
  if (
    diff === "" ||
    diff.startsWith("..") ||
    isAbsolute(diff) ||
    diff.split(sep).includes("..")
  ) {
    throw new Error(
      "AT-RT-INPUT-01 blocked: Runtime input path escapes its root.",
    );
  }
  return resolvedCandidate;
}

export function archiveFormatForUrl(url) {
  if (url.endsWith(".tar.gz") || url.endsWith(".tgz")) return "tar.gz";
  if (url.endsWith(".tar.xz")) return "tar.xz";
  if (url.endsWith(".zip")) return "zip";
  if (url.endsWith(".msi")) return "msi";
  throw new Error(
    `Primary Runtime source has an unsupported archive format: ${url}`,
  );
}

export function sha256FileContents(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isTargetToolchain(value) {
  return (
    isPlainObject(value) &&
    !hasUnexpectedKeys(value, targetKeys) &&
    isNonEmptyString(value.runner) &&
    isBuilder(value.builder) &&
    isArtifact(value.node) &&
    isArtifact(value.python) &&
    Array.isArray(value.pythonWheels) &&
    value.pythonWheels.length > 0 &&
    value.pythonWheels.every(isArtifact) &&
    new Set(value.pythonWheels.map((wheel) => wheel.name)).size ===
      value.pythonWheels.length &&
    Array.isArray(value.nativeRecipes) &&
    value.nativeRecipes.length >= 2 &&
    value.nativeRecipes.every(isNativeRecipe) &&
    new Set(value.nativeRecipes.map((recipe) => recipe.name)).size ===
      value.nativeRecipes.length
  );
}

function isBuilder(value) {
  return (
    isPlainObject(value) &&
    !hasUnexpectedKeys(value, builderKeys) &&
    isNonEmptyString(value.identity) &&
    Array.isArray(value.tools) &&
    value.tools.length > 0 &&
    value.tools.every(isBuilderTool) &&
    new Set(value.tools).size === value.tools.length
  );
}

function isBuilderTool(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function isArtifact(value) {
  return (
    isPlainObject(value) &&
    !hasUnexpectedKeys(value, artifactKeys) &&
    isNonEmptyString(value.name) &&
    isExactVersion(value.version) &&
    isHttpsUrl(value.url) &&
    isSha256(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes > 0 &&
    isNonEmptyString(value.license) &&
    allowedArchiveFormats.has(value.archiveFormat) &&
    Number.isSafeInteger(value.stripComponents) &&
    value.stripComponents >= 0 &&
    value.stripComponents <= 8
  );
}

function isNativeRecipe(value) {
  return (
    isPlainObject(value) &&
    !hasUnexpectedKeys(value, recipeKeys) &&
    isNonEmptyString(value.name) &&
    nativeMaterializations.has(value.materialization) &&
    isNonEmptyString(value.sourceComponent) &&
    allowedArchiveFormats.has(value.sourceArchiveFormat) &&
    isRelativePath(value.sourceDirectory) &&
    isPlainObject(value.toolchain) &&
    Object.values(value.toolchain).every(isNonEmptyString) &&
    isRecipeEnvironment(value.environment, value.materialization) &&
    Array.isArray(value.commands) &&
    (value.materialization === "source-build"
      ? value.commands.length > 0
      : value.commands.length === 0) &&
    value.commands.every(
      (command) =>
        Array.isArray(command) &&
        command.length > 0 &&
        command.every(isNonEmptyString),
    ) &&
    Array.isArray(value.outputs) &&
    value.outputs.length > 0 &&
    value.outputs.every(isRecipeOutput) &&
    isRecipeClosure(value.closure, value.outputs)
  );
}

function isRecipeEnvironment(value, materialization) {
  return (
    isPlainObject(value) &&
    (materialization === "source-build" || Object.keys(value).length === 0) &&
    Object.entries(value).every(
      ([key, environmentValue]) =>
        /^[A-Z_][A-Z0-9_]*$/u.test(key) && isNonEmptyString(environmentValue),
    )
  );
}

function isRecipeOutput(value) {
  return (
    isPlainObject(value) &&
    !hasUnexpectedKeys(value, recipeOutputKeys) &&
    (value.kind === "file" || value.kind === "directory") &&
    isRelativePath(value.source) &&
    isRelativePath(value.destination) &&
    (value.kind === "directory"
      ? value.mode === undefined
      : value.mode === undefined || executableModes.has(value.mode))
  );
}

/**
 * A source recipe may use a genuinely static file, but dynamically-linked
 * tools must name a relocatable directory and every native entrypoint inside
 * it.  This prevents a recipe from silently copying only `soffice`/`pdfinfo`
 * while leaving its sibling libraries behind on the builder image.
 */
function isRecipeClosure(value, outputs) {
  if (
    !isPlainObject(value) ||
    hasUnexpectedKeys(value, recipeClosureKeys) ||
    (value.mode !== "directory" && value.mode !== "static") ||
    !Array.isArray(value.entrypoints) ||
    value.entrypoints.length === 0 ||
    !value.entrypoints.every(isRelativePath) ||
    new Set(value.entrypoints).size !== value.entrypoints.length
  ) {
    return false;
  }
  if (value.mode === "static") {
    const fileDestinations = new Set(
      outputs
        .filter((output) => output.kind === "file")
        .map((output) => output.destination),
    );
    return value.entrypoints.every((entrypoint) =>
      fileDestinations.has(entrypoint),
    );
  }
  const directoryDestinations = outputs
    .filter((output) => output.kind === "directory")
    .map((output) => output.destination);
  return value.entrypoints.every((entrypoint) =>
    directoryDestinations.some(
      (directory) => entrypoint.startsWith(`${directory}/`),
    ),
  );
}

async function collectDirectory({ root, directory, entries }) {
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error(
      "AT-RT-INPUT-01 blocked: Runtime input root cannot be read.",
    );
  }
  for (const child of children) {
    const absolute = join(directory, child.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (child.isSymbolicLink()) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: Runtime input contains a symbolic link: ${path}`,
      );
    }
    if (child.isDirectory()) {
      await collectDirectory({ root, directory: absolute, entries });
      continue;
    }
    if (!child.isFile()) {
      throw new Error(
        `AT-RT-INPUT-01 blocked: Runtime input contains an unsupported entry: ${path}`,
      );
    }
    if (path === "runtime-inputs.manifest.json") continue;
    const details = await lstat(absolute);
    entries.push({
      path,
      mode: (details.mode & 0o111 ? 0o100755 : 0o100644)
        .toString(8)
        .padStart(6, "0"),
      sha256: sha256(await readFile(absolute)),
    });
  }
}

function hasUnexpectedKeys(value, allowed) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isExactVersion(value) {
  return isNonEmptyString(value) && !/[~^*<>=|\s]/u.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    basename(value) !== "."
  );
}

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/(?:^|\/)(?:latest|main|master|head)(?:\/|$)/iu.test(url.pathname)
    );
  } catch {
    return false;
  }
}
