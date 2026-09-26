import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { readRuntimeSourcesLock } from "../scripts/source-lock.mjs";

const executeFile = promisify(execFile);
const patchPath = resolve(
  import.meta.dirname,
  "../patches/presentation-skill-runtime-v0.8.0.patch",
);
const sourceLockPath = resolve(
  import.meta.dirname,
  "../runtime-sources.lock.json",
);
const fixtureRoot = resolve(
  import.meta.dirname,
  "fixtures/presentation-skill-v0.8.0",
);

test("the locked Runtime patch applies to the exact upstream presentation files", async () => {
  const [sourceLock, fixture, patch] = await Promise.all([
    readRuntimeSourcesLock(sourceLockPath),
    readFixtureManifest(),
    readFile(patchPath, "utf8"),
  ]);

  assert.equal(fixture.repository, sourceLock.candidate.repository);
  assert.equal(fixture.tag, sourceLock.candidate.tag);
  assert.equal(fixture.commit, sourceLock.candidate.commit);
  assert.equal(fixture.license.spdx, sourceLock.candidate.license.spdx);
  assert.equal(
    fixture.license.upstreamPath,
    sourceLock.candidate.license.path,
  );
  assert.equal(fixture.license.sha256, sourceLock.candidate.license.sha256);

  const patchBaseFiles = existingPatchBaseFiles(patch);
  assert.deepEqual(
    [...patchBaseFiles.keys()].sort(),
    Object.keys(fixture.files).sort(),
    "the fixture must cover every existing file changed by the Runtime patch",
  );

  for (const [path, expectedBlobSha1] of Object.entries(fixture.files)) {
    const contents = await readFile(resolve(fixtureRoot, path));
    assert.equal(
      gitBlobSha1(contents),
      expectedBlobSha1,
      `${path} fixture drifted`,
    );
    assert.equal(
      patchBaseFiles.get(path),
      expectedBlobSha1,
      `${path} no longer matches the patch preimage`,
    );
  }

  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "presentation-runtime-patch-"),
  );
  const sourceRoot = join(temporaryRoot, "source");
  try {
    await cp(fixtureRoot, sourceRoot, { recursive: true });
    await executeFile(
      "git",
      ["apply", "--check", "--whitespace=error", patchPath],
      { cwd: sourceRoot },
    );
    await executeFile("git", ["apply", "--whitespace=error", patchPath], {
      cwd: sourceRoot,
    });
    await executeFile(
      "git",
      ["apply", "--reverse", "--check", "--whitespace=error", patchPath],
      { cwd: sourceRoot },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function readFixtureManifest() {
  return JSON.parse(await readFile(join(fixtureRoot, "fixture.json"), "utf8"));
}

function existingPatchBaseFiles(patch) {
  const files = new Map();
  for (const block of patch.split(/^diff --git /mu).slice(1)) {
    const header = block.match(/^a\/(.+) b\/(.+)$/mu);
    assert.ok(header, "patch block is missing a diff header");
    assert.equal(
      header[1],
      header[2],
      "Runtime patch may not rename upstream files",
    );
    if (/^new file mode /mu.test(block)) {
      continue;
    }
    const index = block.match(
      /^index ([0-9a-f]{40})\.\.([0-9a-f]{40})(?: .*)?$/mu,
    );
    assert.ok(index, `${header[1]} must use full Git blob identities`);
    files.set(header[1], index[1]);
  }
  return files;
}

function gitBlobSha1(contents) {
  return createHash("sha1")
    .update(`blob ${contents.length}\0`)
    .update(contents)
    .digest("hex");
}
