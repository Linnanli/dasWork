#!/usr/bin/env node

import { execFile } from "node:child_process";
import { once } from "node:events";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInflateRaw } from "node:zlib";

import {
  ARCHIVE_INDEX_PATH,
  parseFeedPublicKeyring,
  publishDevelopmentMetadataSnapshot,
  publishDevelopmentRepositorySnapshot,
  signFeedMetadata,
  verifyFeedMetadataSignature,
} from "../src/repository.mjs";
import { createDevelopmentPrimaryRuntimeFeedServer } from "../src/server.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const repositoryRoot = resolve(packageRoot, "../..");
const feedScriptsRoot = resolve(packageRoot, "scripts");
const primaryRuntimeRoot = resolve(repositoryRoot, "primary-runtime");
const runtimeWorkflow = ".github/workflows/primary-runtime-build.yml";
const developmentChannel = "development";
const loopbackHost = "127.0.0.1";
const defaultPort = 9443;
const metadataLifetimeMs = 24 * 60 * 60 * 1000;
const downloadAttempts = 3;
const githubApiBaseUrl = "https://api.github.com";
const maxZipCentralDirectoryBytes = 64 * 1024 * 1024;
const maxGitHubApiArtifactRedirects = 3;

export const requiredTargets = Object.freeze([
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
]);

const targetEvidenceFiles = Object.freeze([
  "primary-runtime.zip",
  "runtime.json",
  "provenance.json",
  "platform-validation.json",
  "component-smoke.json",
  "build-unpack-measurement.json",
  "runtime-inputs.manifest.json",
  "canonical-file-manifest.txt",
  "source-fetch.json",
  "performance-report.json",
  "runtime-budgets.json",
]);

export function defaultDevelopmentProfileRoot() {
  return resolve(packageRoot, "var", "development");
}

export function parseDevelopmentCliOptions(argv, env = process.env) {
  const options = {
    profileRoot:
      env.PRIMARY_RUNTIME_FEED_DEVELOPMENT_ROOT?.trim() ||
      defaultDevelopmentProfileRoot(),
    sourceRunId: env.DASCOWORK_PRIMARY_RUNTIME_DEV_SOURCE_RUN?.trim(),
    port: env.DASCOWORK_PRIMARY_RUNTIME_DEV_FEED_PORT?.trim(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("Expected a value for --profile-root, --source-run, or --port.");
    }
    index += 1;
    if (flag === "--profile-root") options.profileRoot = value;
    else if (flag === "--source-run") options.sourceRunId = value;
    else if (flag === "--port") options.port = value;
    else throw new Error("Expected --profile-root, --source-run, or --port.");
  }

  if (!isAbsolute(options.profileRoot)) {
    throw new Error("Primary Runtime feed development profile root must be absolute.");
  }
  const port = Number(options.port ?? defaultPort);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("Primary Runtime feed development port is invalid.");
  }
  if (options.sourceRunId && !/^\d+$/u.test(options.sourceRunId)) {
    throw new Error("Primary Runtime source run must be a positive GitHub Actions run ID.");
  }
  const sourceRunId = options.sourceRunId ? Number(options.sourceRunId) : undefined;
  if (sourceRunId !== undefined && sourceRunId <= 0) {
    throw new Error("Primary Runtime source run must be a positive GitHub Actions run ID.");
  }
  return Object.freeze({
    profileRoot: resolve(options.profileRoot),
    sourceRunId,
    port,
  });
}

export function profilePaths(profileRoot) {
  const root = resolve(profileRoot);
  return Object.freeze({
    root,
    downloadsRoot: join(root, "downloads"),
    repositoryRoot: join(root, "repository"),
    archivesRoot: join(root, "repository", "archives"),
    snapshotsRoot: join(root, "repository", "snapshots"),
    currentPath: join(root, "repository", "current"),
    lockPath: join(root, ".lock"),
    profileStatePath: join(root, "profile.json"),
    clientProfilePath: join(root, "client-profile.json"),
    signingRoot: join(root, "signing-key"),
    configSigningPrivateKeyPath: join(root, "signing-key", "config-private-key.pem"),
    configSigningPublicKeyPath: join(root, "signing-key", "config-public-key.pem"),
    configPublicKeyringPath: join(root, "signing-key", "config-public-keyring.json"),
    manifestSigningPrivateKeyPath: join(root, "signing-key", "manifest-private-key.pem"),
    manifestSigningPublicKeyPath: join(root, "signing-key", "manifest-public-key.pem"),
    manifestPublicKeyringPath: join(root, "signing-key", "manifest-public-keyring.json"),
    metadataSequencePath: join(root, "metadata-sequence.json"),
    tlsRoot: join(root, "tls"),
    tlsCaKeyPath: join(root, "tls", "ca-key.pem"),
    tlsCaPath: join(root, "tls", "ca-cert.pem"),
    tlsKeyPath: join(root, "tls", "server-key.pem"),
    tlsCertPath: join(root, "tls", "server-cert.pem"),
  });
}

export function parseGitHubRepository(remoteUrl) {
  const source = remoteUrl?.trim();
  const match = source?.match(
    /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u,
  );
  if (!match) {
    throw new Error("Primary Runtime feed import requires an origin remote hosted on github.com.");
  }
  if (
    !/^[A-Za-z0-9_.-]+$/u.test(match[1]) ||
    !/^[A-Za-z0-9_.-]+$/u.test(match[2])
  ) {
    throw new Error("Primary Runtime feed import found an invalid GitHub repository name.");
  }
  return `${match[1]}/${match[2]}`;
}

export function requiredStagingArtifactNames() {
  return Object.freeze(
    Object.fromEntries(
      requiredTargets.map((target) => [
        target,
        `primary-runtime-${target}-staging`,
      ]),
    ),
  );
}

