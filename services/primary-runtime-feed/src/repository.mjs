import { createHash, createPublicKey, sign, verify } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const FEED_ROOT = "/v1/runtime";
export const CONFIG_PATH = `${FEED_ROOT}/config.json`;
export const ARCHIVE_INDEX_PATH = "archive-index.json";
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
const archiveIndexKeys = ["schemaVersion", "generatedAt", "archives"];
const archiveIndexEntryKeys = [
  "relativePath",
  "version",
  "target",
  "sizeBytes",
  "sha256",
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
  const publishedRoot = await resolvePublishedRoot(repositoryRoot);
  const repository = await resolveRepositoryRoot(repositoryRoot);
  const indexedArchive = await resolveIndexedArchiveAsset({
    repositoryRoot: repository,
    snapshotRoot: publishedRoot,
    relativePath,
  });
  if (indexedArchive) return indexedArchive;
  if (indexedArchive === null && isArchivePath(relativePath)) return null;

  const path = resolve(publishedRoot, relativePath);
  if (!isInside(publishedRoot, path))
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

/**
 * Publishes a development feed snapshot whose metadata is switchable while
 * archives live in a repository-wide immutable store.
 */
export async function publishDevelopmentRepositorySnapshot({
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
  const currentIndex = await readCurrentDevelopmentArchiveIndex(root);
  const stagedArchives = await releaseArchiveAssetRecords(staging);
  const nextIndex = mergeArchiveIndex(currentIndex, stagedArchives);

  await mkdir(root, { recursive: true });
  await copyMissingDevelopmentArchives(root, staging, stagedArchives);

  const snapshots = resolve(root, "metadata-snapshots");
  const next = resolve(
    snapshots,
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const current = resolve(root, "current");
  const nextLink = resolve(
    root,
    `.current-next-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(resolve(next, "channels"), { recursive: true });
  await cp(resolve(staging, "config.json"), resolve(next, "config.json"), {
    errorOnExist: true,
    force: false,
  });
  const config = JSON.parse(
    await readRegularFile(resolve(staging, "config.json"), "config"),
  );
  await mkdir(resolve(next, "channels", config.channel), { recursive: true });
  await cp(
    resolve(staging, "channels", config.channel, "manifest.json"),
    resolve(next, "channels", config.channel, "manifest.json"),
    { errorOnExist: true, force: false },
  );
  await writeJsonFile(resolve(next, ARCHIVE_INDEX_PATH), nextIndex);
  await validateDevelopmentSnapshot(root, next);
  await symlink(relative(root, next), nextLink);
  await rename(nextLink, current);
}

export async function publishDevelopmentMetadataSnapshot({
  repositoryRoot,
  config,
  manifest,
  archiveIndex,
  configPublicKeys,
  manifestPublicKeys,
}) {
  const root = resolve(repositoryRoot);
  await mkdir(root, { recursive: true });
  const snapshotRoot = await writeDevelopmentMetadataSnapshot({
    repositoryRoot: root,
    config,
    manifest,
    archiveIndex,
    configPublicKeys,
    manifestPublicKeys,
  });
  const current = resolve(root, "current");
  const nextLink = resolve(
    root,
    `.current-next-${Math.random().toString(16).slice(2)}`,
  );
  await symlink(relative(root, snapshotRoot), nextLink);
  await rename(nextLink, current);
  return snapshotRoot;
}

export async function loadPublishedRuntimeFeedSnapshot({
  repositoryRoot,
  configPublicKeys,
  manifestPublicKeys,
  previousSnapshot,
}) {
  const root = await resolveRepositoryRoot(repositoryRoot);
  const snapshotRoot = await resolvePublishedRoot(root);
  const { config, manifest } = await validateReleaseMetadataPair(snapshotRoot, {
    configPublicKeys,
    manifestPublicKeys,
  });
  const archiveIndex = await readDevelopmentArchiveIndex(snapshotRoot);
  if (!archiveIndex) {
    throw new Error("Runtime feed development snapshot misses index.");
  }
  const archiveRecords = await validateDevelopmentArchiveIndex(root, {
    archives: archiveIndex.archives,
    manifest,
    previousSnapshot,
  });
  return Object.freeze({
    id: snapshotRoot,
    repositoryRoot: root,
    snapshotRoot,
    config,
    manifest,
    archiveIndex: Object.freeze({
      schemaVersion: archiveIndex.schemaVersion,
      generatedAt: archiveIndex.generatedAt,
      archives: Object.freeze(archiveIndex.archives.map(Object.freeze)),
    }),
    archiveRecords,
  });
}

export async function readPublishedRuntimeFeedSnapshotAsset(snapshot, pathname) {
  const relativePath = runtimeFeedPathForRequest(pathname);
  if (!relativePath) return null;
  const archive = snapshot.archiveRecords?.get(relativePath);
  const isArchive = isArchivePath(relativePath);
  if (isArchive && !archive) return null;
  const path = archive
    ? archive.path
    : resolve(snapshot.snapshotRoot, relativePath);
  const root = archive ? snapshot.repositoryRoot : snapshot.snapshotRoot;
  if (!isInside(root, path)) {
    throw new Error("Runtime feed path escapes the adopted snapshot.");
  }
  const details = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!details) return null;
  if (!details.isFile() || details.size <= 0) {
    throw new Error("Runtime feed refuses a non-regular published asset.");
  }
  if (archive && details.size !== archive.sizeBytes) {
    throw new Error("Runtime feed adopted archive size no longer matches.");
  }
  if (!archive && details.size > maxMetadataBytes) {
    throw new Error("Runtime feed metadata exceeds the permitted size.");
  }
  return {
    path,
    size: details.size,
    etag: archive ? `"${archive.sha256}"` : `"${await sha256File(path)}"`,
    cacheControl: archive
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    contentType: archive ? "application/zip" : "application/json; charset=utf-8",
  };
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

async function resolveIndexedArchiveAsset({
  repositoryRoot,
  snapshotRoot,
  relativePath,
}) {
  if (!isArchivePath(relativePath)) return undefined;
  const index = await readDevelopmentArchiveIndex(snapshotRoot);
  if (!index) return undefined;
  const archive = index.records.get(relativePath);
  if (!archive) return null;
  const path = resolve(repositoryRoot, archive.relativePath);
  if (!isInside(repositoryRoot, path)) {
    throw new Error("Runtime feed indexed archive escapes repository.");
  }
  const details = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!details) return null;
  if (!details.isFile()) {
    throw new Error("Runtime feed refuses a non-regular published asset.");
  }
  if (details.size !== archive.sizeBytes) {
    throw new Error("Runtime feed indexed archive size does not match.");
  }
  const sha256 = await sha256File(path);
  if (sha256 !== archive.sha256) {
    throw new Error("Runtime feed indexed archive SHA256 does not match.");
  }
  return {
    path,
    size: details.size,
    etag: `"${sha256}"`,
    cacheControl: "public, max-age=31536000, immutable",
    contentType: "application/zip",
  };
}

async function readCurrentDevelopmentArchiveIndex(repositoryRoot) {
  const current = await resolvePublishedRoot(repositoryRoot);
  const index = await readDevelopmentArchiveIndex(current);
  if (!index) {
    return {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      archives: [],
      records: new Map(),
    };
  }
  await validateDevelopmentArchiveIndex(repositoryRoot, {
    archives: index.archives,
  });
  return index;
}

async function readDevelopmentArchiveIndex(snapshotRoot) {
  const path = resolve(snapshotRoot, ARCHIVE_INDEX_PATH);
  const details = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!details) return null;
  if (!details.isFile()) {
    throw new Error("Runtime feed archive index must be a regular file.");
  }
  if (details.size <= 0 || details.size > maxMetadataBytes) {
    throw new Error("Runtime feed archive index is empty or oversized.");
  }
  const index = JSON.parse(await readFile(path, "utf8"));
  if (
    !hasExactlyKeys(index, archiveIndexKeys) ||
    index.schemaVersion !== 1 ||
    typeof index.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(index.generatedAt)) ||
    !Array.isArray(index.archives)
  ) {
    throw new Error("Runtime feed archive index is invalid.");
  }
  const records = new Map();
  for (const archive of index.archives) {
    if (
      !hasExactlyKeys(archive, archiveIndexEntryKeys) ||
      !isArchivePath(archive.relativePath) ||
      typeof archive.version !== "string" ||
      archive.version.length === 0 ||
      typeof archive.target !== "string" ||
      !requiredTargets.includes(archive.target) ||
      archive.relativePath !==
        `archives/${archive.version}/${archive.target}/primary-runtime.zip` ||
      !Number.isSafeInteger(archive.sizeBytes) ||
      archive.sizeBytes <= 0 ||
      !isSha256(archive.sha256)
    ) {
      throw new Error("Runtime feed archive index has an invalid entry.");
    }
    if (records.has(archive.relativePath)) {
      throw new Error("Runtime feed archive index has a duplicate entry.");
    }
    records.set(archive.relativePath, archive);
  }
  return { ...index, records };
}

async function validateDevelopmentArchiveIndex(
  repositoryRoot,
  { archives, manifest, previousSnapshot } = {},
) {
  const root = resolve(repositoryRoot);
  const releases = manifest
    ? new Map(
        manifest.releases.map((release) => [
          `${release.version}/${release.platform}-${release.arch}`,
          release,
        ]),
      )
    : null;
  const manifestArchivePaths = manifest
    ? new Set(
        manifest.releases.map((release) => {
          const target = `${release.platform}-${release.arch}`;
          return `archives/${release.version}/${target}/primary-runtime.zip`;
        }),
      )
    : null;
  const archiveRecords = new Map();
  for (const archive of archives) {
    const path = resolve(root, archive.relativePath);
    if (!isInside(root, path)) {
      throw new Error("Runtime feed indexed archive escapes repository.");
    }
    if (releases) {
      const release = releases.get(`${archive.version}/${archive.target}`);
      if (
        release &&
        (release.archiveSizeBytes !== archive.sizeBytes ||
          release.archiveSha256 !== archive.sha256)
      ) {
        throw new Error(
          "Runtime feed archive index does not match the manifest.",
        );
      }
    }
    const details = await lstat(path);
    if (!details.isFile() || details.size !== archive.sizeBytes) {
      throw new Error("Runtime feed indexed archive size does not match.");
    }
    const previous = previousSnapshot?.archiveRecords?.get(
      archive.relativePath,
    );
    if (
      previous &&
      (previous.sha256 !== archive.sha256 ||
        previous.sizeBytes !== archive.sizeBytes)
    ) {
      throw new Error(
        `Runtime feed immutable archive ${archive.version}/${archive.target} changed in the archive index.`,
      );
    }
    const needsSha256 = previousSnapshot
      ? !previous
      : manifestArchivePaths?.has(archive.relativePath) === true;
    if (needsSha256 && (await sha256File(path)) !== archive.sha256) {
      throw new Error("Runtime feed indexed archive SHA256 does not match.");
    }
    archiveRecords.set(archive.relativePath, {
      relativePath: archive.relativePath,
      version: archive.version,
      target: archive.target,
      sizeBytes: archive.sizeBytes,
      sha256: archive.sha256,
      path,
    });
  }
  if (releases) {
    for (const release of manifest.releases) {
      const target = `${release.platform}-${release.arch}`;
      const relativePath = `archives/${release.version}/${target}/primary-runtime.zip`;
      if (!archiveRecords.has(relativePath)) {
        throw new Error("Runtime feed archive index is missing a manifest release.");
      }
    }
  }
  return archiveRecords;
}

async function validateDevelopmentSnapshot(repositoryRoot, snapshotRoot) {
  const { manifest } = await validateReleaseMetadataPair(snapshotRoot);
  const index = await readDevelopmentArchiveIndex(snapshotRoot);
  if (!index) throw new Error("Runtime feed development snapshot misses index.");
  await validateDevelopmentArchiveIndex(repositoryRoot, {
    archives: index.archives,
    manifest,
  });
}

async function writeDevelopmentMetadataSnapshot({
  repositoryRoot,
  config,
  manifest,
  archiveIndex,
  configPublicKeys,
  manifestPublicKeys,
}) {
  const root = resolve(repositoryRoot);
  const snapshots = resolve(root, "metadata-snapshots");
  const temporary = resolve(
    snapshots,
    `.snapshot-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  const final = resolve(
    snapshots,
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(resolve(temporary, "channels", manifest.channel), {
    recursive: true,
  });
  try {
    await writeJsonFile(resolve(temporary, "config.json"), config);
    await writeJsonFile(
      resolve(temporary, "channels", manifest.channel, "manifest.json"),
      manifest,
    );
    await writeJsonFile(resolve(temporary, ARCHIVE_INDEX_PATH), archiveIndex);
    await validateReleaseMetadataPair(temporary, {
      configPublicKeys,
      manifestPublicKeys,
    });
    const index = await readDevelopmentArchiveIndex(temporary);
    await validateDevelopmentArchiveIndex(root, {
      archives: index.archives,
      manifest,
    });
    await rename(temporary, final);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return final;
}

function mergeArchiveIndex(currentIndex, stagedArchives) {
  const records = new Map();
  for (const archive of currentIndex.archives) {
    records.set(archive.relativePath, archive);
  }
  for (const archive of stagedArchives.values()) {
    const existing = records.get(archive.relativePath);
    if (existing && existing.sha256 !== archive.sha256) {
      throw new Error(
        `Runtime feed immutable archive ${archive.version}/${archive.target} is already published with a different SHA256.`,
      );
    }
    records.set(archive.relativePath, archiveIndexEntry(archive));
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    archives: [...records.values()].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    ),
  };
}

async function copyMissingDevelopmentArchives(
  repositoryRoot,
  stagedRoot,
  archives,
) {
  for (const archive of archives.values()) {
    const destination = resolve(repositoryRoot, archive.relativePath);
    if (!isInside(resolve(repositoryRoot), destination)) {
      throw new Error("Runtime feed archive escapes the repository.");
    }
    const existing = await lstat(destination).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (!existing.isFile() || existing.size !== archive.sizeBytes) {
        throw new Error(
          `Runtime feed immutable archive ${archive.version}/${archive.target} is already published with a different size.`,
        );
      }
      const existingSha256 = await sha256File(destination);
      if (existingSha256 !== archive.sha256) {
        throw new Error(
          `Runtime feed immutable archive ${archive.version}/${archive.target} is already published with a different SHA256.`,
        );
      }
      await copyMissingDevelopmentEvidence({
        sourceRoot: dirname(archive.sourcePath),
        destinationRoot: dirname(destination),
      });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = resolve(
      dirname(destination),
      `.primary-runtime.${process.pid}.${Date.now()}.${Math.random()
        .toString(16)
        .slice(2)}.tmp`,
    );
    try {
      await copyFile(archive.sourcePath, temporary);
      if ((await sha256File(temporary)) !== archive.sha256) {
        throw new Error(
          `Runtime feed archive ${archive.version}/${archive.target} changed while copying.`,
        );
      }
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await copyMissingDevelopmentEvidence({
      sourceRoot: dirname(archive.sourcePath),
      destinationRoot: dirname(destination),
    });
  }
}

async function copyMissingDevelopmentEvidence({ sourceRoot, destinationRoot }) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "primary-runtime.zip") continue;
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    if (!isInside(sourceRoot, source) || !isInside(destinationRoot, destination)) {
      throw new Error("Runtime feed evidence path escapes the archive directory.");
    }
    const sourceDetails = await lstat(source);
    if (entry.name === "evidence" && sourceDetails.isDirectory()) {
      const existingDirectory = await lstat(destination).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (existingDirectory && !existingDirectory.isDirectory()) {
        throw new Error("Runtime feed refuses non-directory published evidence.");
      }
      await mkdir(destination, { recursive: true });
      for (const evidenceEntry of await readdir(source, { withFileTypes: true })) {
        const evidenceSource = resolve(source, evidenceEntry.name);
        const evidenceDestination = resolve(destination, evidenceEntry.name);
        if (
          !isInside(source, evidenceSource) ||
          !isInside(destination, evidenceDestination) ||
          !(await lstat(evidenceSource)).isFile()
        ) {
          throw new Error("Runtime feed refuses non-regular archive evidence.");
        }
        await copyMissingDevelopmentEvidenceFile(evidenceSource, evidenceDestination);
      }
      continue;
    }
    if (!sourceDetails.isFile()) {
      throw new Error("Runtime feed refuses non-regular archive evidence.");
    }
    await copyMissingDevelopmentEvidenceFile(source, destination);
  }
}

async function copyMissingDevelopmentEvidenceFile(source, destination) {
  const existing = await lstat(destination).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile()) {
      throw new Error("Runtime feed refuses non-regular published evidence.");
    }
    return;
  }
  await copyFile(source, destination);
}

async function releaseArchiveAssetRecords(root) {
  const records = new Map();
  const releaseRecords = await releaseArchiveRecords(root);
  for (const [key, record] of releaseRecords) {
    const [version, target] = key.split("/");
    const relativePath = `archives/${version}/${target}/primary-runtime.zip`;
    const sourcePath = resolve(root, relativePath);
    const details = await lstat(sourcePath);
    records.set(relativePath, {
      ...record,
      relativePath,
      version,
      target,
      sourcePath,
      sizeBytes: details.size,
      sha256: record.archiveSha256,
    });
  }
  return records;
}

function archiveIndexEntry(archive) {
  return {
    relativePath: archive.relativePath,
    version: archive.version,
    target: archive.target,
    sizeBytes: archive.sizeBytes,
    sha256: archive.sha256,
  };
}

async function writeJsonFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
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
  const root = await resolveRepositoryRoot(repositoryRoot);
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

async function resolveRepositoryRoot(repositoryRoot) {
  const configuredRoot = resolve(repositoryRoot);
  // macOS commonly presents /var as a symlink to /private/var. Resolve the
  // repository root before comparing it to the realpath of the `current`
  // release pointer; otherwise a valid pointer is incorrectly treated as
  // outside the repository and the server falls back to an empty root.
  return realpath(configuredRoot).catch((error) => {
    if (error?.code === "ENOENT") return configuredRoot;
    throw error;
  });
}

async function validateReleaseMetadataPair(
  root,
  { configPublicKeys, manifestPublicKeys } = {},
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
    manifest.sequence !== config.sequence ||
    manifest.channel !== config.channel ||
    !isValidMetadataWindow(manifest) ||
    !isKeyId(manifest.keyId) ||
    !isBase64(manifest.signature) ||
    !Array.isArray(manifest.releases) ||
    manifest.releases.length !== requiredTargets.length
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
  }
  return { config, manifest };
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
    manifest.sequence !== config.sequence ||
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

function isArchivePath(value) {
  return (
    typeof value === "string" &&
    /^archives\/[^/]+\/(?:darwin|win32|linux)-(?:x64|arm64)\/primary-runtime\.zip$/u.test(
      value,
    )
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
