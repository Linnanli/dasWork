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
  expectedBuilderImageIdentity,
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

  const mutableBuilderImage = structuredClone(lock);
  mutableBuilderImage.targets[target].builder.image.version = "latest";
  assert.throws(
    () => validateRuntimeToolchainsLock(mutableBuilderImage),
    /invalid/u,
  );

  const mismatchedBuilderDigest = structuredClone(lock);
  mismatchedBuilderDigest.targets[target].builder.image.imageDigestSha256 =
    "0".repeat(64);
  assert.throws(
    () => validateRuntimeToolchainsLock(mismatchedBuilderDigest),
    /invalid/u,
  );

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

  const unresolvedNativeDependency = structuredClone(lock);
  unresolvedNativeDependency.targets[target].nativeRecipes.find(
    (recipe) => recipe.name === "poppler",
  ).nativeDependencies = ["not-in-the-lock"];
  assert.throws(
    () => validateRuntimeToolchainsLock(unresolvedNativeDependency), /invalid/u,
  );
});

test("LibreOffice recipes use locked target-native binary materialization", async () => {
  const lock = await readRuntimeToolchainsLock(toolchainsLockPath);
  for (const [target, toolchain] of Object.entries(lock.targets)) {
    const recipe = toolchain.nativeRecipes.find(
      (candidate) => candidate.name === "libreoffice",
    );
    assert.equal(recipe?.materialization, "prebuilt", target);
    assert.deepEqual(recipe?.commands, []);
    assert.deepEqual(recipe?.environment, {});
    if (target === "linux-x64") {
      assert.equal(recipe?.sourceComponent, "libreoffice-linux-x64");
      assert.equal(recipe?.sourceArchiveFormat, "tar.gz");
      assert.equal(
        recipe?.sourceDirectory,
        "LibreOffice_26.2.6.3_Linux_x86-64_deb/DEBS",
      );
      assert.equal(recipe?.toolchain.extraction, "dpkg-deb-readonly");
      assert.ok(toolchain.builder.tools.includes("dpkg-deb"));
      assert.deepEqual(recipe?.outputs, [
        {
          kind: "directory",
          source: "runtime-root/opt/libreoffice26.2",
          destination: "dependencies/native/libreoffice",
        },
      ]);
      continue;
    }
    if (target === "win32-x64") {
      assert.equal(recipe?.sourceComponent, "libreoffice-windows-x64");
      assert.equal(recipe?.sourceArchiveFormat, "msi");
      assert.ok(toolchain.builder.tools.includes("msiexec"));
      continue;
    }
    assert.equal(recipe?.sourceComponent, `libreoffice-${target}`);
    assert.equal(recipe?.sourceArchiveFormat, "dmg");
    assert.equal(recipe?.sourceDirectory, "LibreOffice.app");
    assert.ok(toolchain.builder.tools.includes("hdiutil"));
    assert.ok(toolchain.builder.tools.includes("xattr"));
    assert.ok(toolchain.builder.tools.includes("codesign"));
    assert.ok(toolchain.builder.tools.includes("file"));
    assert.equal(recipe?.toolchain.codeSigning, "ad-hoc-test-only");
    assert.deepEqual(recipe?.outputs, [
      {
        kind: "directory",
        source: "Contents",
        destination: "dependencies/native/libreoffice/LibreOffice.app/Contents",
      },
    ]);
    assert.deepEqual(recipe?.closure.entrypoints, [
      "dependencies/native/libreoffice/LibreOffice.app/Contents/MacOS/soffice",
    ]);
  }
});

test("Poppler source recipes use only locked zlib, Freetype, and libpng prefixes", async () => {
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
    "-DFONT_CONFIGURATION=generic",
  ];
  for (const [target, toolchain] of Object.entries(lock.targets)) {
    const zlib = toolchain.nativeRecipes.find(
      (candidate) => candidate.name === "zlib",
    );
    const freetype = toolchain.nativeRecipes.find(
      (candidate) => candidate.name === "freetype",
    );
    const libpng = toolchain.nativeRecipes.find(
      (candidate) => candidate.name === "libpng",
    );
    const recipe = toolchain.nativeRecipes.find(
      (candidate) => candidate.name === "poppler",
    );
    assert.equal(zlib?.materialization, "source-build", target);
    assert.equal(zlib?.sourceComponent, "zlib", target);
    assert.ok(
      zlib?.commands[0]?.includes("-DZLIB_BUILD_EXAMPLES=OFF"),
      `${target}: zlib examples must remain disabled`,
    );
    assert.equal(freetype?.materialization, "source-build", target);
    assert.equal(freetype?.sourceComponent, "freetype", target);
    for (const option of [
      "-DBUILD_SHARED_LIBS=OFF",
      "-DFT_DISABLE_ZLIB=TRUE",
      "-DFT_DISABLE_BZIP2=TRUE",
      "-DFT_DISABLE_PNG=TRUE",
      "-DFT_DISABLE_HARFBUZZ=TRUE",
      "-DFT_DISABLE_BROTLI=TRUE",
    ]) {
      assert.ok(freetype?.commands[0]?.includes(option), `${target}: ${option}`);
    }
    assert.equal(libpng?.materialization, "source-build", target);
    assert.equal(libpng?.sourceComponent, "libpng", target);
    assert.deepEqual(libpng?.nativeDependencies, ["zlib"], target);
    for (const option of [
      "-DPNG_SHARED=OFF",
      "-DPNG_STATIC=ON",
      "-DPNG_TESTS=OFF",
      "-DPNG_TOOLS=OFF",
    ]) {
      assert.ok(libpng?.commands[0]?.includes(option), `${target}: ${option}`);
    }
    assert.equal(recipe?.materialization, "source-build", target);
    assert.deepEqual(recipe?.nativeDependencies, ["zlib", "freetype", "libpng"], target);
    assert.ok(
      recipe?.commands[0]?.includes("-DZLIB_USE_STATIC_LIBS=TRUE"),
      `${target}: zlib must be linked from the locked static prefix`,
    );
    assert.ok(
      recipe?.commands[0]?.includes("-DENABLE_LIBPNG=ON"),
      `${target}: PNG output must be backed by the locked libpng prefix`,
    );
    for (const option of disabledOptions) {
      assert.ok(recipe?.toolchain.flags?.includes(option), `${target}: ${option}`);
      assert.ok(recipe?.commands[0]?.includes(option), `${target}: ${option}`);
    }
  }
});