export function selectSuccessfulRuntimeRun(runs, commit) {
  if (!Array.isArray(runs)) throw new Error("GitHub Actions run listing is invalid.");
  const selected = runs
    .filter(
      (run) =>
        run &&
        run.conclusion === "success" &&
        typeof run.databaseId === "number" &&
        run.headSha === commit,
    )
    .sort(
      (left, right) =>
        Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
    )[0];
  if (!selected) {
    throw new Error(
      `No successful final Primary Runtime workflow was found for current commit ${commit}.`,
    );
  }
  return selected;
}

export function selectRequiredStagingArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error("GitHub Actions artifact listing is invalid.");
  const expected = requiredStagingArtifactNames();
  const selected = Object.fromEntries(
    Object.entries(expected).map(([target, name]) => [
      target,
      artifacts.find(
        (artifact) => artifact?.name === name && artifact.expired !== true,
      ),
    ]),
  );
  const missing = Object.entries(selected)
    .filter(([, artifact]) => !artifact)
    .map(([target]) => target);
  if (missing.length > 0) {
    throw new Error(
      `Primary Runtime workflow is not a usable final run: missing unexpired staging artifacts for ${missing.join(", ")}.`,
    );
  }
  return Object.freeze(selected);
}

export async function retryPrimaryRuntimeArtifactDownload({
  artifactName,
  operation,
  attempts = downloadAttempts,
  sleep = delay,
  log = console.info,
}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("Primary Runtime artifact download attempts must be a positive integer.");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const retryDelayMs = 1_000 * 2 ** (attempt - 1);
      log(
        `Download of ${artifactName} failed (attempt ${attempt}/${attempts}); retrying in ${retryDelayMs / 1_000}s.`,
      );
      await sleep(retryDelayMs);
    }
  }
  throw new Error(
    `Failed to download ${artifactName} after ${attempts} attempts. Check your network and run the command again.`,
    { cause: lastError },
  );
}

export function developmentArtifactZipPath(paths, runId, target) {
  return join(paths.downloadsRoot, "runs", String(runId), "artifact-zips", `${target}.zip`);
}

export async function downloadDevelopmentArtifactZip({
  githubRepository,
  artifact,
  zipPath,
  authToken,
  fetchImpl = fetch,
  apiBaseUrl = githubApiBaseUrl,
}) {
  if (!authToken?.trim()) {
    throw new Error("Primary Runtime artifact download requires a GitHub auth token.");
  }
  if (!Number.isSafeInteger(artifact?.id) || artifact.id <= 0) {
    throw new Error("Primary Runtime artifact metadata is missing a GitHub artifact ID.");
  }
  const expectedSize = readArtifactSize(artifact);
  const expectedSha256 = readArtifactSha256Digest(artifact);
  await mkdir(resolve(zipPath, ".."), { recursive: true });

  const existingSize = await fileSize(zipPath);
  if (existingSize !== undefined) {
    if (expectedSize !== undefined && existingSize > expectedSize) {
      await rm(zipPath, { force: true });
    } else if (expectedSize !== undefined && existingSize === expectedSize) {
      await verifyCompleteArtifactZip(zipPath, artifact);
      return zipPath;
    }
  }

  const partialSize = (await fileSize(zipPath)) ?? 0;
  const signedUrl = await resolveArtifactDownloadUrl({
    githubRepository,
    artifactId: artifact.id,
    authToken,
    fetchImpl,
    apiBaseUrl,
  });
  const response = await fetchImpl(signedUrl, {
    headers: partialSize > 0 ? { Range: `bytes=${partialSize}-` } : {},
    redirect: "manual",
  });
  if (response.status === 416) {
    if (expectedSize !== undefined && partialSize === expectedSize) {
      await verifyCompleteArtifactZip(zipPath, artifact);
      return zipPath;
    }
    throw new Error("Primary Runtime artifact range was rejected before the ZIP was complete.");
  }
  if (response.status === 206) {
    const range = parseContentRange(response.headers.get("content-range"));
    if (!range || range.start !== partialSize) {
      throw new Error("Primary Runtime artifact resume response has an invalid Content-Range.");
    }
    if (expectedSize !== undefined && range.size !== expectedSize) {
      throw new Error("Primary Runtime artifact resume response size does not match GitHub metadata.");
    }
    await assertResponseLength(
      response,
      expectedSize === undefined ? undefined : expectedSize - partialSize,
    );
    await writeResponseBody(response, zipPath, { flags: "a" });
  } else if (response.status === 200) {
    await assertResponseLength(response, expectedSize);
    await writeResponseBody(response, zipPath, { flags: "w" });
  } else {
    throw new Error(`Primary Runtime artifact download failed with HTTP ${response.status}.`);
  }

  const completeSize = await fileSize(zipPath);
  if (expectedSize !== undefined && completeSize !== expectedSize) {
    throw new Error("Primary Runtime artifact ZIP is incomplete after download.");
  }
  if (expectedSha256 && (await sha256File(zipPath)) !== expectedSha256) {
    await rm(zipPath, { force: true });
    throw new Error("Primary Runtime artifact ZIP does not match the GitHub artifact digest.");
  }
  return zipPath;
}

export async function importDevelopmentRuntimeFeed(options) {
  return withProfileLock(options.profileRoot, async () => {
    const paths = profilePaths(options.profileRoot);
    await ensureDevelopmentProfile(paths, options.port);
    const [commit, githubRepository] = await Promise.all([
      currentCommit(),
      githubRepositoryForCurrentCheckout(),
    ]);
    const sourceRun = await resolveSourceRun({
      githubRepository,
      commit,
      requestedRunId: options.sourceRunId,
    });
    const artifacts = await githubJson([
      "api",
      `repos/${githubRepository}/actions/runs/${sourceRun.databaseId}/artifacts?per_page=100`,
    ]);
    const targetArtifacts = selectRequiredStagingArtifacts(artifacts.artifacts);
    const targetRoots = await ensureTargetArtifacts({
      paths,
      githubRepository,
      sourceRun,
      targetArtifacts,
    });
    const signing = await readDevelopmentSigning(paths);
    const sequence = await reserveMetadataSequence(paths);
    const origin = `https://${loopbackHost}:${options.port}`;
    const snapshotRoot = await createSignedSnapshot({
      paths,
      targetRoots,
      sequence,
      origin,
      signing,
    });
    await writeClientProfile({ paths, origin, signing });
    return Object.freeze({
      sourceRunId: sourceRun.databaseId,
      sequence,
      current: snapshotRoot,
      clientProfilePath: paths.clientProfilePath,
    });
  });
}

