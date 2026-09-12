import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  artifactsForTarget,
  assertRuntimeInputsManifest,
  readRuntimeToolchainsLock,
  validateRuntimeToolchainsLock,
  writeRuntimeInputsManifest,
} from "../scripts/runtime-inputs.mjs";
import { currentRuntimeTarget } from "../scripts/runtime-target.mjs";
import { readRuntimeSourcesLock, sha256 } from "../scripts/source-lock.mjs";

const sourceLockPath = resolve(
  import.meta.dirname,
  "../runtime-sources.lock.json",
);
const toolchainsLockPath = resolve(
  import.meta.dirname,
  "../runtime-toolchains.lock.json",
);
const executeFile = promisify(execFile);
const fetchScript = resolve(
  import.meta.dirname,
  "../scripts/fetch-runtime-sources.mjs",
);
const materializeScript = resolve(
  import.meta.dirname,
  "../scripts/materialize-runtime-inputs.mjs",
);
const verifyInputsScript = resolve(
  import.meta.dirname,
  "../scripts/verify-runtime-inputs.mjs",
);
const verifyPlatformScript = resolve(
  import.meta.dirname,
  "../scripts/verify-runtime-platform.mjs",
);

test("input manifest binds the immutable source/toolchain lock and every payload file", async () => {
  const fixture = await createInputFixture();
  try {
    const verified = await assertRuntimeInputsManifest(fixture);
    assert.equal(verified.manifest.target, fixture.target);
    assert.equal(verified.manifest.builder.runner, fixture.runner);
    assert.ok(
      verified.files.some(
        (entry) => entry.path === "dependencies/node/bin/node",
      ),
    );

    await writeFile(join(fixture.inputRoot, "unbound.txt"), "not allowed\n");
    await assert.rejects(
      () => assertRuntimeInputsManifest(fixture),
      /files differ from the verified manifest/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("input manifest rejects runner drift, lock drift, and symbolic-link escape", async () => {
  const fixture = await createInputFixture();
  try {
    const manifestPath = join(
      fixture.inputRoot,
      "runtime-inputs.manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.builder.runner = "wrong-runner";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => assertRuntimeInputsManifest(fixture),
      /source binding is invalid/u,
    );

    await createFixtureManifest(fixture);
    const rebuiltManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    rebuiltManifest.builder.tools.reverse();
    await writeFile(
      manifestPath,
      `${JSON.stringify(rebuiltManifest, null, 2)}\n`,
    );
    await assert.rejects(
      () => assertRuntimeInputsManifest(fixture),
      /source binding is invalid/u,
    );

    await createFixtureManifest(fixture);
    const imageDriftManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    imageDriftManifest.builder.observedImage = "wrong-hosted-image";
    await writeFile(
      manifestPath,
      `${JSON.stringify(imageDriftManifest, null, 2)}\n`,
    );
    await assert.rejects(
      () => assertRuntimeInputsManifest(fixture),
      /does not bind this build/u,
    );

    await createFixtureManifest(fixture);
    await symlink(
      "node",
      join(fixture.inputRoot, "dependencies/node/bin/node-link"),
    );
    await assert.rejects(
      () => assertRuntimeInputsManifest(fixture),
      /symbolic link/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("toolchain lock rejects mutable, incomplete target recipes", async () => {
  const lock = await readRuntimeToolchainsLock(toolchainsLockPath);
  const target = currentRuntimeTarget();
  const badUrl = structuredClone(lock);
  badUrl.targets[target].node.url =
    "https://nodejs.org/dist/latest/node.tar.gz";
  assert.throws(() => validateRuntimeToolchainsLock(badUrl), /invalid/u);

  const missingRecipe = structuredClone(lock);
  missingRecipe.targets[target].nativeRecipes = [];
  assert.throws(() => validateRuntimeToolchainsLock(missingRecipe), /invalid/u);

  const missingBuilder = structuredClone(lock);
  delete missingBuilder.targets[target].builder;
  assert.throws(() => validateRuntimeToolchainsLock(missingBuilder), /invalid/u);

  const missingClosure = structuredClone(lock);
  delete missingClosure.targets[target].nativeRecipes[0].closure;
  assert.throws(() => validateRuntimeToolchainsLock(missingClosure), /invalid/u);

  const incompleteClosure = structuredClone(lock);
  incompleteClosure.targets[target].nativeRecipes[0].outputs = [
    {
      kind: "file",
      source: "instdir/program/soffice",
      destination: "dependencies/native/bin/soffice",
      mode: "0755",
    },
  ];
  assert.throws(
    () => validateRuntimeToolchainsLock(incompleteClosure),
    /invalid/u,
  );
});

test("LibreOffice source recipes invoke its Perl autogen entrypoint explicitly", async () => {
  const lock = await readRuntimeToolchainsLock(toolchainsLockPath);
  for (const [target, toolchain] of Object.entries(lock.targets)) {
    const recipe = toolchain.nativeRecipes.find(
      (candidate) => candidate.name === "libreoffice",
    );
    assert.deepEqual(
      recipe?.commands[0]?.slice(0, 2),
      ["perl", "./autogen.sh"],
      `${target} must not rely on shell execution of a non-shebang script`,
    );
    assert.ok(
      recipe?.commands[0]?.includes("--disable-cups"),
      `${target} must not depend on the builder's CUPS development package`,
    );
    assert.match(recipe?.toolchain.flags ?? "", /--disable-cups/u);
  }
});

test("Windows MSYS2 builder scripts are probed through the selected Bash runtime", async () => {
  const source = await readFile(materializeScript, "utf8");

  assert.match(source, /target === "win32-x64" && process\.env\.MSYSTEM === "MSYS"/u);
  assert.match(source, /\["-lc", 'exec "\$@"', "bash", command, \.\.\.versionArgs\]/u);
  assert.match(source, /command === "cl" \? \[\] : \["--version"\]/u);
});

test("the locked presentation-plugin archive strips only its GitHub tag wrapper", async () => {
  const [sourceLock, toolchainsLock] = await Promise.all([
    readRuntimeSourcesLock(sourceLockPath),
    readRuntimeToolchainsLock(toolchainsLockPath),
  ]);
  const source = artifactsForTarget({
    sourceLock,
    toolchainsLock,
    target: currentRuntimeTarget(),
  }).find((artifact) => artifact.name === "presentation-skill-source");
  assert.equal(source?.stripComponents, 1);
});

test("ZIP Runtime inputs without a strip rule extract from their source root", async () => {
  const [sourceLock, toolchainsLock, materializerSource] = await Promise.all([
    readRuntimeSourcesLock(sourceLockPath),
    readRuntimeToolchainsLock(toolchainsLockPath),
    readFile(materializeScript, "utf8"),
  ]);
  const rootZip = artifactsForTarget({
    sourceLock,
    toolchainsLock,
    target: currentRuntimeTarget(),
  }).find(
    (artifact) =>
      artifact.archiveFormat === "zip" && artifact.stripComponents === undefined,
  );
  assert.ok(rootZip, "the locked inputs must exercise a root ZIP extraction");
  assert.match(
    materializerSource,
    /async function extractArchive\(\{[\s\S]*?stripComponents = 0,/u,
  );
});

test("P1 command line tools accept the documented equals-form arguments", async () => {
  const root = await (
    await import("node:fs/promises")
  ).mkdtemp(join(tmpdir(), "primary-runtime-cli-"));
  const target = currentRuntimeTarget();
  try {
    await assert.rejects(
      () =>
        executeFile(process.execPath, [
          fetchScript,
          `--target=${target}`,
          `--cache=${join(root, "cache")}`,
          "--timeout-ms=999",
        ]),
      /timeout-ms must be an integer/u,
    );
    await assert.rejects(
      () =>
        executeFile(process.execPath, [
          fetchScript,
          `--target=${target}`,
          `--cache=${join(root, "cache")}`,
          "--timeout-ms=900001",
        ]),
      /timeout-ms must be an integer from 1000 through 900000/u,
    );
    await assert.rejects(
      () =>
        executeFile(process.execPath, [
          materializeScript,
          `--target=${target}`,
          `--source-cache=${join(root, "cache")}`,
          `--output=${join(root, "inputs")}`,
        ]),
      /requires locked builder tool|cache is missing locked/u,
    );
    await assert.rejects(
      () =>
        executeFile(process.execPath, [
          verifyInputsScript,
          `--target=${target}`,
          `--input-root=${join(root, "missing-inputs")}`,
        ]),
      /input manifest is missing or invalid/u,
    );
    await assert.rejects(
      () =>
        executeFile(process.execPath, [
          verifyPlatformScript,
          `--target=${target}`,
          `--archive=${join(root, "missing.zip")}`,
          `--output=${join(root, "platform-validation.json")}`,
        ]),
      /ENOENT/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P1 scripts resolve default lock paths through file URLs safely on Windows", async () => {
  const scriptFiles = [
    fetchScript,
    materializeScript,
    verifyInputsScript,
    verifyPlatformScript,
    resolve(import.meta.dirname, "../scripts/build-runtime.mjs"),
    resolve(import.meta.dirname, "../scripts/verify-runtime.mjs"),
    resolve(import.meta.dirname, "../scripts/source-lock.mjs"),
  ];
  for (const scriptFile of scriptFiles) {
    const source = await readFile(scriptFile, "utf8");
    assert.match(source, /fileURLToPath/u, `${scriptFile} must use fileURLToPath`);
    assert.doesNotMatch(
      source,
      /new URL\([^)]*import\.meta\.url\)\.pathname/u,
      `${scriptFile} must not pass a file URL pathname to path.resolve`,
    );
  }
});

async function createInputFixture() {
  const root = await (
    await import("node:fs/promises")
  ).mkdtemp(join(tmpdir(), "primary-runtime-inputs-"));
  const inputRoot = join(root, "runtime-inputs");
  const target = currentRuntimeTarget();
  const toolchains = await readRuntimeToolchainsLock(toolchainsLockPath);
  const fixture = {
    root,
    inputRoot,
    target,
    runner: toolchains.targets[target].runner,
    sourceLockPath,
    toolchainsLockPath,
  };
  await mkdir(join(inputRoot, "dependencies/node/bin"), { recursive: true });
  await mkdir(join(inputRoot, "plugins/presentation-skill"), {
    recursive: true,
  });
  await writeFile(
    join(inputRoot, "dependencies/node/bin/node"),
    "fixture runtime\n",
  );
  await writeFile(
    join(inputRoot, "plugins/presentation-skill/fixture.txt"),
    "fixture plugin\n",
  );
  await createFixtureManifest(fixture);
  return fixture;
}

async function createFixtureManifest(fixture) {
  const [sourceLock, toolchainsLock] = await Promise.all([
    readRuntimeSourcesLock(sourceLockPath),
    readRuntimeToolchainsLock(toolchainsLockPath),
  ]);
  const observedImage = `fixture:${fixture.target}:runner-image-v1`;
  await writeRuntimeInputsManifest({
    inputRoot: fixture.inputRoot,
    target: fixture.target,
    sourceLockPath,
    toolchainsLockPath,
    artifacts: artifactsForTarget({
      sourceLock,
      toolchainsLock,
      target: fixture.target,
    }),
    patches: [
      {
        path: sourceLock.candidate.patch.path,
        sha256: sourceLock.candidate.patch.sha256,
      },
    ],
    builder: {
      name: "@dascowork/primary-runtime-materializer",
      version: toolchainsLock.materializerVersion,
      runner: fixture.runner,
      identity: toolchainsLock.targets[fixture.target].builder.identity,
      observedImage,
      observedImageSha256: sha256(observedImage),
      tools: toolchainsLock.targets[fixture.target].builder.tools.map(
        (command) => ({ command, versionSha256: "a".repeat(64) }),
      ),
    },
  });
}
