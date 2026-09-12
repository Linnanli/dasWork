#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./source-lock.mjs";
import { assertNativeRuntimeTarget, parseRuntimeTargetOption } from "./runtime-target.mjs";
import { readStoredZipArchive } from "./zip-writer.mjs";

const executeFile = promisify(execFile);
const options = parseArgs(process.argv.slice(2));
const target = assertNativeRuntimeTarget(options.target);
const archive = await readFile(options.archivePath);
const entries = readStoredZipArchive(archive);
const entryMap = new Map(entries.map((entry) => [entry.path, entry.data]));
const runtimeManifest = JSON.parse(requireEntry(entryMap, "runtime.json").toString("utf8"));
const [platform, arch] = target.split("-");
if (
  runtimeManifest.bundleFormatVersion !== 2 ||
  runtimeManifest.target?.platform !== platform ||
  runtimeManifest.target?.arch !== arch
) {
  throw new Error("AT-RT-PLATFORM-01 blocked: archive runtime manifest has the wrong target.");
}

const directory = await mkdtemp(join(tmpdir(), "primary-runtime-platform-"));
try {
  const inputRoot = join(directory, "runtime-inputs");
  for (const entry of entries) {
    if (!/^(?:dependencies|plugins|fonts)\//u.test(entry.path)) continue;
    const path = join(inputRoot, ...entry.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.data, { mode: isExecutableEntry(entry.path) ? 0o755 : 0o644 });
    if (isExecutableEntry(entry.path)) await chmod(path, 0o755);
  }
  await mkdir(inputRoot, { recursive: true });
  await writeFile(
    join(inputRoot, "runtime-inputs.manifest.json"),
    requireEntry(entryMap, "provenance/runtime-inputs.manifest.json"),
  );
  const inputReceipt = join(directory, "input-validation.json");
  const verifier = new URL("./verify-runtime-inputs.mjs", import.meta.url).pathname;
  await executeFile(process.execPath, [
    verifier,
    "--target",
    target,
    "--input-root",
    inputRoot,
    "--receipt",
    inputReceipt,
    "--source-lock",
    options.sourceLock,
    "--toolchains-lock",
    options.toolchainsLock,
  ]);
  const inputValidation = JSON.parse(await readFile(inputReceipt, "utf8"));
  const receipt = {
    schemaVersion: "dascowork-primary-runtime-platform-validation.v1",
    status: "verified",
    target,
    runner: process.env.RUNNER_IMAGE ?? inputValidation.runner,
    archiveSha256: sha256(archive),
    archiveSizeBytes: archive.byteLength,
    runtimeManifestSha256: sha256(requireEntry(entryMap, "runtime.json")),
    componentSmokeSha256: sha256(requireEntry(entryMap, "provenance/component-smoke.json")),
    inputValidationSha256: sha256(await readFile(inputReceipt)),
    commands: inputValidation.commands,
    render: inputValidation.render,
    productionTrust: false,
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function requireEntry(entryMap, path) {
  const entry = entryMap.get(path);
  if (!entry) throw new Error(`AT-RT-PLATFORM-01 blocked: archive is missing ${path}.`);
  return entry;
}

function isExecutableEntry(path) {
  return (
    /^(?:dependencies\/(?:node|python)\/bin\/)/u.test(path) ||
    /^dependencies\/native\/libreoffice\/program\/soffice(?:\.exe)?$/u.test(path) ||
    /^dependencies\/native\/poppler\/bin\/(?:pdfinfo|pdftoppm)(?:\.exe)?$/u.test(path)
  );
}

function parseArgs(argv) {
  const target = parseRuntimeTargetOption(argv);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (!new Set(["--target", "--archive", "--output", "--source-lock", "--toolchains-lock"]).has(name)) {
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
    archivePath: required("--archive"),
    outputPath: required("--output"),
    sourceLock: resolve(values.get("--source-lock") ?? new URL("../runtime-sources.lock.json", import.meta.url).pathname),
    toolchainsLock: resolve(values.get("--toolchains-lock") ?? new URL("../runtime-toolchains.lock.json", import.meta.url).pathname),
  };
}
