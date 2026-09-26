#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(requiredOption(process.argv.slice(2), "--output"));
await mkdir(output, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
await writeFile(
  resolve(output, "private-key.pem"),
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);
await writeFile(
  resolve(output, "public-key.pem"),
  publicKeyPem,
  { mode: 0o644 },
);
await writeFile(
  resolve(output, "public-keyring.json"),
  `${JSON.stringify(
    {
      "engineering-config-v1": publicKeyPem,
      "engineering-manifest-v1": publicKeyPem,
    },
    null,
    2,
  )}\n`,
  { mode: 0o644 },
);
process.stdout.write(`${JSON.stringify({ status: "generated", releaseClass: "engineering" })}\n`);

function requiredOption(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) return argv[index + 1];
    if (argv[index].startsWith(`${name}=`)) return argv[index].slice(name.length + 1);
  }
  throw new Error(`Expected ${name} <directory>.`);
}
