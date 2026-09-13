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
const repositoryAttributesPath = resolve(import.meta.dirname, "../../.gitattributes");

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

test("LibreOffice recipes use locked target-native binary materialization where source builds are unsupported", async () => {
  const lock = await readRuntimeToolchainsLock(toolchainsLockPath);
  for (const [target, toolchain] of Object.entries(lock.targets)) {
    const recipe = toolchain.nativeRecipes.find(
      (candidate) => candidate.name === "libreoffice",
    );
    if (target === "win32-x64") {
      assert.equal(recipe?.materialization, "prebuilt");
      assert.equal(recipe?.sourceComponent, "libreoffice-windows-x64");
      assert.equal(recipe?.sourceArchiveFormat, "msi");
      assert.deepEqual(recipe?.commands, []);
      assert.deepEqual(recipe?.environment, {});
      assert.ok(toolchain.builder.tools.includes("msiexec"));
      continue;
    }
    if (target.startsWith("darwin")) {
      assert.equal(recipe?.materialization, "prebuilt");
      assert.equal(recipe?.sourceComponent, `libreoffice-${target}`);
      assert.equal(recipe?.sourceArchiveFormat, "dmg");
      assert.equal(recipe?.sourceDirectory, "LibreOffice.app");
      assert.deepEqual(recipe?.commands, []);
      assert.deepEqual(recipe?.environment, {});
      assert.ok(toolchain.builder.tools.includes("hdiutil"));
      assert.deepEqual(recipe?.outputs, [
        {
          kind: "directory",
          source: "Contents",
          destination: "dependencies/native/libreoffice",
        },
      ]);
      assert.deepEqual(recipe?.closure.entrypoints, [
        "dependencies/native/libreoffice/MacOS/soffice",
      ]);
      continue;
    }
    assert.equal(recipe?.materialization, "source-build");
    assert.deepEqual(
      recipe?.commands[0]?.slice(0, 2),
      ["bash", "./configure"],
      `${target} must not regenerate configure with the mutable builder autotools`,
    );
    assert.ok(
      toolchain.builder.tools.includes("bash"),
      `${target} must record the shell that executes the locked configure script`,
    );
    assert.ok(
      recipe?.commands[0]?.includes("--disable-cups"),
      `${target} must not depend on the builder's CUPS development package`,
    );
    assert.match(recipe?.toolchain.flags ?? "", /--disable-cups/u);
    assert.ok(
      recipe?.commands[0]?.includes("--disable-gui"),
      `${target} must use the Runtime's headless LibreOffice build recipe`,
    );
    assert.match(recipe?.toolchain.flags ?? "", /--disable-gui/u);
    if (target.startsWith("darwin")) {
      assert.ok(recipe?.commands[0]?.includes("--enable-bogus-pkg-config"));
      assert.match(
        recipe?.toolchain.flags ?? "",
        /--enable-bogus-pkg-config/u,
      );
    } else {
      assert.ok(!recipe?.commands[0]?.includes("--enable-bogus-pkg-config"));
    }
  }
});

test("Poppler source recipes disable non-QA optional backends rather than discovering runner dependencies", async () => {
  const lock = await readRuntimeToolchainsLock(toolchainsLockPath);
  const disabledOptions = [
    "-DENABLE_NSS3=OFF",
    "-DENABLE_GPGME=OFF",
    "-DENABLE_LIBTIFF=OFF",
    "-DENABLE_BOOST=OFF",
    "-DENABLE_GLIB=OFF",
    "-DENABLE_GOBJECT_INTROSPECTION=OFF",
    "-DENABLE_QT5=OFF",
    "-DENABLE_QT6=OFF",
    "-DENABLE_LIBOPENJPEG=OFF",
    "-DENABLE_LIBJPEG=OFF",
    "-DENABLE_LCMS=OFF",
    "-DENABLE_LIBCURL=OFF",
    "-DENABLE_HARFBUZZ=OFF",
  ];
  for (const [target, toolchain] of Object.entries(lock.targets)) {
    const recipe = toolchain.nativeRecipes.find(
      (candidate) => candidate.name === "poppler",
    );
    assert.equal(recipe?.materialization, "source-build", target);
    for (const option of disabledOptions) {
      assert.ok(recipe?.toolchain.flags?.includes(option), `${target}: ${option}`);
      assert.ok(recipe?.commands[0]?.includes(option), `${target}: ${option}`);
    }
  }
});

test("Windows MSI extraction is locked and does not restore the rejected MSYS source-build path", async () => {
  const source = await readFile(materializeScript, "utf8");

  assert.match(
    source,
    /target === "win32-x64" && command === "msiexec"[\s\S]*?System32", "msiexec\.exe"/u,
  );
  assert.match(
    source,
    /if \(archiveFormat === "msi"\)[\s\S]*?extractWindowsMsi/u,
  );
  assert.match(source, /\["\/a", archive, "\/qn", `TARGETDIR=\$\{output\}`\]/u);
  assert.doesNotMatch(source, /DASCOWORK_PRIMARY_RUNTIME_MSYS_ROOT|MSYSTEM/u);
});

