#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  normalizeMeasurements,
  runtimeBudgetTargets,
} from "./runtime-budgets.mjs";

const options = parseArgs(process.argv.slice(2));
const reports = Object.fromEntries(
  await Promise.all(
    runtimeBudgetTargets.map(async (target) => [
      target,
      await readTargetReport(target, options.reports[target]),
    ]),
  ),
);
const evidence = reports[runtimeBudgetTargets[0]].evidence;
for (const target of runtimeBudgetTargets.slice(1)) {
  assertSameEvidence(evidence, reports[target].evidence, target);
}
const measurements = {
  schemaVersion: "dascowork-primary-runtime-budget-measurements.v1",
  evidence: {
    sourceRunId: evidence.sourceRunId,
    sourceCommit: evidence.sourceCommit,
    installerCommit: evidence.installerCommit,
    hardLimitsSha256: evidence.hardLimitsSha256,
    sourceLockSha256: evidence.sourceLockSha256,
    toolchainsLockSha256: evidence.toolchainsLockSha256,
  },
  targets: Object.fromEntries(
    runtimeBudgetTargets.map((target) => [
      target,
      {
        runner: reports[target].runner,
        candidateArchiveSha256: reports[target].candidateArchiveSha256,
        p1aBuildUnpackReceiptSha256:
          reports[target].p1aBuildUnpackReceiptSha256,
        normalChatPassed: reports[target].normalChatPassed,
        archiveBytes: reports[target].archiveBytes,
        unpackedBytes: reports[target].unpackedBytes,
        coldInstallMs: reports[target].coldInstallMs,
        mainEventLoopDelayP99Ms: reports[target].mainEventLoopDelayP99Ms,
        mainEventLoopDelayMaxMs: reports[target].mainEventLoopDelayMaxMs,
      },
    ]),
  ),
};
normalizeMeasurements(measurements);
await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify(measurements, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(measurements, null, 2)}\n`);

async function readTargetReport(target, path) {
  const report = JSON.parse(await readFile(path, "utf8"));
  if (
    report?.schemaVersion !==
      "dascowork-primary-runtime-performance-target.v1" ||
    report.target !== target ||
    typeof report.runner !== "string" ||
    report.runner.trim().length === 0 ||
    !isObject(report.evidence)
  ) {
    throw new Error(`P3b target performance report for ${target} is invalid.`);
  }
  return report;
}

function assertSameEvidence(expected, actual, target) {
  for (const field of [
    "sourceRunId",
    "sourceCommit",
    "installerCommit",
    "hardLimitsSha256",
    "sourceLockSha256",
    "toolchainsLockSha256",
  ]) {
    if (expected[field] !== actual[field]) {
      throw new Error(
        `P3b target performance report ${target} does not match ${field}.`,
      );
    }
  }
}

function parseArgs(argv) {
  const reports = {};
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Expected a value after ${argument}.`);
    if (argument === "--output") {
      output = resolve(value);
    } else if (argument === "--report") {
      const delimiter = value.indexOf("=");
      const target = value.slice(0, delimiter);
      const path = value.slice(delimiter + 1);
      if (!runtimeBudgetTargets.includes(target) || !path || reports[target]) {
        throw new Error(
          "--report requires one path for each supported Runtime target.",
        );
      }
      reports[target] = resolve(path);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }
  if (!output || Object.keys(reports).length !== runtimeBudgetTargets.length) {
    throw new Error(
      "P3b performance assembly requires --output and exactly four --report target=path values.",
    );
  }
  return { output, reports };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
