#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson } from "../src/repository.mjs";

const supportedTargets = new Set(["darwin-x64", "darwin-arm64", "win32-x64", "linux-x64"]);
const targets = new Map();
const options = parseArgs(process.argv.slice(2));
for (const [target, root] of targets) await assertTargetEvidence(target, root);

const originUrl = new URL(options.origin);
if (
  originUrl.protocol !== "https:" ||
  originUrl.username ||
  originUrl.password ||
  originUrl.pathname !== "/" ||
  originUrl.search ||
  originUrl.hash
) {
  throw new Error("Engineering metadata origin must be an exact HTTPS origin.");
}
const origin = originUrl.origin;
const now = new Date();
const issuedAt = now.toISOString();
const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
const releases = await Promise.all(
  [...targets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
    async ([target, root]) => releaseForTarget({ target, root, origin }),
  ),
);
const config = {
  schemaVersion: 1,
  sequence: options.sequence,
  channel: options.channel,
  manifestUrl: `${origin}/v1/runtime/channels/${options.channel}/manifest.json`,
  pollIntervalMs: 3_600_000,
  issuedAt,
  expiresAt,
  keyId: options.configKeyId,
};
const manifest = {
  schemaVersion: 1,
  sequence: options.sequence,
  channel: options.channel,
  issuedAt,
  expiresAt,
  keyId: options.manifestKeyId,
  releases,
};
const evidence = {
  schemaVersion: "dascowork-primary-runtime-engineering-metadata.v1",
  releaseClass: "engineering",
  productionTrust: false,
  publiclyDeployable: false,
  configUnsignedSha256: sha256(canonicalJson(config)),
  manifestUnsignedSha256: sha256(canonicalJson(manifest)),
  targets: Object.fromEntries(
    await Promise.all(
      [...targets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
        async ([target, root]) => [target, await engineeringEvidence(target, root)],
      ),
    ),
  ),
};
await mkdir(options.output, { recursive: true });
await writeJson(join(options.output, "config.unsigned.json"), config);
await writeJson(join(options.output, "manifest.unsigned.json"), manifest);
await writeJson(join(options.output, "engineering-evidence.json"), evidence);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function releaseForTarget({ target, root, origin }) {
  const [platform, arch] = target.split("-");
  const [runtime, provenance, budget] = await Promise.all([
    readJson(join(root, "runtime.json")),
    readJson(join(root, "provenance.json")),
    readJson(join(root, "runtime-budgets.json")),
  ]);
  const targetBudget = budget.targets?.[target];
  if (!targetBudget || provenance.bundleVersion !== runtime.bundleVersion) {
    throw new Error(`Engineering metadata cannot bind ${target} to the reviewed budget.`);
  }
  return {
    platform,
    arch,
    version: runtime.bundleVersion,
    archiveFormat: "zip",
    archiveUrl: `${origin}/v1/runtime/archives/${runtime.bundleVersion}/${target}/primary-runtime.zip`,
    archiveSizeBytes: provenance.archiveSizeBytes,
    archiveSha256: provenance.archiveSha256,
    budget: targetBudget,
  };
}

async function engineeringEvidence(target, root) {
  const required = [
    "provenance.json",
    "platform-validation.json",
    "component-smoke.json",
    "build-unpack-measurement.json",
    "runtime-inputs.manifest.json",
    "performance-report.json",
    "runtime-budgets.json",
  ];
  const document = { target };
  for (const name of required) document[name] = sha256(await readFile(join(root, name)));
  const provenance = await readJson(join(root, "provenance.json"));
  if (
    provenance.target !== target ||
    provenance.productionTrust !== false ||
    provenance.releaseClass !== "engineering-final-candidate" ||
    !isSha256(provenance.reviewedBudgetSha256) ||
    !isSha256(provenance.performanceReportSha256)
  ) {
    throw new Error(`Engineering metadata cannot use invalid ${target} provenance.`);
  }
  return document;
}

async function assertTargetEvidence(target, root) {
  if (!supportedTargets.has(target)) throw new Error(`Unsupported target ${target}.`);
  const directory = await stat(root).catch(() => undefined);
  if (!directory?.isDirectory()) throw new Error(`Target evidence root is missing: ${target}.`);
  for (const name of [
    "primary-runtime.zip",
    "runtime.json",
    "provenance.json",
    "platform-validation.json",
    "component-smoke.json",
    "build-unpack-measurement.json",
    "runtime-inputs.manifest.json",
    "performance-report.json",
    "runtime-budgets.json",
  ]) {
    const details = await stat(join(root, name)).catch(() => undefined);
    if (!details?.isFile() || details.size <= 0) {
      throw new Error(`Target ${target} is missing declared engineering evidence ${name}.`);
    }
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const assignment = argv[index + 1] ?? "";
      const equal = assignment.indexOf("=");
      const target = assignment.slice(0, equal);
      const root = assignment.slice(equal + 1);
      if (!supportedTargets.has(target) || !root || targets.has(target)) {
        throw new Error("--target requires one unique matrix target=staging-root pair.");
      }
      targets.set(target, resolve(root));
      index += 1;
      continue;
    }
    if (!argument.startsWith("--") || !argv[index + 1]) {
      throw new Error("Invalid engineering metadata option.");
    }
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  if (targets.size !== supportedTargets.size) {
    throw new Error("Engineering metadata requires exactly four target staging roots.");
  }
  const required = (name) => {
    const value = values.get(name);
    if (!value) throw new Error(`Expected ${name}.`);
    return value;
  };
  const releaseClass = required("--release-class");
  if (releaseClass !== "engineering") throw new Error("Only engineering metadata is supported.");
  const sequence = Number(values.get("--sequence") ?? 1);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("Engineering metadata sequence must be a positive integer.");
  }
  return {
    output: resolve(required("--output")),
    origin: values.get("--origin") ?? "https://engineering.invalid",
    channel: values.get("--channel") ?? "engineering",
    sequence,
    configKeyId: values.get("--config-key-id") ?? "engineering-config-v1",
    manifestKeyId: values.get("--manifest-key-id") ?? "engineering-manifest-v1",
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
