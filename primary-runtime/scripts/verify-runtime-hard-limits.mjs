#!/usr/bin/env node

import { resolve } from "node:path";

import { readRuntimeHardLimits } from "./runtime-hard-limits.mjs";

const path = parseArgs(process.argv.slice(2));
const limits = await readRuntimeHardLimits(path);
process.stdout.write(
  `${JSON.stringify(
    {
      status: "verified",
      schemaVersion: limits.schemaVersion,
      targets: Object.keys(limits.targets),
    },
    null,
    2,
  )}\n`,
);

function parseArgs(argv) {
  if (argv.length === 0) {
    return new URL("../runtime-hard-limits.json", import.meta.url).pathname;
  }
  if (argv.length === 2 && argv[0] === "--hard-limits" && !argv[1].startsWith("--")) {
    return resolve(argv[1]);
  }
  throw new Error("Expected no arguments or --hard-limits <path>.");
}
