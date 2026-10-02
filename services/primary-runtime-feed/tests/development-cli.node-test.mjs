import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertTlsCertificateFresh,
  assertUsableRuntimeRun,
  createDevelopmentImportWorkRoot,
  developmentArtifactZipPath,
  downloadDevelopmentArtifactZip,
  extractSafeArtifactZip,
  parseGitHubRepository,
  profilePaths,
  readClientProfile,
  requiredStagingArtifactNames,
  retryPrimaryRuntimeArtifactDownload,
  selectRequiredStagingArtifacts,
  selectSuccessfulRuntimeRun,
  validateCachedTargetProvenance,
} from "../scripts/development-cli.mjs";

const execFileAsync = promisify(execFile);

test("development import resolves only a GitHub origin", () => {
  assert.equal(
    parseGitHubRepository("https://github.com/example/dasCowork.git"),
    "example/dasCowork",
  );
  assert.equal(
    parseGitHubRepository("git@github.com:example/dasCowork.git"),
    "example/dasCowork",
  );
  assert.throws(
    () => parseGitHubRepository("https://gitlab.com/example/dasCowork.git"),
    /github\.com/u,
  );
});

test("development import selects the newest successful run for the current commit", () => {
  const selected = selectSuccessfulRuntimeRun(
    [
      {
        databaseId: 2,
        conclusion: "success",
        headSha: "current",
        createdAt: "2026-09-18T01:00:00Z",
      },
      {
        databaseId: 1,
        conclusion: "success",
        headSha: "current",
        createdAt: "2026-09-17T01:00:00Z",
      },
      {
        databaseId: 3,
        conclusion: "failure",
        headSha: "current",
        createdAt: "2026-09-18T02:00:00Z",
      },
    ],
    "current",
  );
  assert.equal(selected.databaseId, 2);
  assert.throws(() => selectSuccessfulRuntimeRun([], "current"), /No successful/u);
});

test("development import checks workflow ID by path instead of workflow display name", async () => {
  const calls = [];
  await assertUsableRuntimeRun({
    githubRepository: "example/dasCowork",
    commit: "current",
    run: {
      databaseId: 123,
      workflowDatabaseId: 456,
      conclusion: "success",
      headSha: "current",
    },
    githubJsonForTest: async (args) => {
      calls.push(args);
      return { path: ".github/workflows/primary-runtime-build.yml" };
    },
  });
  assert.deepEqual(calls[0], [
    "api",
    "repos/example/dasCowork/actions/workflows/456",
  ]);

  await assert.rejects(
    assertUsableRuntimeRun({
      githubRepository: "example/dasCowork",
      commit: "current",
      run: {
        databaseId: 123,
        workflowDatabaseId: 999,
        conclusion: "success",
        headSha: "current",
      },
      githubJsonForTest: async () => ({ path: ".github/workflows/other.yml" }),
    }),
    /final workflow path/u,
  );
});

test("development import requires every unexpired target staging artifact", () => {
  const expected = requiredStagingArtifactNames();
  const artifacts = Object.values(expected).map((name) => ({
    name,
    expired: false,
  }));
  assert.deepEqual(
    Object.keys(selectRequiredStagingArtifacts(artifacts)).sort(),
    Object.keys(expected).sort(),
  );
  assert.throws(
    () =>
      selectRequiredStagingArtifacts(
        artifacts.map((artifact) =>
          artifact.name === expected["linux-x64"]
            ? { ...artifact, expired: true }
            : artifact,
        ),
      ),
    /linux-x64/u,
  );
});

