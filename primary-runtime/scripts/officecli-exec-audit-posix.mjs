#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

export const officeCliExecAuditPosixSchemaVersion = "dascowork-officecli-exec-audit-posix.v1";

const defaultTimeoutMs = 45_000;
const capturedOutputBytes = 64 * 1024;

export function buildMacOfficeCliExecAuditProfile(options) {
  const officecliPath = requireAbsolutePath(options?.officecliPath, "officecliPath");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-exec)",
    `(allow process-exec (literal ${sandboxStringLiteral(officecliPath)}))`,
    "",
  ].join("\n");
}

export function buildMacSandboxExecAuditInvocation(options) {
  const officecliPath = requireAbsolutePath(options?.officecliPath, "officecliPath");
  const args = arrayOfStrings(options?.args);
  return {
    strategy: "macos-sandbox-exec-process-allowlist",
    command: "/usr/bin/sandbox-exec",
    args: ["-p", buildMacOfficeCliExecAuditProfile({ officecliPath }), officecliPath, ...args],
    env: options?.env ?? process.env,
    allowedExecPaths: [officecliPath],
  };
}

export function buildLinuxStraceExecAuditInvocation(options) {
  const officecliPath = requireAbsolutePath(options?.officecliPath, "officecliPath");
  const tracePath = requireAbsolutePath(options?.tracePath, "tracePath");
  const args = arrayOfStrings(options?.args);
  const auditCommand = buildLinuxStraceExecAuditCommand({ officecliPath, tracePath, args });
  return {
    strategy: "linux-strace-execve-allowlist",
    command: auditCommand.executable,
    args: auditCommand.args,
    env: options?.env ?? process.env,
    tracePath,
    allowedExecPaths: normalizedAllowedExecPaths({
      officecliPath,
      additionalAllowedExecPaths: options?.additionalAllowedExecPaths,
    }),
  };
}

export function buildLinuxStraceExecAuditCommand(options) {
  const officecliPath = requireAbsolutePath(options?.officecliPath, "officecliPath");
  const tracePath = requireAbsolutePath(options?.tracePath, "tracePath");
  const args = arrayOfStrings(options?.args);
  return {
    executable: "/usr/bin/strace",
    args: [
      "-f",
      "-qq",
      "-e",
      "trace=execve,execveat",
      "-s",
      "4096",
      "-o",
      tracePath,
      officecliPath,
      ...args,
    ],
  };
}

export function buildLinuxIsolatedStraceExecAuditInvocation(options) {
  const isolationInvocation = options?.isolationInvocation;
  if (!isolationInvocation || typeof isolationInvocation !== "object") {
    throw new Error("OfficeCLI Linux exec audit requires an existing isolation invocation.");
  }
  const officecliPath = requireAbsolutePath(options?.officecliPath, "officecliPath");
  const tracePath = requireAbsolutePath(options?.tracePath, "tracePath");
  const auditCommand = buildLinuxStraceExecAuditCommand({
    officecliPath,
    tracePath,
    args: options?.args,
  });
  const isolationArgs = arrayOfStrings(isolationInvocation.args);
  const unshareIndex = isolationArgs.indexOf("/usr/bin/unshare");
  const delimiterIndex = isolationArgs.indexOf("--", unshareIndex);
  if (unshareIndex < 0 || delimiterIndex < 0) {
    throw new Error("OfficeCLI Linux exec audit requires a sudo env-i unshare invocation.");
  }
  return {
    strategy: "linux-unshare-strace-execve-allowlist",
    command: requireNonEmptyString(isolationInvocation.command, "isolationInvocation.command"),
    args: [
      ...isolationArgs.slice(0, delimiterIndex + 1),
      auditCommand.executable,
      ...auditCommand.args,
    ],
    env: isolationInvocation.env ?? {},
    tracePath,
    allowedExecPaths: normalizedAllowedExecPaths({
      officecliPath,
      additionalAllowedExecPaths: options?.additionalAllowedExecPaths,
    }),
  };
}

