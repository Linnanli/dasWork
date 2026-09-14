#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertApprovedSources,
  assertRepositoryPatchMatchesLock,
  canonicalFileManifest,
  readRuntimeSourcesLock,
  sha256,
} from "./source-lock.mjs";
import {
  assertRuntimeInputsManifest,
  readRuntimeToolchainsLock,
} from "./runtime-inputs.mjs";
import {
  assertBudgetWithinHardLimits,
  readRuntimeHardLimits,
} from "./runtime-hard-limits.mjs";
import { verifyRuntimeBudgets } from "./runtime-budgets.mjs";
import {
  assertNativeRuntimeTarget,
  parseRuntimeTargetOption,
} from "./runtime-target.mjs";
import { writeDeflatedZipArchive } from "./zip-writer.mjs";

const builderName = "@dascowork/primary-runtime-builder";
const outputArchiveName = "primary-runtime.zip";

const argumentsValue = parseArgs(process.argv.slice(2));
if (!argumentsValue.target || !argumentsValue.inputRootWasExplicit) {
  throw new Error(
    "AT-RT-BUILD-01 blocked: engineering builds require explicit --target and --input-root.",
  );
}
const target = assertNativeRuntimeTarget(argumentsValue.target);
const [platform, arch] = target.split("-");
const sourceLockBytes = await readFile(argumentsValue.lock);
const [lock, toolchains, hardLimits, toolchainsLockBytes] = await Promise.all([
  readRuntimeSourcesLock(argumentsValue.lock),
  readRuntimeToolchainsLock(argumentsValue.toolchainsLock),
  readRuntimeHardLimits(argumentsValue.hardLimitsPath),
  readFile(argumentsValue.toolchainsLock),
]);
assertApprovedSources(lock);
await assertRepositoryPatchMatchesLock({
  lockPath: argumentsValue.lock,
  repositoryRoot: resolve(argumentsValue.lock, ".."),
});

const inputRoot = argumentsValue.inputRoot;
await assertInputRoot(inputRoot);
const { manifest: inputManifest } = await assertRuntimeInputsManifest({
  inputRoot,
  target,
  sourceLockPath: argumentsValue.lock,
  toolchainsLockPath: argumentsValue.toolchainsLock,
});
const inputManifestBytes = await readFile(
  join(inputRoot, "runtime-inputs.manifest.json"),
);
const componentSmoke = await readComponentSmoke({
  path: argumentsValue.inputValidationPath,
  target,
  inputManifestSha256: sha256(inputManifestBytes),
});
const componentSmokeBytes = await readFile(argumentsValue.inputValidationPath);
const reviewedReleaseEvidence = await readReviewedReleaseEvidence({
  target,
  budgetPath: argumentsValue.releaseBudgetPath,
  performancePath: argumentsValue.performanceReportPath,
  hardLimits,
});
const outputRoot = join(argumentsValue.outputRoot, target);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const bundleVersion =
  argumentsValue.version ?? `${lock.builderVersion}+${target}`;
const inputEntries = await withEntryDigests(
  await collectInputEntries(inputRoot),
);
assertRequiredRuntimeInputs(inputEntries, target);

