import { readFile } from "node:fs/promises";

import {
  assertNativeRuntimeTarget,
  parseRuntimeTargetOption,
} from "./runtime-target.mjs";

const compatibility = JSON.parse(
  await readFile(
    new URL("../target-compatibility.json", import.meta.url),
    "utf8",
  ),
);
const target = assertNativeRuntimeTarget(
  parseRuntimeTargetOption(process.argv.slice(2)),
);
if (!compatibility.targets || Object.keys(compatibility.targets).length !== 4) {
  throw new Error(
    "AT-RT-BUILD-01 blocked: target compatibility matrix is incomplete.",
  );
}
if (!compatibility.targets[target]) {
  throw new Error(
    `AT-RT-BUILD-01 blocked: target compatibility is missing ${target}.`,
  );
}
throw new Error(
  "AT-RT-BUILD-01 blocked: platform signing/notarization, Authenticode, and Linux ABI evidence must come from clean target runners.",
);
