import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

import {
  assertBudgetWithinHardLimits,
  readRuntimeHardLimits,
  validateRuntimeHardLimits,
} from "../scripts/runtime-hard-limits.mjs";

const executeFile = promisify(execFile);
const verifier = resolve(import.meta.dirname, "../scripts/verify-runtime-hard-limits.mjs");
const committedLimits = resolve(import.meta.dirname, "../runtime-hard-limits.json");

test("hard limits are immutable, complete candidate ceilings", async () => {
  const limits = await readRuntimeHardLimits(committedLimits);
  assert.equal(limits.schemaVersion, "dascowork-primary-runtime-hard-limits.v1");
  assert.deepEqual(Object.keys(limits.targets).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "win32-x64",
  ]);
  assert.doesNotThrow(() =>
    assertBudgetWithinHardLimits({
      target: "linux-x64",
      hardLimits: limits,
      budget: {
        maxArchiveBytes: 1,
        maxUnpackedBytes: 1,
        minimumFreeDiskBytes: 1,
      },
    }),
  );
});

test("hard limits reject missing targets, unreviewable fields, and release overflow", async () => {
  const limits = await readRuntimeHardLimits(committedLimits);
  assert.throws(
    () => validateRuntimeHardLimits({ ...limits, targets: { ...limits.targets, "linux-x64": undefined } }),
    /invalid schema|incomplete/u,
  );
  assert.throws(
    () =>
      validateRuntimeHardLimits({
        ...limits,
        targets: {
          ...limits.targets,
          "linux-x64": { ...limits.targets["linux-x64"], maxColdInstallMs: 1 },
        },
      }),
    /incomplete/u,
  );
  assert.throws(
    () =>
      assertBudgetWithinHardLimits({
        target: "linux-x64",
        hardLimits: limits,
        budget: {
          maxArchiveBytes: limits.targets["linux-x64"].maxArchiveBytes + 1,
          maxUnpackedBytes: 1,
          minimumFreeDiskBytes: 1,
        },
      }),
    /exceeds its hard limit/u,
  );
});

test("hard-limit verifier only reads reviewed source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-hard-limits-"));
  try {
    const path = join(directory, "limits.json");
    await writeFile(path, await readFile(committedLimits));
    const { stdout } = await executeFile(process.execPath, [verifier, "--hard-limits", path]);
    assert.equal(JSON.parse(stdout).status, "verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
