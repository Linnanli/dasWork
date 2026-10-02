import { resolve } from "node:path";

import {
  parseFeedPublicKeyring,
  publishRepository,
} from "../src/repository.mjs";

const { repositoryRoot, stagedRoot } = parseArgs(process.argv.slice(2));
await publishRepository({
  repositoryRoot: resolve(repositoryRoot),
  stagedRoot: resolve(stagedRoot),
  configPublicKeys: requiredPublicKeyring(
    "DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON",
    "config",
  ),
  manifestPublicKeys: requiredPublicKeyring(
    "DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON",
    "manifest",
  ),
});
console.info("Published Primary Runtime feed atomically.");

function parseArgs(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--repository-root", "--staged-root"].includes(flag))
      throw new Error("Expected --repository-root --staged-root.");
    values[flag] = value;
  }
  if (!values["--repository-root"] || !values["--staged-root"])
    throw new Error("Expected --repository-root --staged-root.");
  return {
    repositoryRoot: values["--repository-root"],
    stagedRoot: values["--staged-root"],
  };
}

function requiredPublicKeyring(name, label) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return parseFeedPublicKeyring(value, label);
}
