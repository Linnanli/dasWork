#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalFileManifest, sha256 } from "./source-lock.mjs";
import { writeStoredZipArchive } from "./zip-writer.mjs";

export const syntheticRuntimeTargets = [
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
];

const schemaVersion = "dascowork-primary-runtime-synthetic-build.v1";
const sourceLockSchemaVersion =
  "dascowork-primary-runtime-synthetic-sources.v1";
const provenanceSchemaVersion = "dascowork-primary-runtime-provenance.v1";
const packageName = "@dascowork/test-artifact-tool";
const packageVersion = "0.0.0-synthetic.1";
const pluginBundleName = "primary-runtime-test-plugin-bundle";
const launcherEnvName = "DASCOWORK_SYNTHETIC_RUNTIME_HOST_NODE";
const defaultVersion = "0.0.0-synthetic.1";

export async function buildSyntheticRuntime(options) {
  const outputRoot = resolveRequiredOutput(options?.outputRoot);
  const version = options?.version ?? defaultVersion;
  await mkdir(outputRoot, { recursive: true });

  const sourceLock = syntheticSourceLock();
  const sourceLockBytes = `${JSON.stringify(sourceLock, null, 2)}\n`;
  const sourceLockSha256 = sha256(sourceLockBytes);
  await writeJson(join(outputRoot, "synthetic-source-lock.json"), sourceLock);

  const targets = [];
  for (const target of syntheticRuntimeTargets) {
    const targetRoot = join(outputRoot, "targets", target);
    await mkdir(targetRoot, { recursive: true });
    const entries = syntheticRuntimeEntries({ target, version });
    const runtimeManifest = JSON.parse(entryText(entries, "runtime.json"));
    const fileManifest = canonicalFileManifest(
      entries.map((entry) => ({
        path: entry.path,
        mode: (entry.mode ?? 0o100644).toString(8).padStart(6, "0"),
        sha256: sha256(entry.data),
      })),
    );
    const archivePath = join(targetRoot, "primary-runtime.zip");
    await writeStoredZipArchive(archivePath, entries);
    const archive = await readFile(archivePath);
    const archiveDetails = await stat(archivePath);
    const runtimeManifestSha256 = sha256(entryText(entries, "runtime.json"));
    const provenance = {
      schemaVersion: provenanceSchemaVersion,
      syntheticTestOnly: true,
      target,
      version,
      archiveSha256: sha256(archive),
      archiveSizeBytes: archiveDetails.size,
      sourceLockSha256,
      runtimeManifestSha256,
      canonicalFileManifestSha256: sha256(fileManifest),
      componentSmokeReportSha256: sha256(
        `synthetic-smoke:${target}:${version}\n`,
      ),
      platformTrustReportSha256: sha256(
        `synthetic-platform-trust:${target}:${version}\n`,
      ),
      syntheticInputs: sourceLock.inputs,
      zipWriter: {
        name: "@dascowork/primary-runtime-builder/store-only-zip-writer",
        version: "1.0.0",
        purpose: "synthetic-test-only",
      },
    };
    await writeJson(join(targetRoot, "runtime.json"), runtimeManifest);
    await writeFile(
      join(targetRoot, "canonical-file-manifest.txt"),
      fileManifest,
      {
        mode: 0o600,
      },
    );
    await writeJson(join(targetRoot, "provenance.json"), provenance);
    targets.push({
      target,
      platform: runtimeManifest.target.platform,
      arch: runtimeManifest.target.arch,
      targetRoot,
      archivePath,
      archiveSizeBytes: archiveDetails.size,
      archiveSha256: provenance.archiveSha256,
      provenancePath: join(targetRoot, "provenance.json"),
      runtimeManifestPath: join(targetRoot, "runtime.json"),
      runtimeManifestSha256,
    });
  }

  const metadata = {
    schemaVersion,
    syntheticTestOnly: true,
    version,
    packageName,
    packageVersion,
    pluginBundleName,
    launcherEnvName,
    outputRoot,
    sourceLockPath: join(outputRoot, "synthetic-source-lock.json"),
    sourceLockSha256,
    targets,
  };
  await writeJson(join(outputRoot, "synthetic-build-metadata.json"), metadata);
  return metadata;
}