export async function refreshDevelopmentRuntimeFeed(options) {
  return withProfileLock(options.profileRoot, async () => {
    const paths = profilePaths(options.profileRoot);
    const current = await readCurrentSnapshot(paths);
    const signing = await readDevelopmentSigning(paths);
    const config = await readJson(join(current.root, "config.json"));
    const manifest = await readJson(
      join(current.root, "channels", config.channel, "manifest.json"),
    );
    const archiveIndex = await readArchiveIndex(current.root);
    verifyFeedMetadataSignature(config, signing.configPublicKeys, "config");
    verifyFeedMetadataSignature(manifest, signing.manifestPublicKeys, "manifest");
    await verifyArchiveIndexFiles(paths, archiveIndex, {
      checkSha256: true,
      manifest,
    });
    const sequence = await reserveMetadataSequence(paths);
    const issuedAt = new Date();
    const unsignedConfig = withoutSignature(config);
    const unsignedManifest = withoutSignature(manifest);
    const signedConfig = signFeedMetadata(
      {
        ...unsignedConfig,
        sequence,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + metadataLifetimeMs).toISOString(),
      },
      await readFile(paths.configSigningPrivateKeyPath, "utf8"),
    );
    const signedManifest = signFeedMetadata(
      {
        ...unsignedManifest,
        sequence,
        issuedAt: signedConfig.issuedAt,
        expiresAt: signedConfig.expiresAt,
      },
      await readFile(paths.manifestSigningPrivateKeyPath, "utf8"),
    );
    const snapshotRoot = await publishRefreshSnapshot({
      paths,
      config: signedConfig,
      manifest: signedManifest,
      archiveIndex,
      signing,
    });
    await writeClientProfile({
      paths,
      origin: new URL(config.manifestUrl).origin,
      signing,
    });
    return Object.freeze({
      sequence,
      current: snapshotRoot,
      clientProfilePath: paths.clientProfilePath,
    });
  });
}

export async function serveDevelopmentRuntimeFeed(options) {
  const paths = profilePaths(options.profileRoot);
  const profile = await readClientProfile(paths.clientProfilePath);
  if (profile.origin !== `https://${loopbackHost}:${options.port}`) {
    throw new Error("Primary Runtime feed client profile does not match the requested serve origin.");
  }
  await assertTlsCertificateFresh(paths.tlsCertPath, "service certificate");
  await assertTlsCertificateFresh(paths.tlsCaPath, "CA certificate");
  const server = await createDevelopmentPrimaryRuntimeFeedServer({
    repositoryRoot: paths.repositoryRoot,
    tls: { keyPath: paths.tlsKeyPath, certPath: paths.tlsCertPath },
    allowedHosts: [`${loopbackHost}:${options.port}`],
    configPublicKeys: profile.configPublicKeys,
    manifestPublicKeys: profile.manifestPublicKeys,
  });
  await new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(options.port, loopbackHost, () => {
      server.off("error", reject);
      resolveServer(undefined);
    });
  });
  console.info(`Primary Runtime development feed listening on https://${loopbackHost}:${options.port}`);
  await once(server, "close");
}

export async function assertTlsCertificateFresh(path, label, now = new Date()) {
  const certificate = new X509Certificate(await readFile(path));
  if (Date.parse(certificate.validTo) <= now.getTime()) {
    throw new Error(`Primary Runtime development TLS ${label} has expired.`);
  }
}

export async function readClientProfile(path) {
  const profile = await readJson(path);
  const origin = new URL(profile.origin);
  const keys = Object.keys(profile).sort();
  if (
    keys.length !== 5 ||
    keys.join(",") !== "caPath,channel,configPublicKeys,manifestPublicKeys,origin" ||
    origin.protocol !== "https:" ||
    origin.hostname !== loopbackHost ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    profile.channel !== developmentChannel ||
    !isAbsolute(profile.caPath) ||
    typeof profile.configPublicKeys !== "object" ||
    typeof profile.manifestPublicKeys !== "object"
  ) {
    throw new Error("Primary Runtime feed client profile is invalid.");
  }
  await access(profile.caPath);
  return profile;
}

async function ensureDevelopmentProfile(paths, port) {
  const existed = await exists(paths.profileStatePath);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await mkdir(paths.repositoryRoot, { recursive: true });
  await mkdir(paths.archivesRoot, { recursive: true });
  await mkdir(paths.snapshotsRoot, { recursive: true });
  if (!existed) {
    await writeJson(paths.profileStatePath, {
      schemaVersion: 1,
      origin: `https://${loopbackHost}:${port}`,
      channel: developmentChannel,
    });
  }
  await ensureDevelopmentSigning(paths, { allowCreate: !existed });
  await ensureDevelopmentTls(paths, { allowCreate: !existed });
}

async function ensureDevelopmentSigning(paths, { allowCreate }) {
  if (
    (await exists(paths.configSigningPrivateKeyPath)) &&
    (await exists(paths.manifestSigningPrivateKeyPath))
  ) {
    return;
  }
  if (!allowCreate) {
    throw new Error("Primary Runtime development signing keys are missing from an existing profile.");
  }
  await generateDevelopmentSigningRole({
    paths,
    role: "config",
    keyId: "engineering-config-v1",
    privateKeyPath: paths.configSigningPrivateKeyPath,
    publicKeyPath: paths.configSigningPublicKeyPath,
    keyringPath: paths.configPublicKeyringPath,
  });
  await generateDevelopmentSigningRole({
    paths,
    role: "manifest",
    keyId: "engineering-manifest-v1",
    privateKeyPath: paths.manifestSigningPrivateKeyPath,
    publicKeyPath: paths.manifestSigningPublicKeyPath,
    keyringPath: paths.manifestPublicKeyringPath,
  });
}

