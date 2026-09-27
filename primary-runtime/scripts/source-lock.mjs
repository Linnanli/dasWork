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
const expectedCandidateName = "iOfficeAI/OfficeCLI";
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
  "license",
  "runtimeScope",
]);
const publisherKeys = new Set(["githubAccount", "releaseActor"]);
const licenseKeys = new Set(["spdx", "path"]);
const runtimeScopeKeys = new Set([
  "entryPoints",
  "capabilities",
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
  "capability",
  "version",
  "source",
  "sha256",
  "license",
  "platforms",
  "entryRequired",
]);
const componentGroups = Object.freeze(["node", "python", "native", "fonts"]);
const componentGroupKeys = new Set(componentGroups);
const unresolvedValue = /^(?:unresolved|pending|awaiting|unknown|tbd|latest|main|master|head)$/iu;
const floatingVersion = /(?:[~^*<>=|]|\bx\b|\bX\b|\s)/u;
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
    const mayBeEmpty = group === "node" || group === "python";
    if (
      !Array.isArray(entries) ||
      (!mayBeEmpty && entries.length === 0) ||
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
    const coverageByCapability = new Map();
    for (const component of validated.components[group]) {
      const capability = component.capability ?? component.name;
      const coveredTargets = coverageByCapability.get(capability) ?? new Set();
      for (const target of component.platforms) coveredTargets.add(target);
      coverageByCapability.set(capability, coveredTargets);
    }
    for (const [capability, coveredTargets] of coverageByCapability) {
      if (coveredTargets.size !== supportedRuntimeTargets.length) {
        throw new Error(
          `AT-RT-PROVENANCE-01 blocked: ${group} capability ${capability} does not cover every release target.`,
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
  if (!lock.candidate.patch) {
    return {
      candidate: lock.candidate.name,
      tag: lock.candidate.tag,
      patchPath: undefined,
      patchSha256: undefined,
    };
  }
  const patchPath = resolve(repositoryRoot, lock.candidate.patch.path);
  const patch = await readFile(patchPath, "utf8");
  const patchDigest = sha256(patch);
  if (patchDigest !== lock.candidate.patch.sha256) {
    throw new Error(
      `AT-RT-PROVENANCE-01 blocked: patch digest mismatch for ${lock.candidate.patch.path}.`,
    );
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
    isMeaningfulString(candidate.publisher.releaseActor) &&
    isExactTag(candidate.tag) &&
    isCommit(candidate.commit) &&
    isLicense(candidate.license) &&
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
    isNonEmptyStringArray(scope.capabilities) &&
    isNonEmptyStringArray(scope.excludedCapabilities)
  );
}

function isComponent(component) {
  return (
    isPlainObject(component) &&
    !hasUnexpectedKeys(component, componentKeys) &&
    isResolvedValue(component.name) &&
    (component.capability === undefined || isResolvedValue(component.capability)) &&
    isExactVersion(component.version) &&
    isHttpsUrl(component.source) &&
    isSha256(component.sha256) &&
    isResolvedValue(component.license) &&
    (component.entryRequired === undefined || typeof component.entryRequired === "boolean") &&
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
    isRelativePath(value.path)
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
  return typeof value === "string" && /^[a-f0-9]{7,40}$/u.test(value);
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
