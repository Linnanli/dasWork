#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256 } from "./source-lock.mjs";
import { assertNativeRuntimeTarget, parseRuntimeTargetOption } from "./runtime-target.mjs";
import { readStoredZipArchive } from "./zip-writer.mjs";

const options = parseArgs(process.argv.slice(2));
const target = assertNativeRuntimeTarget(options.target);
const archive = await readFile(options.archivePath);
const entries = readStoredZipArchive(archive);
const entryMap = new Map(entries.map((entry) => [entry.path, entry.data]));
const inputManifest = readJsonEntry(entryMap, "provenance/runtime-inputs.manifest.json");
const runtime = readJsonEntry(entryMap, "runtime.json");
const externalProvenance = JSON.parse(await readFile(options.provenancePath, "utf8"));
const [platform, arch] = target.split("-");
if (
  runtime.bundleFormatVersion !== 2 ||
  runtime.target?.platform !== platform ||
  runtime.target?.arch !== arch
) {
  throw new Error("AT-RT-BUILD-01 blocked: archive target does not match unpack measurement target.");
}

const directory = await mkdtemp(join(tmpdir(), "primary-runtime-unpack-"));
try {
  const unpackRoot = join(directory, "archive");
  await mkdir(unpackRoot, { recursive: true });
  for (const entry of entries) {
    const destination = safeDestination(unpackRoot, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.data, {
      mode: isExecutable(entry.path) ? 0o755 : 0o644,
    });
  }

  let unpackedBytes = 0;
  for (const entry of entries) {
    const path = safeDestination(unpackRoot, entry.path);
    const details = await stat(path);
    if (!details.isFile() || details.size !== entry.data.byteLength) {
      throw new Error("AT-RT-BUILD-01 blocked: archive unpack did not reproduce a regular file.");
    }
    unpackedBytes += details.size;
  }
  const receipt = {
    schemaVersion: "dascowork-primary-runtime-p1a-build-unpack-measurement.v1",
    target,
    archiveSha256: sha256(archive),
    archiveBytes: archive.byteLength,
    unpackedBytes,
    entryCount: entries.length,
    sourceLockSha256: externalProvenance.sourceLockSha256,
    toolchainsLockSha256: externalProvenance.toolchainsLockSha256,
    inputManifestSha256: externalProvenance.inputManifestSha256,
    inputFileManifestSha256: externalProvenance.inputFileManifestSha256,
    canonicalFileManifestSha256: externalProvenance.canonicalFileManifestSha256,
    hardLimitsSha256: externalProvenance.hardLimitsSha256,
    runner: process.env.RUNNER_IMAGE ?? inputManifest.builder?.runner,
    releaseClass: "engineering-candidate",
    productionTrust: false,
  };
  const bindingFailures = [
    externalProvenance.archiveSha256 !== receipt.archiveSha256 && "archive",
    externalProvenance.target !== target && "target",
    externalProvenance.inputManifestSha256 !== sha256(requireEntry(entryMap, "provenance/runtime-inputs.manifest.json")) && "input-manifest",
    externalProvenance.sourceLockSha256 !== sha256(requireEntry(entryMap, "provenance/source-lock.json")) && "source-lock",
    !/^[a-f0-9]{64}$/u.test(receipt.canonicalFileManifestSha256 ?? "") && "canonical-files",
    !/^[a-f0-9]{64}$/u.test(receipt.toolchainsLockSha256 ?? "") && "toolchains",
    !/^[a-f0-9]{64}$/u.test(receipt.hardLimitsSha256 ?? "") && "hard-limits",
  ].filter(Boolean);
  if (bindingFailures.length > 0) {
    throw new Error(
      `AT-RT-BUILD-01 blocked: unpack provenance does not bind this archive (${bindingFailures.join(", ")}).`,
    );
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function requireEntry(entryMap, path) {
  const entry = entryMap.get(path);
  if (!entry) throw new Error(`AT-RT-BUILD-01 blocked: archive is missing ${path}.`);
  return entry;
}

function readJsonEntry(entryMap, path) {
  return JSON.parse(requireEntry(entryMap, path).toString("utf8"));
}

function safeDestination(root, archivePath) {
  if (
    !archivePath ||
    archivePath.includes("\\") ||
    isAbsolute(archivePath) ||
    archivePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("AT-RT-BUILD-01 blocked: archive entry path is unsafe.");
  }
  const destination = resolve(root, ...archivePath.split("/"));
  const diff = relative(root, destination);
  if (
    !diff ||
    diff.startsWith("..") ||
    isAbsolute(diff) ||
    diff.split(sep).includes("..")
  ) {
    throw new Error("AT-RT-BUILD-01 blocked: archive entry escapes unpack root.");
  }
  return destination;
}

function isExecutable(path) {
  return /^(?:dependencies\/(?:node|python|native)\/bin\/)/u.test(path);
}

function parseArgs(argv) {
  const target = parseRuntimeTargetOption(argv);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--target=")) continue;
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    if (!new Set(["--target", "--archive", "--output", "--provenance"]).has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Expected a value after ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const required = (name) => {
    const value = values.get(name);
    if (!value) throw new Error(`Expected ${name} <path>.`);
    return resolve(value);
  };
  return {
    target: target ?? values.get("--target"),
    archivePath: required("--archive"),
    outputPath: required("--output"),
    provenancePath: required("--provenance"),
  };
}
