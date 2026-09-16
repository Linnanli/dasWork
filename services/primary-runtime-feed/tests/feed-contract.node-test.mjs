import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  CONFIG_PATH,
  canonicalSignedPayload,
  readPublishedRuntimeFeedAsset,
  publishRepository,
  runtimeFeedPathForRequest,
  signFeedMetadata,
  validateReleaseTree,
} from "../src/repository.mjs";
import { assembleReleaseStaging } from "../scripts/assemble-release-staging.mjs";
import {
  isAllowedRequestHost,
  normalizeAllowedRequestHosts,
} from "../src/server.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

test("maps only the versioned config, manifest, and immutable archive layout", () => {
  assert.equal(runtimeFeedPathForRequest(CONFIG_PATH), "config.json");
  assert.equal(
    runtimeFeedPathForRequest("/v1/runtime/channels/stable/manifest.json"),
    "channels/stable/manifest.json",
  );
  assert.equal(
    runtimeFeedPathForRequest(
      "/v1/runtime/archives/2026.09.10/darwin-arm64/primary-runtime.zip",
    ),
    "archives/2026.09.10/darwin-arm64/primary-runtime.zip",
  );
  assert.equal(
    runtimeFeedPathForRequest(
      "/v1/runtime/archives/2026.09.10/win32-x64/primary-runtime.zip",
    ),
    "archives/2026.09.10/win32-x64/primary-runtime.zip",
  );
  assert.equal(
    runtimeFeedPathForRequest("/v1/runtime/archives/../secret"),
    null,
  );
  assert.equal(runtimeFeedPathForRequest("/v1/runtime/upload"), null);
});

