#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { verifyRuntimeBudgets } from "./runtime-budgets.mjs";

const { budgetPath, measurementsPath } = parseArgs(process.argv.slice(2));
const budgets = JSON.parse(await readFile(budgetPath, "utf8"));
const measurements = measurementsPath
  ? JSON.parse(await readFile(measurementsPath, "utf8"))
  : undefined;
verifyRuntimeBudgets({ budgets, measurements });
process.stdout.write("Primary Runtime budgets verified.\n");

function parseArgs(argv) {
  let budgetPath = new URL("../runtime-budgets.json", import.meta.url).pathname;
  let measurementsPath;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--budget") {
      if (!argv[index + 1]) throw new Error("Expected a path after --budget.");
      budgetPath = resolve(argv[index + 1]);
      index += 1;
    } else if (item === "--measurements") {
      if (!argv[index + 1]) {
        throw new Error("Expected a path after --measurements.");
      }
      measurementsPath = resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return { budgetPath: resolve(budgetPath), measurementsPath };
}
