#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./source-lock.mjs";
import {
  assertNativeRuntimeTarget,
  parseRuntimeTargetOption,
} from "./runtime-target.mjs";

const options = parseArgs(process.argv.slice(2));
const target = assertNativeRuntimeTarget(options.target);
const files = await readRequiredFiles(options);
const provenance = readJson(files.provenance, "provenance");
const platformValidation = readJson(
  files.platformValidation,
  "platform validation",
);
const sourceLock = readJson(files.sourceLock, "source lock");

assertExistingBindings({
  files,
  provenance,
  platformValidation,
  sourceLock,
  target,
});

const bound = {
  ...provenance,
  desktopCommit: options.desktopCommit,
  runtimeCommit: options.runtimeCommit,
  workflowRun: {
    id: options.workflowRunId,
    repository: options.workflowRepository,
    url: options.workflowRunUrl,
  },
  platformValidationSha256: sha256(files.platformValidation),
};
const output = `${JSON.stringify(bound, null, 2)}\n`;
const temporaryPath = `${options.provenancePath}.${process.pid}.next`;
let renamed = false;
try {
  await mkdir(dirname(options.provenancePath), { recursive: true });
  await writeFile(temporaryPath, output, { mode: 0o600 });
  await rename(temporaryPath, options.provenancePath);
  renamed = true;
} finally {
  if (!renamed) await rm(temporaryPath, { force: true });
}
process.stdout.write(`${JSON.stringify(bound, null, 2)}\n`);

async function readRequiredFiles(options) {
  const entries = await Promise.all(
    Object.entries({
      provenance: options.provenancePath,
      platformValidation: options.platformValidationPath,
      archive: options.archivePath,
      sourceLock: options.sourceLockPath,
      toolchainsLock: options.toolchainsLockPath,
      inputManifest: options.inputManifestPath,
      canonicalFileManifest: options.canonicalFileManifestPath,
      runtimeManifest: options.runtimeManifestPath,
      sbom: options.sbomPath,
      notices: options.noticesPath,
      componentSmoke: options.componentSmokePath,
    }).map(async ([name, path]) => [name, await readFile(path)]),
  );
  return Object.fromEntries(entries);
}

function assertExistingBindings({
  files,
  provenance,
  platformValidation,
  sourceLock,
  target,
}) {
  const failures = [
    provenance.schemaVersion !== "dascowork-primary-runtime-provenance.v1" &&
      "schema",
    provenance.target !== target && "target",
    provenance.archiveSha256 !== sha256(files.archive) && "archive",
    provenance.archiveSizeBytes !== files.archive.byteLength && "archive-size",
    provenance.sourceLockSha256 !== sha256(files.sourceLock) && "source-lock",
    provenance.toolchainsLockSha256 !== sha256(files.toolchainsLock) &&
      "toolchains-lock",
    provenance.inputManifestSha256 !== sha256(files.inputManifest) &&
      "input-manifest",
    provenance.canonicalFileManifestSha256 !==
      sha256(files.canonicalFileManifest) && "canonical-file-manifest",
    provenance.runtimeManifestSha256 !== sha256(files.runtimeManifest) &&
      "runtime-manifest",
    provenance.sbomSha256 !== sha256(files.sbom) && "sbom",
    provenance.noticesSha256 !== sha256(files.notices) && "notices",
    provenance.componentSmokeSha256 !== sha256(files.componentSmoke) &&
      "component-smoke",
    provenance.patchSha256 !== sourceLock.candidate?.patch?.sha256 && "patch",
    (!provenance.builderIdentity ||
      typeof provenance.builderIdentity.runner !== "string") && "builder-identity",
    platformValidation.schemaVersion !==
      "dascowork-primary-runtime-platform-validation.v1" && "platform-schema",
    platformValidation.status !== "verified" && "platform-status",
    platformValidation.target !== target && "platform-target",
    platformValidation.archiveSha256 !== sha256(files.archive) &&
      "platform-archive",
    platformValidation.archiveSizeBytes !== files.archive.byteLength &&
      "platform-archive-size",
    platformValidation.runtimeManifestSha256 !== sha256(files.runtimeManifest) &&
      "platform-runtime-manifest",
    platformValidation.componentSmokeSha256 !== sha256(files.componentSmoke) &&
      "platform-component-smoke",
    platformValidation.inputValidationSha256 !== sha256(files.componentSmoke) &&
      "platform-input-validation",
    platformValidation.runner !== provenance.builderIdentity?.runner &&
      "platform-runner",
    provenance.productionTrust !== false && "production-trust",
    platformValidation.productionTrust !== false && "platform-production-trust",
  ].filter(Boolean);
  if (failures.length > 0) {
    throw new Error(
      `AT-RT-BUILD-01 blocked: cannot bind final provenance (${failures.join(", ")}).`,
    );
  }
}

