import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  assertApprovedSources,
  assertRepositoryPatchMatchesLock,
  canonicalFileManifest,
  sha256,
  validateRuntimeSourcesLock,
} from "../scripts/source-lock.mjs";
import {
  buildSyntheticRuntime,
  syntheticRuntimeTargets,
} from "../scripts/build-synthetic-runtime.mjs";
import { listStoredZipEntries } from "../scripts/zip-writer.mjs";
import {
  assertNativeRuntimeTarget,
  currentRuntimeTarget,
  parseRuntimeTargetOption,
} from "../scripts/runtime-target.mjs";
import {
  expectedBuilderImageIdentity,
  writeRuntimeInputsManifest,
} from "../scripts/runtime-inputs.mjs";

const executeFile = promisify(execFile);
const provenanceScript = resolve(
  import.meta.dirname,
  "../scripts/create-provenance.mjs",
);
const buildScript = resolve(import.meta.dirname, "../scripts/build-runtime.mjs");
const verifyScript = resolve(import.meta.dirname, "../scripts/verify-runtime.mjs");
const unpackMeasurementScript = resolve(
  import.meta.dirname,
  "../scripts/measure-runtime-unpack.mjs",
);
const sourceLockPath = resolve(import.meta.dirname, "../runtime-sources.lock.json");
const toolchainsLockPath = resolve(import.meta.dirname, "../runtime-toolchains.lock.json");
const releaseTargets = ["darwin-x64", "darwin-arm64", "win32-x64", "linux-x64"];

test("accepts only a complete, immutable approved Runtime source record", () => {
  const lock = validApprovedLock();
  assert.equal(assertApprovedSources(lock), lock);
});

test("rejects missing candidate provenance and every floating or placeholder value", () => {
  const lock = validApprovedLock();
  for (const invalid of [
    { ...lock, candidate: { ...lock.candidate, commit: "a".repeat(39) } },
    { ...lock, candidate: { ...lock.candidate, tag: "main" } },
    { ...lock, candidate: { ...lock.candidate, patch: { ...lock.candidate.patch, sha256: "TBD" } } },
    { ...lock, components: { ...lock.components, node: [{ ...lock.components.node[0], version: "^4.0.1" }] } },
    { ...lock, components: { ...lock.components, python: [{ ...lock.components.python[0], source: "https://token@example.test/wheel" }] } },
    { ...lock, components: { ...lock.components, fonts: [] } },
    { ...lock, candidate: { ...lock.candidate, unexpected: "mutable-claim" } },
  ]) {
    assert.throws(
      () => validateRuntimeSourcesLock(invalid),
      /invalid schema|invalid (node|python|fonts) components/u,
    );
  }
  assert.throws(
    () => validateRuntimeSourcesLock({ ...lock, accessToken: "must-not-persist" }),
    /invalid schema/u,
  );
});

test("requires every audited capability to cover every release target", () => {
  const lock = validApprovedLock();
  assert.throws(
    () =>
      assertApprovedSources({
        ...lock,
        components: {
          ...lock.components,
          native: [{ ...lock.components.native[0], platforms: ["darwin-x64"] }],
        },
      }),
    /native capability poppler does not cover every release target/u,
  );
});

test("accepts platform-specific immutable binaries when their capability coverage is complete", () => {
  const lock = validApprovedLock();
  const poppler = lock.components.native.find(
    (component) => component.name === "poppler",
  );
  assert.ok(poppler);
  poppler.capability = "poppler";
  poppler.platforms = ["darwin-x64", "darwin-arm64", "linux-x64"];
  lock.components.native.push({
    ...poppler,
    name: "poppler-windows-x64",
    platforms: ["win32-x64"],
  });
  assert.doesNotThrow(() => assertApprovedSources(lock));
});