test("native source dependency prefixes are injected only into CMake configure commands", async () => {
  const source = await readFile(materializeScript, "utf8");

  assert.match(source, /resolveNativeDependencyPrefixes/u);
  assert.match(source, /addLockedNativeDependencyPrefixes/u);
  assert.match(source, /-DCMAKE_FIND_USE_CMAKE_SYSTEM_PATH=FALSE/u);
  assert.match(source, /run\(resolveLockedBuilderCommand\(file\), commandArgs/u);
  assert.doesNotMatch(source, /(?:apt-get|brew)\s+(?:install|update)/u);
});

test("native dependency closure validates executable entrypoints without accepting host dependencies", async () => {
  const source = await readFile(verifyInputsScript, "utf8");

  assert.match(source, /dependency\.startsWith\("\/lib\/"\) \|\|\s+dependency\.startsWith\("\/lib64\/"\)/u);
  assert.match(source, /if \(header\.length < 4\) return false;/u);
  assert.match(source, /const nativeClosureEntrypoints = \[/u);
  assert.match(source, /entrypoints: nativeClosureEntrypoints/u);
  assert.match(source, /basename\(dependency\) === basename\(object\)/u);
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

test("Linux LibreOffice DEB extraction is offline and never installs into the runner", async () => {
  const source = await readFile(materializeScript, "utf8");

  assert.match(source, /recipe\.toolchain\.extraction !== "dpkg-deb-readonly"/u);
  assert.match(
    source,
    /resolveLockedBuilderCommand\("dpkg-deb"\),\s*\["--extract", join\(buildRoot, packageName\), runtimeRoot\]/u,
  );
  assert.doesNotMatch(source, /dpkg\s+--install|dpkg\s+-i/u);
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
  assert.match(source, /clearMacosQuarantine\(join\(output, "LibreOffice\.app"\)\)/u);
  assert.match(source, /xattr", \["-dr", "com\.apple\.quarantine", application\]/u);
  assert.match(source, /applyMacosAdHocSignature\(\{ recipe, outputRoot \}\)/u);
  assert.match(source, /await visit\(application, async \(path\) =>/u);
  assert.match(source, /const inspected = await run\(file, \["-b", path\]/u);
  assert.match(source, /\/\\bMach-O\\b\/u\.test\(inspected\.stdout\)/u);
  assert.match(source, /const codeTarget = macosCodeSignatureTarget\(application, path\)/u);
  assert.match(source, /if \(codeTarget\) codeTargets\.add\(codeTarget\)/u);
  assert.match(source, /function macosCodeSignatureTarget\(application, path\)/u);
  assert.match(source, /framework\|app\|appex\|xpc\|plugin\|bundle/u);
  assert.match(source, /isStandardMacosNestedCodeBundle\(application, candidate\)/u);
  assert.match(source, /"Contents\/Frameworks"/u);
  assert.match(source, /let hasNonStandardBundleAncestor = false/u);
  assert.match(source, /hasNonStandardBundleAncestor = true/u);
  assert.match(source, /hasNonStandardBundleAncestor \|\|/u);
  assert.match(source, /\/\\\.framework\$\/iu\.test\(basename\(path\)\)/u);
  assert.match(source, /\["--force", "--sign", "-", codeTarget\]/u);
  assert.match(source, /\["--force", "--sign", "-", application\]/u);
  assert.doesNotMatch(source, /\["--force", "--deep", "--sign", "-", application\]/u);
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
  assert.match(verifierSource, /runtimeUtilityPaths\(target\)/u);
  assert.match(verifierSource, /\["\/usr\/bin", "\/bin"\]/u);
  assert.match(verifierSource, /PYTHONDONTWRITEBYTECODE: "1"/u);
  assert.doesNotMatch(verifierSource, /create-smoke\.cjs|pptxgenjs-create-chinese-deck/u);
});

test("locked-source fetch streams Web response chunks without buffering an archive", async () => {
  const source = await readFile(fetchScript, "utf8");

  assert.match(source, /async function writeResponseBody/u);
  assert.match(source, /for await \(const chunk of body\)/u);
  assert.match(source, /await once\(output, "drain"\)/u);
  assert.match(source, /request as requestHttps/u);
  assert.match(source, /function requestLockedObject/u);
  assert.doesNotMatch(source, /\bfetch\(|Readable\.fromWeb|response\.arrayBuffer\(\)|await pipeline\(/u);
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
      /must use locked builder image|requires locked builder tool|cache is missing locked/u,
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
  const observedImage = expectedBuilderImageIdentity(
    toolchainsLock.targets[fixture.target].builder,
  );
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
