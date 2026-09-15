import { createHash } from "node:crypto";

export const runtimeBudgetTargets = Object.freeze([
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
]);

export const runtimeBudgetFields = Object.freeze([
  "maxArchiveBytes",
  "maxUnpackedBytes",
  "minimumFreeDiskBytes",
  "maxColdInstallMs",
  "maxMainEventLoopDelayP99Ms",
  "maxMainEventLoopDelayMaxMs",
]);

export const installerAbuseLimits = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxUnpackedBytes: 8 * 1024 * 1024 * 1024,
});

const archiveMultiplier = 1.15;
const timingMultiplier = 1.25;

export function calibrateRuntimeBudgets(measurements) {
  const normalized = normalizeMeasurements(measurements);
  for (const target of runtimeBudgetTargets) {
    if (!normalized.targets[target].normalChatPassed) {
      throw new Error(
        `Primary Runtime ${target} calibration cannot proceed without a real normal chat smoke receipt.`,
      );
    }
  }
  return {
    schemaVersion: "dascowork-primary-runtime-budget-candidate.v1",
    generatedFrom: normalized.schemaVersion,
    evidence: {
      ...normalized.evidence,
      measurementsFingerprint: measurementFingerprint(normalized),
    },
    targets: Object.fromEntries(
      runtimeBudgetTargets.map((target) => [
        target,
        candidateBudgetForTarget(normalized.targets[target]),
      ]),
    ),
  };
}

export function verifyRuntimeBudgets({
  budgets,
  measurements,
  installerLimits = installerAbuseLimits,
} = {}) {
  if (!isPlainObject(budgets)) {
    throw new Error("Primary Runtime budgets file must be a JSON object.");
  }
  if (
    budgets.schemaVersion !== "dascowork-primary-runtime-budgets.v1" ||
    !isPlainObject(budgets.targets) ||
    hasUnexpectedTarget(budgets.targets) ||
    !isReviewedBudgetEvidence(budgets.evidence)
  ) {
    throw new Error("Primary Runtime budgets file has an invalid schema.");
  }

  const normalizedMeasurements = measurements
    ? normalizeMeasurements(measurements)
    : undefined;
  if (normalizedMeasurements) {
    assertBudgetEvidenceMatchesMeasurements(
      budgets.evidence,
      normalizedMeasurements,
    );
  }
  for (const target of runtimeBudgetTargets) {
    const budget = budgets.targets[target];
    if (!isBudget(budget)) {
      throw new Error(`Primary Runtime budget for ${target} is incomplete.`);
    }
    if (budget.maxArchiveBytes > installerLimits.maxArchiveBytes) {
      throw new Error(
        `Primary Runtime ${target} archive budget exceeds installer hard limit.`,
      );
    }
    if (budget.maxUnpackedBytes > installerLimits.maxUnpackedBytes) {
      throw new Error(
        `Primary Runtime ${target} unpacked budget exceeds installer hard limit.`,
      );
    }
    const minimumFreeDiskBytes = Math.ceil(
      (budget.maxArchiveBytes + 2 * budget.maxUnpackedBytes) *
        archiveMultiplier,
    );
    if (budget.minimumFreeDiskBytes < minimumFreeDiskBytes) {
      throw new Error(
        `Primary Runtime ${target} minimumFreeDiskBytes is below the required formula.`,
      );
    }
    if (normalizedMeasurements) {
      assertMeasurementsWithinBudget({
        target,
        budget,
        measurements: normalizedMeasurements.targets[target],
      });
    }
  }
  return budgets;
}

export function measurementFingerprint(measurements) {
  return createSha256(stableJson(measurements));
}

export function normalizeMeasurements(measurements) {
  if (
    !isPlainObject(measurements) ||
    measurements.schemaVersion !==
      "dascowork-primary-runtime-budget-measurements.v1" ||
    !isPlainObject(measurements.targets) ||
    hasUnexpectedTarget(measurements.targets)
  ) {
    throw new Error(
      "Primary Runtime budget measurements have an invalid schema.",
    );
  }
  return {
    schemaVersion: measurements.schemaVersion,
    evidence: normalizeMeasurementEvidence(measurements.evidence),
    targets: Object.fromEntries(
      runtimeBudgetTargets.map((target) => [
        target,
        normalizeTargetMeasurements(target, measurements.targets[target]),
      ]),
    ),
  };
}

function candidateBudgetForTarget(measurement) {
  return {
    maxArchiveBytes: ceilScaled(
      max(measurement.archiveBytes),
      archiveMultiplier,
    ),
    maxUnpackedBytes: ceilScaled(
      max(measurement.unpackedBytes),
      archiveMultiplier,
    ),
    minimumFreeDiskBytes: Math.ceil(
      (ceilScaled(max(measurement.archiveBytes), archiveMultiplier) +
        2 * ceilScaled(max(measurement.unpackedBytes), archiveMultiplier)) *
        archiveMultiplier,
    ),
    maxColdInstallMs: ceilScaled(
      percentile95(measurement.coldInstallMs),
      timingMultiplier,
    ),
    maxMainEventLoopDelayP99Ms: ceilScaled(
      percentile95(measurement.mainEventLoopDelayP99Ms),
      timingMultiplier,
    ),
    maxMainEventLoopDelayMaxMs: ceilScaled(
      percentile95(measurement.mainEventLoopDelayMaxMs),
      timingMultiplier,
    ),
  };
}

