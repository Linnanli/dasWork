#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- This executable is exercised through its exported option and artifact-selection contracts. */

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  primaryRuntimeFeedChildEnvironment,
  resolvePrimaryRuntimeFeedDevelopmentConfiguration,
  startPrimaryRuntimeFeed,
} from "../desktop-app/scripts/dev-with-primary-runtime-feed.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const appRoot = resolve(repositoryRoot, "desktop-app");
const feedRoot = resolve(repositoryRoot, "services/primary-runtime-feed");
const feedScriptsRoot = resolve(feedRoot, "scripts");
const runtimeWorkflow = ".github/workflows/primary-runtime-build.yml";
const loopbackHost = "127.0.0.1";
const defaultPort = 9443;
const developmentChannel = "development";
const downloadAttempts = 3;
const requiredTargets = Object.freeze([
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

if (resolve(process.argv[1] ?? "") === new URL(import.meta.url).pathname) {
  process.exitCode = await main();
}

/** Parses the small, explicit surface used by the one-command development launcher. */
export function parsePrimaryRuntimeDevelopmentOptions(argv, env = process.env) {
  let sourceRunId = env.DASCOWORK_PRIMARY_RUNTIME_DEV_SOURCE_RUN?.trim();
  let cacheRoot = env.DASCOWORK_PRIMARY_RUNTIME_DEV_CACHE_DIR?.trim();
  let port = env.DASCOWORK_PRIMARY_RUNTIME_DEV_FEED_PORT?.trim();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(
        "Expected a value for --source-run, --cache-dir, or --port.",
      );
    }
    index += 1;
    if (flag === "--source-run") sourceRunId = value;
    else if (flag === "--cache-dir") cacheRoot = value;
    else if (flag === "--port") port = value;
    else throw new Error("Expected --source-run, --cache-dir, or --port.");
  }

  if (sourceRunId && !/^\d+$/u.test(sourceRunId)) {
    throw new Error(
      "Primary Runtime development source run must be a positive GitHub Actions run ID.",
    );
  }
  if (sourceRunId && Number(sourceRunId) <= 0) {
    throw new Error(
      "Primary Runtime development source run must be a positive GitHub Actions run ID.",
    );
  }
  const resolvedPort = Number(port ?? defaultPort);
  if (
    !Number.isSafeInteger(resolvedPort) ||
    resolvedPort <= 0 ||
    resolvedPort > 65_535
  ) {
    throw new Error("Primary Runtime development feed port is invalid.");
  }
  const cachePath = cacheRoot || join(appRoot, ".primary-runtime-dev-cache");
  if (!isAbsolute(cachePath)) {
    throw new Error(
      "Primary Runtime development cache must be an absolute path.",
    );
  }
  const resolvedCacheRoot = resolve(cachePath);
  return Object.freeze({
    sourceRunId: sourceRunId ? Number(sourceRunId) : undefined,
    cacheRoot: resolvedCacheRoot,
    port: resolvedPort,
  });
}

export function parseGitHubRepository(remoteUrl) {
  const source = remoteUrl?.trim();
  const match = source?.match(
    /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u,
  );
  if (!match) {
    throw new Error(
      "Primary Runtime development launcher requires an origin remote hosted on github.com.",
    );
  }
  const owner = match[1];
  const repository = match[2];
  if (
    !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repository)
  ) {
    throw new Error(
      "Primary Runtime development launcher found an invalid GitHub repository name.",
    );
  }
  return `${owner}/${repository}`;
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
  if (!Array.isArray(runs))
    throw new Error("GitHub Actions run listing is invalid.");
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
      `No successful final Primary Runtime workflow was found for current commit ${commit}. Run the final workflow first or pass --source-run <run-id>.`,
    );
  }
  return selected;
}

export function selectRequiredStagingArtifacts(artifacts) {
  if (!Array.isArray(artifacts))
    throw new Error("GitHub Actions artifact listing is invalid.");
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

/** Retries transient GitHub artifact transfers without weakening staging validation. */
export async function retryPrimaryRuntimeArtifactDownload({
  artifactName,
  operation,
  attempts = downloadAttempts,
  sleep = delay,
  log = console.info,
}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error(
      "Primary Runtime artifact download attempts must be a positive integer.",
    );
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
        `Download of ${artifactName} failed (attempt ${attempt}/${attempts}); retrying in ${retryDelayMs / 1_000}s…`,
      );
      await sleep(retryDelayMs);
    }
  }
  throw new Error(
    `Failed to download ${artifactName} after ${attempts} attempts. Check your network and run the command again.`,
    { cause: lastError },
  );
}

