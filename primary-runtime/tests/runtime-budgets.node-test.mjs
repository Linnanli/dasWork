import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  calibrateRuntimeBudgets,
  measurementFingerprint,
  runtimeBudgetTargets,
  verifyRuntimeBudgets,
} from "../scripts/runtime-budgets.mjs";

const executeFile = promisify(execFile);
const calibrateScript = resolve(
  import.meta.dirname,
  "../scripts/calibrate-runtime-budgets.mjs",
);
const verifyScript = resolve(
  import.meta.dirname,
  "../scripts/verify-runtime-budgets.mjs",
);
const assemblePerformanceScript = resolve(
  import.meta.dirname,
  "../scripts/assemble-runtime-performance-report.mjs",
);
const hardLimitsPath = resolve(import.meta.dirname, "../runtime-hard-limits.json");
const sourceLockPath = resolve(import.meta.dirname, "../runtime-sources.lock.json");
const toolchainsLockPath = resolve(
  import.meta.dirname,
  "../runtime-toolchains.lock.json",
);

test("calibrates reviewable budgets from clean-runner measurements", () => {
  const report = calibrateRuntimeBudgets(validMeasurements());
  assert.equal(
    report.schemaVersion,
    "dascowork-primary-runtime-budget-candidate.v1",
  );
  assert.equal(
    report.evidence.measurementsFingerprint,
    measurementFingerprint(validMeasurements()),
  );
  for (const target of runtimeBudgetTargets) {
    assert.equal(report.targets[target].maxArchiveBytes, 1150);
    assert.equal(report.targets[target].maxUnpackedBytes, 2300);
    assert.equal(report.targets[target].minimumFreeDiskBytes, 6613);
    assert.equal(report.targets[target].maxColdInstallMs, 1250);
    assert.equal(report.targets[target].maxMainEventLoopDelayP99Ms, 25);
    assert.equal(report.targets[target].maxMainEventLoopDelayMaxMs, 125);
  }
});

test("verifies review-bound budgets and rejects missing or malformed targets", () => {
  const budgets = validBudgets();
  assert.equal(verifyRuntimeBudgets({ budgets }), budgets);
  assert.throws(
    () =>
      verifyRuntimeBudgets({
        budgets,
        currentEvidence: {
          hardLimitsSha256: "c".repeat(64),
          sourceLockSha256: "0".repeat(64),
          toolchainsLockSha256: "e".repeat(64),
        },
      }),
    /does not match current sourceLockSha256/u,
  );
  assert.throws(
    () =>
      verifyRuntimeBudgets({
        budgets: {
          ...budgets,
          targets: { ...budgets.targets, "darwin-x64": undefined },
        },
      }),
    /budget for darwin-x64 is incomplete/u,
  );
  assert.throws(
    () =>
      verifyRuntimeBudgets({
        budgets: {
          ...budgets,
          targets: {
            ...budgets.targets,
            "darwin-x64": {
              ...budgets.targets["darwin-x64"],
              maxArchiveBytes: 0,
            },
          },
        },
      }),
    /budget for darwin-x64 is incomplete/u,
  );
});

test("rejects budgets below formula, hard limit, or actual measurements", () => {
  const budgets = validBudgets();
  assert.throws(
    () =>
      verifyRuntimeBudgets({
        budgets: {
          ...budgets,
          targets: {
            ...budgets.targets,
            "darwin-x64": {
              ...budgets.targets["darwin-x64"],
              minimumFreeDiskBytes: 1,
            },
          },
        },
      }),
    /minimumFreeDiskBytes is below/u,
  );
  assert.throws(
    () =>
      verifyRuntimeBudgets({
        budgets,
        installerLimits: { maxArchiveBytes: 999, maxUnpackedBytes: 9_000_000 },
      }),
    /archive budget exceeds installer hard limit/u,
  );
  assert.throws(
    () => {
      const lowDiskMeasurements = validMeasurements({
        minimumAvailableDiskBytes: Array(10).fill(1_000),
      });
      return verifyRuntimeBudgets({
        budgets: validBudgets(lowDiskMeasurements),
        measurements: lowDiskMeasurements,
      });
    },
    /lacks measured available disk/u,
  );
  assert.throws(
    () =>
      verifyRuntimeBudgets({
        budgets: validBudgets(
          validMeasurements({
            archiveBytes: [
              2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000,
            ],
          }),
        ),
        measurements: validMeasurements({
          archiveBytes: [2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000],
        }),
      }),
    /exceeds maxArchiveBytes/u,
  );
});