export async function runPosixOfficeCliExecAudit(options) {
  const target = requireNonEmptyString(options?.target, "target");
  const officecliPath = requireAbsolutePath(options?.officecliPath, "officecliPath");
  const args = arrayOfStrings(options?.args);
  const timeoutMs = positiveInteger(options?.timeoutMs ?? defaultTimeoutMs, "timeoutMs");
  if (target.startsWith("darwin")) {
    const invocation = buildMacSandboxExecAuditInvocation({
      officecliPath,
      args,
      env: options?.env,
    });
    const command = await runRawCommand({
      command: invocation.command,
      args: invocation.args,
      env: invocation.env,
      cwd: options?.cwd,
      timeoutMs,
      allowedExitCodes: options?.allowedExitCodes ?? [0],
      name: options?.name ?? "officecli-macos-exec-audit",
    });
    return {
      schemaVersion: officeCliExecAuditPosixSchemaVersion,
      target,
      strategy: invocation.strategy,
      passed: true,
      allowedExecPaths: invocation.allowedExecPaths,
      command: commandReceipt({ command, executable: officecliPath, args }),
    };
  }
  if (target.startsWith("linux")) {
    const ownsTraceDirectory = !options?.tracePath;
    const traceDirectory = ownsTraceDirectory
      ? await mkdtemp(join(resolve(options?.tempParent ?? tmpdir()), "officecli-exec-audit-"))
      : null;
    const tracePath = resolve(options?.tracePath ?? join(traceDirectory, "strace.log"));
    const invocation = buildLinuxStraceExecAuditInvocation({
      officecliPath,
      args,
      env: options?.env,
      tracePath,
      additionalAllowedExecPaths: options?.additionalAllowedExecPaths,
    });
    try {
      const command = await runRawCommand({
        command: invocation.command,
        args: invocation.args,
        env: invocation.env,
        cwd: options?.cwd,
        timeoutMs,
        allowedExitCodes: options?.allowedExitCodes ?? [0],
        name: options?.name ?? "officecli-linux-exec-audit",
      });
      const traceText = await readFile(tracePath, "utf8");
      const trace = validateLinuxExecTrace({
        traceText,
        allowedExecPaths: invocation.allowedExecPaths,
      });
      return {
        schemaVersion: officeCliExecAuditPosixSchemaVersion,
        target,
        strategy: invocation.strategy,
        passed: true,
        allowedExecPaths: invocation.allowedExecPaths,
        command: commandReceipt({ command, executable: officecliPath, args }),
        trace,
      };
    } finally {
      if (traceDirectory) await rm(traceDirectory, { recursive: true, force: true });
    }
  }
  throw new Error(`OfficeCLI POSIX exec audit does not support target ${target}.`);
}

export async function probePosixOfficeCliExecAudit(options) {
  const target = requireNonEmptyString(options?.target, "target");
  if (target.startsWith("darwin")) {
    return await runMacExecDenyProbeForTest(options);
  }
  if (target.startsWith("linux")) {
    return await runLinuxExecAuditProbeForTest(options);
  }
  throw new Error(`OfficeCLI POSIX exec audit probe does not support target ${target}.`);
}

export function validateLinuxExecTrace(options) {
  const traceText = requireNonEmptyString(options?.traceText, "traceText");
  const allowed = new Set(
    arrayOfStrings(options?.allowedExecPaths).map((path) => requireAbsolutePath(path, "allowedExecPaths[]")),
  );
  if (allowed.size === 0) {
    throw new Error("OfficeCLI Linux exec audit has no allowed executable paths.");
  }
  const lines = traceText.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("OfficeCLI Linux exec audit trace is empty.");
  }
  const entries = [];
  const incomplete = [];
  for (const line of lines) {
    if (line.includes("<unfinished ...>") || line.includes("<... execve resumed>") || line.includes("<... execveat resumed>")) {
      incomplete.push(line);
      continue;
    }
    if (/(?:^|\s)execve(?:at)?\(/u.test(line)) {
      const entry = parseLinuxExecTraceLine(line);
      if (!entry) {
        throw new Error(`OfficeCLI Linux exec audit trace has unparseable exec syscall line: ${line}`);
      }
      entries.push(entry);
      if (!allowed.has(entry.path)) {
        throw new Error(`OfficeCLI Linux exec audit blocked external executable ${entry.path}.`);
      }
      continue;
    }
    const entry = parseLinuxExecTraceLine(line);
    if (!entry) continue;
  }
  if (incomplete.length > 0) {
    throw new Error(`OfficeCLI Linux exec audit trace is incomplete: ${incomplete[0]}`);
  }
  if (entries.length === 0) {
    throw new Error("OfficeCLI Linux exec audit trace did not record execve or execveat.");
  }
  return {
    entries,
    allowedExecPaths: [...allowed].sort((left, right) => left.localeCompare(right)),
  };
}

export function parseLinuxExecTraceLine(line) {
  const execve = line.match(/(?:^|\s)execve\("((?:\\.|[^"\\])*)"/u);
  if (execve) {
    return { syscall: "execve", path: unescapeStraceString(execve[1]) };
  }
  const execveat = line.match(/(?:^|\s)execveat\([^,]+,\s*"((?:\\.|[^"\\])*)"/u);
  if (execveat) {
    return { syscall: "execveat", path: unescapeStraceString(execveat[1]) };
  }
  return null;
}