function normalizeTargetMeasurements(target, value) {
  if (!isPlainObject(value)) {
    throw new Error(`Primary Runtime measurements for ${target} are missing.`);
  }
  const archiveBytes = readPositiveIntegerArray(
    target,
    value,
    "archiveBytes",
    5,
  );
  const unpackedBytes = readPositiveIntegerArray(
    target,
    value,
    "unpackedBytes",
    5,
  );
  return {
    runner: readRunner(target, value.runner),
    candidateArchiveSha256: readSha256(target, value.candidateArchiveSha256),
    p1aBuildUnpackReceiptSha256: readSha256(
      target,
      value.p1aBuildUnpackReceiptSha256,
    ),
    normalChatPassed: value.normalChatPassed === true,
    archiveBytes,
    unpackedBytes,
    coldInstallMs: readPositiveIntegerArray(target, value, "coldInstallMs", 10),
    mainEventLoopDelayP99Ms: readPositiveIntegerArray(
      target,
      value,
      "mainEventLoopDelayP99Ms",
      10,
    ),
    mainEventLoopDelayMaxMs: readPositiveIntegerArray(
      target,
      value,
      "mainEventLoopDelayMaxMs",
      10,
    ),
  };
}

function normalizeMeasurementEvidence(value) {
  if (
    !isPlainObject(value) ||
    !isPositiveRunId(value.sourceRunId) ||
    !isCommit(value.sourceCommit) ||
    !isCommit(value.installerCommit) ||
    !isSha256(value.hardLimitsSha256) ||
    !isSha256(value.sourceLockSha256) ||
    !isSha256(value.toolchainsLockSha256)
  ) {
    throw new Error(
      "Primary Runtime measurements lack clean-runner lineage evidence.",
    );
  }
  return {
    sourceRunId: String(value.sourceRunId),
    sourceCommit: value.sourceCommit,
    installerCommit: value.installerCommit,
    hardLimitsSha256: value.hardLimitsSha256,
    sourceLockSha256: value.sourceLockSha256,
    toolchainsLockSha256: value.toolchainsLockSha256,
  };
}

function isReviewedBudgetEvidence(value) {
  return (
    isPlainObject(value) &&
    value.reviewed === true &&
    isPositiveRunId(value.sourceRunId) &&
    isCommit(value.sourceCommit) &&
    isCommit(value.installerCommit) &&
    isSha256(value.hardLimitsSha256) &&
    isSha256(value.sourceLockSha256) &&
    isSha256(value.toolchainsLockSha256) &&
    isSha256(value.measurementsFingerprint) &&
    isPlainObject(value.candidateArchiveSha256) &&
    !hasUnexpectedTarget(value.candidateArchiveSha256) &&
    Object.values(value.candidateArchiveSha256).every(isSha256)
  );
}

function assertBudgetEvidenceMatchesMeasurements(evidence, measurements) {
  const expected = measurements.evidence;
  for (const field of [
    "sourceRunId",
    "sourceCommit",
    "installerCommit",
    "hardLimitsSha256",
    "sourceLockSha256",
    "toolchainsLockSha256",
  ]) {
    if (evidence[field] !== expected[field]) {
      throw new Error(
        `Primary Runtime budget evidence does not match ${field}.`,
      );
    }
  }
  if (
    evidence.measurementsFingerprint !== measurementFingerprint(measurements)
  ) {
    throw new Error(
      "Primary Runtime budget evidence does not match the calibration report.",
    );
  }
  for (const target of runtimeBudgetTargets) {
    const targetMeasurement = measurements.targets[target];
    if (
      evidence.candidateArchiveSha256[target] !==
        targetMeasurement.candidateArchiveSha256 ||
      !targetMeasurement.normalChatPassed
    ) {
      throw new Error(
        `Primary Runtime budget evidence does not bind ${target} candidate or normal chat smoke.`,
      );
    }
  }
}

function assertMeasurementsWithinBudget({ target, budget, measurements }) {
  const observed = {
    maxArchiveBytes: max(measurements.archiveBytes),
    maxUnpackedBytes: max(measurements.unpackedBytes),
    maxColdInstallMs: max(measurements.coldInstallMs),
    maxMainEventLoopDelayP99Ms: max(measurements.mainEventLoopDelayP99Ms),
    maxMainEventLoopDelayMaxMs: max(measurements.mainEventLoopDelayMaxMs),
  };
  for (const field of runtimeBudgetFields) {
    if (field === "minimumFreeDiskBytes") continue;
    if (observed[field] > budget[field]) {
      throw new Error(`Primary Runtime ${target} exceeds ${field}.`);
    }
  }
}

function readPositiveIntegerArray(target, value, field, minimumLength) {
  const entries = value[field];
  if (
    !Array.isArray(entries) ||
    entries.length < minimumLength ||
    entries.some((entry) => !isPositiveInteger(entry))
  ) {
    throw new Error(
      `Primary Runtime ${target} measurements require at least ${minimumLength} ${field} samples.`,
    );
  }
  return entries;
}

function isBudget(value) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === runtimeBudgetFields.length &&
    runtimeBudgetFields.every((field) => isPositiveInteger(value[field]))
  );
}

function hasUnexpectedTarget(value) {
  const keys = Object.keys(value);
  return (
    keys.length !== runtimeBudgetTargets.length ||
    keys.some((target) => !runtimeBudgetTargets.includes(target))
  );
}

function ceilScaled(value, multiplier) {
  return Math.ceil(value * multiplier);
}

function max(values) {
  return Math.max(...values);
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)];
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isPositiveRunId(value) {
  return (
    (typeof value === "string" || Number.isSafeInteger(value)) &&
    /^[1-9][0-9]*$/u.test(String(value))
  );
}

function isCommit(value) {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function readSha256(target, value) {
  if (!isSha256(value)) {
    throw new Error(
      `Primary Runtime measurements for ${target} have no immutable digest.`,
    );
  }
  return value;
}

function readRunner(target, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Primary Runtime measurements for ${target} have no runner identity.`,
    );
  }
  return value;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function createSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
