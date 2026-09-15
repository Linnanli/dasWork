import { readFile, writeFile } from "node:fs/promises";

import { signFeedMetadata } from "../src/repository.mjs";

await signFile(process.argv.slice(2), "config");

async function signFile(argv, label) {
  const { input, output, key } = parseArgs(argv);
  const signed = signFeedMetadata(
    JSON.parse(await readFile(input, "utf8")),
    await readFile(key, "utf8"),
  );
  await writeFile(output, `${JSON.stringify(signed, null, 2)}\n`, {
    mode: 0o600,
  });
  console.info(`Signed Primary Runtime ${label}: ${output}`);
}

function parseArgs(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--input", "--output", "--key"].includes(flag))
      throw new Error("Expected --input --output --key.");
    values[flag] = value;
  }
  if (!values["--input"] || !values["--output"] || !values["--key"])
    throw new Error("Expected --input --output --key.");
  return {
    input: values["--input"],
    output: values["--output"],
    key: values["--key"],
  };
}