test("provenance binds the exact approved source-lock bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-source-lock-"));
  const sourceLockPath = join(directory, "runtime-sources.lock.json");
  const patchPath = join(directory, "patches/presentation-skill-runtime-v0.8.0.patch");
  const patch = validRuntimePatch();
  const lock = validApprovedLock({
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  });
  const source = `${JSON.stringify(lock, null, 2)}\n`;
  try {
    await mkdir(join(directory, "patches"), { recursive: true });
    await writeFile(patchPath, patch);
    await writeFile(sourceLockPath, source);
    const { stdout } = await executeFile(process.execPath, [
      provenanceScript,
      "--lock",
      sourceLockPath,
    ]);
    const provenance = JSON.parse(stdout);
    assert.equal(
      provenance.sourceLockSha256,
      createHash("sha256").update(source).digest("hex"),
    );
    assert.equal(provenance.builderVersion, "1.1.0");
    assert.deepEqual(provenance.candidate, lock.candidate);
    assert.deepEqual(provenance.components, lock.components);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds the project patch file to the source lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-patch-lock-"));
  const sourceLockPath = join(directory, "runtime-sources.lock.json");
  const patchPath = join(directory, "patches/presentation-skill-runtime-v0.8.0.patch");
  const patch = validRuntimePatch();
  try {
    await mkdir(join(directory, "patches"), { recursive: true });
    await writeFile(patchPath, patch);
    await writeFile(
      sourceLockPath,
      `${JSON.stringify(
        validApprovedLock({ patchSha256: createHash("sha256").update(patch).digest("hex") }),
        null,
        2,
      )}\n`,
    );
    assert.deepEqual(
      await assertRepositoryPatchMatchesLock({
        lockPath: sourceLockPath,
        repositoryRoot: directory,
      }),
      {
        patchPath,
        patchSha256: createHash("sha256").update(patch).digest("hex"),
      },
    );
    await writeFile(patchPath, `${patch}\nmutated\n`);
    await assert.rejects(
      () =>
        assertRepositoryPatchMatchesLock({
          lockPath: sourceLockPath,
          repositoryRoot: directory,
        }),
      /patch digest mismatch/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects Runtime patch additions that restore host or icon-renderer fallbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-patch-boundary-"));
  const sourceLockPath = join(directory, "runtime-sources.lock.json");
  const patchPath = join(directory, "patches/presentation-skill-runtime-v0.8.0.patch");
  const patch = `${validRuntimePatch()}+const sharp = require('sharp');\n`;
  try {
    await mkdir(join(directory, "patches"), { recursive: true });
    await writeFile(patchPath, patch);
    await writeFile(
      sourceLockPath,
      `${JSON.stringify(
        validApprovedLock({ patchSha256: createHash("sha256").update(patch).digest("hex") }),
        null,
        2,
      )}\n`,
    );
    await assert.rejects(
      () =>
        assertRepositoryPatchMatchesLock({
          lockPath: sourceLockPath,
          repositoryRoot: directory,
        }),
      /restores a forbidden Runtime fallback/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical file manifests are deterministic and content-bound", () => {
  const manifest = canonicalFileManifest([
    { path: "b", mode: "0644", sha256: "b".repeat(64) },
    { path: "a", mode: "0755", sha256: "a".repeat(64) },
  ]);
  assert.equal(
    manifest,
    `0755\t${"a".repeat(64)}\ta\n0644\t${"b".repeat(64)}\tb\n`,
  );
  assert.match(sha256(manifest), /^[a-f0-9]{64}$/u);
});

test("binds a claimed build target to the native runner", () => {
  assert.equal(
    currentRuntimeTarget({ platform: "darwin", architecture: "arm64" }),
    "darwin-arm64",
  );
  assert.equal(parseRuntimeTargetOption(["--target=linux-x64"]), "linux-x64");
  assert.equal(parseRuntimeTargetOption(["--target", "win32-x64"]), "win32-x64");
  assert.equal(
    assertNativeRuntimeTarget("linux-x64", { platform: "linux", architecture: "x64" }),
    "linux-x64",
  );
  assert.throws(
    () => assertNativeRuntimeTarget("darwin-arm64", { platform: "linux", architecture: "x64" }),
    /cannot claim native verification/u,
  );
  assert.throws(
    () => currentRuntimeTarget({ platform: "freebsd", architecture: "x64" }),
    /not a supported native Runtime build target/u,
  );
  assert.throws(() => parseRuntimeTargetOption(["--target"]), /required after --target/u);
});

test("builds four explicit synthetic test-only Runtime archives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-synthetic-"));
  try {
    const metadata = await buildSyntheticRuntime({ outputRoot: directory });
    assert.equal(metadata.schemaVersion, "dascowork-primary-runtime-synthetic-build.v1");
    assert.equal(metadata.syntheticTestOnly, true);
    assert.equal(metadata.packageName, "@dascowork/test-artifact-tool");
    assert.equal(metadata.launcherEnvName, "DASCOWORK_SYNTHETIC_RUNTIME_HOST_NODE");
    assert.deepEqual(metadata.targets.map((entry) => entry.target).sort(), [...syntheticRuntimeTargets].sort());

    const metadataFile = JSON.parse(await readFile(join(directory, "synthetic-build-metadata.json"), "utf8"));
    assert.equal(metadataFile.sourceLockSha256, metadata.sourceLockSha256);

    for (const target of metadata.targets) {
      assert.match(target.archiveSha256, /^[a-f0-9]{64}$/u);
      assert.ok(target.archiveSizeBytes > 0);
      const archive = await readFile(target.archivePath);
      assert.equal(sha256(archive), target.archiveSha256);
      const archiveText = archive.toString("utf8");
      assert.doesNotMatch(archiveText, /@oai\/artifact-tool/u);
      assert.doesNotMatch(archiveText, /openai-primary-runtime/u);
      assert.doesNotMatch(archiveText, /reference-projects/u);
      assert.doesNotMatch(archiveText, /\/Users\/nallylin/u);
      const entries = listStoredZipEntries(archive);
      assert.deepEqual(entries, [...entries].sort((left, right) => left.localeCompare(right)));
      assert.ok(entries.includes("runtime.json"));
      assert.ok(entries.includes("dependencies/node/bin/node"));
      assert.ok(entries.includes("dependencies/node/node_modules/@dascowork/test-artifact-tool/package.json"));
      assert.ok(entries.includes("plugins/primary-runtime-test-plugin-bundle/.agents/plugins/marketplace.json"));
      assert.match(archiveText, /"path": "\.\/plugins\/dascowork-synthetic-presentations-plugin"/u);

      const runtimeManifest = JSON.parse(await readFile(target.runtimeManifestPath, "utf8"));
      assert.equal(runtimeManifest.syntheticTestOnly.requiredNodePackage, metadata.packageName);
      assert.equal(runtimeManifest.node.path, "dependencies/node/bin/node");
      assert.equal(runtimeManifest.nodePackages[0].name, metadata.packageName);

      const provenance = JSON.parse(await readFile(target.provenancePath, "utf8"));
      assert.equal(provenance.syntheticTestOnly, true);
      assert.equal(provenance.archiveSha256, target.archiveSha256);
      assert.equal(provenance.sourceLockSha256, metadata.sourceLockSha256);
      assert.equal(provenance.zipWriter.purpose, "synthetic-test-only");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsafe synthetic ZIP entry paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-zip-"));
  try {
    await assert.rejects(
      import("../scripts/zip-writer.mjs").then(({ writeStoredZipArchive }) =>
        writeStoredZipArchive(join(directory, "bad.zip"), [{ path: "../escape", data: "bad" }]),
      ),
      /Invalid ZIP entry path/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("builds and verifies a generic v2 Runtime archive from offline inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primary-runtime-build-"));
  const target = currentRuntimeTarget();
  const inputRoot = join(directory, "input");
  const outputRoot = join(directory, "dist");
  try {
    const validationPath = await createOfflineRuntimeInputs({ inputRoot, target });
    const { stdout: buildStdout } = await executeFile(process.execPath, [
      buildScript,
      "--target",
      target,
      "--input-root",
      inputRoot,
      "--output-root",
      outputRoot,
      "--version",
      "1.2.3-test",
      "--input-validation",
      validationPath,
    ]);
    const provenance = JSON.parse(buildStdout);
    assert.equal(provenance.target, target);
    assert.equal(provenance.bundleVersion, "1.2.3-test");
    const targetRoot = join(outputRoot, target);
    const [notices, sbom] = await Promise.all([
      readFile(join(targetRoot, "THIRD_PARTY_NOTICES.txt")),
      readFile(join(targetRoot, "SBOM.json")),
    ]);
    assert.equal(sha256(notices), provenance.noticesSha256);
    assert.equal(sha256(sbom), provenance.sbomSha256);
    const measurementPath = join(outputRoot, target, "build-unpack-measurement.json");
    const { stdout: measurementStdout } = await executeFile(process.execPath, [
      unpackMeasurementScript,
      "--target",
      target,
      "--archive",
      join(outputRoot, target, "primary-runtime.zip"),
      "--provenance",
      join(outputRoot, target, "provenance.json"),
      "--output",
      measurementPath,
    ]);
    const measurement = JSON.parse(measurementStdout);
    assert.equal(measurement.target, target);
    assert.equal(measurement.archiveSha256, provenance.archiveSha256);
    assert.ok(measurement.unpackedBytes > 0);
    assert.ok(measurement.entryCount > 0);
    assert.equal(measurement.productionTrust, false);

    const { stdout: verifyStdout } = await executeFile(process.execPath, [
      verifyScript,
      "--target",
      target,
      "--output-root",
      outputRoot,
    ]);
    const verified = JSON.parse(verifyStdout);
    assert.equal(verified.status, "verified");
    assert.equal(verified.archiveSha256, provenance.archiveSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function validApprovedLock({ patchSha256 = "e".repeat(64) } = {}) {
  return {
    schemaVersion: "dascowork-primary-runtime-sources.v2",
    builderVersion: "1.1.0",
    candidate: {
      name: "siril9/presentation-skill",
      repository: "https://github.com/siril9/presentation-skill",
      publisher: { githubAccount: "siril9", commitAuthor: "Siril Sengolraj" },
      tag: "v0.8.0",
      commit: "a".repeat(40),
      sourceArchive: { url: "https://github.com/siril9/presentation-skill/archive/refs/tags/v0.8.0.tar.gz", sha256: "b".repeat(64) },
      pluginDirectory: { path: "plugins/presentation-skill", fileCount: 1, treeSha256: "c".repeat(64) },
      license: { spdx: "MIT", path: "LICENSE", sha256: "d".repeat(64) },
      patch: { path: "patches/presentation-skill-runtime-v0.8.0.patch", sha256: patchSha256 },
      runtimeScope: { entryPoints: ["scripts/build_deck_pptxgenjs.js"], nodeDependencyClosure: ["pptxgenjs@4.0.1"], excludedCapabilities: ["existing-pptx-editing"] },
    },
    rejectedCandidates: [{ tag: "v0.11.0", commit: "f".repeat(40), sourceArchiveSha256: "0".repeat(64), status: "candidate_rejected", reason: "Pinned dependency is not published." }],
    components: {
      node: [component("pptxgenjs", "4.0.1")],
      python: [component("python-pptx", "1.0.2")],
      native: [component("poppler", "26.09.0")],
      fonts: [component("noto-sans-cjk-sc", "2.004")],
    },
  };
}

function component(name, version) {
  return {
    name,
    version,
    source: `https://example.test/${name}-${version}.tar.gz`,
    sha256: "1".repeat(64),
    license: "MIT",
    platforms: releaseTargets,
  };
}

function validRuntimePatch() {
  return [
    "diff --git a/plugins/presentation-skill/skills/presentation-skill/SKILL.md b/plugins/presentation-skill/skills/presentation-skill/SKILL.md",
    "+++ b/plugins/presentation-skill/skills/presentation-skill/SKILL.md",
    "+This Runtime-owned distribution is restricted to creating a new PPTX.",
    "+Before running a deck command, call `load_workspace_dependencies`.",
    "+Do not run `npm`, `npx`, `pip`, `uv`, `conda`, a bootstrap/setup script, or create a virtual environment.",
    "+Never call a model HTTP endpoint, read a model API key, download an image, scrape a URL, or make another network request.",
    "+Missing Runtime paths are terminal for this operation; no host fallback or online install is permitted.",
    "+Existing PPTX inspection, editing, redesign, or round-trip workflows.",
    "",
  ].join("\n");
}

async function createOfflineRuntimeInputs({ inputRoot, target }) {
  const [platform] = target.split("-");
  const nodePath =
    platform === "win32"
      ? "dependencies/node/bin/node.exe"
      : "dependencies/node/bin/node";
  const pythonPath =
    platform === "win32"
      ? "dependencies/python/python.exe"
      : "dependencies/python/bin/python";
  await writeExecutable(join(inputRoot, nodePath), "#!/bin/sh\nexit 0\n");
  await writeExecutable(join(inputRoot, pythonPath), "#!/bin/sh\nexit 0\n");
  const extension = platform === "win32" ? ".exe" : "";
  const sofficePath = target.startsWith("darwin")
    ? "dependencies/native/libreoffice/LibreOffice.app/Contents/MacOS/soffice"
    : "dependencies/native/libreoffice/program/soffice";
  for (const [, path] of [
    ["soffice", sofficePath],
    ["pdfinfo", "dependencies/native/poppler/bin/pdfinfo"],
    ["pdftoppm", "dependencies/native/poppler/bin/pdftoppm"],
  ]) {
    await writeExecutable(
      join(inputRoot, `${path}${extension}`),
      "#!/bin/sh\nexit 0\n",
    );
  }

  const lock = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../runtime-sources.lock.json"), "utf8"),
  );
  for (const component of lock.components.node) {
    await writeJson(join(inputRoot, "dependencies/node/node_modules", component.name, "package.json"), {
      name: component.name,
      version: component.version,
      type: "module",
      main: "index.js",
    });
    await writeFileEnsured(
      join(inputRoot, "dependencies/node/node_modules", component.name, "index.js"),
      "export {};\n",
    );
  }
  for (const component of lock.components.python) {
    await writeFileEnsured(
      join(inputRoot, "dependencies/python/packages", component.name, "METADATA"),
      `Name: ${component.name}\nVersion: ${component.version}\n`,
    );
  }

  const skill = [
    "---",
    "name: presentation-skill",
    "description: Runtime-owned presentation skill test fixture.",
    "---",
    "",
    "Create new PPTX files only.",
    "",
  ].join("\n");
  const pluginRoot = join(inputRoot, "plugins/presentation-skill");
  await writeJson(join(pluginRoot, ".agents/plugins/marketplace.json"), {
    name: "presentation-skill",
    plugins: [
      {
        name: "presentation-skill",
        source: { source: "local", path: "./plugins/presentation-skill" },
      },
    ],
  });
  await writeJson(join(pluginRoot, "bundle-lock.json"), {
    bundleFormatVersion: 2,
    marketplace: { name: "presentation-skill", pluginRoot: "plugins" },
    plugins: [
      {
        name: "presentation-skill",
        version: lock.candidate.tag,
        installWhenMissing: true,
        internal: true,
        provenance: {
          kind: "repo-owned",
          sourcePath: "desktop-app/resources/bundled-plugins/presentation-skill",
          licensePath: "LICENSE",
          reviewStatus: "approved",
        },
        files: [
          {
            path: "skills/presentation-skill/SKILL.md",
            sha256: sha256(skill),
          },
        ],
      },
    ],
  });
  await writeJson(
    join(pluginRoot, "plugins/presentation-skill/.codex-plugin/plugin.json"),
    {
      name: "presentation-skill",
      version: lock.candidate.tag,
      description: "Runtime-owned presentation skill.",
    },
  );
  await writeFileEnsured(
    join(pluginRoot, "plugins/presentation-skill/skills/presentation-skill/SKILL.md"),
    skill,
  );
  await writeFileEnsured(join(inputRoot, "fonts/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf"), "OTTOfixture\n");
  const toolchainsLock = JSON.parse(await readFile(toolchainsLockPath, "utf8"));
  const targetToolchain = toolchainsLock.targets[target];
  const observedImage = expectedBuilderImageIdentity(targetToolchain.builder);
  await writeRuntimeInputsManifest({
    inputRoot,
    target,
    sourceLockPath,
    toolchainsLockPath,
    artifacts: (await import("../scripts/runtime-inputs.mjs")).artifactsForTarget({
      sourceLock: lock,
      toolchainsLock,
      target,
    }),
    patches: [{ path: lock.candidate.patch.path, sha256: lock.candidate.patch.sha256 }],
    builder: {
      name: "@dascowork/primary-runtime-materializer",
      version: "1.0.0",
      runner: targetToolchain.runner,
      identity: targetToolchain.builder.identity,
      observedImage,
      observedImageSha256: sha256(observedImage),
      tools: targetToolchain.builder.tools.map((command) => ({
        command,
        versionSha256: "a".repeat(64),
      })),
    },
  });
  const validationPath = join(resolve(inputRoot, ".."), "component-smoke.json");
  await writeFile(
    validationPath,
    `${JSON.stringify(
      {
        schemaVersion: "dascowork-primary-runtime-input-validation.v1",
        status: "verified",
        target,
        inputManifestSha256: sha256(await readFile(join(inputRoot, "runtime-inputs.manifest.json"))),
        commands: [{ name: "fixture", resultSha256: "f".repeat(64) }],
        productionTrust: false,
      },
      null,
      2,
    )}\n`,
  );
  return validationPath;
}

async function writeExecutable(path, value) {
  await writeFileEnsured(path, value, { mode: 0o755 });
}

async function writeJson(path, value) {
  await writeFileEnsured(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileEnsured(path, value, options = undefined) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, value, options);
}