function readJson(bytes, name) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`AT-RT-BUILD-01 blocked: ${name} is not valid JSON.`);
  }
}

function parseArgs(argv) {
  const target = parseRuntimeTargetOption(argv);
  const values = readOptions(argv);
  const requiredPath = (name) => resolve(requiredValue(values, name));
  const commit = (name) => {
    const value = requiredValue(values, name);
    if (!/^[a-f0-9]{40}$/u.test(value)) {
      throw new Error(`AT-RT-BUILD-01 blocked: ${name} must be a full commit SHA.`);
    }
    return value;
  };
  const workflowRunId = requiredValue(values, "--workflow-run-id");
  if (!/^[1-9]\d*$/u.test(workflowRunId)) {
    throw new Error("AT-RT-BUILD-01 blocked: --workflow-run-id must be a positive integer.");
  }
  const workflowRepository = requiredValue(values, "--workflow-repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(workflowRepository)) {
    throw new Error("AT-RT-BUILD-01 blocked: --workflow-repository is invalid.");
  }
  const workflowRunUrl = requiredValue(values, "--workflow-run-url");
  const expectedRunUrl = `https://github.com/${workflowRepository}/actions/runs/${workflowRunId}`;
  if (workflowRunUrl !== expectedRunUrl) {
    throw new Error("AT-RT-BUILD-01 blocked: --workflow-run-url does not identify this run.");
  }
  return {
    target: target ?? requiredValue(values, "--target"),
    provenancePath: requiredPath("--provenance"),
    platformValidationPath: requiredPath("--platform-validation"),
    archivePath: requiredPath("--archive"),
    sourceLockPath: requiredPath("--source-lock"),
    toolchainsLockPath: requiredPath("--toolchains-lock"),
    inputManifestPath: requiredPath("--input-manifest"),
    canonicalFileManifestPath: requiredPath("--canonical-file-manifest"),
    runtimeManifestPath: requiredPath("--runtime-manifest"),
    sbomPath: requiredPath("--sbom"),
    noticesPath: requiredPath("--notices"),
    componentSmokePath: requiredPath("--component-smoke"),
    desktopCommit: commit("--desktop-commit"),
    runtimeCommit: commit("--runtime-commit"),
    workflowRunId,
    workflowRepository,
    workflowRunUrl,
  };
}

function readOptions(argv) {
  const allowed = new Set([
    "--target",
    "--provenance",
    "--platform-validation",
    "--archive",
    "--source-lock",
    "--toolchains-lock",
    "--input-manifest",
    "--canonical-file-manifest",
    "--runtime-manifest",
    "--sbom",
    "--notices",
    "--component-smoke",
    "--desktop-commit",
    "--runtime-commit",
    "--workflow-run-id",
    "--workflow-repository",
    "--workflow-run-url",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${argument}`);
    const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`Expected a value for ${name}.`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  return values;
}

function requiredValue(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Expected ${name} <value>.`);
  return value;
}