test("serves metadata and archives with exact size, ETag, and immutable archive caching", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-feed-"));
  try {
    await mkdir(join(root, "archives", "2026.09.10", "darwin-arm64"), {
      recursive: true,
    });
    await writeFile(join(root, "config.json"), '{"signature":"x"}\n');
    await writeFile(
      join(
        root,
        "archives",
        "2026.09.10",
        "darwin-arm64",
        "primary-runtime.zip",
      ),
      "zip",
    );
    const metadata = await readPublishedRuntimeFeedAsset(root, CONFIG_PATH);
    const archive = await readPublishedRuntimeFeedAsset(
      root,
      "/v1/runtime/archives/2026.09.10/darwin-arm64/primary-runtime.zip",
    );
    assert.equal(metadata.cacheControl, "no-cache");
    assert.equal(archive.cacheControl, "public, max-age=31536000, immutable");
    assert.equal(archive.size, 3);
    assert.match(archive.etag, /^"[a-f0-9]{64}"$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses non-regular published assets before serving or validating them", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "primary-runtime-feed-nonregular-"),
  );
  try {
    await mkdir(join(root, "config.json"));
    await assert.rejects(
      readPublishedRuntimeFeedAsset(root, CONFIG_PATH),
      /non-regular/u,
    );

    await rm(join(root, "config.json"), { recursive: true, force: true });
    const verification = await writeReleaseTree(root);
    const archivePath = join(
      root,
      "archives",
      "2026.09.10",
      "darwin-arm64",
      "primary-runtime.zip",
    );
    await rm(archivePath);
    await mkdir(archivePath);
    await assert.rejects(
      validateReleaseTree(root, verification),
      /archive size/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical signed payload removes only the signature and has stable key order", () => {
  assert.equal(
    canonicalSignedPayload({ z: 1, signature: "x", a: { b: true } }),
    '{"a":{"b":true},"z":1}',
  );
});

test("P7 feed signing CLI package scripts are registered and callable", async () => {
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["sign:config"],
    "node scripts/sign-config.mjs",
  );
  assert.equal(
    packageJson.scripts["sign:manifest"],
    "node scripts/sign-manifest.mjs",
  );

  const root = await mkdtemp(join(tmpdir(), "primary-runtime-feed-cli-"));
  try {
    const signing = generateKeyPairSync("ed25519");
    const keyPath = join(root, "private-key.pem");
    await writeFile(
      keyPath,
      signing.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );

    for (const [script, label] of [
      ["sign:config", "config"],
      ["sign:manifest", "manifest"],
    ]) {
      const input = join(root, `${label}.unsigned.json`);
      const output = join(root, `${label}.json`);
      await writeFile(
        input,
        `${JSON.stringify({
          schemaVersion: 1,
          sequence: 1,
          keyId: `${label}-test`,
        })}\n`,
      );
      await execFileAsync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        [
          "run",
          script,
          "--",
          "--key",
          keyPath,
          "--input",
          input,
          "--output",
          output,
        ],
        { cwd: packageRoot, timeout: 10_000 },
      );
      const signed = JSON.parse(await readFile(output, "utf8"));
      assert.equal(signed.keyId, `${label}-test`);
      assert.match(signed.signature, /^[A-Za-z0-9+/]+={0,2}$/u);
      assert.equal(
        signed.signature.length > 40,
        true,
        `${script} should write a real signature`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts only the configured HTTPS Host header", () => {
  const hosts = normalizeAllowedRequestHosts([
    "Feed.Example.Test:9443",
    "[::1]:9443",
  ]);
  assert.deepEqual(hosts, ["feed.example.test:9443", "[::1]:9443"]);
  assert.equal(isAllowedRequestHost("feed.example.test:9443", hosts), true);
  assert.equal(isAllowedRequestHost("[::1]:9443", hosts), true);
  assert.equal(isAllowedRequestHost("feed.example.test", hosts), false);
  assert.equal(isAllowedRequestHost("evil.example.test:9443", hosts), false);
  assert.equal(isAllowedRequestHost(undefined, hosts), false);
  assert.throws(
    () => normalizeAllowedRequestHosts(["https://feed.example.test"]),
    /request host is invalid/u,
  );
});

test("publishing rejects an incomplete matrix or archive/provenance mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-feed-release-"));
  try {
    let verification = await writeReleaseTree(root);
    await assert.doesNotReject(validateReleaseTree(root, verification));

    await writeFile(
      join(
        root,
        "archives",
        "2026.09.10",
        "darwin-arm64",
        "primary-runtime.zip",
      ),
      "tampered",
    );
    await assert.rejects(
      validateReleaseTree(root, verification),
      /(?:size|SHA256)/u,
    );

    verification = await writeReleaseTree(root);
    const manifestPath = join(root, "channels", "stable", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.releases.pop();
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      validateReleaseTree(root, verification),
      /complete matrix/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P1a calibration candidates require the explicit local calibration-only allowance", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "primary-runtime-feed-calibration-"),
  );
  try {
    const verification = await writeReleaseTree(root, {
      calibrationCandidateTarget: "darwin-arm64",
    });
    await assert.rejects(
      validateReleaseTree(root, verification),
      /complete matrix/u,
    );
    await assert.doesNotReject(
      validateReleaseTree(root, {
        ...verification,
        allowCalibrationCandidate: true,
      }),
    );
    const provenancePath = join(
      root,
      "archives",
      "2026.09.10",
      "darwin-arm64",
      "provenance.json",
    );
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.releaseClass = "engineering-final-candidate";
    await writeFile(provenancePath, JSON.stringify(provenance));
    await assert.rejects(
      validateReleaseTree(root, {
        ...verification,
        allowCalibrationCandidate: true,
      }),
      /not a P1a calibration candidate/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishing serves its current pointer after realpath normalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-feed-published-"));
  const staged = join(root, "staged");
  try {
    const verification = await writeReleaseTree(staged);
    await publishRepository({
      repositoryRoot: root,
      stagedRoot: staged,
      ...verification,
    });
    const config = await readPublishedRuntimeFeedAsset(root, CONFIG_PATH);
    assert.equal(config.contentType, "application/json; charset=utf-8");
    const archive = await readPublishedRuntimeFeedAsset(
      root,
      "/v1/runtime/archives/2026.09.10/darwin-arm64/primary-runtime.zip",
    );
    assert.equal(archive.size, Buffer.byteLength("archive:darwin-arm64"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assembles only the signed metadata and four independently verified targets", async () => {
  const source = await mkdtemp(join(tmpdir(), "primary-runtime-feed-source-"));
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-feed-staging-"));
  const output = join(root, "staging");
  try {
    const verification = await writeReleaseTree(source);
    const metadata = await copyMetadata(source, root);
    const targetRoots = await copyTargetRoots(source, root);
    await assert.doesNotReject(
      assembleReleaseStaging({
        outputRoot: output,
        metadataRoot: metadata,
        targetRoots,
        ...verification,
      }),
    );
    await assert.doesNotReject(validateReleaseTree(output, verification));
    await assert.rejects(
      assembleReleaseStaging({
        outputRoot: join(root, "missing-target"),
        metadataRoot: metadata,
        targetRoots: { "darwin-x64": targetRoots["darwin-x64"] },
        ...verification,
      }),
      /include exactly the release matrix/u,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects structurally valid metadata when the matching role key cannot verify it", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-feed-signature-"));
  try {
    const verification = await writeReleaseTree(root);
    const configPath = join(root, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.signature = "c2lnbmF0dXJlLXRhbXBlcmVk";
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    await assert.rejects(
      validateReleaseTree(root, verification),
      /config signature is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeReleaseTree(root, { calibrationCandidateTarget } = {}) {
  const version = "2026.09.10";
  const now = new Date();
  const issuedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const configSigning = generateKeyPairSync("ed25519");
  const manifestSigning = generateKeyPairSync("ed25519");
  const targets = calibrationCandidateTarget
    ? [calibrationCandidateTarget]
    : ["darwin-x64", "darwin-arm64", "win32-x64", "linux-x64"];
  const releases = [];
  for (const target of targets) {
    const [platform, arch] = target.split("-");
    const directory = join(root, "archives", version, target);
    const archive = Buffer.from(`archive:${target}`, "utf8");
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "primary-runtime.zip"), archive);
    const evidence = Object.fromEntries(
      [
        "sourceLockSha256",
        "toolchainsLockSha256",
        "inputManifestSha256",
        "inputFileManifestSha256",
        "hardLimitsSha256",
        "runtimeManifestSha256",
        "canonicalFileManifestSha256",
        "sbomSha256",
        "noticesSha256",
        "componentSmokeSha256",
        "patchSha256",
        "reviewedBudgetSha256",
        "performanceReportSha256",
      ].map((key, index) => [
        key,
        String(index + 10)
          .repeat(64)
          .slice(0, 64),
      ]),
    );
    await writeFile(
      join(directory, "provenance.json"),
      JSON.stringify({
        schemaVersion: "dascowork-primary-runtime-provenance.v1",
        target,
        bundleVersion: version,
        archiveSha256,
        archiveSizeBytes: archive.byteLength,
        releaseClass: calibrationCandidateTarget
          ? "engineering-candidate"
          : "engineering-final-candidate",
        productionTrust: false,
        ...evidence,
        builderIdentity: { name: "test-builder", runner: "test-runner" },
      }),
    );
    for (const name of engineeringEvidenceFiles()) {
      await writeFile(join(directory, name), `${name}:${target}\n`);
    }
    releases.push({
      platform,
      arch,
      version,
      archiveFormat: "zip",
      archiveUrl: `https://feed.example.test/v1/runtime/archives/${version}/${target}/primary-runtime.zip`,
      archiveSizeBytes: archive.byteLength,
      archiveSha256,
      budget: releaseBudget(),
    });
  }
  await mkdir(join(root, "channels", "stable"), { recursive: true });
  await writeFile(
    join(root, "config.json"),
    JSON.stringify(
      signFeedMetadata(
        {
          schemaVersion: 1,
          sequence: 3,
          channel: "stable",
          manifestUrl:
            "https://feed.example.test/v1/runtime/channels/stable/manifest.json",
          pollIntervalMs: 30_000,
          issuedAt,
          expiresAt,
          keyId: "config-test",
        },
        configSigning.privateKey,
      ),
    ),
  );
  await writeFile(
    join(root, "channels", "stable", "manifest.json"),
    JSON.stringify(
      signFeedMetadata(
        {
          schemaVersion: 1,
          sequence: 4,
          channel: "stable",
          issuedAt,
          expiresAt,
          keyId: "manifest-test",
          releases,
        },
        manifestSigning.privateKey,
      ),
    ),
  );
  return {
    configPublicKeys: {
      "config-test": configSigning.publicKey.export({
        type: "spki",
        format: "pem",
      }),
    },
    manifestPublicKeys: {
      "manifest-test": manifestSigning.publicKey.export({
        type: "spki",
        format: "pem",
      }),
    },
  };
}

function releaseBudget() {
  return {
    maxArchiveBytes: 1000,
    maxUnpackedBytes: 2000,
    minimumFreeDiskBytes: 5750,
    maxColdInstallMs: 1000,
    maxMainEventLoopDelayP99Ms: 50,
    maxMainEventLoopDelayMaxMs: 250,
  };
}

async function copyMetadata(source, root) {
  const metadata = join(root, "metadata");
  await mkdir(join(metadata, "channels", "stable"), { recursive: true });
  await copyFile(join(source, "config.json"), join(metadata, "config.json"));
  await copyFile(
    join(source, "channels", "stable", "manifest.json"),
    join(metadata, "channels", "stable", "manifest.json"),
  );
  return metadata;
}

async function copyTargetRoots(source, root) {
  const targets = ["darwin-x64", "darwin-arm64", "win32-x64", "linux-x64"];
  const roots = Object.create(null);
  for (const target of targets) {
    const targetRoot = join(root, "targets", target);
    await mkdir(targetRoot, { recursive: true });
    await copyFile(
      join(source, "archives", "2026.09.10", target, "primary-runtime.zip"),
      join(targetRoot, "primary-runtime.zip"),
    );
    await copyFile(
      join(source, "archives", "2026.09.10", target, "provenance.json"),
      join(targetRoot, "provenance.json"),
    );
    for (const name of engineeringEvidenceFiles()) {
      await copyFile(
        join(source, "archives", "2026.09.10", target, name),
        join(targetRoot, name),
      );
    }
    roots[target] = targetRoot;
  }
  return roots;
}

function engineeringEvidenceFiles() {
  return [
    "runtime.json",
    "canonical-file-manifest.txt",
    "component-smoke.json",
    "build-unpack-measurement.json",
    "platform-validation.json",
    "runtime-inputs.manifest.json",
    "source-fetch.json",
    "performance-report.json",
    "runtime-budgets.json",
  ];
}