const runtimeManifest = buildRuntimeManifest({
  bundleVersion,
  platform,
  arch,
  lock,
  toolchains,
  inputEntries,
  sourceLockBytes,
  toolchainsLockBytes,
});
const notices = thirdPartyNotices(lock, toolchains);
const sbomDocument = sbom({ lock, toolchains, target, bundleVersion });
const generatedEntries = [
  textEntry("runtime.json", runtimeManifest),
  binaryEntry("provenance/source-lock.json", sourceLockBytes),
  binaryEntry("provenance/toolchains-lock.json", toolchainsLockBytes),
  binaryEntry("provenance/runtime-inputs.manifest.json", inputManifestBytes),
  textEntry("provenance/THIRD_PARTY_NOTICES.txt", notices),
  textEntry("provenance/SBOM.json", sbomDocument),
  binaryEntry("provenance/component-smoke.json", componentSmokeBytes),
];
const entries = await withEntryDigests([...inputEntries, ...generatedEntries]);
const canonicalManifest = canonicalFileManifest(
  entries.map((entry) => ({
    path: entry.path,
    mode: (entry.mode ?? 0o100644).toString(8).padStart(6, "0"),
    sha256: entry.sha256,
  })),
);
const archivePath = join(outputRoot, outputArchiveName);
await writeDeflatedZipArchive(archivePath, entries, {
  compressionLevel: argumentsValue.zipCompressionLevel,
});
const archiveDetails = await stat(archivePath);
const archiveSha256 = await sha256File(archivePath);
const unpackedBytes = entries.reduce(
  (total, entry) => total + entry.sizeBytes,
  0,
);
const hardLimit = hardLimits.targets[target];
if (
  archiveDetails.size > hardLimit.maxArchiveBytes ||
  unpackedBytes > hardLimit.maxUnpackedBytes
) {
  throw new Error(
    "AT-RT-BUILD-01 blocked: candidate exceeds immutable Runtime hard limits.",
  );
}
const runtimeManifestText = JSON.stringify(runtimeManifest, null, 2);
const provenance = {
  schemaVersion: "dascowork-primary-runtime-provenance.v1",
  builder: builderName,
  builderVersion: lock.builderVersion,
  target,
  bundleVersion,
  archiveSha256,
  archiveSizeBytes: archiveDetails.size,
  sourceLockSha256: sha256(sourceLockBytes),
  toolchainsLockSha256: sha256(toolchainsLockBytes),
  inputManifestSha256: sha256(inputManifestBytes),
  inputFileManifestSha256: sha256(canonicalFileManifest(inputManifest.files)),
  hardLimitsSha256: sha256(await readFile(argumentsValue.hardLimitsPath)),
  runtimeManifestSha256: sha256(`${runtimeManifestText}\n`),
  canonicalFileManifestSha256: sha256(canonicalManifest),
  sbomSha256: sha256(`${JSON.stringify(sbomDocument, null, 2)}\n`),
  noticesSha256: sha256(notices),
  componentSmokeSha256: sha256(componentSmokeBytes),
  patchSha256: lock.candidate.patch.sha256,
  builderIdentity: inputManifest.builder,
  releaseClass: "engineering-candidate",
  productionTrust: false,
  zipCompressionLevel: argumentsValue.zipCompressionLevel,
  ...(reviewedReleaseEvidence ?? {}),
};
const measurement = {
  schemaVersion: "dascowork-primary-runtime-p1a-build-unpack-measurement.v1",
  target,
  archiveSha256: provenance.archiveSha256,
  archiveBytes: archiveDetails.size,
  unpackedBytes,
  sourceLockSha256: provenance.sourceLockSha256,
  toolchainsLockSha256: provenance.toolchainsLockSha256,
  inputManifestSha256: provenance.inputManifestSha256,
  canonicalFileManifestSha256: provenance.canonicalFileManifestSha256,
  hardLimitsSha256: provenance.hardLimitsSha256,
  runner: process.env.RUNNER_IMAGE ?? inputManifest.builder.runner,
  releaseClass: provenance.releaseClass,
  productionTrust: false,
  zipCompressionLevel: argumentsValue.zipCompressionLevel,
};
await writeJson(join(outputRoot, "runtime.json"), runtimeManifest);
await writeFile(
  join(outputRoot, "canonical-file-manifest.txt"),
  canonicalManifest,
);
await writeFile(join(outputRoot, "THIRD_PARTY_NOTICES.txt"), notices);
await writeJson(join(outputRoot, "SBOM.json"), sbomDocument);
await writeJson(join(outputRoot, "provenance.json"), provenance);
await writeJson(join(outputRoot, "component-smoke.json"), componentSmoke);
await writeJson(join(outputRoot, "build-unpack-measurement.json"), measurement);
process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);