export async function runMacExecDenyProbeForTest(options) {
  const root = await mkdtemp(join(resolve(options?.tempParent ?? tmpdir()), "officecli-mac-exec-audit-test-"));
  const fakeOfficeCli = join(root, basename(process.execPath));
  try {
    await mkdir(root, { recursive: true });
    const nodeBytes = await readFile(process.execPath);
    await writeFile(fakeOfficeCli, nodeBytes, { mode: 0o755 });
    await chmod(fakeOfficeCli, 0o755);
    const canonicalFakeOfficeCli = await realpath(fakeOfficeCli);
    const unrestricted = await runRawCommand({
      command: canonicalFakeOfficeCli,
      args: [
        "--input-type=module",
        "--eval",
        [
          "import { spawnSync } from 'node:child_process';",
          "const result = spawnSync('/bin/sh', ['-c', 'true']);",
          "process.stderr.write(String(result.error?.code ?? result.status ?? 'unknown'));",
          "process.exit(result.status === 0 ? 0 : 72);",
        ].join(" "),
      ],
      env: options?.env ?? process.env,
      timeoutMs: options?.timeoutMs ?? 10_000,
      allowedExitCodes: [0],
      name: "officecli-macos-exec-audit-unrestricted-control",
    });
    const positive = await runPosixOfficeCliExecAudit({
      target: "darwin-x64",
      officecliPath: canonicalFakeOfficeCli,
      args: ["--version"],
      env: options?.env,
      timeoutMs: options?.timeoutMs ?? 10_000,
    });
    const negative = await runPosixOfficeCliExecAudit({
      target: "darwin-x64",
      officecliPath: canonicalFakeOfficeCli,
      args: [
        "--input-type=module",
        "--eval",
        [
          "import { spawnSync } from 'node:child_process';",
          "const result = spawnSync('/bin/sh', ['-c', 'true']);",
          "const denied = result.error?.code === 'EPERM' || result.error?.code === 'EACCES';",
          "process.stderr.write(String(result.error?.code ?? result.status ?? 'unknown'));",
          "process.exit(denied ? 73 : 0);",
        ].join(" "),
      ],
      env: options?.env,
      timeoutMs: options?.timeoutMs ?? 10_000,
      allowedExitCodes: [73],
    });
    return { passed: true, unrestricted, positive, negative, deniedExecutable: "/bin/sh" };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runLinuxExecAuditProbeForTest(options) {
  await assertExecutableExists("/usr/bin/strace");
  await assertExecutableExists("/bin/true");
  const root = await mkdtemp(join(resolve(options?.tempParent ?? tmpdir()), "officecli-linux-exec-audit-test-"));
  try {
    const positiveTrace = join(root, "positive.strace.log");
    const positive = await runPosixOfficeCliExecAudit({
      target: "linux-x64",
      officecliPath: await realpath(process.execPath),
      args: ["--version"],
      tracePath: positiveTrace,
      env: options?.env,
      timeoutMs: options?.timeoutMs ?? 10_000,
    });

    const spawnTrace = join(root, "spawn.strace.log");
    const spawnCommand = buildLinuxStraceExecAuditInvocation({
      officecliPath: await realpath(process.execPath),
      tracePath: spawnTrace,
      args: [
        "--input-type=module",
        "--eval",
        "import { spawnSync } from 'node:child_process'; const result = spawnSync('/bin/true'); process.exit(result.status ?? 1);",
      ],
      env: options?.env,
    });
    await runRawCommand({
      command: spawnCommand.command,
      args: spawnCommand.args,
      env: spawnCommand.env,
      timeoutMs: options?.timeoutMs ?? 10_000,
      allowedExitCodes: [0],
      name: "officecli-linux-exec-audit-spawn-control",
    });
    const spawnTraceText = await readFile(spawnTrace, "utf8");
    let externalSpawnRejection = null;
    try {
      validateLinuxExecTrace({
        traceText: spawnTraceText,
        allowedExecPaths: spawnCommand.allowedExecPaths,
      });
    } catch (error) {
      externalSpawnRejection = String(error.message ?? error);
    }
    if (!externalSpawnRejection?.includes("/bin/true")) {
      throw new Error(`OfficeCLI Linux exec audit did not reject spawned /bin/true: ${externalSpawnRejection ?? "no rejection"}`);
    }

    const replacementTrace = join(root, "replacement.strace.log");
    const replacement = buildLinuxStraceExecAuditInvocation({
      officecliPath: "/usr/bin/env",
      tracePath: replacementTrace,
      args: ["/bin/true"],
      env: options?.env,
    });
    await runRawCommand({
      command: replacement.command,
      args: replacement.args,
      env: replacement.env,
      timeoutMs: options?.timeoutMs ?? 10_000,
      allowedExitCodes: [0],
      name: "officecli-linux-exec-audit-replacement-control",
    });
    const replacementTraceText = await readFile(replacementTrace, "utf8");
    let execReplacementRejection = null;
    try {
      validateLinuxExecTrace({
        traceText: replacementTraceText,
        allowedExecPaths: replacement.allowedExecPaths,
      });
    } catch (error) {
      execReplacementRejection = String(error.message ?? error);
    }
    if (!execReplacementRejection?.includes("/bin/true")) {
      throw new Error(`OfficeCLI Linux exec audit did not reject exec replacement /bin/true: ${execReplacementRejection ?? "no rejection"}`);
    }

    return {
      passed: true,
      positive,
      externalSpawnRejection,
      execReplacementRejection,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await runPosixOfficeCliExecAudit(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

function parseArgs(argv) {
  const options = { args: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.args = argv.slice(index + 1);
      break;
    }
    if (arg === "--target") options.target = argv[++index];
    else if (arg === "--officecli") options.officecliPath = argv[++index];
    else if (arg === "--trace") options.tracePath = argv[++index];
    else if (arg === "--cwd") options.cwd = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--allow-exec") {
      options.additionalAllowedExecPaths ??= [];
      options.additionalAllowedExecPaths.push(argv[++index]);
    } else {
      throw new Error(`Unsupported officecli exec audit option: ${arg}`);
    }
  }
  return options;
}

function normalizedAllowedExecPaths({ officecliPath, additionalAllowedExecPaths }) {
  return [...new Set([officecliPath, ...arrayOfStrings(additionalAllowedExecPaths)].map((path) => resolve(path)))];
}

function commandReceipt({ command, executable, args }) {
  return {
    executable,
    args,
    exitCode: command.exitCode,
    signal: command.signal,
    elapsedMs: command.elapsedMs,
    outputBytes: command.outputBytes,
    stdoutBytes: command.stdoutBytes,
    stderrBytes: command.stderrBytes,
    stdout: command.stdout.toString("utf8"),
    stderr: command.stderr.toString("utf8"),
  };
}

async function runRawCommand({ command, args, env, cwd, timeoutMs, allowedExitCodes, name }) {
  return await new Promise((resolveCommand, rejectCommand) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = createCappedCapture("stdout");
    const stderr = createCappedCapture("stderr");
    let settled = false;
    let timedOut = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => finish(() => rejectCommand(error)));
    child.once("close", (exitCode, signal) => {
      finish(() => {
        const elapsedMs = Date.now() - startedAt;
        const overflow = [stdout, stderr].find((captureState) => captureState.truncated);
        if (overflow) {
          rejectCommand(
            new Error(
              `${name} exceeded ${overflow.label} output limit ${capturedOutputBytes} bytes (${overflow.bytes} bytes).`,
            ),
          );
          return;
        }
        if (!timedOut && allowedExitCodes.includes(exitCode)) {
          resolveCommand({
            stdout: stdout.buffer(),
            stderr: stderr.buffer(),
            outputBytes: stdout.bytes + stderr.bytes,
            stdoutBytes: stdout.bytes,
            stderrBytes: stderr.bytes,
            elapsedMs,
            exitCode,
            signal,
          });
          return;
        }
        const reason = timedOut ? `timed out after ${timeoutMs}ms` : `failed with ${exitCode ?? signal ?? "unknown"}`;
        const captured = Buffer.concat([stdout.buffer(), stderr.buffer()]).toString("utf8");
        rejectCommand(new Error(`${name} ${reason}: ${captured.slice(-500) || "no command output"}`));
      });
    });
  });
}

function createCappedCapture(label) {
  const chunks = [];
  let bytes = 0;
  let storedBytes = 0;
  let truncated = false;
  return {
    label,
    get bytes() {
      return bytes;
    },
    get truncated() {
      return truncated;
    },
    push(buffer) {
      bytes += buffer.length;
      if (storedBytes >= capturedOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = capturedOutputBytes - storedBytes;
      const stored = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(stored);
      storedBytes += stored.length;
      if (buffer.length > remaining) truncated = true;
    },
    buffer() {
      return Buffer.concat(chunks, storedBytes);
    },
  };
}

function sandboxStringLiteral(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function unescapeStraceString(value) {
  return value.replace(/\\([\\"])/gu, "$1");
}

async function assertExecutableExists(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`OfficeCLI POSIX exec audit requires executable ${path}.`);
  }
}

function arrayOfStrings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Expected an array of strings.");
  }
  return value.map(String);
}

function requireAbsolutePath(value, name) {
  const text = requireNonEmptyString(value, name);
  if (!text.startsWith(sep)) {
    throw new Error(`OfficeCLI exec audit option ${name} must be an absolute path.`);
  }
  return resolve(text);
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required OfficeCLI exec audit option: ${name}`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`OfficeCLI exec audit option ${name} must be a positive integer.`);
  }
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${String(error.stack ?? error.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