test("rejects measurement reports without required sample counts", () => {
  assert.throws(
    () =>
      calibrateRuntimeBudgets(
        validMeasurements({
          coldInstallMs: [100, 100, 100],
        }),
      ),
    /at least 10 coldInstallMs samples/u,
  );
  assert.throws(
    () =>
      calibrateRuntimeBudgets(
        validMeasurements({
          minimumAvailableDiskBytes: [10_000],
        }),
      ),
    /at least 10 minimumAvailableDiskBytes samples/u,
  );
});

test("rejects calibration without ten real Main-overlap chat/install samples", () => {
  assert.throws(
    () =>
      calibrateRuntimeBudgets(validMeasurements({ chatInstallOverlapMs: [25] })),
    /at least 10 chatInstallOverlapMs samples/u,
  );
});

test("budget CLIs read files and fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-budgets-"));
  const measurementsPath = join(directory, "measurements.json");
  const budgetPath = join(directory, "runtime-budgets.json");
  const staleSourceLockPath = join(directory, "stale-runtime-sources.lock.json");
  try {
    const measurements = validMeasurements({
      evidence: await currentCheckoutEvidence(),
    });
    await writeFile(
      measurementsPath,
      `${JSON.stringify(measurements, null, 2)}\n`,
    );
    await writeFile(
      budgetPath,
      `${JSON.stringify(validBudgets(measurements), null, 2)}\n`,
    );
    const { stdout: calibrateStdout } = await executeFile(process.execPath, [
      calibrateScript,
      "--measurements",
      measurementsPath,
    ]);
    assert.equal(
      JSON.parse(calibrateStdout).schemaVersion,
      "dascowork-primary-runtime-budget-candidate.v1",
    );
    const { stdout: verifyStdout } = await executeFile(process.execPath, [
      verifyScript,
      "--budget",
      budgetPath,
      "--measurements",
      measurementsPath,
      "--hard-limits",
      hardLimitsPath,
      "--source-lock",
      sourceLockPath,
      "--toolchains-lock",
      toolchainsLockPath,
    ]);
    assert.match(verifyStdout, /budgets verified/u);
    await writeFile(staleSourceLockPath, '{"stale":true}\n');
    await assert.rejects(
      () =>
        executeFile(process.execPath, [
          verifyScript,
          "--budget",
          budgetPath,
          "--measurements",
          measurementsPath,
          "--hard-limits",
          hardLimitsPath,
          "--source-lock",
          staleSourceLockPath,
          "--toolchains-lock",
          toolchainsLockPath,
        ]),
      /does not match current sourceLockSha256/u,
    );
    const awaitingReviewBudget = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "../runtime-budgets.json"),
        "utf8",
      ),
    );
    awaitingReviewBudget.evidence.reviewed = false;
    assert.throws(
      () => verifyRuntimeBudgets({ budgets: awaitingReviewBudget }),
      /invalid schema|incomplete provenance/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("assembles four target-native P3b reports only when their lineage matches", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "primary-runtime-performance-assembly-"),
  );
  const outputPath = join(directory, "performance-report.json");
  try {
    const measurements = validMeasurements();
    const args = [assemblePerformanceScript, "--output", outputPath];
    for (const target of runtimeBudgetTargets) {
      const reportPath = join(directory, `${target}.json`);
      const targetMeasurement = measurements.targets[target];
      await writeFile(
        reportPath,
        `${JSON.stringify(
          {
            schemaVersion: "dascowork-primary-runtime-performance-target.v1",
            target,
            evidence: {
              ...measurements.evidence,
              runner: targetMeasurement.runner,
            },
            ...targetMeasurement,
          },
          null,
          2,
        )}\n`,
      );
      args.push("--report", `${target}=${reportPath}`);
    }
    await executeFile(process.execPath, args);
    assert.deepEqual(
      JSON.parse(await readFile(outputPath, "utf8")),
      measurements,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function validBudgets(measurements = validMeasurements()) {
  return {
    schemaVersion: "dascowork-primary-runtime-budgets.v1",
    evidence: {
      reviewed: true,
      sourceRunId: measurements.evidence.sourceRunId,
      sourceCommit: measurements.evidence.sourceCommit,
      installerCommit: measurements.evidence.installerCommit,
      hardLimitsSha256: measurements.evidence.hardLimitsSha256,
      sourceLockSha256: measurements.evidence.sourceLockSha256,
      toolchainsLockSha256: measurements.evidence.toolchainsLockSha256,
      measurementsFingerprint: measurementFingerprint(measurements),
      candidateArchiveSha256: Object.fromEntries(
        runtimeBudgetTargets.map((target) => [
          target,
          measurements.targets[target].candidateArchiveSha256,
        ]),
      ),
    },
    targets: Object.fromEntries(
      runtimeBudgetTargets.map((target) => [
        target,
        {
          maxArchiveBytes: 1_000_000,
          maxUnpackedBytes: 2_000_000,
          minimumFreeDiskBytes: 5_750_000,
          maxColdInstallMs: 2_000,
          maxMainEventLoopDelayP99Ms: 50,
          maxMainEventLoopDelayMaxMs: 200,
        },
      ]),
    ),
  };
}

function validMeasurements(overrides = {}) {
  const targetMeasurements = {
    archiveBytes: overrides.archiveBytes ?? [1000, 900, 950, 975, 925],
    unpackedBytes: overrides.unpackedBytes ?? [2000, 1900, 1950, 1975, 1925],
    coldInstallMs: overrides.coldInstallMs ?? [
      1000, 900, 950, 975, 925, 875, 825, 800, 750, 700,
    ],
    mainEventLoopDelayP99Ms: overrides.mainEventLoopDelayP99Ms ?? [
      20, 18, 19, 17, 16, 15, 14, 13, 12, 11,
    ],
    mainEventLoopDelayMaxMs: overrides.mainEventLoopDelayMaxMs ?? [
      100, 90, 95, 97, 92, 87, 82, 80, 75, 70,
    ],
    minimumAvailableDiskBytes: overrides.minimumAvailableDiskBytes ?? [
      6_000_000, 5_990_000, 5_980_000, 5_970_000, 5_960_000, 5_950_000,
      5_940_000, 5_930_000, 5_920_000, 5_910_000,
    ],
    chatInstallOverlapMs: overrides.chatInstallOverlapMs ?? [
      500, 450, 475, 425, 400, 390, 380, 370, 360, 350,
    ],
  };
  return {
    schemaVersion: "dascowork-primary-runtime-budget-measurements.v1",
    evidence: {
      sourceRunId: "123456",
      sourceCommit: "a".repeat(40),
      installerCommit: "b".repeat(40),
      hardLimitsSha256: "c".repeat(64),
      sourceLockSha256: "d".repeat(64),
      toolchainsLockSha256: "e".repeat(64),
      ...(overrides.evidence ?? {}),
    },
    targets: Object.fromEntries(
      runtimeBudgetTargets.map((target) => [
        target,
        {
          ...targetMeasurements,
          runner: `${target}-runner`,
          candidateArchiveSha256: `${target.charCodeAt(0).toString(16)}`
            .repeat(64)
            .slice(0, 64),
          p1aBuildUnpackReceiptSha256: "f".repeat(64),
        },
      ]),
    ),
  };
}

async function currentCheckoutEvidence() {
  return {
    hardLimitsSha256: await sha256File(hardLimitsPath),
    sourceLockSha256: await sha256File(sourceLockPath),
    toolchainsLockSha256: await sha256File(toolchainsLockPath),
  };
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
