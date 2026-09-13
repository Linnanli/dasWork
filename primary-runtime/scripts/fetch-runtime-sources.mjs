#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { request as requestHttps } from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readRuntimeSourcesLock } from "./source-lock.mjs";
import {
  artifactsForTarget,
  assertCachedArtifact,
  contentAddressedCachePath,
  readRuntimeToolchainsLock,
} from "./runtime-inputs.mjs";
import { assertNativeRuntimeTarget, parseRuntimeTargetOption } from "./runtime-target.mjs";

const options = parseArgs(process.argv.slice(2));
const target = assertNativeRuntimeTarget(options.target);
const [sourceLock, toolchainsLock] = await Promise.all([
  readRuntimeSourcesLock(options.sourceLock),
  readRuntimeToolchainsLock(options.toolchainsLock),
]);
const artifacts = artifactsForTarget({ sourceLock, toolchainsLock, target });
const fetched = [];

for (const artifact of artifacts) {
  const cachePath = contentAddressedCachePath(options.cacheRoot, artifact);
  let cacheHit = false;
  try {
    await assertCachedArtifact(options.cacheRoot, artifact);
    cacheHit = true;
  } catch {
    // A corrupt or partially written cache object is never trusted. Removing
    // this one content-addressed file cannot affect another locked artifact.
    await rm(cachePath, { force: true });
    await downloadLockedArtifact({ cachePath, artifact });
    await assertCachedArtifact(options.cacheRoot, artifact);
  }
  const details = await stat(cachePath);
  fetched.push({
    name: artifact.name,
    version: artifact.version,
    kind: artifact.kind,
    license: artifact.license,
    sha256: artifact.sha256,
    sizeBytes: details.size,
    cacheHit,
  });
}

