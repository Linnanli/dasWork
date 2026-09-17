#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./source-lock.mjs";
import { readRuntimeHardLimits } from "./runtime-hard-limits.mjs";
import {
  assertNativeRuntimeTarget,
  parseRuntimeTargetOption,
  supportedRuntimeTargets,
} from "./runtime-target.mjs";
import { readStoredZipArchive } from "./zip-writer.mjs";

const argumentsValue = parseArgs(process.argv.slice(2));
const target = argumentsValue.allowCrossTarget
  ? assertSupportedRuntimeTarget(argumentsValue.target)
  : assertNativeRuntimeTarget(argumentsValue.target);
const targetRoot = join(argumentsValue.outputRoot, target);
const archivePath = argumentsValue.archive ?? join(targetRoot, "primary-runtime.zip");
const provenancePath = argumentsValue.provenance ?? join(targetRoot, "provenance.json");
const archive = await readFile(archivePath);
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const [sourceLockBytes, toolchainsLockBytes, hardLimitsBytes] = await Promise.all([
  readFile(argumentsValue.lock),
  readFile(argumentsValue.toolchainsLock),
  readFile(argumentsValue.hardLimitsPath),
]);
await readRuntimeHardLimits(argumentsValue.hardLimitsPath);
const entries = readStoredZipArchive(archive);
const entryMap = new Map(entries.map((entry) => [entry.path, entry.data]));
const manifest = readJsonEntry(entryMap, "runtime.json");

verifyProvenance({
  provenance,
  archive,
  target,
  manifest,
  sourceLockBytes,
  toolchainsLockBytes,
  hardLimitsBytes,
  reviewedBudgetBytes: argumentsValue.releaseBudgetPath
    ? await readFile(argumentsValue.releaseBudgetPath)
    : undefined,
  performanceReportBytes: argumentsValue.performanceReportPath
    ? await readFile(argumentsValue.performanceReportPath)
    : undefined,
});
verifyManifest({ manifest, entryMap, target });
verifyCandidateEvidence({ provenance, entryMap, target });
verifyBundledPlugin({ entryMap, manifest });
verifySourceDigests({ entryMap, manifest });

process.stdout.write(
  `${JSON.stringify(
    {
      status: "verified",
      target,
      archiveSha256: sha256(archive),
      bundleVersion: manifest.bundleVersion,
    },
    null,
    2,
  )}\n`,
);

function verifyProvenance({
  provenance,
  archive,
  target,
  manifest,
  sourceLockBytes,
  toolchainsLockBytes,
  hardLimitsBytes,
  reviewedBudgetBytes,
  performanceReportBytes,
}) {
  if (
    provenance.schemaVersion !== "dascowork-primary-runtime-provenance.v1" ||
    provenance.target !== target ||
    provenance.archiveSha256 !== sha256(archive) ||
    provenance.archiveSizeBytes !== archive.byteLength ||
    provenance.bundleVersion !== manifest.bundleVersion ||
    provenance.runtimeManifestSha256 !==
      sha256(`${JSON.stringify(manifest, null, 2)}\n`) ||
    provenance.sourceLockSha256 !== sha256(sourceLockBytes) ||
    provenance.toolchainsLockSha256 !== sha256(toolchainsLockBytes) ||
    provenance.hardLimitsSha256 !== sha256(hardLimitsBytes) ||
    !["engineering-candidate", "engineering-final-candidate"].includes(
      provenance.releaseClass,
    ) ||
    provenance.productionTrust !== false
  ) {
    throw new Error("AT-RT-BUILD-01 blocked: Runtime provenance does not match archive.");
  }
  if (Boolean(reviewedBudgetBytes) !== Boolean(performanceReportBytes)) {
    throw new Error(
      "AT-RT-BUILD-01 blocked: final verification requires both --release-budget and --performance-report.",
    );
  }
  if (provenance.releaseClass === "engineering-final-candidate") {
    if (
      !reviewedBudgetBytes ||
      !performanceReportBytes ||
      provenance.reviewedBudgetSha256 !== sha256(reviewedBudgetBytes) ||
      provenance.performanceReportSha256 !== sha256(performanceReportBytes)
    ) {
      throw new Error("AT-RT-BUILD-01 blocked: final candidate lacks reviewed budget evidence.");
    }
  } else if (reviewedBudgetBytes || performanceReportBytes) {
    throw new Error("AT-RT-BUILD-01 blocked: P1a candidate must not claim reviewed budget evidence.");
  }
}

function verifyCandidateEvidence({ provenance, entryMap, target }) {
  const sourceLock = requireEntry(entryMap, "provenance/source-lock.json");
  const toolchainsLock = requireEntry(entryMap, "provenance/toolchains-lock.json");
  const inputManifest = requireEntry(entryMap, "provenance/runtime-inputs.manifest.json");
  const sbom = requireEntry(entryMap, "provenance/SBOM.json");
  const notices = requireEntry(entryMap, "provenance/THIRD_PARTY_NOTICES.txt");
  const componentSmoke = readJsonEntry(entryMap, "provenance/component-smoke.json");
  if (
    provenance.sourceLockSha256 !== sha256(sourceLock) ||
    provenance.toolchainsLockSha256 !== sha256(toolchainsLock) ||
    provenance.inputManifestSha256 !== sha256(inputManifest) ||
    provenance.sbomSha256 !== sha256(sbom) ||
    provenance.noticesSha256 !== sha256(notices) ||
    provenance.componentSmokeSha256 !== sha256(
      requireEntry(entryMap, "provenance/component-smoke.json"),
    ) ||
    componentSmoke.schemaVersion !== "dascowork-primary-runtime-input-validation.v1" ||
    componentSmoke.status !== "verified" ||
    componentSmoke.target !== target ||
    componentSmoke.inputManifestSha256 !== provenance.inputManifestSha256 ||
    componentSmoke.productionTrust !== false
  ) {
    throw new Error("AT-RT-BUILD-01 blocked: candidate evidence does not bind the archive.");
  }
}