async function generateDevelopmentSigningRole({
  paths,
  role,
  keyId,
  privateKeyPath,
  publicKeyPath,
  keyringPath,
}) {
  await mkdir(paths.signingRoot, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  await writeFile(publicKeyPath, publicKeyPem, { mode: 0o644 });
  await writeJson(keyringPath, { [keyId]: publicKeyPem }, { mode: 0o644 });
  console.info(`Generated Primary Runtime development ${role} signing key.`);
}

async function readDevelopmentSigning(paths) {
  const [configPrivateKey, manifestPrivateKey, configKeyring, manifestKeyring] = await Promise.all([
    lstat(paths.configSigningPrivateKeyPath),
    lstat(paths.manifestSigningPrivateKeyPath),
    readFile(paths.configPublicKeyringPath, "utf8"),
    readFile(paths.manifestPublicKeyringPath, "utf8"),
  ]);
  if (!configPrivateKey.isFile() || !manifestPrivateKey.isFile()) {
    throw new Error("Primary Runtime development signing private keys are not files.");
  }
  const configPublicKeys = parseFeedPublicKeyring(configKeyring, "config");
  const manifestPublicKeys = parseFeedPublicKeyring(manifestKeyring, "manifest");
  return Object.freeze({
    configPrivateKeyPath: paths.configSigningPrivateKeyPath,
    manifestPrivateKeyPath: paths.manifestSigningPrivateKeyPath,
    configPublicKeyring: configKeyring.trim(),
    manifestPublicKeyring: manifestKeyring.trim(),
    configPublicKeys,
    manifestPublicKeys,
  });
}

async function ensureDevelopmentTls(paths, { allowCreate }) {
  if ((await exists(paths.tlsKeyPath)) && (await exists(paths.tlsCertPath)) && (await exists(paths.tlsCaPath))) {
    return;
  }
  if (!allowCreate) {
    throw new Error("Primary Runtime development TLS material is missing from an existing profile.");
  }
  await createLoopbackTls(paths);
}

async function createLoopbackTls(paths) {
  const requestPath = join(paths.tlsRoot, "server.csr");
  const extensionsPath = join(paths.tlsRoot, "server-extensions.cnf");
  await mkdir(paths.tlsRoot, { recursive: true, mode: 0o700 });
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    paths.tlsCaKeyPath,
    "-out",
    paths.tlsCaPath,
    "-days",
    "1825",
    "-subj",
    "/CN=dascowork-primary-runtime-development-ca",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await run("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    paths.tlsKeyPath,
    "-out",
    requestPath,
    "-subj",
    "/CN=127.0.0.1",
  ]);
  await writeFile(
    extensionsPath,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=IP:127.0.0.1",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    requestPath,
    "-CA",
    paths.tlsCaPath,
    "-CAkey",
    paths.tlsCaKeyPath,
    "-CAcreateserial",
    "-out",
    paths.tlsCertPath,
    "-days",
    "365",
    "-extfile",
    extensionsPath,
  ]);
  await rm(requestPath, { force: true });
  await rm(join(paths.tlsRoot, "ca-cert.srl"), { force: true });
}

async function reserveMetadataSequence(paths) {
  const current = await readMetadataSequence(paths);
  const published = await readCurrentPublishedSequence(paths);
  const sequence = Math.max(current, published) + 1;
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(
    paths.metadataSequencePath,
    { schemaVersion: 1, sequence },
    { mode: 0o600 },
  );
  return sequence;
}