function syntheticRuntimeEntries({ target, version }) {
  const [platform, arch] = target.split("-");
  const runtimeManifest = {
    bundleFormatVersion: 1,
    bundleVersion: `${version}+${target}`,
    target: { platform, arch },
    node: {
      path: "dependencies/node/bin/node",
      version: `synthetic-host-node:${launcherEnvName}`,
    },
    nodePackages: [
      {
        name: packageName,
        version: packageVersion,
        path: "dependencies/node/node_modules/@dascowork/test-artifact-tool",
      },
    ],
    bundledPlugins: [
      {
        marketplace: pluginBundleName,
        path: `plugins/${pluginBundleName}`,
      },
    ],
    syntheticTestOnly: {
      kind: "dascowork-primary-runtime-synthetic-test.v1",
      requiredNodePackage: packageName,
    },
  };
  const pluginManifest = {
    // Codex plugin identifiers are intentionally unscoped. This is a
    // repository-owned test marker, not an npm package name.
    name: "dascowork-synthetic-presentations-plugin",
    version: packageVersion,
    description:
      "Synthetic test-only Presentations plugin for Primary Runtime Feed E2E.",
  };
  const marketplace = {
    name: pluginBundleName,
    plugins: [
      {
        name: pluginManifest.name,
        source: {
          source: "local",
          // The Codex plugin marketplace resolves local sources from its own
          // directory, so retain the explicit relative-path marker used by
          // the app-owned bundled marketplace.
          path: "./plugins/dascowork-synthetic-presentations-plugin",
        },
      },
    ],
  };
  const pluginFileSha = sha256(syntheticPluginSkill());
  const bundleLock = {
    bundleFormatVersion: 2,
    marketplace: {
      name: pluginBundleName,
      pluginRoot: "plugins",
    },
    plugins: [
      {
        name: pluginManifest.name,
        version: packageVersion,
        installWhenMissing: true,
        internal: true,
        provenance: {
          kind: "repo-owned",
          sourcePath:
            "desktop-app/resources/bundled-plugins/synthetic-test-only",
          licensePath: "LICENSE",
          reviewStatus: "pending-independent-review",
        },
        files: [
          {
            path: "skills/presentations/SKILL.md",
            sha256: pluginFileSha,
          },
        ],
      },
    ],
  };

  return [
    textEntry("runtime.json", runtimeManifest),
    {
      path: "dependencies/node/bin/node",
      mode: 0o100755,
      data: syntheticNodeLauncher(),
    },
    textEntry(
      "dependencies/node/node_modules/@dascowork/test-artifact-tool/package.json",
      {
        name: packageName,
        version: packageVersion,
        type: "module",
        main: "./index.js",
        bin: {
          "test-artifact-tool": "./cli.js",
        },
        private: true,
        license: "UNLICENSED",
      },
    ),
    {
      path: "dependencies/node/node_modules/@dascowork/test-artifact-tool/index.js",
      data: [
        `export const syntheticTestOnly = true;`,
        `export const version = ${JSON.stringify(packageVersion)};`,
        `export function identify() {`,
        `  return { name: ${JSON.stringify(packageName)}, version, syntheticTestOnly };`,
        `}`,
        "",
      ].join("\n"),
    },
    {
      path: "dependencies/node/node_modules/@dascowork/test-artifact-tool/cli.js",
      mode: 0o100755,
      data: [
        "#!/usr/bin/env node",
        "import { identify } from './index.js';",
        "process.stdout.write(JSON.stringify(identify()));",
        "",
      ].join("\n"),
    },
    textEntry(
      `plugins/${pluginBundleName}/.agents/plugins/marketplace.json`,
      marketplace,
    ),
    textEntry(`plugins/${pluginBundleName}/bundle-lock.json`, bundleLock),
    textEntry(
      `plugins/${pluginBundleName}/plugins/dascowork-synthetic-presentations-plugin/.codex-plugin/plugin.json`,
      pluginManifest,
    ),
    {
      path: `plugins/${pluginBundleName}/plugins/dascowork-synthetic-presentations-plugin/skills/presentations/SKILL.md`,
      data: syntheticPluginSkill(),
    },
  ];
}

