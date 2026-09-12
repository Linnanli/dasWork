import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertApprovedSources,
  assertRepositoryPatchMatchesLock,
  readRuntimeSourcesLock,
  sha256,
} from "./source-lock.mjs";

const lockPath = parseArgs(process.argv.slice(2));
const sourceLock = await readFile(lockPath);
const lock = await readRuntimeSourcesLock(lockPath);
assertApprovedSources(lock);
await assertRepositoryPatchMatchesLock({
  lockPath,
  repositoryRoot: dirname(lockPath),
});
console.log(
  JSON.stringify(
    {
      schemaVersion: "dascowork-primary-runtime-provenance.v1",
      builderVersion: lock.builderVersion,
      sourceLockSha256: sha256(sourceLock),
      candidate: lock.candidate,
      components: lock.components,
    },
    null,
    2,
  ),
);

function parseArgs(argv) {
  if (argv.length === 0) {
    return fileURLToPath(
      new URL("../runtime-sources.lock.json", import.meta.url),
    );
  }
  if (argv.length === 2 && argv[0] === "--lock" && argv[1]) {
    return resolve(argv[1]);
  }
  throw new Error("Expected an optional --lock <path>.");
}
