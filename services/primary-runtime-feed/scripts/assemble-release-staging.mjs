import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFeedPublicKeyring,
  validateReleaseTree,
} from "../src/repository.mjs";

const requiredTargets = [
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
];
const channelPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const versionPattern = /^[A-Za-z0-9._-]+$/u;

/**
 * Combines independently built target archives with signed engineering metadata.
 * The allowlist is deliberately explicit: it retains the evidence required for
 * engineering review while excluding caches and every form of private key.
 */
export async function assembleReleaseStaging({
  outputRoot,
  metadataRoot,
  targetRoots,
  configPublicKeys,
  manifestPublicKeys,
}) {
  const output = resolve(outputRoot);
  const metadata = await resolveRegularDirectory(metadataRoot, "metadata root");
  const targets = await resolveTargetRoots(targetRoots);
  await assertAbsent(output);

  const configPath = await resolveRegularFile(
    metadata,
    "config.json",
    "signed config",
  );
  const config = await readJson(configPath, "signed config");
  if (!channelPattern.test(config.channel ?? "")) {
    throw new Error("Runtime feed signed config has an invalid channel.");
  }
  const manifestRelativePath = join(
    "channels",
    config.channel,
    "manifest.json",
  );
  const manifestPath = await resolveRegularFile(
    metadata,
    manifestRelativePath,
    "signed channel manifest",
  );
  const manifest = await readJson(manifestPath, "signed channel manifest");
  const releases = indexReleases(manifest);

  await mkdir(output, { recursive: false });
  await copyInto(output, "config.json", configPath);
  await copyInto(output, manifestRelativePath, manifestPath);
  for (const target of requiredTargets) {
    const release = releases.get(target);
    const directory = join("archives", release.version, target);
    await copyInto(
      output,
      join(directory, "primary-runtime.zip"),
      await resolveRegularFile(
        targets.get(target),
        "primary-runtime.zip",
        `${target} archive`,
      ),
    );
    await copyInto(
      output,
      join(directory, "provenance.json"),
      await resolveRegularFile(
        targets.get(target),
        "provenance.json",
        `${target} provenance`,
      ),
    );
    for (const evidenceName of engineeringEvidenceFiles) {
      await copyInto(
        output,
        join(directory, "evidence", evidenceName),
        await resolveRegularFile(
          targets.get(target),
          evidenceName,
          `${target} engineering evidence ${evidenceName}`,
        ),
      );
    }
  }

  await validateReleaseTree(output, { configPublicKeys, manifestPublicKeys });
  return output;
}

const engineeringEvidenceFiles = [
  "runtime.json",
  "canonical-file-manifest.txt",
  "component-smoke.json",
  "build-unpack-measurement.json",
  "platform-validation.json",
  "runtime-inputs.manifest.json",
  "source-fetch.json",
  "performance-report.json",
  "runtime-budgets.json",
];

function indexReleases(manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !Array.isArray(manifest.releases)
  ) {
    throw new Error("Runtime feed signed channel manifest has no releases.");
  }
  const releases = new Map();
  for (const release of manifest.releases) {
    if (!release || typeof release !== "object") {
      throw new Error(
        "Runtime feed signed channel manifest has an invalid release.",
      );
    }
    const target = `${release.platform}-${release.arch}`;
    if (
      !requiredTargets.includes(target) ||
      releases.has(target) ||
      !versionPattern.test(release.version ?? "")
    ) {
      throw new Error(
        "Runtime feed signed channel manifest has an invalid target release.",
      );
    }
    releases.set(target, release);
  }
  if (releases.size !== requiredTargets.length) {
    throw new Error(
      "Runtime feed signed channel manifest is missing a release target.",
    );
  }
  return releases;
}

async function resolveTargetRoots(targetRoots) {
  if (!targetRoots || typeof targetRoots !== "object") {
    throw new Error("Runtime feed target roots are required.");
  }
  const names = Object.keys(targetRoots).sort();
  if (
    names.length !== requiredTargets.length ||
    names.some((name, index) => name !== [...requiredTargets].sort()[index])
  ) {
    throw new Error(
      "Runtime feed target roots must include exactly the release matrix.",
    );
  }
  return new Map(
    await Promise.all(
      requiredTargets.map(async (target) => [
        target,
        await resolveRegularDirectory(
          targetRoots[target],
          `${target} target root`,
        ),
      ]),
    ),
  );
}

async function resolveRegularDirectory(path, label) {
  const resolved = resolve(path);
  const details = await lstat(resolved);
  if (!details.isDirectory()) {
    throw new Error(`Runtime feed ${label} must be a regular directory.`);
  }
  return resolved;
}

async function resolveRegularFile(root, relativePath, label) {
  const path = resolve(root, relativePath);
  if (!isInside(root, path)) {
    throw new Error(`Runtime feed ${label} escapes its source root.`);
  }
  const details = await lstat(path);
  if (!details.isFile()) {
    throw new Error(`Runtime feed ${label} must be a regular file.`);
  }
  return path;
}

async function copyInto(root, relativePath, source) {
  const destination = resolve(root, relativePath);
  if (!isInside(root, destination)) {
    throw new Error(
      "Runtime feed staging destination escapes its output root.",
    );
  }
  await mkdir(resolve(destination, ".."), { recursive: true });
  await copyFile(source, destination, 0);
}

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Runtime feed staging output must not already exist.");
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Runtime feed ${label} is not valid JSON.`);
  }
}

function isInside(root, candidate) {
  const diff = relative(root, candidate);
  return (
    diff !== "" &&
    !diff.startsWith("..") &&
    !isAbsolute(diff) &&
    !diff.split(sep).includes("..")
  );
}

function parseArgs(argv) {
  const targetRoots = Object.create(null);
  let outputRoot;
  let metadataRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(
        "Expected values for --output, --metadata, and --target.",
      );
    }
    index += 1;
    if (flag === "--output") outputRoot = value;
    else if (flag === "--metadata") metadataRoot = value;
    else if (flag === "--target") {
      const equals = value.indexOf("=");
      const target = value.slice(0, equals);
      const path = value.slice(equals + 1);
      if (!requiredTargets.includes(target) || !path || targetRoots[target]) {
        throw new Error(
          "Runtime feed --target values must be unique matrix target=path pairs.",
        );
      }
      targetRoots[target] = path;
    } else {
      throw new Error("Expected --output, --metadata, and --target.");
    }
  }
  if (!outputRoot || !metadataRoot) {
    throw new Error("Expected --output, --metadata, and --target.");
  }
  return { outputRoot, metadataRoot, targetRoots };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const output = await assembleReleaseStaging({
    ...parseArgs(process.argv.slice(2)),
    configPublicKeys: requiredPublicKeyring(
      "DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON",
      "config",
    ),
    manifestPublicKeys: requiredPublicKeyring(
      "DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON",
      "manifest",
    ),
  });
  console.info(`Assembled Primary Runtime feed staging: ${output}`);
}

function requiredPublicKeyring(name, label) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return parseFeedPublicKeyring(value, label);
}