async function readMetadataSequence(paths) {
  try {
    const state = await readJson(paths.metadataSequencePath);
    if (
      state?.schemaVersion !== 1 ||
      !Number.isSafeInteger(state.sequence) ||
      state.sequence < 0
    ) {
      throw new Error("Primary Runtime development metadata sequence state is invalid.");
    }
    return state.sequence;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function readCurrentPublishedSequence(paths) {
  try {
    const current = await readCurrentSnapshot(paths);
    const config = await readJson(join(current.root, "config.json"));
    return Number.isSafeInteger(config.sequence) ? config.sequence : 0;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function resolveSourceRun({ githubRepository, commit, requestedRunId }) {
  if (requestedRunId !== undefined) {
    const run = await githubJson([
      "run",
      "view",
      String(requestedRunId),
      "--repo",
      githubRepository,
      "--json",
      "databaseId,conclusion,headSha,workflowDatabaseId,createdAt",
    ]);
    await assertUsableRuntimeRun({ githubRepository, run, commit });
    return run;
  }
  const listing = await githubJson([
    "run",
    "list",
    "--repo",
    githubRepository,
    "--workflow",
    runtimeWorkflow,
    "--commit",
    commit,
    "--limit",
    "100",
    "--json",
    "databaseId,conclusion,headSha,createdAt",
  ]);
  const candidates = listing
    .filter(
      (run) =>
        run &&
        run.conclusion === "success" &&
        typeof run.databaseId === "number" &&
        run.headSha === commit,
    )
    .sort(
      (left, right) =>
        Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
    );
  if (candidates.length === 0) selectSuccessfulRuntimeRun(listing, commit);
  for (const candidate of candidates) {
    const run = await githubJson([
      "run",
      "view",
      String(candidate.databaseId),
      "--repo",
      githubRepository,
      "--json",
      "databaseId,conclusion,headSha,workflowDatabaseId,createdAt",
    ]);
    try {
      await assertUsableRuntimeRun({ githubRepository, run, commit });
      const artifacts = await githubJson([
        "api",
        `repos/${githubRepository}/actions/runs/${run.databaseId}/artifacts?per_page=100`,
      ]);
      selectRequiredStagingArtifacts(artifacts.artifacts);
      return run;
    } catch (error) {
      console.info(
        `Skipping GitHub Actions run ${candidate.databaseId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `No usable final Primary Runtime workflow with all four staging artifacts was found for current commit ${commit}.`,
  );
}

export async function assertUsableRuntimeRun({
  githubRepository,
  run,
  commit,
  githubJsonForTest = githubJson,
}) {
  if (
    !run ||
    run.conclusion !== "success" ||
    run.headSha !== commit ||
    !Number.isSafeInteger(run.databaseId) ||
    run.databaseId <= 0 ||
    !Number.isSafeInteger(run.workflowDatabaseId)
  ) {
    throw new Error("Primary Runtime source run is not a successful final workflow for this checkout.");
  }
  const workflow = await githubJsonForTest([
    "api",
    `repos/${githubRepository}/actions/workflows/${run.workflowDatabaseId}`,
  ]);
  if (workflow.path !== runtimeWorkflow) {
    throw new Error("Primary Runtime source run does not belong to the final workflow path.");
  }
}

async function ensureTargetArtifacts({ paths, githubRepository, sourceRun, targetArtifacts }) {
  const roots = Object.create(null);
  let githubToken;
  for (const target of requiredTargets) {
    const artifact = targetArtifacts[target];
    const targetRoot = join(
      paths.downloadsRoot,
      "runs",
      String(sourceRun.databaseId),
      "targets",
      target,
    );
    const evidenceRoot = await findTargetEvidenceRoot(targetRoot);
    if (evidenceRoot) {
      await validateCachedTargetEvidence(target, evidenceRoot);
      roots[target] = evidenceRoot;
      continue;
    }
    await rm(targetRoot, { recursive: true, force: true });
    const parent = resolve(targetRoot, "..");
    await mkdir(parent, { recursive: true });
    const temporaryRoot = await mkdtemp(join(parent, `.${target}.download-`));
    try {
      console.info(`Downloading ${artifact.name} from GitHub Actions run ${sourceRun.databaseId}.`);
      const artifactZipPath = developmentArtifactZipPath(paths, sourceRun.databaseId, target);
      githubToken ??= await githubAuthToken();
      const downloadedAttemptRoot = await retryPrimaryRuntimeArtifactDownload({
        artifactName: artifact.name,
        operation: async (attempt) => {
          const attemptRoot = join(temporaryRoot, `attempt-${attempt}`);
          await mkdir(attemptRoot, { recursive: true });
          try {
            await downloadDevelopmentArtifactZip({
              githubRepository,
              artifact,
              zipPath: artifactZipPath,
              authToken: githubToken,
            });
            await extractSafeArtifactZip(artifactZipPath, attemptRoot);
            return attemptRoot;
          } catch (error) {
            await rm(attemptRoot, { recursive: true, force: true });
            throw error;
          }
        },
      });
      const downloadedRoot = await findTargetEvidenceRoot(downloadedAttemptRoot);
      if (!downloadedRoot) {
        throw new Error(`Downloaded ${artifact.name} does not contain a valid target staging root.`);
      }
      await validateCachedTargetEvidence(target, downloadedRoot);
      await rename(downloadedRoot, targetRoot);
      roots[target] = targetRoot;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
  return Object.freeze(roots);
}

async function validateCachedTargetEvidence(target, root) {
  if (!(await hasTargetEvidence(root))) {
    throw new Error(`Cached ${target} artifact is incomplete.`);
  }
  await validateCachedTargetProvenance(target, root);
  await run(process.execPath, [
    join(primaryRuntimeRoot, "scripts", "verify-runtime.mjs"),
    "--allow-cross-target",
    "--archive",
    join(root, "primary-runtime.zip"),
    "--provenance",
    join(root, "provenance.json"),
    "--lock",
    join(primaryRuntimeRoot, "runtime-sources.lock.json"),
    "--toolchains-lock",
    join(primaryRuntimeRoot, "runtime-toolchains.lock.json"),
    "--hard-limits",
    join(primaryRuntimeRoot, "runtime-hard-limits.json"),
    "--release-budget",
    join(root, "runtime-budgets.json"),
    "--performance-report",
    join(root, "performance-report.json"),
    "--target",
    target,
  ]);
}

export async function validateCachedTargetProvenance(target, root) {
  const provenance = await readJson(join(root, "provenance.json"));
  const archivePath = join(root, "primary-runtime.zip");
  const archive = await lstat(archivePath);
  const archiveSha256 = await sha256File(archivePath);
  if (
    provenance.target !== target ||
    provenance.archiveSizeBytes !== archive.size ||
    provenance.archiveSha256 !== archiveSha256
  ) {
    throw new Error(`Cached ${target} artifact no longer matches its provenance.`);
  }
}

async function createSignedSnapshot({ paths, targetRoots, sequence, origin, signing }) {
  const workRoot = await createDevelopmentImportWorkRoot(paths);
  try {
    const metadataRoot = join(workRoot, "metadata");
    const stagingRoot = join(workRoot, "staging");
    const targetArguments = requiredTargets.flatMap((target) => [
      "--target",
      `${target}=${targetRoots[target]}`,
    ]);
    await run(process.execPath, [
      join(feedScriptsRoot, "create-release-metadata.mjs"),
      "--release-class",
      "engineering",
      "--origin",
      origin,
      "--channel",
      developmentChannel,
      "--sequence",
      String(sequence),
      "--output",
      metadataRoot,
      ...targetArguments,
    ]);
    await mkdir(join(metadataRoot, "channels", developmentChannel), { recursive: true });
    await run(process.execPath, [
      join(feedScriptsRoot, "sign-config.mjs"),
      "--input",
      join(metadataRoot, "config.unsigned.json"),
      "--output",
      join(metadataRoot, "config.json"),
      "--key",
      signing.configPrivateKeyPath,
    ]);
    await run(process.execPath, [
      join(feedScriptsRoot, "sign-manifest.mjs"),
      "--input",
      join(metadataRoot, "manifest.unsigned.json"),
      "--output",
      join(metadataRoot, "channels", developmentChannel, "manifest.json"),
      "--key",
      signing.manifestPrivateKeyPath,
    ]);
    await assembleReleaseStaging({
      stagingRoot,
      metadataRoot,
      targetRoots,
      signing,
    });
    await publishDevelopmentRepositorySnapshot({
      repositoryRoot: paths.repositoryRoot,
      stagedRoot: stagingRoot,
      configPublicKeys: signing.configPublicKeys,
      manifestPublicKeys: signing.manifestPublicKeys,
    });
    return realpath(paths.currentPath);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

export async function createDevelopmentImportWorkRoot(paths) {
  await mkdir(paths.repositoryRoot, { recursive: true });
  return mkdtemp(join(paths.repositoryRoot, ".import-"));
}

async function assembleReleaseStaging({ stagingRoot, metadataRoot, targetRoots, signing }) {
  const targetArguments = requiredTargets.flatMap((target) => [
    "--target",
    `${target}=${targetRoots[target]}`,
  ]);
  await run(
    process.execPath,
    [
      join(feedScriptsRoot, "assemble-release-staging.mjs"),
      "--output",
      stagingRoot,
      "--metadata",
      metadataRoot,
      ...targetArguments,
    ],
    {
      env: {
        ...process.env,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON:
          signing.configPublicKeyring,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON:
          signing.manifestPublicKeyring,
      },
    },
  );
}

async function publishRefreshSnapshot({
  paths,
  config,
  manifest,
  archiveIndex,
  signing,
}) {
  return publishDevelopmentMetadataSnapshot({
    repositoryRoot: paths.repositoryRoot,
    config,
    manifest,
    archiveIndex,
    configPublicKeys: signing.configPublicKeys,
    manifestPublicKeys: signing.manifestPublicKeys,
  });
}

async function writeClientProfile({ paths, origin, signing }) {
  await writeJson(paths.clientProfilePath, {
    origin,
    channel: developmentChannel,
    configPublicKeys: signing.configPublicKeys,
    manifestPublicKeys: signing.manifestPublicKeys,
    caPath: paths.tlsCaPath,
  });
}

function withoutSignature(value) {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

async function readCurrentSnapshot(paths) {
  const root = await realpath(paths.currentPath);
  if (!isInside(paths.repositoryRoot, root)) {
    throw new Error("Primary Runtime development current snapshot escapes repository.");
  }
  return { root };
}

async function readArchiveIndex(snapshotRoot) {
  const index = await readJson(join(snapshotRoot, ARCHIVE_INDEX_PATH));
  if (
    index?.schemaVersion !== 1 ||
    typeof index.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(index.generatedAt)) ||
    !Array.isArray(index.archives)
  ) {
    throw new Error("Primary Runtime development archive index is invalid.");
  }
  return index;
}

async function verifyArchiveIndexFiles(paths, archiveIndex, { checkSha256, manifest }) {
  const releases = new Map(
    manifest.releases.map((release) => [`${release.version}/${release.platform}-${release.arch}`, release]),
  );
  const seen = new Set();
  for (const entry of archiveIndex.archives) {
    if (
      !entry ||
      typeof entry.version !== "string" ||
      !requiredTargets.includes(entry.target) ||
      typeof entry.relativePath !== "string" ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes <= 0 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("Primary Runtime development archive index has an invalid entry.");
    }
    const release = releases.get(`${entry.version}/${entry.target}`);
    if (!release) continue;
    seen.add(`${entry.version}/${entry.target}`);
    if (
      release.archiveSizeBytes !== entry.sizeBytes ||
      release.archiveSha256 !== entry.sha256
    ) {
      throw new Error("Primary Runtime development archive index does not match the manifest.");
    }
    const archivePath = resolve(paths.repositoryRoot, entry.relativePath);
    if (!isInside(paths.repositoryRoot, archivePath)) {
      throw new Error("Primary Runtime development archive index path escapes repository.");
    }
    const details = await lstat(archivePath);
    if (!details.isFile() || details.size !== entry.sizeBytes) {
      throw new Error("Primary Runtime development archive index points at a missing archive.");
    }
    if (checkSha256 && (await sha256File(archivePath)) !== entry.sha256) {
      throw new Error("Primary Runtime development archive SHA256 no longer matches the archive index.");
    }
  }
  for (const key of releases.keys()) {
    if (!seen.has(key)) {
      throw new Error("Primary Runtime development archive index is missing a manifest archive.");
    }
  }
}

async function findTargetEvidenceRoot(root) {
  if (await hasTargetEvidence(root)) return root;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) return undefined;
  const nested = join(root, directories[0].name);
  return (await hasTargetEvidence(nested)) ? nested : undefined;
}

async function hasTargetEvidence(root) {
  try {
    const details = await lstat(root);
    if (!details.isDirectory()) return false;
    for (const name of targetEvidenceFiles) {
      const file = await lstat(join(root, name));
      if (!file.isFile() || file.size <= 0) return false;
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function withProfileLock(profileRoot, operation) {
  const paths = profilePaths(profileRoot);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await mkdir(paths.lockPath).catch((error) => {
    if (error?.code === "EEXIST") {
      throw new Error("Primary Runtime development profile is locked by another operation.");
    }
    throw error;
  });
  try {
    return await operation();
  } finally {
    await rm(paths.lockPath, { recursive: true, force: true });
  }
}

async function currentCommit() {
  return (await output("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).trim();
}

async function githubRepositoryForCurrentCheckout() {
  return parseGitHubRepository(
    await output("git", ["remote", "get-url", "origin"], {
      cwd: repositoryRoot,
    }),
  );
}

async function githubJson(args) {
  const source = await output("gh", args, { cwd: repositoryRoot });
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("GitHub CLI returned invalid JSON while resolving the Primary Runtime source run.");
  }
}

async function githubAuthToken() {
  return (await output("gh", ["auth", "token"], { cwd: repositoryRoot })).trim();
}

async function resolveArtifactDownloadUrl({
  githubRepository,
  artifactId,
  authToken,
  fetchImpl,
  apiBaseUrl,
}) {
  const initialEndpoint = new URL(
    `/repos/${githubRepository}/actions/artifacts/${artifactId}/zip`,
    apiBaseUrl,
  );
  let endpoint = initialEndpoint;
  for (let redirects = 0; redirects <= maxGitHubApiArtifactRedirects; redirects += 1) {
    const response = await fetchImpl(endpoint, {
      headers: githubArtifactApiHeaders(authToken),
      redirect: "manual",
    });
    if (response.status === 302) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("GitHub artifact download URL response did not include a Location header.");
      }
      return validateSignedArtifactDownloadUrl(location, endpoint);
    }
    if (response.status === 301 || response.status === 308) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("GitHub artifact API redirect did not include a Location header.");
      }
      endpoint = validateGitHubArtifactApiRedirect(location, endpoint, initialEndpoint);
      continue;
    }
    throw new Error(`GitHub artifact download URL request failed with HTTP ${response.status}.`);
  }
  throw new Error("GitHub artifact API redirect limit was exceeded.");
}

function githubArtifactApiHeaders(authToken) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${authToken}`,
    "User-Agent": "dascowork-primary-runtime-feed-development-import",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function validateGitHubArtifactApiRedirect(location, currentEndpoint, initialEndpoint) {
  const redirected = new URL(location, currentEndpoint);
  if (redirected.origin !== currentEndpoint.origin) {
    throw new Error("GitHub artifact API redirect changed origin.");
  }
  if (!isGitHubArtifactApiEndpoint(redirected, initialEndpoint)) {
    throw new Error("GitHub artifact API redirect is not trusted.");
  }
  return redirected;
}

function isGitHubArtifactApiEndpoint(endpoint, initialEndpoint) {
  if (initialEndpoint.protocol === "https:" && initialEndpoint.hostname === "api.github.com") {
    return endpoint.protocol === "https:" && endpoint.hostname === "api.github.com";
  }
  return isLoopbackHttpTestApi(initialEndpoint) && isLoopbackHttpTestApi(endpoint);
}

function validateSignedArtifactDownloadUrl(location, apiEndpoint) {
  const url = new URL(location, apiEndpoint);
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopbackHttpTestApi(apiEndpoint)) {
    return url.toString();
  }
  throw new Error("GitHub artifact download URL must use HTTPS.");
}

function isLoopbackHttpTestApi(apiEndpoint) {
  return (
    apiEndpoint.protocol === "http:" &&
    (apiEndpoint.hostname === "127.0.0.1" ||
      apiEndpoint.hostname === "::1" ||
      apiEndpoint.hostname === "localhost")
  );
}

function readArtifactSize(artifact) {
  return Number.isSafeInteger(artifact?.size_in_bytes) && artifact.size_in_bytes > 0
    ? artifact.size_in_bytes
    : undefined;
}

function readArtifactSha256Digest(artifact) {
  if (typeof artifact?.digest !== "string" || artifact.digest.length === 0) {
    return undefined;
  }
  const match = artifact.digest.match(/^sha256:([a-f0-9]{64})$/iu);
  if (!match) {
    throw new Error("Primary Runtime artifact metadata has an unsupported digest format.");
  }
  return match[1].toLowerCase();
}

async function verifyCompleteArtifactZip(zipPath, artifact) {
  const expectedSize = readArtifactSize(artifact);
  const actualSize = await fileSize(zipPath);
  if (expectedSize !== undefined && actualSize !== expectedSize) {
    throw new Error("Primary Runtime artifact ZIP size does not match GitHub metadata.");
  }
  const expectedSha256 = readArtifactSha256Digest(artifact);
  if (expectedSha256 && (await sha256File(zipPath)) !== expectedSha256) {
    await rm(zipPath, { force: true });
    throw new Error("Primary Runtime artifact ZIP does not match the GitHub artifact digest.");
  }
}

function parseContentRange(value) {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    end < start ||
    size <= end
  ) {
    return undefined;
  }
  return { start, end, size };
}

async function assertResponseLength(response, expectedLength) {
  if (expectedLength === undefined) return;
  const value = response.headers.get("content-length");
  if (value === null) return;
  const actualLength = Number(value);
  if (!Number.isSafeInteger(actualLength) || actualLength !== expectedLength) {
    throw new Error("Primary Runtime artifact response length does not match GitHub metadata.");
  }
}

async function writeResponseBody(response, path, { flags }) {
  if (!response.body) {
    throw new Error("Primary Runtime artifact download response did not include a body.");
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(path, { flags, mode: 0o600 }),
  );
}

export async function extractSafeArtifactZip(zipPath, outputRoot) {
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const entries = await readSafeZipEntries(zipPath);
  for (const entry of entries) {
    const outputPath = resolve(root, entry.name);
    if (!isInside(root, outputPath)) {
      throw new Error("Primary Runtime artifact ZIP entry escapes the extraction root.");
    }
    if (entry.directory) {
      await mkdir(outputPath, { recursive: true });
      continue;
    }
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    if (entry.compressedSize === 0) {
      await writeFile(outputPath, "", { mode: 0o600 });
      continue;
    }
    const source = createReadStream(zipPath, {
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1,
    });
    const destination = createWriteStream(outputPath, {
      flags: "w",
      mode: 0o600,
    });
    if (entry.method === 0) {
      await pipeline(source, destination);
    } else if (entry.method === 8) {
      await pipeline(source, createInflateRaw(), destination);
    } else {
      throw new Error("Primary Runtime artifact ZIP entry uses an unsupported compression method.");
    }
  }
}

async function readSafeZipEntries(zipPath) {
  const zip = await open(zipPath, "r");
  try {
    const { size } = await zip.stat();
    const eocd = await readZipEndOfCentralDirectory(zip, size);
    if (eocd.centralDirectorySize > maxZipCentralDirectoryBytes) {
      throw new Error("Primary Runtime artifact ZIP central directory is too large.");
    }
    if (eocd.centralDirectoryOffset + eocd.centralDirectorySize > size) {
      throw new Error("Primary Runtime artifact ZIP central directory escapes the archive.");
    }
    const centralDirectory = Buffer.alloc(eocd.centralDirectorySize);
    await zip.read(
      centralDirectory,
      0,
      centralDirectory.length,
      eocd.centralDirectoryOffset,
    );
    const entries = [];
    const seen = new Set();
    let offset = 0;
    for (let index = 0; index < eocd.entryCount; index += 1) {
      if (centralDirectory.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error("Primary Runtime artifact ZIP has an invalid central directory.");
      }
      const flags = centralDirectory.readUInt16LE(offset + 8);
      const method = centralDirectory.readUInt16LE(offset + 10);
      const compressedSize = centralDirectory.readUInt32LE(offset + 20);
      const uncompressedSize = centralDirectory.readUInt32LE(offset + 24);
      const nameLength = centralDirectory.readUInt16LE(offset + 28);
      const extraLength = centralDirectory.readUInt16LE(offset + 30);
      const commentLength = centralDirectory.readUInt16LE(offset + 32);
      const externalAttributes = centralDirectory.readUInt32LE(offset + 38);
      const localHeaderOffset = centralDirectory.readUInt32LE(offset + 42);
      const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
      if (nextOffset > centralDirectory.length) {
        throw new Error("Primary Runtime artifact ZIP has a truncated central directory.");
      }
      const name = centralDirectory
        .subarray(offset + 46, offset + 46 + nameLength)
        .toString("utf8");
      const directory = name.endsWith("/");
      assertSafeZipEntry({
        name,
        flags,
        method,
        compressedSize,
        uncompressedSize,
        externalAttributes,
        localHeaderOffset,
      });
      if (seen.has(name)) {
        throw new Error("Primary Runtime artifact ZIP contains duplicate entries.");
      }
      seen.add(name);
      const dataOffset = await readZipEntryDataOffset(zip, localHeaderOffset, size);
      if (dataOffset + compressedSize > size) {
        throw new Error("Primary Runtime artifact ZIP entry data escapes the archive.");
      }
      entries.push({
        name,
        method,
        compressedSize,
        directory,
        dataOffset,
      });
      offset = nextOffset;
    }
    if (offset !== centralDirectory.length) {
      throw new Error("Primary Runtime artifact ZIP has unexpected central directory data.");
    }
    return entries;
  } finally {
    await zip.close();
  }
}

async function readZipEndOfCentralDirectory(zip, size) {
  const tailLength = Math.min(size, 65_557);
  const tail = Buffer.alloc(tailLength);
  await zip.read(tail, 0, tail.length, size - tailLength);
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== 0x06054b50) continue;
    const diskNumber = tail.readUInt16LE(offset + 4);
    const centralDirectoryDisk = tail.readUInt16LE(offset + 6);
    const diskEntryCount = tail.readUInt16LE(offset + 8);
    const entryCount = tail.readUInt16LE(offset + 10);
    const centralDirectorySize = tail.readUInt32LE(offset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(offset + 16);
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== tail.length) continue;
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) {
      throw new Error("Primary Runtime artifact ZIP cannot span multiple disks.");
    }
    if (
      entryCount === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      throw new Error("Primary Runtime artifact ZIP64 archives are not supported.");
    }
    return { entryCount, centralDirectorySize, centralDirectoryOffset };
  }
  throw new Error("Primary Runtime artifact ZIP is missing its central directory.");
}

function assertSafeZipEntry({
  name,
  flags,
  method,
  compressedSize,
  uncompressedSize,
  externalAttributes,
  localHeaderOffset,
}) {
  const normalizedName = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    !normalizedName ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/u.test(name)
  ) {
    throw new Error("Primary Runtime artifact ZIP contains an unsafe entry path.");
  }
  const parts = normalizedName.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Primary Runtime artifact ZIP contains an unsafe entry path.");
  }
  if ((flags & 0x1) !== 0) {
    throw new Error("Primary Runtime artifact ZIP contains an encrypted entry.");
  }
  if (method !== 0 && method !== 8) {
    throw new Error("Primary Runtime artifact ZIP entry uses an unsupported compression method.");
  }
  if (
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    localHeaderOffset === 0xffffffff
  ) {
    throw new Error("Primary Runtime artifact ZIP64 entries are not supported.");
  }
  const unixMode = externalAttributes >>> 16;
  if ((unixMode & 0o170000) === 0o120000) {
    throw new Error("Primary Runtime artifact ZIP contains a symlink entry.");
  }
}

async function readZipEntryDataOffset(zip, localHeaderOffset, archiveSize) {
  const header = Buffer.alloc(30);
  await zip.read(header, 0, header.length, localHeaderOffset);
  if (header.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Primary Runtime artifact ZIP entry has an invalid local header.");
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset > archiveSize) {
    throw new Error("Primary Runtime artifact ZIP entry data escapes the archive.");
  }
  return dataOffset;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value, options = {}) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: options.mode ?? 0o600,
  });
}