function buildRuntimeManifest({
  bundleVersion,
  platform,
  arch,
  lock,
  toolchains,
  inputEntries,
  sourceLockBytes,
  toolchainsLockBytes,
}) {
  const executableExtension = platform === "win32" ? ".exe" : "";
  const target = `${platform}-${arch}`;
  const sofficePath = libreofficeBinaryPath(target, executableExtension);
  const bundledSkillPath =
    "plugins/presentation-skill/plugins/presentation-skill/skills/presentation-skill/SKILL.md";
  const bundledSkill = inputEntries.find(
    (entry) => entry.path === bundledSkillPath,
  );
  if (!bundledSkill) {
    throw new Error(
      "AT-RT-BUILD-01 blocked: missing Runtime-owned presentation SKILL.md.",
    );
  }
  const fonts = lock.components.fonts.map((component) => {
    const prefix = `fonts/${component.name}/`;
    const font = inputEntries
      .filter(
        (entry) =>
          entry.path.startsWith(prefix) && /\.(?:ttf|otf)$/iu.test(entry.path),
      )
      .sort((left, right) => left.path.localeCompare(right.path))[0];
    if (!font) {
      throw new Error(
        `AT-RT-BUILD-01 blocked: missing locked Runtime font for ${component.name}.`,
      );
    }
    return { name: component.name, path: font.path };
  });
  return {
    bundleFormatVersion: 2,
    bundleVersion,
    target: { platform, arch },
    node: {
      path:
        platform === "win32"
          ? "dependencies/node/node.exe"
          : "dependencies/node/bin/node",
      version: toolchains.targets[target].node.version,
    },
    nodePackages: lock.components.node.map((component) => ({
      name: component.name,
      version: component.version,
      path: `dependencies/node/node_modules/${component.name}`,
      ...(component.entryRequired === false ? { entryRequired: false } : {}),
    })),
    python: {
      path:
        platform === "win32"
          ? "dependencies/python/python.exe"
          : "dependencies/python/bin/python",
      packages: lock.components.python.map((component) => ({
        name: component.name,
        version: component.version,
        path: "dependencies/python/packages",
      })),
    },
    binaries: [
      {
        name: "soffice",
        path: sofficePath,
        required: true,
      },
      {
        name: "pdfinfo",
        path: `dependencies/native/poppler/bin/pdfinfo${executableExtension}`,
        required: true,
      },
      {
        name: "pdftoppm",
        path: `dependencies/native/poppler/bin/pdftoppm${executableExtension}`,
        required: true,
      },
    ],
    fonts,
    bundledPlugins: [
      {
        marketplace: "presentation-skill",
        path: "plugins/presentation-skill",
      },
    ],
    bundledSkills: [
      {
        path: bundledSkillPath,
        sha256: bundledSkill.sha256,
      },
    ],
    // New Runtime generations do not retire any skill by default. A future
    // migration must declare a relative path here so Main can move it safely.
    skillsToRemove: [],
    sourceDigests: [
      {
        path: "provenance/source-lock.json",
        sha256: sha256(sourceLockBytes),
      },
      {
        path: "provenance/THIRD_PARTY_NOTICES.txt",
        sha256: sha256(thirdPartyNotices(lock, toolchains)),
      },
      {
        path: "provenance/toolchains-lock.json",
        sha256: sha256(toolchainsLockBytes),
      },
    ],
  };
}

async function assertInputRoot(inputRoot) {
  let details;
  try {
    details = await stat(inputRoot);
  } catch {
    throw new Error(
      `AT-RT-BUILD-01 blocked: offline Runtime input root is missing: ${inputRoot}`,
    );
  }
  if (!details.isDirectory()) {
    throw new Error(
      `AT-RT-BUILD-01 blocked: input root is not a directory: ${inputRoot}`,
    );
  }
}

function assertRequiredRuntimeInputs(entries, target) {
  const paths = new Set(entries.map((entry) => entry.path));
  for (const required of [
    "plugins/presentation-skill/.agents/plugins/marketplace.json",
    "plugins/presentation-skill/bundle-lock.json",
    "plugins/presentation-skill/plugins/presentation-skill/.codex-plugin/plugin.json",
    "plugins/presentation-skill/plugins/presentation-skill/skills/presentation-skill/SKILL.md",
  ]) {
    if (!paths.has(required)) {
      throw new Error(
        `AT-RT-BUILD-01 blocked: missing Runtime input ${required}.`,
      );
    }
  }
  const nodePath = target.startsWith("win32")
    ? "dependencies/node/node.exe"
    : "dependencies/node/bin/node";
  if (!paths.has(nodePath)) {
    throw new Error(
      "AT-RT-BUILD-01 blocked: missing Runtime-owned Node executable.",
    );
  }
  const extension = target.startsWith("win32") ? ".exe" : "";
  for (const [binary, path] of [
    ["soffice", libreofficeBinaryPath(target, extension)],
    ["pdfinfo", `dependencies/native/poppler/bin/pdfinfo${extension}`],
    ["pdftoppm", `dependencies/native/poppler/bin/pdftoppm${extension}`],
  ]) {
    if (!paths.has(path)) {
      throw new Error(
        `AT-RT-BUILD-01 blocked: missing Runtime-owned ${binary} executable.`,
      );
    }
  }
  if (
    ![...paths].some((path) => path.startsWith("dependencies/python/packages/"))
  ) {
    throw new Error(
      "AT-RT-BUILD-01 blocked: missing Runtime-owned Python package closure.",
    );
  }
  if (
    ![...paths].some(
      (path) => path.startsWith("fonts/") && /\.(?:ttf|otf)$/iu.test(path),
    )
  ) {
    throw new Error(
      "AT-RT-BUILD-01 blocked: missing locked Chinese font input.",
    );
  }
}