async function main() {
  const options = parsePrimaryRuntimeDevelopmentOptions(process.argv.slice(2));
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
    cacheRoot: options.cacheRoot,
    githubRepository,
    sourceRun,
    targetArtifacts,
  });

  const workRoot = await mkdtemp(
    join(tmpdir(), "dascowork-primary-runtime-dev-feed-"),
  );
  let server;
  try {
    const profileRoot = join(
      options.cacheRoot,
      "profiles",
      `${loopbackHost}-${options.port}`,
    );
    const sequence = await nextMetadataSequence(profileRoot);
    const tls = await createLoopbackTls(workRoot);
    const signing = await ensureDevelopmentSigningKey(profileRoot);
    const metadataRoot = await createLocalFeedMetadata({
      workRoot,
      targetRoots,
      privateKeyPath: signing.privateKeyPath,
      sequence,
      port: options.port,
    });
    const stagingRoot = await assembleLocalFeedStaging({
      workRoot,
      metadataRoot,
      targetRoots,
      publicKeyring: signing.publicKeyring,
    });
    const feedRepository = join(workRoot, "repository");
    const feedStagedRoot = join(feedRepository, "staged");
    await mkdir(feedRepository, { recursive: true });
    await copyDirectory(stagingRoot, feedStagedRoot);

    const configuration = resolvePrimaryRuntimeFeedDevelopmentConfiguration({
      ...process.env,
      DASCOWORK_PRIMARY_RUNTIME_FEED_REPOSITORY_ROOT: feedRepository,
      DASCOWORK_PRIMARY_RUNTIME_FEED_STAGED_ROOT: feedStagedRoot,
      DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_KEY: tls.keyPath,
      DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CERT: tls.certPath,
      DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CA: tls.caPath,
      DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: signing.publicKeyring,
      DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON:
        signing.publicKeyring,
      DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: developmentChannel,
      DASCOWORK_PRIMARY_RUNTIME_FEED_HOST: loopbackHost,
      DASCOWORK_PRIMARY_RUNTIME_FEED_PORT: String(options.port),
    });
    server = await startPrimaryRuntimeFeed(configuration);
    await persistMetadataSequence(profileRoot, sequence);
    console.info(
      `Primary Runtime development feed is ready from GitHub Actions run ${sourceRun.databaseId} at https://${loopbackHost}:${options.port}.`,
    );
    return await launchDevelopmentClient(configuration);
  } finally {
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    await rm(workRoot, { recursive: true, force: true });
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
      "databaseId,conclusion,headSha,workflowName,createdAt",
    ]);
    assertUsableRuntimeRun(run, commit);
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
      "databaseId,conclusion,headSha,workflowName,createdAt",
    ]);
    try {
      assertUsableRuntimeRun(run, commit);
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

function assertUsableRuntimeRun(run, commit) {
  if (
    !run ||
    run.conclusion !== "success" ||
    run.headSha !== commit ||
    run.workflowName !== runtimeWorkflow ||
    !Number.isSafeInteger(run.databaseId) ||
    run.databaseId <= 0
  ) {
    throw new Error(
      "Primary Runtime source run is not a successful final workflow for this checkout.",
    );
  }
}

async function ensureTargetArtifacts({
  cacheRoot,
  githubRepository,
  sourceRun,
  targetArtifacts,
}) {
  const roots = Object.create(null);
  for (const target of requiredTargets) {
    const artifact = targetArtifacts[target];
    const targetRoot = join(
      cacheRoot,
      "runs",
      String(sourceRun.databaseId),
      "targets",
      target,
    );
    const evidenceRoot = await findTargetEvidenceRoot(targetRoot);
    if (evidenceRoot) {
      roots[target] = evidenceRoot;
      continue;
    }

    await rm(targetRoot, { recursive: true, force: true });
    const parent = resolve(targetRoot, "..");
    await mkdir(parent, { recursive: true });
    const temporaryRoot = await mkdtemp(join(parent, `.${target}.download-`));
    try {
      console.info(
        `Downloading ${artifact.name} from GitHub Actions run ${sourceRun.databaseId}…`,
      );
      const downloadedAttemptRoot = await retryPrimaryRuntimeArtifactDownload({
        artifactName: artifact.name,
        operation: async (attempt) => {
          const attemptRoot = join(temporaryRoot, `attempt-${attempt}`);
          await mkdir(attemptRoot, { recursive: true });
          try {
            await run("gh", [
              "run",
              "download",
              String(sourceRun.databaseId),
              "--repo",
              githubRepository,
              "--name",
              artifact.name,
              "--dir",
              attemptRoot,
            ]);
            return attemptRoot;
          } catch (error) {
            await rm(attemptRoot, { recursive: true, force: true });
            throw error;
          }
        },
      });
      const downloadedRoot = await findTargetEvidenceRoot(
        downloadedAttemptRoot,
      );
      if (!downloadedRoot) {
        throw new Error(
          `Downloaded ${artifact.name} does not contain a valid target staging root.`,
        );
      }
      await rename(downloadedRoot, targetRoot);
      roots[target] = targetRoot;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
  return Object.freeze(roots);
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

async function ensureDevelopmentSigningKey(profileRoot) {
  const keyRoot = join(profileRoot, "signing-key");
  const keyringPath = join(keyRoot, "public-keyring.json");
  const privateKeyPath = join(keyRoot, "private-key.pem");
  try {
    const [privateKey, keyring] = await Promise.all([
      lstat(privateKeyPath),
      readFile(keyringPath, "utf8"),
    ]);
    if (!privateKey.isFile())
      throw new Error("Primary Runtime development signing key is not a file.");
    JSON.parse(keyring);
    return Object.freeze({ privateKeyPath, publicKeyring: keyring.trim() });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(profileRoot, { recursive: true });
    await run(process.execPath, [
      join(feedScriptsRoot, "generate-engineering-signing-key.mjs"),
      "--output",
      keyRoot,
    ]);
    return Object.freeze({
      privateKeyPath,
      publicKeyring: (await readFile(keyringPath, "utf8")).trim(),
    });
  }
}

async function nextMetadataSequence(profileRoot) {
  try {
    const state = JSON.parse(
      await readFile(join(profileRoot, "metadata-sequence.json"), "utf8"),
    );
    if (
      state?.schemaVersion !== 1 ||
      !Number.isSafeInteger(state.sequence) ||
      state.sequence < 0
    ) {
      throw new Error(
        "Primary Runtime development metadata sequence cache is invalid.",
      );
    }
    return state.sequence + 1;
  } catch (error) {
    if (error?.code === "ENOENT") return 1;
    throw error;
  }
}

async function persistMetadataSequence(profileRoot, sequence) {
  await mkdir(profileRoot, { recursive: true });
  await writeFile(
    join(profileRoot, "metadata-sequence.json"),
    `${JSON.stringify({ schemaVersion: 1, sequence })}\n`,
    { mode: 0o600 },
  );
}

async function createLocalFeedMetadata({
  workRoot,
  targetRoots,
  privateKeyPath,
  sequence,
  port,
}) {
  const metadataRoot = join(workRoot, "metadata");
  const origin = `https://${loopbackHost}:${port}`;
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
  await mkdir(join(metadataRoot, "channels", developmentChannel), {
    recursive: true,
  });
  await run(process.execPath, [
    join(feedScriptsRoot, "sign-config.mjs"),
    "--input",
    join(metadataRoot, "config.unsigned.json"),
    "--output",
    join(metadataRoot, "config.json"),
    "--key",
    privateKeyPath,
  ]);
  await run(process.execPath, [
    join(feedScriptsRoot, "sign-manifest.mjs"),
    "--input",
    join(metadataRoot, "manifest.unsigned.json"),
    "--output",
    join(metadataRoot, "channels", developmentChannel, "manifest.json"),
    "--key",
    privateKeyPath,
  ]);
  return metadataRoot;
}

async function assembleLocalFeedStaging({
  workRoot,
  metadataRoot,
  targetRoots,
  publicKeyring,
}) {
  const outputRoot = join(workRoot, "feed-staging");
  const targetArguments = requiredTargets.flatMap((target) => [
    "--target",
    `${target}=${targetRoots[target]}`,
  ]);
  await run(
    process.execPath,
    [
      join(feedScriptsRoot, "assemble-release-staging.mjs"),
      "--output",
      outputRoot,
      "--metadata",
      metadataRoot,
      ...targetArguments,
    ],
    {
      env: {
        ...process.env,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: publicKeyring,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON:
          publicKeyring,
      },
    },
  );
  return outputRoot;
}

async function createLoopbackTls(root) {
  const tlsRoot = join(root, "tls");
  const caKeyPath = join(tlsRoot, "ca-key.pem");
  const caPath = join(tlsRoot, "ca-cert.pem");
  const keyPath = join(tlsRoot, "server-key.pem");
  const requestPath = join(tlsRoot, "server.csr");
  const certPath = join(tlsRoot, "server-cert.pem");
  const extensionsPath = join(tlsRoot, "server-extensions.cnf");
  await mkdir(tlsRoot, { recursive: true });
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKeyPath,
    "-out",
    caPath,
    "-days",
    "1",
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
    keyPath,
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
    caPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    certPath,
    "-days",
    "1",
    "-extfile",
    extensionsPath,
  ]);
  await rm(caKeyPath, { force: true });
  await rm(requestPath, { force: true });
  await rm(join(tlsRoot, "ca-cert.srl"), { force: true });
  return { keyPath, certPath, caPath };
}

async function launchDevelopmentClient(configuration) {
  const child = spawn("npm", ["run", "dev"], {
    cwd: appRoot,
    env: primaryRuntimeFeedChildEnvironment(configuration),
    stdio: "inherit",
  });
  const forwardShutdown = (signal) => child.kill(signal);
  process.once("SIGINT", () => forwardShutdown("SIGINT"));
  process.once("SIGTERM", () => forwardShutdown("SIGTERM"));
  const [code, signal] = await once(child, "exit");
  if (signal) return 1;
  return typeof code === "number" ? code : 1;
}

async function currentCommit() {
  return (
    await output("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).trim();
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
    throw new Error(
      "GitHub CLI returned invalid JSON while resolving the Primary Runtime source run.",
    );
  }
}

async function copyDirectory(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else
      throw new Error(
        "Primary Runtime development feed staging contains an unsupported filesystem entry.",
      );
  }
}

async function output(command, args, options = {}) {
  const result = await executeFile(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return result.stdout;
}

async function run(command, args, options = {}) {
  await executeFile(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