const receipt = {
  schemaVersion: "dascowork-primary-runtime-source-fetch.v1",
  target,
  cacheRoot: resolve(options.cacheRoot),
  sources: fetched,
};
if (options.receiptPath) {
  await mkdir(resolve(options.receiptPath, ".."), { recursive: true });
  await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

async function downloadLockedArtifact({ cachePath, artifact }) {
  await mkdir(resolve(cachePath, ".."), { recursive: true });
  const temporaryPath = `${cachePath}.partial`;
  const partialMetadataPath = `${temporaryPath}.json`;
  const partial = await reusablePartial({
    path: temporaryPath,
    metadataPath: partialMetadataPath,
    artifact,
  });
  const existingBytes = partial.bytes;
  try {
    const headers = { "User-Agent": "dasCowork-primary-runtime-fetch/1.0" };
    if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;
    const response = await requestLockedObject({
      url: partial.url ?? artifact.url,
      headers,
      timeoutMs: options.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300 || !response.body) {
      response.body?.resume();
      throw new Error(`HTTP ${response.status}`);
    }
    const responseUrl = response.url;
    const resumes = existingBytes > 0 && response.status === 206;
    if (existingBytes > 0 && !resumes && response.status !== 200) {
      throw new Error("server rejected the locked object range request");
    }
    const declaredSize = responseHeader(response.headers, "content-length");
    const hasLockedSize = Number.isSafeInteger(artifact.sizeBytes);
    const expectedBytes = hasLockedSize
      ? (resumes ? artifact.sizeBytes - existingBytes : artifact.sizeBytes)
      : undefined;
    if (
      hasLockedSize &&
      declaredSize !== null &&
      Number(declaredSize) !== expectedBytes
    ) {
      throw new Error("content-length differs from the immutable toolchain lock");
    }
    let responseTotalBytes = hasLockedSize ? artifact.sizeBytes : undefined;
    if (resumes) {
      const contentRange = responseHeader(response.headers, "content-range");
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange ?? "");
      if (
        !range ||
        Number(range[1]) !== existingBytes ||
        (hasLockedSize &&
          (Number(range[2]) !== artifact.sizeBytes - 1 || Number(range[3]) !== artifact.sizeBytes))
      ) {
        throw new Error("content-range differs from the immutable toolchain lock");
      }
      responseTotalBytes ??= Number(range[3]);
    }
    if (!resumes && declaredSize !== null && /^\d+$/u.test(declaredSize)) {
      responseTotalBytes ??= Number(declaredSize);
    }
    await writePartialMetadata({
      path: partialMetadataPath,
      artifact,
      url: responseUrl,
      ...(responseTotalBytes ? { totalBytes: responseTotalBytes } : {}),
    });
    await writeResponseBody({
      body: response.body,
      path: temporaryPath,
      append: resumes,
    });
    const completed = await stat(temporaryPath);
    if (
      !completed.isFile() ||
      (hasLockedSize && completed.size !== artifact.sizeBytes) ||
      (!hasLockedSize && responseTotalBytes !== undefined && completed.size !== responseTotalBytes)
    ) {
      throw new Error("downloaded object size differs from the immutable toolchain lock");
    }
    await rename(temporaryPath, cachePath);
    await rm(partialMetadataPath, { force: true });
  } catch (error) {
    throw new Error(
      `AT-RT-INPUT-01 blocked: unable to fetch locked ${artifact.name}: ${String(error.message ?? error)}`,
    );
  }
}

/**
 * Keep the locked-object fetch streaming end-to-end through Node's built-in
 * HTTPS client. GitHub-hosted macOS Node 22 exposed an Undici parser assertion
 * before a Web response could be iterated. The IncomingMessage stream avoids
 * that client path while retaining back-pressure and bounded memory.
 */
async function writeResponseBody({ body, path, append }) {
  const output = createWriteStream(path, {
    flags: append ? "a" : "w",
    mode: 0o600,
  });
  try {
    for await (const chunk of body) {
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy(error);
    throw error;
  }
}

function requestLockedObject({ url, headers, timeoutMs, redirects = 0 }) {
  const resolvedUrl = assertHttpsDownloadUrl(url);
  return new Promise((resolveResponse, rejectResponse) => {
    const request = requestHttps(
      resolvedUrl,
      {
        headers,
        timeout: timeoutMs,
      },
      (body) => {
        const status = body.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          body.resume();
          if (redirects >= 5) {
            rejectResponse(new Error("locked source exceeded the redirect limit"));
            return;
          }
          const location = responseHeader(body.headers, "location");
          if (!location) {
            rejectResponse(new Error("locked source redirect has no location"));
            return;
          }
          let nextUrl;
          try {
            nextUrl = assertHttpsDownloadUrl(new URL(location, resolvedUrl).toString());
          } catch (error) {
            rejectResponse(error);
            return;
          }
          resolveResponse(
            requestLockedObject({
              url: nextUrl,
              headers,
              timeoutMs,
              redirects: redirects + 1,
            }),
          );
          return;
        }
        resolveResponse({ status, headers: body.headers, url: resolvedUrl, body });
      },
    );
    request.once("timeout", () => {
      request.destroy(new Error("locked source request timed out"));
    });
    request.once("error", rejectResponse);
    request.end();
  });
}

function responseHeader(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function reusablePartial({ path, metadataPath, artifact }) {
  try {
    const details = await lstat(path);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size < 0 ||
      (Number.isSafeInteger(artifact.sizeBytes) && details.size >= artifact.sizeBytes)
    ) {
      await rm(path, { force: true });
      await rm(metadataPath, { force: true });
      return { bytes: 0, url: undefined };
    }
    const metadata = await readPartialMetadata(metadataPath, artifact);
    if (!metadata || (metadata.totalBytes !== undefined && details.size >= metadata.totalBytes)) {
      await rm(path, { force: true });
      await rm(metadataPath, { force: true });
      return { bytes: 0, url: undefined };
    }
    return { bytes: details.size, url: metadata.url };
  } catch (error) {
    if (error?.code === "ENOENT") return { bytes: 0, url: undefined };
    throw error;
  }
}

async function readPartialMetadata(path, artifact) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      value.schemaVersion !== "dascowork-primary-runtime-partial-download.v1" ||
      value.sha256 !== artifact.sha256 ||
      typeof value.url !== "string" ||
      (value.totalBytes !== undefined &&
        (!Number.isSafeInteger(value.totalBytes) || value.totalBytes <= 0))
    ) {
      return undefined;
    }
    return {
      url: assertHttpsDownloadUrl(value.url),
      ...(value.totalBytes !== undefined ? { totalBytes: value.totalBytes } : {}),
    };
  } catch {
    return undefined;
  }
}

async function writePartialMetadata({ path, artifact, url, totalBytes }) {
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: "dascowork-primary-runtime-partial-download.v1",
      sha256: artifact.sha256,
      url,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
    })}\n`,
    { mode: 0o600 },
  );
}

function assertHttpsDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("locked source redirect is not a safe HTTPS URL");
  }
  return url.toString();
}

function parseArgs(argv) {
  const target = parseRuntimeTargetOption(argv);
  const values = readOptions(argv, new Set(["--target", "--cache", "--receipt", "--source-lock", "--toolchains-lock", "--timeout-ms"]));
  const option = (name, fallback = undefined) => values.get(name) ?? fallback;
  const cache = option("--cache");
  if (!cache) throw new Error("Expected --cache <content-addressed-cache>.");
  return {
    target,
    cacheRoot: resolve(cache),
    receiptPath: option("--receipt") ? resolve(option("--receipt")) : undefined,
    sourceLock: resolve(
      option(
        "--source-lock",
        fileURLToPath(new URL("../runtime-sources.lock.json", import.meta.url)),
      ),
    ),
    toolchainsLock: resolve(
      option(
        "--toolchains-lock",
        fileURLToPath(
          new URL("../runtime-toolchains.lock.json", import.meta.url),
        ),
      ),
    ),
    timeoutMs: readPositiveTimeout(option("--timeout-ms", "120000")),
  };
}

function readOptions(argv, allowed) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${argument}`);
    const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`Expected a value for ${name}.`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  return values;
}

function readPositiveTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
    throw new Error("--timeout-ms must be an integer from 1000 through 900000.");
  }
  return timeoutMs;
}
