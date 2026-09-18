import { createHash, createPublicKey, sign, verify } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const FEED_ROOT = "/v1/runtime";
export const CONFIG_PATH = `${FEED_ROOT}/config.json`;
const maxMetadataBytes = 1024 * 1024;
const requiredTargets = [
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
];
const provenanceSchema = "dascowork-primary-runtime-provenance.v1";
const configKeys = [
  "schemaVersion",
  "sequence",
  "channel",
  "manifestUrl",
  "pollIntervalMs",
  "issuedAt",
  "expiresAt",
  "keyId",
  "signature",
];
const manifestKeys = [
  "schemaVersion",
  "sequence",
  "channel",
  "issuedAt",
  "expiresAt",
  "keyId",
  "releases",
  "signature",
];
const manifestReleaseKeys = [
  "platform",
  "arch",
  "version",
  "archiveFormat",
  "archiveUrl",
  "archiveSizeBytes",
  "archiveSha256",
  "budget",
];
const releaseBudgetKeys = [
  "maxArchiveBytes",
  "maxUnpackedBytes",
  "minimumFreeDiskBytes",
  "maxColdInstallMs",
  "maxMainEventLoopDelayP99Ms",
  "maxMainEventLoopDelayMaxMs",
];

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function canonicalSignedPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Signed Runtime feed metadata must be an object.");
  }
  const { signature: _signature, ...unsigned } = value;
  return canonicalJson(unsigned);
}

export function signFeedMetadata(value, privateKey) {
  const payload = canonicalSignedPayload(value);
  return {
    ...value,
    signature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString(
      "base64",
    ),
  };
}

export function verifyFeedMetadataSignature(value, publicKeys, label) {
  if (
    !publicKeys ||
    typeof publicKeys !== "object" ||
    Array.isArray(publicKeys)
  ) {
    throw new Error(`Primary Runtime ${label} public keyring is invalid.`);
  }
  const key = publicKeys[value.keyId];
  if (!key || typeof key !== "string") {
    throw new Error(`Primary Runtime ${label} uses an unknown key ID.`);
  }
  if (!isBase64(value.signature)) {
    throw new Error(`Primary Runtime ${label} signature is not base64.`);
  }
  let publicKey;
  try {
    publicKey = createPublicKey(key);
  } catch {
    throw new Error(`Primary Runtime ${label} public key is invalid.`);
  }
  if (
    !verify(
      null,
      Buffer.from(canonicalSignedPayload(value), "utf8"),
      publicKey,
      Buffer.from(value.signature, "base64"),
    )
  ) {
    throw new Error(`Primary Runtime ${label} signature is invalid.`);
  }
}

export function parseFeedPublicKeyring(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      `Primary Runtime ${label} public keyring is not valid JSON.`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0 ||
    Object.values(parsed).some(
      (key) => typeof key !== "string" || key.trim().length === 0,
    )
  ) {
    throw new Error(`Primary Runtime ${label} public keyring is invalid.`);
  }
  return parsed;
}

export function runtimeFeedPathForRequest(pathname) {
  if (pathname === CONFIG_PATH) return "config.json";
  const manifest =
    /^\/v1\/runtime\/channels\/([a-z0-9][a-z0-9._-]{0,63})\/manifest\.json$/u.exec(
      pathname,
    );
  if (manifest) return `channels/${manifest[1]}/manifest.json`;
  const archive =
    /^\/v1\/runtime\/archives\/([A-Za-z0-9._-]+)\/([a-z0-9]+)-(x64|arm64)\/primary-runtime\.zip$/u.exec(
      pathname,
    );
  if (archive)
    return `archives/${archive[1]}/${archive[2]}-${archive[3]}/primary-runtime.zip`;
  return null;
}

