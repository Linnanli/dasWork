import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const sourceLockSchema = "dascowork-primary-runtime-sources.v2";
export const supportedRuntimeTargets = Object.freeze([
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
]);

const supportedTargets = new Set(supportedRuntimeTargets);
const expectedCandidateName = "siril9/presentation-skill";
const sourceLockKeys = new Set([
  "schemaVersion",
  "builderVersion",
  "candidate",
  "rejectedCandidates",
  "components",
]);
const candidateKeys = new Set([
  "name",
  "repository",
  "publisher",
  "tag",
  "commit",
  "sourceArchive",
  "pluginDirectory",
  "license",
  "patch",
  "runtimeScope",
]);
const publisherKeys = new Set(["githubAccount", "commitAuthor"]);
const sourceArchiveKeys = new Set(["url", "sha256"]);
const pluginDirectoryKeys = new Set(["path", "fileCount", "treeSha256"]);
const licenseKeys = new Set(["spdx", "path", "sha256"]);
const patchKeys = new Set(["path", "sha256"]);
const runtimeScopeKeys = new Set([
  "entryPoints",
  "nodeDependencyClosure",
  "excludedCapabilities",
]);
const rejectedCandidateKeys = new Set([
  "tag",
  "commit",
  "sourceArchiveSha256",
  "status",
  "reason",
]);
const componentKeys = new Set([
  "name",
  "version",
  "source",
  "sha256",
  "license",
  "platforms",
]);
const componentGroups = Object.freeze(["node", "python", "native", "fonts"]);
const componentGroupKeys = new Set(componentGroups);
const unresolvedValue = /^(?:unresolved|pending|awaiting|unknown|tbd|latest|main|master|head)$/iu;
const floatingVersion = /(?:[~^*<>=|]|\bx\b|\bX\b|\s)/u;
const requiredPatchTerms = Object.freeze([
  /new\W+PPTX/iu,
  /load_workspace_dependencies/u,
  /Do[\s+]+not run `npm`, `npx`, `pip`, `uv`, `conda`/u,
  /Never call a model HTTP endpoint/u,
  /no host fallback or[\s+]+online install is permitted/u,
  /Existing PPTX inspection, editing, redesign, or round-trip workflows/u,
]);
const forbiddenRuntimePatchAdditions = Object.freeze([
  /require\(['"]react['"]\)/u,
  /require\(['"]react-dom\/server['"]\)/u,
  /require\(['"]sharp['"]\)/u,
  /\bos\.homedir\(/u,
  /\bshutil\.which\(/u,
]);

export async function readRuntimeSourcesLock(path) {
  return validateRuntimeSourcesLock(JSON.parse(await readFile(path, "utf8")));
}

export function validateRuntimeSourcesLock(value) {
  if (
    !isPlainObject(value) ||
    hasUnexpectedKeys(value, sourceLockKeys) ||
    value.schemaVersion !== sourceLockSchema ||
    !isResolvedValue(value.builderVersion) ||
    !isValidCandidate(value.candidate) ||
    !Array.isArray(value.rejectedCandidates) ||
    value.rejectedCandidates.some((entry) => !isRejectedCandidate(entry)) ||
    !isPlainObject(value.components) ||
    hasUnexpectedKeys(value.components, componentGroupKeys)
  ) {
    throw new Error("Primary Runtime source lock has an invalid schema.");
  }

  for (const group of componentGroups) {
    const entries = value.components[group];
    const groupNames = new Set();
    let hasInvalidEntry = false;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!isComponent(entry) || groupNames.has(entry.name)) {
          hasInvalidEntry = true;
          break;
        }
        groupNames.add(entry.name);
      }
    }
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      hasInvalidEntry
    ) {
      throw new Error(`Primary Runtime source lock has invalid ${group} components.`);
    }
  }
  return value;
}

export function assertApprovedSources(lock) {
  const validated = validateRuntimeSourcesLock(lock);
  for (const group of componentGroups) {
    for (const component of validated.components[group]) {
      if (component.platforms.length !== supportedRuntimeTargets.length) {
        throw new Error(
          `AT-RT-PROVENANCE-01 blocked: ${group} component ${component.name} does not cover every release target.`,
        );
      }
    }
  }
  return validated;
}

export async function assertRepositoryPatchMatchesLock({
  lockPath = fileURLToPath(
    new URL("../runtime-sources.lock.json", import.meta.url),
  ),
  repositoryRoot = fileURLToPath(new URL("..", import.meta.url)),
} = {}) {
  const lock = await readRuntimeSourcesLock(lockPath);
  const patchPath = resolve(repositoryRoot, lock.candidate.patch.path);
  const patch = await readFile(patchPath, "utf8");
  const patchDigest = sha256(patch);
  if (patchDigest !== lock.candidate.patch.sha256) {
    throw new Error(
      `AT-RT-PROVENANCE-01 blocked: patch digest mismatch for ${lock.candidate.patch.path}.`,
    );
  }
  for (const term of requiredPatchTerms) {
    if (!term.test(patch)) {
      throw new Error(
        `AT-RT-PROVENANCE-01 blocked: patch ${lock.candidate.patch.path} is missing required Runtime boundary text.`,
      );
    }
  }
  const addedLines = patch
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  for (const forbidden of forbiddenRuntimePatchAdditions) {
    if (forbidden.test(addedLines)) {
      throw new Error(
        `AT-RT-PROVENANCE-01 blocked: patch ${lock.candidate.patch.path} restores a forbidden Runtime fallback.`,
      );
    }
  }
  return { patchPath, patchSha256: patchDigest };
}

export function canonicalFileManifest(files) {
  return `${[...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.mode}\t${entry.sha256}\t${entry.path}`)
    .join("\n")}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isValidCandidate(candidate) {
  return (
    isPlainObject(candidate) &&
    !hasUnexpectedKeys(candidate, candidateKeys) &&
    candidate.name === expectedCandidateName &&
    isHttpsUrl(candidate.repository) &&
    isPlainObject(candidate.publisher) &&
    !hasUnexpectedKeys(candidate.publisher, publisherKeys) &&
    isMeaningfulString(candidate.publisher.githubAccount) &&
    isMeaningfulString(candidate.publisher.commitAuthor) &&
    isExactTag(candidate.tag) &&
    isCommit(candidate.commit) &&
    isPlainObject(candidate.sourceArchive) &&
    !hasUnexpectedKeys(candidate.sourceArchive, sourceArchiveKeys) &&
    isHttpsUrl(candidate.sourceArchive.url) &&
    isSha256(candidate.sourceArchive.sha256) &&
    isPlainObject(candidate.pluginDirectory) &&
    !hasUnexpectedKeys(candidate.pluginDirectory, pluginDirectoryKeys) &&
    isRelativePath(candidate.pluginDirectory.path) &&
    Number.isSafeInteger(candidate.pluginDirectory.fileCount) &&
    candidate.pluginDirectory.fileCount > 0 &&
    isSha256(candidate.pluginDirectory.treeSha256) &&
    isLicense(candidate.license) &&
    isPlainObject(candidate.patch) &&
    !hasUnexpectedKeys(candidate.patch, patchKeys) &&
    isRelativePath(candidate.patch.path) &&
    isSha256(candidate.patch.sha256) &&
    isRuntimeScope(candidate.runtimeScope)
  );
}

function isRejectedCandidate(candidate) {
  return (
    isPlainObject(candidate) &&
    !hasUnexpectedKeys(candidate, rejectedCandidateKeys) &&
    isExactTag(candidate.tag) &&
    isCommit(candidate.commit) &&
    isSha256(candidate.sourceArchiveSha256) &&
    candidate.status === "candidate_rejected" &&
    isResolvedValue(candidate.reason)
  );
}

function isRuntimeScope(scope) {
  return (
    isPlainObject(scope) &&
    !hasUnexpectedKeys(scope, runtimeScopeKeys) &&
    isNonEmptyStringArray(scope.entryPoints) &&
    isNonEmptyStringArray(scope.nodeDependencyClosure) &&
    isNonEmptyStringArray(scope.excludedCapabilities)
  );
}

function isComponent(component) {
  return (
    isPlainObject(component) &&
    !hasUnexpectedKeys(component, componentKeys) &&
    isResolvedValue(component.name) &&
    isExactVersion(component.version) &&
    isHttpsUrl(component.source) &&
    isSha256(component.sha256) &&
    isResolvedValue(component.license) &&
    Array.isArray(component.platforms) &&
    component.platforms.length > 0 &&
    component.platforms.every((target) => supportedTargets.has(target)) &&
    new Set(component.platforms).size === component.platforms.length
  );
}

function isLicense(value) {
  return (
    isPlainObject(value) &&
    !hasUnexpectedKeys(value, licenseKeys) &&
    isResolvedValue(value.spdx) &&
    isRelativePath(value.path) &&
    isSha256(value.sha256)
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnexpectedKeys(value, allowed) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isMeaningfulString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isResolvedValue(value) {
  return isMeaningfulString(value) && !unresolvedValue.test(value.trim());
}

function isExactTag(value) {
  return typeof value === "string" && /^v\d+\.\d+\.\d+$/u.test(value);
}

function isExactVersion(value) {
  return isResolvedValue(value) && !floatingVersion.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCommit(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

function isHttpsUrl(value) {
  if (typeof value !== "string" || unresolvedValue.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isResolvedValue);
}