function verifyManifest({ manifest, entryMap, target }) {
  const [platform, arch] = target.split("-");
  if (
    manifest.bundleFormatVersion !== 2 ||
    manifest.artifactToolVersion !== undefined ||
    manifest.target?.platform !== platform ||
    manifest.target?.arch !== arch ||
    !manifest.node?.path ||
    !Array.isArray(manifest.nodePackages) ||
    manifest.nodePackages.length === 0
  ) {
    throw new Error("AT-RT-BUILD-01 blocked: Runtime manifest is not generic v2.");
  }
  requireEntry(entryMap, manifest.node.path);
  for (const packageEntry of manifest.nodePackages) {
    const packageJson = readJsonEntry(entryMap, `${packageEntry.path}/package.json`);
    if (packageJson.name !== packageEntry.name || packageJson.version !== packageEntry.version) {
      throw new Error(
        `AT-RT-BUILD-01 blocked: Node package ${packageEntry.name} does not match manifest.`,
      );
    }
  }
  if (manifest.python) {
    requireEntry(entryMap, manifest.python.path);
    for (const packageEntry of manifest.python.packages ?? []) {
      if (![...entryMap.keys()].some((path) => path.startsWith(`${packageEntry.path}/`))) {
        throw new Error(`AT-RT-BUILD-01 blocked: Python package root ${packageEntry.path} is absent.`);
      }
    }
  }
  for (const binary of manifest.binaries ?? []) requireEntry(entryMap, binary.path);
}

function verifyBundledPlugin({ entryMap, manifest }) {
  for (const plugin of manifest.bundledPlugins ?? []) {
    requireEntry(entryMap, `${plugin.path}/.agents/plugins/marketplace.json`);
    const lock = readJsonEntry(entryMap, `${plugin.path}/bundle-lock.json`);
    if (lock.bundleFormatVersion !== 2 || lock.marketplace?.name !== plugin.marketplace) {
      throw new Error("AT-RT-BUILD-01 blocked: bundled plugin lock is invalid.");
    }
    for (const item of lock.plugins ?? []) {
      const pluginManifest = readJsonEntry(
        entryMap,
        `${plugin.path}/plugins/${item.name}/.codex-plugin/plugin.json`,
      );
      if (pluginManifest?.name !== item.name || pluginManifest?.version !== item.version) {
        throw new Error(
          `AT-RT-BUILD-01 blocked: bundled plugin manifest does not match lock for ${item.name}.`,
        );
      }
      for (const file of item.files ?? []) {
        const pluginFilePath = `${plugin.path}/plugins/${item.name}/${file.path}`;
        const data = requireEntry(entryMap, pluginFilePath);
        if (sha256(data) !== file.sha256) {
          throw new Error(
            `AT-RT-BUILD-01 blocked: bundled plugin file digest mismatch for ${pluginFilePath}.`,
          );
        }
      }
    }
  }
}

function verifySourceDigests({ entryMap, manifest }) {
  for (const sourceDigest of manifest.sourceDigests ?? []) {
    const data = requireEntry(entryMap, sourceDigest.path);
    if (sha256(data) !== sourceDigest.sha256) {
      throw new Error(
        `AT-RT-BUILD-01 blocked: source digest mismatch for ${sourceDigest.path}.`,
      );
    }
  }
}

function requireEntry(entryMap, path) {
  const entry = entryMap.get(path);
  if (!entry) throw new Error(`AT-RT-BUILD-01 blocked: archive is missing ${path}.`);
  return entry;
}

function readJsonEntry(entryMap, path) {
  return JSON.parse(requireEntry(entryMap, path).toString("utf8"));
}

function parseArgs(argv) {
  const target = parseRuntimeTargetOption(argv);
  return {
    target,
    // The final engineering-feed aggregator runs on Linux while rechecking
    // archives produced by the native matrix. This flag permits artifact
    // integrity verification without misrepresenting the runner as native.
    allowCrossTarget: argv.includes("--allow-cross-target"),
    outputRoot: resolve(
      optionValue(argv, "--output-root") ??
        fileURLToPath(new URL("../dist", import.meta.url)),
    ),
    archive: optionalResolvedValue(argv, "--archive"),
    provenance: optionalResolvedValue(argv, "--provenance"),
    lock: resolve(
      optionValue(argv, "--lock") ??
        fileURLToPath(new URL("../runtime-sources.lock.json", import.meta.url)),
    ),
    toolchainsLock: resolve(
      optionValue(argv, "--toolchains-lock") ??
        fileURLToPath(
          new URL("../runtime-toolchains.lock.json", import.meta.url),
        ),
    ),
    hardLimitsPath: resolve(
      optionValue(argv, "--hard-limits") ??
        fileURLToPath(
          new URL("../runtime-hard-limits.json", import.meta.url),
        ),
    ),
    releaseBudgetPath: optionalResolvedValue(argv, "--release-budget"),
    performanceReportPath: optionalResolvedValue(argv, "--performance-report"),
  };
}

function assertSupportedRuntimeTarget(target) {
  if (!supportedRuntimeTargets.includes(target)) {
    throw new Error(
      `AT-RT-BUILD-01 blocked: ${target} is not a supported Runtime target.`,
    );
  }
  return target;
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
