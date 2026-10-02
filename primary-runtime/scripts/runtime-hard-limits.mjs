import { readFile } from "node:fs/promises";

import { supportedRuntimeTargets } from "./source-lock.mjs";

export const runtimeHardLimitsSchema = "dascowork-primary-runtime-hard-limits.v1";
export const runtimeHardLimitFields = Object.freeze([
  "maxArchiveBytes",
  "maxUnpackedBytes",
  "minimumFreeDiskBytes",
]);

export async function readRuntimeHardLimits(path) {
  return validateRuntimeHardLimits(JSON.parse(await readFile(path, "utf8")));
}

export function validateRuntimeHardLimits(value) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== runtimeHardLimitsSchema ||
    typeof value.purpose !== "string" ||
    value.purpose.trim().length === 0 ||
    !isPlainObject(value.targets) ||
    !hasExactTargets(value.targets)
  ) {
    throw new Error("Primary Runtime hard limits have an invalid schema.");
  }

  for (const target of supportedRuntimeTargets) {
    const limit = value.targets[target];
    if (!isHardLimit(limit)) {
      throw new Error(`Primary Runtime hard limit for ${target} is incomplete.`);
    }
    if (limit.minimumFreeDiskBytes < limit.maxArchiveBytes + 2 * limit.maxUnpackedBytes) {
      throw new Error(
        `Primary Runtime hard limit for ${target} cannot provide its unpack headroom.`,
      );
    }
  }
  return value;
}

export function assertBudgetWithinHardLimits({ target, budget, hardLimits }) {
  const limits = validateRuntimeHardLimits(hardLimits).targets[target];
  if (!limits) throw new Error(`Primary Runtime hard limits do not support ${target}.`);
  for (const field of runtimeHardLimitFields) {
    if (!Number.isSafeInteger(budget?.[field]) || budget[field] > limits[field]) {
      throw new Error(`Primary Runtime ${target} ${field} exceeds its hard limit.`);
    }
  }
  return limits;
}

function isHardLimit(value) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === runtimeHardLimitFields.length &&
    runtimeHardLimitFields.every((field) => isPositiveSafeInteger(value[field]))
  );
}

function hasExactTargets(value) {
  const keys = Object.keys(value);
  return (
    keys.length === supportedRuntimeTargets.length &&
    keys.every((target) => supportedRuntimeTargets.includes(target))
  );
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
