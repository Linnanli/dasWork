#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { calibrateRuntimeBudgets } from "./runtime-budgets.mjs";

const measurementsPath = parseMeasurementsPath(process.argv.slice(2));
const measurements = JSON.parse(await readFile(measurementsPath, "utf8"));
process.stdout.write(
  `${JSON.stringify(calibrateRuntimeBudgets(measurements), null, 2)}\n`,
);

function parseMeasurementsPath(argv) {
  const index = argv.indexOf("--measurements");
  if (index < 0 || !argv[index + 1]) {
    throw new Error("Expected --measurements <path>.");
  }
  return resolve(argv[index + 1]);
}