test("development import retries interrupted artifact downloads with bounded backoff", async () => {
  let calls = 0;
  const delays = [];
  const result = await retryPrimaryRuntimeArtifactDownload({
    artifactName: "primary-runtime-darwin-arm64-staging",
    operation: async () => {
      calls += 1;
      if (calls < 3) throw new Error("unexpected EOF");
      return "downloaded";
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
    log: () => undefined,
  });
  assert.equal(result, "downloaded");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("development import resumes an interrupted artifact ZIP download", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-resume-"));
  const body = Buffer.from("downloadable artifact zip fixture");
  const fixture = await createArtifactDownloadFixture(body, {
    interruptFirstResponseAt: 13,
  });
  try {
    const paths = profilePaths(root);
    const zipPath = developmentArtifactZipPath(paths, 123, "darwin-arm64");
    const artifact = {
      id: 456,
      name: "primary-runtime-darwin-arm64-staging",
      size_in_bytes: body.length,
      digest: `sha256:${sha256(body)}`,
    };
    await assert.rejects(
      downloadDevelopmentArtifactZip({
        githubRepository: "example/dasCowork",
        artifact,
        zipPath,
        authToken: "test-token",
        apiBaseUrl: fixture.origin,
      }),
    );
    assert.equal((await readFile(zipPath)).length, 13);

    await downloadDevelopmentArtifactZip({
      githubRepository: "example/dasCowork",
      artifact,
      zipPath,
      authToken: "test-token",
      apiBaseUrl: fixture.origin,
    });

    assert.deepEqual(await readFile(zipPath), body);
    assert.deepEqual(fixture.blobRanges, [undefined, "bytes=13-"]);
    assert.deepEqual(fixture.apiAuthorizations, [
      "Bearer test-token",
      "Bearer test-token",
    ]);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("development import rejects an artifact ZIP with a mismatched GitHub digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-digest-"));
  const body = Buffer.from("downloadable artifact zip fixture");
  const fixture = await createArtifactDownloadFixture(body);
  try {
    const paths = profilePaths(root);
    const zipPath = developmentArtifactZipPath(paths, 123, "linux-x64");
    await assert.rejects(
      downloadDevelopmentArtifactZip({
        githubRepository: "example/dasCowork",
        artifact: {
          id: 789,
          name: "primary-runtime-linux-x64-staging",
          size_in_bytes: body.length,
          digest: `sha256:${sha256("same length, different bytes")}`,
        },
        zipPath,
        authToken: "test-token",
        apiBaseUrl: fixture.origin,
      }),
      /digest/u,
    );
    await assert.rejects(readFile(zipPath), /ENOENT/u);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("development import follows bounded same-origin GitHub API redirects before the signed blob", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-canonical-"));
  const body = Buffer.from("downloadable artifact zip fixture");
  const fixture = await createArtifactDownloadFixture(body, {
    canonicalApiRedirect: true,
  });
  try {
    const paths = profilePaths(root);
    const zipPath = developmentArtifactZipPath(paths, 123, "darwin-x64");
    await downloadDevelopmentArtifactZip({
      githubRepository: "example/dasCowork",
      artifact: {
        id: 789,
        name: "primary-runtime-darwin-x64-staging",
        size_in_bytes: body.length,
        digest: `sha256:${sha256(body)}`,
      },
      zipPath,
      authToken: "test-token",
      apiBaseUrl: fixture.origin,
    });

    assert.deepEqual(await readFile(zipPath), body);
    assert.deepEqual(fixture.apiPaths, [
      "/repos/example/dasCowork/actions/artifacts/789/zip",
      "/repositories/1281047778/actions/artifacts/789/zip",
    ]);
    assert.deepEqual(fixture.apiAuthorizations, [
      "Bearer test-token",
      "Bearer test-token",
    ]);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("development import rejects insecure GitHub artifact redirect URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-insecure-"));
  try {
    const paths = profilePaths(root);
    const zipPath = developmentArtifactZipPath(paths, 123, "linux-x64");
    await assert.rejects(
      downloadDevelopmentArtifactZip({
        githubRepository: "example/dasCowork",
        artifact: {
          id: 789,
          name: "primary-runtime-linux-x64-staging",
          size_in_bytes: 1,
          digest: `sha256:${sha256("x")}`,
        },
        zipPath,
        authToken: "test-token",
        fetchImpl: async () =>
          new Response(undefined, {
            status: 302,
            headers: { Location: "http://example.test/signed-artifact.zip" },
          }),
      }),
      /HTTPS/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development import extracts artifact ZIPs without a platform unzip binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-extract-"));
  try {
    const zipPath = join(root, "artifact.zip");
    const outputRoot = join(root, "out");
    await writeFile(
      zipPath,
      createStoredZip([
        { name: "staging/", data: "" },
        { name: "staging/provenance.json", data: "{\"target\":\"linux-x64\"}\n" },
      ]),
    );

    await extractSafeArtifactZip(zipPath, outputRoot);

    assert.equal(
      await readFile(join(outputRoot, "staging", "provenance.json"), "utf8"),
      "{\"target\":\"linux-x64\"}\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development import rejects unsafe artifact ZIP paths before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-zip-slip-"));
  try {
    const zipPath = join(root, "artifact.zip");
    await writeFile(
      zipPath,
      createStoredZip([{ name: "../escape.txt", data: "escaped" }]),
    );

    await assert.rejects(
      extractSafeArtifactZip(zipPath, join(root, "out")),
      /unsafe entry path/u,
    );
    await assert.rejects(readFile(join(root, "escape.txt")), /ENOENT/u);

    await writeFile(
      zipPath,
      createStoredZip([
        {
          name: "staging/link",
          data: "target",
          externalAttributes: 0o120777 << 16,
        },
      ]),
    );
    await assert.rejects(
      extractSafeArtifactZip(zipPath, join(root, "out")),
      /symlink/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development import stages beneath the repository root for atomic publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-import-root-"));
  try {
    const paths = profilePaths(root);
    const workRoot = await createDevelopmentImportWorkRoot(paths);
    const diff = relative(paths.repositoryRoot, workRoot);
    assert.equal(diff.startsWith(".."), false);
    assert.equal(isAbsolute(diff), false);
    assert.match(diff, /^\.import-/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development import rejects a tampered cached archive before reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-cache-"));
  try {
    const archivePath = join(root, "primary-runtime.zip");
    await writeFile(archivePath, "zip");
    await writeFile(
      join(root, "provenance.json"),
      `${JSON.stringify({
        target: "darwin-arm64",
        archiveSizeBytes: 3,
        archiveSha256: sha256("zip"),
      })}\n`,
    );
    await validateCachedTargetProvenance("darwin-arm64", root);
    await writeFile(archivePath, "tampered");
    await assert.rejects(
      validateCachedTargetProvenance("darwin-arm64", root),
      /no longer matches/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development client profile contains only public connection material", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-profile-"));
  try {
    const paths = profilePaths(root);
    await mkdir(paths.tlsRoot, { recursive: true });
    await writeFile(paths.tlsCaPath, "ca");
    await writeFile(
      paths.clientProfilePath,
      `${JSON.stringify({
        origin: "https://127.0.0.1:9443",
        channel: "development",
        configPublicKeys: { "engineering-config-v1": "public-key" },
        manifestPublicKeys: { "engineering-manifest-v1": "public-key" },
        caPath: paths.tlsCaPath,
      })}\n`,
    );
    const profile = await readClientProfile(paths.clientProfilePath);
    assert.deepEqual(Object.keys(profile).sort(), [
      "caPath",
      "channel",
      "configPublicKeys",
      "manifestPublicKeys",
      "origin",
    ]);
    assert.equal(JSON.stringify(profile).includes("private-key"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development serve rejects an expired TLS certificate explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "primary-runtime-tls-"));
  try {
    const keyPath = join(root, "key.pem");
    const certPath = join(root, "cert.pem");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ]);
    await assertTlsCertificateFresh(certPath, "service certificate", new Date());
    await assert.rejects(
      assertTlsCertificateFresh(
        certPath,
        "service certificate",
        new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      ),
      /expired/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createStoredZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const directory = entry.name.endsWith("/");
    const externalAttributes =
      entry.externalAttributes ??
      ((directory ? 0o040755 : 0o100644) << 16);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localRecords.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(externalAttributes >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    offset += local.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

async function createArtifactDownloadFixture(body, options = {}) {
  const blobRanges = [];
  const apiAuthorizations = [];
  const apiPaths = [];
  let blobRequests = 0;
  let origin;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/repos/example/dasCowork/actions/artifacts/")) {
      apiPaths.push(request.url);
      apiAuthorizations.push(request.headers.authorization);
      if (options.canonicalApiRedirect) {
        const artifactId = request.url.match(/\/artifacts\/(\d+)\/zip$/u)?.[1];
        response.writeHead(301, {
          Location: `${origin}/repositories/1281047778/actions/artifacts/${artifactId}/zip`,
        });
        response.end();
        return;
      }
      response.writeHead(302, { Location: `${origin}/signed-artifact.zip` });
      response.end();
      return;
    }

    if (request.url?.startsWith("/repositories/1281047778/actions/artifacts/")) {
      apiPaths.push(request.url);
      apiAuthorizations.push(request.headers.authorization);
      response.writeHead(302, { Location: `${origin}/signed-artifact.zip` });
      response.end();
      return;
    }

    if (request.url !== "/signed-artifact.zip") {
      response.writeHead(404);
      response.end();
      return;
    }

    blobRequests += 1;
    blobRanges.push(request.headers.range);
    if (
      blobRequests === 1 &&
      Number.isSafeInteger(options.interruptFirstResponseAt)
    ) {
      response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": String(body.length),
        "Content-Type": "application/zip",
      });
      response.write(body.subarray(0, options.interruptFirstResponseAt));
      setTimeout(() => response.destroy(new Error("interrupted")), 5);
      return;
    }

    const range = request.headers.range?.match(/^bytes=(\d+)-$/u);
    if (range) {
      const start = Number(range[1]);
      if (start >= body.length) {
        response.writeHead(416, {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${body.length}`,
        });
        response.end();
        return;
      }
      response.writeHead(206, {
        "Accept-Ranges": "bytes",
        "Content-Length": String(body.length - start),
        "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
        "Content-Type": "application/zip",
      });
      response.end(body.subarray(start));
      return;
    }

    response.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Length": String(body.length),
      "Content-Type": "application/zip",
    });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    blobRanges,
    apiAuthorizations,
    apiPaths,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
