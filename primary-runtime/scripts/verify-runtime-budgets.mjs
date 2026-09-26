#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRuntimeBudgets } from "./runtime-budgets.mjs";

const {
  budgetPath,
  measurementsPath,
  hardLimitsPath,
  sourceLockPath,
  toolchainsLockPath,
} = parseArgs(process.argv.slice(2));
const budgets = JSON.parse(await readFile(budgetPath, "utf8"));
const measurements = measurementsPath
  ? JSON.parse(await readFile(measurementsPath, "utf8"))
  : undefined;
verifyRuntimeBudgets({
  budgets,
  measurements,
  currentEvidence: {
    hardLimitsSha256: await sha256File(hardLimitsPath),
    sourceLockSha256: await sha256File(sourceLockPath),
    toolchainsLockSha256: await sha256File(toolchainsLockPath),
  },
});
process.stdout.write("Primary Runtime budgets verified.\n");

function parseArgs(argv) {
  let budgetPath = fileURLToPath(
    new URL("../runtime-budgets.json", import.meta.url),
  );
  let measurementsPath;
  let hardLimitsPath = fileURLToPath(
    new URL("../runtime-hard-limits.json", import.meta.url),
  );
  let sourceLockPath = fileURLToPath(
    new URL("../runtime-sources.lock.json", import.meta.url),
  );
  let toolchainsLockPath = fileURLToPath(
    new URL("../runtime-toolchains.lock.json", import.meta.url),
  );
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--budget") {
      if (!argv[index + 1]) throw new Error("Expected a path after --budget.");
      budgetPath = resolve(argv[index + 1]);
      index += 1;
    } else if (item === "--measurements") {
      if (!argv[index + 1]) {
        throw new Error("Expected a path after --measurements.");
      }
      measurementsPath = resolve(argv[index + 1]);
      index += 1;
    } else if (item === "--hard-limits") {
      if (!argv[index + 1]) {
        throw new Error("Expected a path after --hard-limits.");
      }
      hardLimitsPath = resolve(argv[index + 1]);
      index += 1;
    } else if (item === "--source-lock") {
      if (!argv[index + 1]) {
        throw new Error("Expected a path after --source-lock.");
      }
      sourceLockPath = resolve(argv[index + 1]);
      index += 1;
    } else if (item === "--toolchains-lock") {
      if (!argv[index + 1]) {
        throw new Error("Expected a path after --toolchains-lock.");
      }
      toolchainsLockPath = resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return {
    budgetPath: resolve(budgetPath),
    measurementsPath,
    hardLimitsPath: resolve(hardLimitsPath),
    sourceLockPath: resolve(sourceLockPath),
    toolchainsLockPath: resolve(toolchainsLockPath),
  };
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