export async function readPublishedRuntimeFeedAsset(repositoryRoot, pathname) {
  const relativePath = runtimeFeedPathForRequest(pathname);
  if (!relativePath) return null;
  const root = await resolvePublishedRoot(repositoryRoot);
  const path = resolve(root, relativePath);
  if (!isInside(root, path))
    throw new Error("Runtime feed path escapes the repository.");
  const details = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!details) return null;
  if (!details.isFile()) {
    throw new Error("Runtime feed refuses a non-regular published asset.");
  }
  if (details.size <= 0)
    throw new Error("Runtime feed refuses an empty asset.");
  const metadata = !relativePath.endsWith(".zip");
  if (metadata && details.size > maxMetadataBytes) {
    throw new Error("Runtime feed metadata exceeds the permitted size.");
  }
  return {
    path,
    size: details.size,
    etag: `"${await sha256File(path)}"`,
    cacheControl: metadata ? "no-cache" : "public, max-age=31536000, immutable",
    contentType: relativePath.endsWith(".zip")
      ? "application/zip"
      : "application/json; charset=utf-8",
  };
}

/** Copies a fully validated static release tree and atomically swaps a current symlink. */
export async function publishRepository({
  repositoryRoot,
  stagedRoot,
  configPublicKeys,
  manifestPublicKeys,
  allowSyntheticTestOnly = false,
  allowCalibrationCandidate = false,
}) {
  const root = resolve(repositoryRoot);
  const staging = resolve(stagedRoot);
  if (!isInside(root, staging) || root === staging) {
    throw new Error(
      "Runtime feed staging directory must live beneath its repository root.",
    );
  }
  await validateReleaseTree(staging, {
    configPublicKeys,
    manifestPublicKeys,
    allowSyntheticTestOnly,
    allowCalibrationCandidate,
  });
  await validatePublishedArchiveImmutability(root, staging);
  const releases = resolve(root, "releases");
  const next = resolve(
    releases,
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const current = resolve(root, "current");
  const nextLink = resolve(
    root,
    `.current-next-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  await mkdir(releases, { recursive: true });
  await cp(staging, next, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await symlink(relative(root, next), nextLink);
  await rename(nextLink, current);
}

async function validatePublishedArchiveImmutability(repositoryRoot, stagedRoot) {
  const [publishedReleases, stagedReleases] = await Promise.all([
    publishedArchiveRecords(repositoryRoot),
    releaseArchiveRecords(stagedRoot),
  ]);
  for (const [key, staged] of stagedReleases) {
    const published = publishedReleases.get(key);
    if (!published) continue;
    if (published.archiveSha256 !== staged.archiveSha256) {
      throw new Error(
        `Runtime feed immutable archive ${key} is already published with a different SHA256.`,
      );
    }
  }
}

async function publishedArchiveRecords(repositoryRoot) {
  const records = new Map();
  const releasesRoot = resolve(repositoryRoot, "releases");
  let entries;
  try {
    entries = await readdir(releasesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return records;
    throw error;
  }
  for (const entry of entries) {
    const releaseRoot = resolve(releasesRoot, entry.name);
    if (!isInside(releasesRoot, releaseRoot)) {
      throw new Error("Runtime feed release history path escapes repository.");
    }
    const details = await lstat(releaseRoot);
    if (details.isSymbolicLink()) {
      throw new Error("Runtime feed release history refuses symlinks.");
    }
    if (!details.isDirectory()) continue;
    const releaseRecords = await releaseArchiveRecords(releaseRoot).catch(
      (error) => {
        if (error?.code === "ENOENT") return new Map();
        throw error;
      },
    );
    for (const [key, record] of releaseRecords) {
      const existing = records.get(key);
      if (existing && existing.archiveSha256 !== record.archiveSha256) {
        throw new Error(
          `Runtime feed immutable archive ${key} has conflicting published history.`,
        );
      }
      records.set(key, record);
    }
  }
  return records;
}

async function releaseArchiveRecords(root) {
  const config = JSON.parse(
    await readRegularFile(resolve(root, "config.json"), "config"),
  );
  const manifestPath = resolve(
    root,
    "channels",
    config.channel,
    "manifest.json",
  );
  const manifest = JSON.parse(
    await readRegularFile(manifestPath, "channel manifest"),
  );
  const records = new Map();
  if (!Array.isArray(manifest.releases)) return records;
  for (const release of manifest.releases) {
    if (
      typeof release?.version !== "string" ||
      typeof release.platform !== "string" ||
      typeof release.arch !== "string" ||
      typeof release.archiveSha256 !== "string"
    ) {
      continue;
    }
    records.set(`${release.version}/${release.platform}-${release.arch}`, {
      archiveSha256: release.archiveSha256,
    });
  }
  return records;
}

async function resolvePublishedRoot(repositoryRoot) {
  const configuredRoot = resolve(repositoryRoot);
  // macOS commonly presents /var as a symlink to /private/var. Resolve the
  // repository root before comparing it to the realpath of the `current`
  // release pointer; otherwise a valid pointer is incorrectly treated as
  // outside the repository and the server falls back to an empty root.
  const root = await realpath(configuredRoot).catch((error) => {
    if (error?.code === "ENOENT") return configuredRoot;
    throw error;
  });
  const current = resolve(root, "current");
  try {
    const details = await lstat(current);
    if (!details.isSymbolicLink() && !details.isDirectory()) return root;
    const published = await realpath(current);
    return isInside(root, published) ? published : root;
  } catch (error) {
    if (error?.code === "ENOENT") return root;
    throw error;
  }
}

export async function validateReleaseTree(
  root,
  {
    configPublicKeys,
    manifestPublicKeys,
    allowSyntheticTestOnly = false,
    allowCalibrationCandidate = false,
  } = {},
) {
  if (Boolean(configPublicKeys) !== Boolean(manifestPublicKeys)) {
    throw new Error(
      "Runtime feed requires both config and manifest public keyrings.",
    );
  }
  const config = JSON.parse(
    await readRegularFile(resolve(root, "config.json"), "config"),
  );
  const configPayload = canonicalSignedPayload(config);
  if (
    !hasExactlyKeys(config, configKeys) ||
    config.schemaVersion !== 1 ||
    !isPositiveInteger(config.sequence) ||
    !isChannel(config.channel) ||
    !isPollInterval(config.pollIntervalMs) ||
    !isValidMetadataWindow(config) ||
    !isKeyId(config.keyId) ||
    !isBase64(config.signature) ||
    Buffer.byteLength(configPayload, "utf8") > maxMetadataBytes
  ) {
    throw new Error("Runtime feed config is invalid or oversized.");
  }
  const manifestUrl = new URL(config.manifestUrl);
  if (
    manifestUrl.protocol !== "https:" ||
    manifestUrl.username ||
    manifestUrl.password ||
    manifestUrl.hash ||
    manifestUrl.search ||
    manifestUrl.pathname !==
      `${FEED_ROOT}/channels/${config.channel}/manifest.json`
  ) {
    throw new Error(
      "Runtime feed config does not select its channel manifest.",
    );
  }
  const manifestPath = resolve(
    root,
    "channels",
    config.channel,
    "manifest.json",
  );
  if (!isInside(resolve(root), manifestPath))
    throw new Error("Runtime feed manifest escapes repository.");
  const manifest = JSON.parse(
    await readRegularFile(manifestPath, "channel manifest"),
  );
  if (
    !hasExactlyKeys(manifest, manifestKeys) ||
    manifest.schemaVersion !== 1 ||
    !isPositiveInteger(manifest.sequence) ||
    manifest.channel !== config.channel ||
    !isValidMetadataWindow(manifest) ||
    !isKeyId(manifest.keyId) ||
    !isBase64(manifest.signature) ||
    !Array.isArray(manifest.releases) ||
    manifest.releases.length !==
      (allowCalibrationCandidate ? 1 : requiredTargets.length)
  ) {
    throw new Error(
      "Runtime feed manifest is invalid or does not contain the complete matrix.",
    );
  }
  if (configPublicKeys) {
    verifyFeedMetadataSignature(config, configPublicKeys, "config");
    verifyFeedMetadataSignature(manifest, manifestPublicKeys, "manifest");
  }
  const seenTargets = new Set();
  for (const release of manifest.releases) {
    if (
      !release ||
      typeof release !== "object" ||
      !hasExactlyKeys(release, manifestReleaseKeys) ||
      typeof release.platform !== "string" ||
      typeof release.arch !== "string" ||
      typeof release.version !== "string" ||
      release.version.length === 0 ||
      release.archiveFormat !== "zip" ||
      !release.archiveUrl ||
      !release.archiveSha256 ||
      !/^[a-f0-9]{64}$/u.test(release.archiveSha256) ||
      !Number.isSafeInteger(release.archiveSizeBytes) ||
      release.archiveSizeBytes <= 0 ||
      !isReleaseBudget(release.budget)
    ) {
      throw new Error("Runtime feed manifest has an invalid release.");
    }
    const target = `${release.platform}-${release.arch}`;
    if (!requiredTargets.includes(target) || seenTargets.has(target)) {
      throw new Error(
        "Runtime feed manifest has a duplicate or unsupported target.",
      );
    }
    seenTargets.add(target);
    await validateReleaseArchiveAndProvenance({
      root,
      config,
      manifest,
      release,
      target,
      allowSyntheticTestOnly,
      allowCalibrationCandidate,
    });
  }
  if (
    !allowCalibrationCandidate &&
    seenTargets.size !== requiredTargets.length
  ) {
    throw new Error("Runtime feed manifest is missing a required target.");
  }
}

async function validateReleaseArchiveAndProvenance({
  root,
  config,
  manifest,
  release,
  target,
  allowSyntheticTestOnly,
  allowCalibrationCandidate,
}) {
  const archiveUrl = new URL(release.archiveUrl);
  const expectedPath = `${FEED_ROOT}/archives/${release.version}/${target}/primary-runtime.zip`;
  if (
    archiveUrl.protocol !== "https:" ||
    archiveUrl.username ||
    archiveUrl.password ||
    archiveUrl.hash ||
    archiveUrl.pathname !== expectedPath
  ) {
    throw new Error(
      `Runtime feed release ${target} has an invalid immutable archive URL.`,
    );
  }
  const archivePath = resolve(
    root,
    "archives",
    release.version,
    target,
    "primary-runtime.zip",
  );
  if (!isInside(resolve(root), archivePath)) {
    throw new Error("Runtime feed archive escapes the staging tree.");
  }
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.size !== release.archiveSizeBytes) {
    throw new Error(
      `Runtime feed release ${target} archive size does not match the manifest.`,
    );
  }
  const archiveSha256 = await sha256File(archivePath);
  if (archiveSha256 !== release.archiveSha256) {
    throw new Error(
      `Runtime feed release ${target} archive SHA256 does not match the manifest.`,
    );
  }

  const provenancePath = resolve(
    root,
    "archives",
    release.version,
    target,
    "provenance.json",
  );
  if (!isInside(resolve(root), provenancePath)) {
    throw new Error("Runtime feed provenance escapes the staging tree.");
  }
  const provenance = JSON.parse(
    await readRegularFile(provenancePath, `Runtime feed ${target} provenance`),
  );
  if (
    allowCalibrationCandidate &&
    provenance?.releaseClass !== "engineering-candidate"
  ) {
    throw new Error(
      `Runtime feed release ${target} is not a P1a calibration candidate.`,
    );
  }
  if (provenance?.syntheticTestOnly === true) {
    if (!allowSyntheticTestOnly) {
      throw new Error(
        `Runtime feed release ${target} is synthetic and cannot enter engineering staging.`,
      );
    }
    if (
      provenance.schemaVersion !== provenanceSchema ||
      provenance.target !== target ||
      provenance.version !== release.version ||
      provenance.archiveSha256 !== archiveSha256 ||
      provenance.archiveSizeBytes !== archive.size ||
      !isSha256(provenance.sourceLockSha256) ||
      !isSha256(provenance.runtimeManifestSha256) ||
      !isSha256(provenance.canonicalFileManifestSha256)
    ) {
      throw new Error(
        `Runtime feed synthetic release ${target} has incomplete provenance.`,
      );
    }
    return;
  }
  if (provenance?.releaseClass === "engineering-candidate") {
    if (!allowCalibrationCandidate) {
      throw new Error(
        `Runtime feed release ${target} is a P1a calibration candidate and cannot enter engineering staging.`,
      );
    }
    if (
      provenance.schemaVersion !== provenanceSchema ||
      provenance.target !== target ||
      provenance.bundleVersion !== release.version ||
      provenance.archiveSha256 !== archiveSha256 ||
      provenance.archiveSizeBytes !== archive.size ||
      provenance.productionTrust !== false ||
      !isSha256(provenance.sourceLockSha256) ||
      !isSha256(provenance.toolchainsLockSha256) ||
      !isSha256(provenance.inputManifestSha256) ||
      !isSha256(provenance.hardLimitsSha256) ||
      !isSha256(provenance.runtimeManifestSha256) ||
      !isSha256(provenance.canonicalFileManifestSha256)
    ) {
      throw new Error(
        `Runtime feed P1a calibration candidate ${target} has incomplete provenance.`,
      );
    }
    return;
  }
  if (
    !provenance ||
    typeof provenance !== "object" ||
    provenance.schemaVersion !== provenanceSchema ||
    provenance.target !== target ||
    provenance.bundleVersion !== release.version ||
    provenance.archiveSha256 !== archiveSha256 ||
    provenance.releaseClass !== "engineering-final-candidate" ||
    provenance.productionTrust !== false ||
    !isSha256(provenance.sourceLockSha256) ||
    !isSha256(provenance.toolchainsLockSha256) ||
    !isSha256(provenance.inputManifestSha256) ||
    !isSha256(provenance.inputFileManifestSha256) ||
    !isSha256(provenance.hardLimitsSha256) ||
    !isSha256(provenance.runtimeManifestSha256) ||
    !isSha256(provenance.canonicalFileManifestSha256) ||
    !isSha256(provenance.sbomSha256) ||
    !isSha256(provenance.noticesSha256) ||
    !isSha256(provenance.componentSmokeSha256) ||
    !isSha256(provenance.patchSha256) ||
    !isSha256(provenance.reviewedBudgetSha256) ||
    !isSha256(provenance.performanceReportSha256) ||
    !provenance.builderIdentity ||
    typeof provenance.builderIdentity !== "object"
  ) {
    throw new Error(
      `Runtime feed release ${target} has incomplete provenance.`,
    );
  }
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function readRegularFile(path, label) {
  const details = await lstat(path);
  if (!details.isFile()) {
    throw new Error(`Runtime feed ${label} must be a regular file.`);
  }
  return readFile(path, "utf8");
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

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function hasExactlyKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isReleaseBudget(value) {
  if (!hasExactlyKeys(value, releaseBudgetKeys)) return false;
  if (releaseBudgetKeys.some((key) => !isPositiveInteger(value[key])))
    return false;
  if (value.maxArchiveBytes > 2 * 1024 * 1024 * 1024) return false;
  if (value.maxUnpackedBytes > 8 * 1024 * 1024 * 1024) return false;
  return (
    value.minimumFreeDiskBytes >=
    Math.ceil((value.maxArchiveBytes + 2 * value.maxUnpackedBytes) * 1.15)
  );
}

function isChannel(value) {
  return (
    typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)
  );
}

function isPollInterval(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 30_000 &&
    value <= 7 * 24 * 60 * 60 * 1000
  );
}

function isValidMetadataWindow(value) {
  if (
    typeof value.issuedAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return false;
  }
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  return (
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > issuedAt
  );
}

function isKeyId(value) {
  return typeof value === "string" && value.length > 0;
}

function isBase64(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value) &&
    Buffer.from(value, "base64").byteLength > 0
  );
}