function libreofficeBinaryPath(target, extension) {
  if (target.startsWith("win32")) {
    return "dependencies/native/libreoffice/program/soffice.com";
  }
  const relativePath = target.startsWith("darwin")
    ? "libreoffice/LibreOffice.app/Contents/MacOS/soffice"
    : "libreoffice/program/soffice";
  return `dependencies/native/${relativePath}${extension}`;
}

async function collectInputEntries(inputRoot) {
  const entries = [];
  await collectDirectory({ root: inputRoot, directory: inputRoot, entries });
  return entries.filter(
    (entry) =>
      entry.path.startsWith("dependencies/") ||
      entry.path.startsWith("plugins/") ||
      entry.path.startsWith("fonts/"),
  );
}

async function collectDirectory({ root, directory, entries }) {
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, child.name);
    const archivePath = relative(root, absolute).split(sep).join("/");
    if (child.isDirectory()) {
      await collectDirectory({ root, directory: absolute, entries });
    } else if (child.isFile()) {
      const details = await stat(absolute);
      entries.push({
        path: archivePath,
        mode: details.mode & 0o111 ? 0o100755 : 0o100644,
        sourcePath: absolute,
        sizeBytes: details.size,
      });
    } else {
      throw new Error(
        `AT-RT-BUILD-01 blocked: unsupported input file type ${archivePath}.`,
      );
    }
  }
}

async function withEntryDigests(entries) {
  const output = [];
  for (const entry of entries) {
    const sizeBytes =
      entry.sizeBytes ?? Buffer.byteLength(Buffer.from(entry.data ?? ""));
    output.push({
      ...entry,
      sizeBytes,
      sha256:
        entry.sha256 ??
        (entry.sourcePath
          ? await sha256File(entry.sourcePath)
          : sha256(entry.data ?? "")),
    });
  }
  return output;
}

async function sha256File(path) {
  const digest = createHash("sha256");
  const input = createReadStream(path);
  for await (const chunk of input) digest.update(chunk);
  return digest.digest("hex");
}

function thirdPartyNotices(lock, toolchains = undefined) {
  return [
    "dasCowork Primary Runtime third-party notices",
    "",
    `Source candidate: ${lock.candidate.name} ${lock.candidate.tag} ${lock.candidate.license.spdx}`,
    "",
    ...Object.entries(lock.components).flatMap(([group, components]) =>
      components.map(
        (component) =>
          `${group}: ${component.name}@${component.version} ${component.license} ${component.source} ${component.sha256}`,
      ),
    ),
    ...(toolchains
      ? Object.entries(toolchains.targets).flatMap(([target, toolchain]) => [
          `toolchain:${target}: ${toolchain.node.name}@${toolchain.node.version} ${toolchain.node.license} ${toolchain.node.url} ${toolchain.node.sha256}`,
          `toolchain:${target}: ${toolchain.python.name}@${toolchain.python.version} ${toolchain.python.license} ${toolchain.python.url} ${toolchain.python.sha256}`,
        ])
      : []),
    "",
  ].join("\n");
}

function sbom({ lock, toolchains, target, bundleVersion }) {
  return {
    schemaVersion: "dascowork-primary-runtime-sbom.v1",
    target,
    bundleVersion,
    candidate: lock.candidate,
    components: lock.components,
    toolchain: toolchains.targets[target],
  };
}