function syntheticSourceLock() {
  return {
    schemaVersion: sourceLockSchemaVersion,
    builderVersion: "1.0.0-synthetic",
    inputs: [
      {
        name: packageName,
        version: packageVersion,
        source: "repo://primary-runtime/scripts/build-synthetic-runtime.mjs",
        licenseOrAuthorizationRecord:
          "TEST-ONLY-PRIMARY-RUNTIME-SYNTHETIC-2026-09-10",
        platforms: syntheticRuntimeTargets,
        sourceSha256: syntheticSourceSha256("package"),
        authorization: "approved",
      },
      {
        name: pluginBundleName,
        version: packageVersion,
        source: "repo://primary-runtime/scripts/build-synthetic-runtime.mjs",
        licenseOrAuthorizationRecord:
          "TEST-ONLY-PRIMARY-RUNTIME-SYNTHETIC-2026-09-10",
        platforms: syntheticRuntimeTargets,
        sourceSha256: syntheticSourceSha256("plugin"),
        authorization: "approved",
      },
    ],
  };
}

function syntheticSourceSha256(label) {
  return createHash("sha256")
    .update(`dascowork:${label}:${packageVersion}:synthetic-test-only\n`)
    .digest("hex");
}

function syntheticNodeLauncher() {
  return [
    "#!/bin/sh",
    `if [ -z "\${${launcherEnvName}:-}" ]; then`,
    `  echo "${launcherEnvName} is required for the synthetic Primary Runtime test launcher." >&2`,
    "  exit 90",
    "fi",
    `exec "\${${launcherEnvName}}" "$@"`,
    "",
  ].join("\n");
}

function syntheticPluginSkill() {
  return [
    "---",
    "name: presentations",
    "description: Synthetic test-only Presentations skill marker for Primary Runtime Feed E2E.",
    "---",
    "",
    "This skill is a repository-owned synthetic marker used only by the Primary Runtime Feed E2E lane.",
    "It must not be used as evidence for real PowerPoint generation or real artifact-tool availability.",
    "",
  ].join("\n");
}

function textEntry(path, value) {
  return {
    path,
    data: `${JSON.stringify(value, null, 2)}\n`,
  };
}

function entryText(entries, path) {
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`Missing synthetic runtime entry: ${path}`);
  return Buffer.from(entry.data).toString("utf8");
}

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function resolveRequiredOutput(outputRoot) {
  if (typeof outputRoot !== "string" || outputRoot.trim().length === 0) {
    throw new Error("--output <absolute path> is required.");
  }
  const resolved = resolve(outputRoot);
  if (!isAbsolute(resolved))
    throw new Error("--output must resolve to an absolute path.");
  return resolved;
}

function parseArgs(argv) {
  const outputIndex = argv.indexOf("--output");
  const versionIndex = argv.indexOf("--version");
  if (outputIndex < 0 || !argv[outputIndex + 1]) {
    throw new Error("Expected --output <absolute path>.");
  }
  return {
    outputRoot: argv[outputIndex + 1],
    version: versionIndex >= 0 ? argv[versionIndex + 1] : defaultVersion,
  };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const metadata = await buildSyntheticRuntime(
    parseArgs(process.argv.slice(2)),
  );
  console.info(JSON.stringify(metadata, null, 2));
}
