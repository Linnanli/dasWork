#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { arch, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const lock = JSON.parse(await readFile(join(runtimeRoot, "libreoffice-build.lock.json"), "utf8"));
const spec = lock.targets[args.target];
if (!spec || platform() !== "darwin" || arch() !== (args.target === "darwin-x64" ? "x64" : "arm64")) {
  throw new Error(`Target ${args.target} requires a matching native macOS host`);
}
if (!/^[a-f0-9]{64}$/.test(lock.source.sha256) || !/^[a-f0-9]{64}$/.test(lock.patch.sha256)) {
  throw new Error("LibreOffice build lock has an invalid SHA-256");
}

const developerDir = `/Applications/Xcode_${spec.xcodeVersion}.app/Contents/Developer`;
const env = { ...process.env, DEVELOPER_DIR: developerDir };
const xcode = await capture("xcodebuild", ["-version"], { env });
const sdkVersion = (await capture("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { env })).trim();
const sdkPath = (await capture("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { env })).trim();
const hostArchitecture = (await capture("uname", ["-m"], { env })).trim();
const make = await findModernMake(env);
env.GNUMAKE = make.command;
const buildTools = {
  make: make.version.trim(),
  autoconf: (await capture("autoconf", ["--version"], { env })).split("\n")[0],
  aclocal: (await capture("aclocal", ["--version"], { env })).split("\n")[0],
  pkgConfig: (await capture("pkg-config", ["--version"], { env })).trim(),
};
if (!xcode.includes(`Xcode ${spec.xcodeVersion}\nBuild version ${spec.xcodeBuild}`)
    || sdkVersion !== spec.sdk.replace("macosx", "")
    || hostArchitecture !== spec.architecture) {
  throw new Error(`Toolchain mismatch: ${JSON.stringify({ xcode, sdkVersion, hostArchitecture })}`);
}

const sourceArchive = resolve(args.sourceArchive);
await assertHash(sourceArchive, lock.source.sha256, "source archive");
const patch = resolve(runtimeRoot, lock.patch.path);
await assertHash(patch, lock.patch.sha256, "source patch");
const output = resolve(args.output);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) {
  throw new Error(`Output directory must be empty: ${output}`);
}

const work = join(output, "work");
await mkdir(work);
await run("tar", ["-xzf", sourceArchive, "-C", work], { env });
const source = join(work, lock.source.directory);
await assertHash(join(source, lock.externalSources.manifest), lock.externalSources.sha256, "download.lst");
await assertHash(join(source, lock.configuration.upstreamFile), lock.configuration.sha256, "macOS configuration");
const config = await readFile(join(source, lock.configuration.upstreamFile), "utf8");
for (const option of lock.configuration.requiredOptions) {
  if (!config.split(/\r?\n/).includes(option)) throw new Error(`Missing required configure option: ${option}`);
}
await run("git", ["apply", "--check", patch], { cwd: source, env });
await run("git", ["apply", patch], { cwd: source, env });
// A GitHub tag archive has no .git or release-generated sources.ver. The
// configured build has no required language/help/dictionary submodules, but
// Makefile.fetch still reads this fixed version file unconditionally.
await writeFile(join(source, "sources.ver"), `lo_sources_ver=${lock.source.tag.replace("libreoffice-", "")}\n`);

const configureArgs = [
  "--with-distro=LibreOfficeMacOSX",
  "--without-help",
  "--without-myspell-dicts",
  "--with-lang=en-US",
];
await run(join(source, "autogen.sh"), configureArgs, { cwd: source, env });
await run(make.command, ["fetch"], { cwd: source, env });
const externalSources = await verifyFetchedSources(source, lock);
await run(make.command, ["test-install", `-j${args.jobs ?? 2}`], { cwd: source, env });

const app = join(source, "test-install", "LibreOffice.app");
const soffice = join(app, "Contents", "MacOS", "soffice");
if (!(await stat(soffice)).isFile()) throw new Error(`Missing built soffice: ${soffice}`);
await cp(app, join(output, "LibreOffice.app"), { recursive: true });
const builtSoffice = join(output, "LibreOffice.app", "Contents", "MacOS", "soffice");
const report = {
  schemaVersion: "dascowork-libreoffice-source-build.v1",
  target: args.target,
  source: lock.source,
  patch: lock.patch,
  configuration: { ...lock.configuration, arguments: configureArgs },
  toolchain: { ...spec, observedXcode: xcode.trim(), sdkVersion, sdkPath, hostArchitecture, buildTools,
    runnerImageVersion: process.env.ImageVersion ?? null },
  externalSources,
  sofficeSha256: await sha256(builtSoffice),
  completedAt: new Date().toISOString(),
};
await writeFile(join(output, "source-build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output, sofficeSha256: report.sofficeSha256 })}\n`);

function parseArgs(input) {
  const options = {};
  for (let index = 0; index < input.length; index += 1) {
    const [key, inline] = input[index].split("=", 2);
    if (!["--target", "--source-archive", "--output", "--jobs"].includes(key)) {
      throw new Error(`Unknown build option: ${input[index]}`);
    }
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = inline ?? input[++index];
  }
  if (!options.target || !options.sourceArchive || !options.output) {
    throw new Error("Usage: build-libreoffice-headless.mjs --target=darwin-x64|darwin-arm64 --source-archive=FILE --output=DIR [--jobs=N]");
  }
  if (options.jobs !== undefined && !/^[1-9][0-9]*$/.test(options.jobs)) {
    throw new Error("--jobs must be a positive integer");
  }
  return options;
}

async function findModernMake(env) {
  for (const command of ["gmake", "make"]) {
    let version;
    try {
      version = await capture(command, ["--version"], { env });
    } catch {
      continue;
    }
    const match = /GNU Make (\d+)\.(\d+)/.exec(version);
    if (match && Number(match[1]) >= 4) return { command, version: version.split("\n")[0] };
  }
  throw new Error("LibreOffice requires GNU Make 4 or newer; neither gmake nor make qualifies");
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertHash(path, expected, label) {
  const actual = await sha256(path);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: ${actual} != ${expected}`);
}

async function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, { stdio: "inherit", ...options });
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  if (code !== 0) throw new Error(`${basename(command)} exited ${code}`);
}

async function capture(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let output = "";
  let error = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { error += chunk; });
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  if (code !== 0) throw new Error(`${command} exited ${code}: ${error}`);
  return output;
}

async function verifyFetchedSources(source, buildLock) {
  const variables = new Map();
  const manifest = await readFile(join(source, buildLock.externalSources.manifest), "utf8");
  for (const line of manifest.split(/\r?\n/)) {
    const entry = /^([A-Z0-9_]+)\s*:=\s*(.*?)\s*$/.exec(line);
    if (entry) variables.set(entry[1], entry[2]);
  }
  const resolveVariable = (name, depth = 0) => {
    if (depth > 10 || !variables.has(name)) throw new Error(`Unresolved download.lst variable: ${name}`);
    return variables.get(name).replace(/\$\(([A-Z0-9_]+)\)/g, (_, nested) => resolveVariable(nested, depth + 1));
  };
  const expected = new Map();
  for (const name of variables.keys()) {
    if (!/_(?:TARBALL|JAR|PACK|TTF|DLL)$/.test(name)) continue;
    const checksumName = name.replace(/_(?:TARBALL|JAR|PACK|TTF|DLL)$/, "_SHA256SUM");
    if (!variables.has(checksumName)) throw new Error(`Missing ${checksumName}`);
    expected.set(resolveVariable(name), resolveVariable(checksumName));
  }
  const fetched = [];
  const directory = join(source, "external", "tarballs");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "tmp") continue;
    if (entry.name === "fetch.log") continue;
    if (!entry.isFile() || !expected.has(entry.name)) {
      throw new Error(`Untracked external source object: ${entry.name}`);
    }
    const actual = await sha256(join(directory, entry.name));
    if (actual !== expected.get(entry.name)) throw new Error(`External source SHA-256 mismatch: ${entry.name}`);
    fetched.push({ name: entry.name, sha256: actual });
  }
  if (fetched.length === 0) throw new Error("No external source archives were fetched");
  return fetched.sort((a, b) => a.name.localeCompare(b.name));
}