function textEntry(path, value) {
  return {
    path,
    data:
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  };
}

function binaryEntry(path, data) {
  return { path, data };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const target = parseRuntimeTargetOption(argv);
  const explicitInputRoot = optionValue(argv, "--input-root");
  return {
    target,
    lock: resolve(
      optionValue(argv, "--lock") ??
        fileURLToPath(new URL("../runtime-sources.lock.json", import.meta.url)),
    ),
    inputRoot: resolve(
      explicitInputRoot ??
        new URL("../resources/runtime-inputs/fixture-only", import.meta.url)
          .pathname,
    ),
    inputRootWasExplicit: Boolean(explicitInputRoot),
    outputRoot: resolve(
      optionValue(argv, "--output-root") ??
        fileURLToPath(new URL("../dist", import.meta.url)),
    ),
    version: optionValue(argv, "--version"),
    toolchainsLock: resolve(
      optionValue(argv, "--toolchains-lock") ??
        fileURLToPath(
          new URL("../runtime-toolchains.lock.json", import.meta.url),
        ),
    ),
    hardLimitsPath: resolve(
      optionValue(argv, "--hard-limits") ??
        fileURLToPath(new URL("../runtime-hard-limits.json", import.meta.url)),
    ),
    inputValidationPath: resolve(
      optionValue(argv, "--input-validation") ??
        join(
          explicitInputRoot ??
            new URL("../resources/runtime-inputs/fixture-only", import.meta.url)
              .pathname,
          "component-smoke.json",
        ),
    ),
    releaseBudgetPath: optionalResolvedValue(argv, "--release-budget"),
    performanceReportPath: optionalResolvedValue(argv, "--performance-report"),
    zipCompressionLevel: parseZipCompressionLevel(
      optionValue(argv, "--compression-level") ??
        process.env.PRIMARY_RUNTIME_ZIP_COMPRESSION_LEVEL ??
        "9",
    ),
  };
}

function parseZipCompressionLevel(value) {
  const level = Number(value);
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new Error("Expected --compression-level to be an integer from 0 through 9.");
  }
  return level;
}

function optionalResolvedValue(argv, name) {
  const value = optionValue(argv, name);
  return value ? resolve(value) : undefined;
}

function optionValue(argv, name) {
  const equalsPrefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === name) {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
        throw new Error(`Expected a value after ${name}.`);
      }
      return argv[index + 1];
    }
    if (item.startsWith(equalsPrefix)) return item.slice(equalsPrefix.length);
  }
  return undefined;
}

async function readComponentSmoke({ path, target, inputManifestSha256 }) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      "AT-RT-BUILD-01 blocked: verified Runtime component smoke receipt is missing.",
    );
  }
  if (
    receipt.schemaVersion !== "dascowork-primary-runtime-input-validation.v1" ||
    receipt.status !== "verified" ||
    receipt.target !== target ||
    receipt.inputManifestSha256 !== inputManifestSha256 ||
    !Array.isArray(receipt.commands) ||
    receipt.commands.length === 0
  ) {
    throw new Error(
      "AT-RT-BUILD-01 blocked: component smoke receipt does not bind this input root.",
    );
  }
  return receipt;
}

async function readReviewedReleaseEvidence({
  target,
  budgetPath,
  performancePath,
  hardLimits,
}) {
  if (Boolean(budgetPath) !== Boolean(performancePath)) {
    throw new Error(
      "AT-RT-BUILD-01 blocked: final engineering candidates require both --release-budget and --performance-report.",
    );
  }
  if (!budgetPath) return undefined;
  const [budgetBytes, performanceBytes] = await Promise.all([
    readFile(budgetPath),
    readFile(performancePath),
  ]);
  const budget = JSON.parse(budgetBytes.toString("utf8"));
  const performance = JSON.parse(performanceBytes.toString("utf8"));
  verifyRuntimeBudgets({ budgets: budget, measurements: performance });
  assertBudgetWithinHardLimits({
    target,
    budget: budget.targets[target],
    hardLimits,
  });
  return {
    reviewedBudgetSha256: sha256(budgetBytes),
    performanceReportSha256: sha256(performanceBytes),
    releaseClass: "engineering-final-candidate",
  };
}
