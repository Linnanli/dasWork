import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";

import { readPublishedRuntimeFeedAsset } from "./repository.mjs";

export async function createPrimaryRuntimeFeedServer({
  repositoryRoot,
  tls,
  allowedHosts,
}) {
  if (!repositoryRoot || !tls?.keyPath || !tls?.certPath || !allowedHosts) {
    throw new Error(
      "Primary Runtime feed requires a repository root, explicit TLS key/certificate paths, and allowed request hosts.",
    );
  }
  const trustedHosts = normalizeAllowedRequestHosts(allowedHosts);
  const key = await readFile(tls.keyPath);
  const cert = await readFile(tls.certPath);
  return createServer({ key, cert }, async (request, response) => {
    try {
      if (!isAllowedRequestHost(request.headers.host, trustedHosts)) {
        response.writeHead(421, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, {
          allow: "GET, HEAD",
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      const pathname = new URL(
        request.url ?? "/",
        "https://primary-runtime.invalid",
      ).pathname;
      const asset = await readPublishedRuntimeFeedAsset(
        repositoryRoot,
        pathname,
      );
      if (!asset) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": asset.contentType,
        "content-length": String(asset.size),
        etag: asset.etag,
        "cache-control": asset.cacheControl,
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(asset.path).pipe(response);
    } catch (error) {
      response.writeHead(500, { "cache-control": "no-store" });
      response.end(
        error instanceof Error ? error.message : "Runtime feed error",
      );
    }
  });
}

export function normalizeAllowedRequestHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error("Primary Runtime feed allowed request hosts are required.");
  }
  return [...new Set(hosts.map(normalizeRequestHost))];
}

export function isAllowedRequestHost(host, allowedHosts) {
  if (typeof host !== "string") return false;
  try {
    return (
      normalizeRequestHost(host) &&
      allowedHosts.includes(normalizeRequestHost(host))
    );
  } catch {
    return false;
  }
}

async function main() {
  const repositoryRoot = process.env.PRIMARY_RUNTIME_FEED_ROOT;
  const keyPath = process.env.PRIMARY_RUNTIME_FEED_TLS_KEY;
  const certPath = process.env.PRIMARY_RUNTIME_FEED_TLS_CERT;
  const allowedHosts = process.env.PRIMARY_RUNTIME_FEED_ALLOWED_HOSTS?.split(
    ",",
  )
    .map((host) => host.trim())
    .filter(Boolean);
  const port = Number(process.env.PRIMARY_RUNTIME_FEED_PORT ?? "9443");
  const host = process.env.PRIMARY_RUNTIME_FEED_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error("Invalid feed port.");
  const server = await createPrimaryRuntimeFeedServer({
    repositoryRoot,
    tls: { keyPath, certPath },
    allowedHosts,
  });
  server.listen(port, host, () => {
    console.info(`Primary Runtime feed listening on https://${host}:${port}`);
  });
}

function normalizeRequestHost(value) {
  if (!value || value !== value.trim() || /[/?#@]/u.test(value)) {
    throw new Error("Primary Runtime feed request host is invalid.");
  }
  let url;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new Error("Primary Runtime feed request host is invalid.");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new Error("Primary Runtime feed request host is invalid.");
  }
  return url.host;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
