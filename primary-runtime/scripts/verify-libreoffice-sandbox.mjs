#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, platform, release } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const options = parseArgs(process.argv.slice(2));
await mkdir(options.reportDir, { recursive: true });
const runDir = await mkdtemp(join(options.reportDir, `${options.label}-`));
const outputDir = join(runDir, "output");
await mkdir(outputDir);
const probe = await probeUnixSocket(join(runDir, "socket-probe"));
const binary = resolve(options.binary);
const input = resolve(options.input);
const args = [
  ...(options.mode === "default" ? [] : ["-env:DASCOWORK_HEADLESS_NO_IPC=1"]),
  ...(options.mode === "switch-only" ? [] : ["--headless"]),
  "--nologo", "--norestore",
  `-env:UserInstallation=${pathToFileURL(join(runDir, "profile")).href}`,
  "--convert-to", "pdf", "--outdir", outputDir, input,
];
const startedAt = new Date().toISOString();
const start = performance.now();
const conversion = probe.denied
  ? await run(binary, args, options.timeoutMs)
  : { exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", error: "sandbox probe allowed AF_UNIX bind" };
const pdfPath = join(outputDir, `${basename(input).replace(/\.[^.]+$/, "")}.pdf`);
let pdf = null;
try {
  const pdfStat = await stat(pdfPath);
  if (pdfStat.isFile() && pdfStat.size > 0) {
    const info = await run(options.pdfinfo, [pdfPath], 15000);
    const textResult = await run(options.pdftotext, [pdfPath, "-"], 15000);
    const pages = Number(/^Pages:\s*(\d+)\s*$/m.exec(info.stdout)?.[1]);
    const render = await run(options.pdftoppm, ["-f", "1", "-l", String(pages), "-scale-to", "960", "-png", pdfPath, join(runDir, "page")], 60000);
    const renderedPages = (await readdir(runDir)).filter((name) => /^page-\d+\.png$/.test(name)).length;
    pdf = {
      path: pdfPath, size: pdfStat.size, sha256: await sha256(pdfPath),
      pages, expectedPages: options.expectedPages,
      textFound: textResult.stdout.includes(options.expectedText),
      expectedText: options.expectedText,
      extractedTextSample: textResult.stdout.slice(0, 2000),
      pdfinfo: info.stdout, pdfinfoExitCode: info.exitCode,
      pdftotextExitCode: textResult.exitCode,
      renderedPages, renderExitCode: render.exitCode, renderStderr: render.stderr,
    };
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const passed = probe.denied && conversion.exitCode === 0 && !conversion.timedOut
  && pdf?.pages === options.expectedPages && pdf.textFound
  && pdf.pdfinfoExitCode === 0 && pdf.pdftotextExitCode === 0
  && pdf.renderExitCode === 0 && pdf.renderedPages === options.expectedPages;
const report = {
  schemaVersion: "dascowork-libreoffice-sandbox.v1",
  label: options.label, environmentClass: options.environmentClass,
  host: { platform: platform(), architecture: arch(), release: release() },
  sandbox: { unixSocketBindDenied: probe.denied, error: probe.error, elevated: false },
  binary: { path: binary, sha256: await sha256(binary) },
  input: { path: input, sha256: await sha256(input) },
  command: { executable: binary, args, timeoutMs: options.timeoutMs },
  startedAt, completedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
  conversion, pdf, passed,
};
const reportPath = join(runDir, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ reportPath, passed, conversion: { exitCode: conversion.exitCode, signal: conversion.signal, timedOut: conversion.timedOut }, pdf: pdf && { pages: pdf.pages, renderedPages: pdf.renderedPages, textFound: pdf.textFound } })}\n`);
if (!probe.denied || (options.expectSuccess && !passed)) process.exitCode = 1;

function parseArgs(input) {
  const parsed = {};
  for (let i = 0; i < input.length; i += 1) {
    const [name, inline] = input[i].split("=", 2);
    if (!["--binary", "--input", "--report-dir", "--label", "--mode", "--environment-class", "--expected-pages", "--expected-text", "--pdfinfo", "--pdftotext", "--pdftoppm", "--timeout-ms", "--expect-success"].includes(name)) throw new Error(`Unknown option: ${name}`);
    parsed[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = name === "--expect-success" ? true : inline ?? input[++i];
  }
  if (!parsed.binary || !parsed.input || !parsed.reportDir || !parsed.label || !parsed.environmentClass || !parsed.expectedPages || !parsed.expectedText) {
    throw new Error("Required: --binary --input --report-dir --label --environment-class --expected-pages --expected-text");
  }
  if (!["default", "enabled", "switch-only"].includes(parsed.mode)) throw new Error("--mode must be default, enabled, or switch-only");
  if (!["codex-tool-restricted", "app-server-restricted"].includes(parsed.environmentClass)) throw new Error("Unknown environment class");
  parsed.reportDir = resolve(parsed.reportDir);
  parsed.expectedPages = Number(parsed.expectedPages);
  parsed.timeoutMs = Number(parsed.timeoutMs ?? 60000);
  if (!Number.isSafeInteger(parsed.expectedPages) || parsed.expectedPages < 1 || !Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 1) throw new Error("Invalid page count or timeout");
  parsed.pdfinfo ??= "pdfinfo";
  parsed.pdftotext ??= "pdftotext";
  parsed.pdftoppm ??= "pdftoppm";
  return parsed;
}

async function probeUnixSocket(path) {
  const server = createServer();
  return await new Promise((finish) => {
    server.once("error", (error) => finish({ denied: error.code === "EPERM" || error.code === "EACCES", error: `${error.code}: ${error.message}` }));
    server.listen(path, () => server.close(() => finish({ denied: false, error: null })));
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(command, args, timeoutMs) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, timeoutMs);
  const result = await new Promise((finish) => {
    child.once("error", (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.once("close", (exitCode, signal) => finish({ exitCode, signal, error: null }));
  });
  clearTimeout(timer);
  return { ...result, timedOut, stdout, stderr };
}