test("macOS DMG extraction is temporary and produces only the locked application payload", async () => {
  const source = await readFile(materializeScript, "utf8");

  assert.match(
    source,
    /if \(archiveFormat === "dmg"\)[\s\S]*?extractMacosDmg/u,
  );
  assert.match(
    source,
    /target\.startsWith\("darwin"\)[\s\S]*?DMG Runtime inputs/u,
  );
  assert.match(
    source,
    /\["attach", "-readonly", "-nobrowse", "-noverify", "-mountpoint", mountpoint, archive\]/u,
  );
  assert.match(source, /safeChild\(mountpoint, "LibreOffice\.app"\)/u);
  assert.match(source, /\["detach", mountpoint, "-force"\]/u);
});

test("P1 rendering uses only the Runtime-owned presentation plugin scripts", async () => {
  const [materializerSource, verifierSource] = await Promise.all([
    readFile(materializeScript, "utf8"),
    readFile(verifyInputsScript, "utf8"),
  ]);

  assert.match(
    materializerSource,
    /scripts\/design_tokens\.py[\s\S]*?scripts\/design_tokens\.py/u,
  );
  assert.match(verifierSource, /build_deck_pptxgenjs\.js/u);
  assert.match(verifierSource, /layout_lint\.py/u);
  assert.match(verifierSource, /render_slides\.py/u);
  assert.match(verifierSource, /presentation-plugin-create-chinese-deck/u);
  assert.match(verifierSource, /presentation-plugin-layout-lint/u);
  assert.match(verifierSource, /presentation-plugin-render-slides/u);
  assert.match(verifierSource, /variant: "table"/u);
  assert.match(verifierSource, /variant: "chart"/u);
  assert.match(verifierSource, /variant: "image-sidebar"/u);
  assert.match(verifierSource, /PPTX_RUNTIME_SOFFICE: soffice/u);
  assert.match(verifierSource, /PPTX_RUNTIME_PDFTOPPM: pdftoppm/u);
  assert.doesNotMatch(verifierSource, /create-smoke\.cjs|pptxgenjs-create-chinese-deck/u);
});

test("the source-lock-bound Runtime patch preserves its exact bytes on Windows checkouts", async () => {
  const attributes = await readFile(repositoryAttributesPath, "utf8");
  assert.match(
    attributes,
    /^primary-runtime\/patches\/\*\.patch -text$/mu,
    "a Windows checkout must not rewrite the patch bytes bound by runtime-sources.lock.json",
  );
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
  assert.match(
    materializerSource,
    /async function extractZipWithLockedTar\(\{ archive, output, stripComponents \}\)/u,
  );
  assert.match(
    materializerSource,
    /if \(!python\) \{\s+await extractZipWithLockedTar\(\{ archive, output, stripComponents \}\);/u,
  );
  assert.match(
    materializerSource,
    /async function extractWithLockedTar\(\{ archive, output, stripComponents \}\)/u,
  );
  assert.match(
    materializerSource,
    /target === "win32-x64"\s+\? relative\(output, archive\)\.split\(sep\)\.join\("\/"\)\s+: archive/u,
  );
  assert.match(
    materializerSource,
    /if \(target !== "win32-x64"\) args\.push\("-C", output\);/u,
  );
  assert.match(
    materializerSource,
    /await run\(resolveLockedBuilderCommand\("tar"\), args, \{ cwd: output \}\);/u,
  );
  assert.match(
    materializerSource,
    /target === "win32-x64" && command === "tar"[\s\S]*?System32", "tar\.exe"/u,
  );
});

test("toolchain lock rejects a prebuilt native binary with build commands or environment", async () => {
  const lock = await readRuntimeToolchainsLock(toolchainsLockPath);
  const badCommands = structuredClone(lock);
  const windowsRecipe = badCommands.targets["win32-x64"].nativeRecipes.find(
    (recipe) => recipe.name === "libreoffice",
  );
  windowsRecipe.commands = [["cmd", "/c", "ver"]];
  assert.throws(() => validateRuntimeToolchainsLock(badCommands), /invalid/u);

  const badEnvironment = structuredClone(lock);
  const prebuiltRecipe = badEnvironment.targets["win32-x64"].nativeRecipes.find(
    (recipe) => recipe.name === "libreoffice",
  );
  prebuiltRecipe.environment = { PATH: "host" };
  assert.throws(() => validateRuntimeToolchainsLock(badEnvironment), /invalid/u);
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

test("materialization keeps source-build intermediates outside the signed input root", async () => {
  const source = await readFile(materializeScript, "utf8");

  assert.match(
    source,
    /const workRoot = resolve\(\s*options\.outputRoot,\s*"\.\.",\s*`\$\{basename\(options\.outputRoot\)\}\.materialize-work`,/u,
  );
  assert.doesNotMatch(
    source,
    /join\(options\.outputRoot, "\.materialize-work"\)/u,
  );
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