async function writeJsonAtomic(path, value, options = {}) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeJson(temporary, value, options);
  await rename(temporary, path);
}

async function output(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return result.stdout;
}

async function run(command, args, options = {}) {
  await execFileAsync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileSize(path) {
  try {
    const details = await lstat(path);
    if (!details.isFile()) return undefined;
    return details.size;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function isInside(root, candidate) {
  const diff = relative(resolve(root), resolve(candidate));
  return (
    diff !== "" &&
    !diff.startsWith("..") &&
    !isAbsolute(diff) &&
    !diff.split(sep).includes("..")
  );
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function developmentCliMain(command, argv) {
  const options = parseDevelopmentCliOptions(argv);
  if (command === "import") {
    const result = await importDevelopmentRuntimeFeed(options);
    console.info(
      `Primary Runtime development feed imported run ${result.sourceRunId} at sequence ${result.sequence}.`,
    );
    console.info(`Client profile: ${result.clientProfilePath}`);
    return;
  }
  if (command === "refresh") {
    const result = await refreshDevelopmentRuntimeFeed(options);
    console.info(`Primary Runtime development feed refreshed at sequence ${result.sequence}.`);
    console.info(`Client profile: ${result.clientProfilePath}`);
    return;
  }
  if (command === "serve") {
    await serveDevelopmentRuntimeFeed(options);
    return;
  }
  throw new Error("Expected import, refresh, or serve.");
}
