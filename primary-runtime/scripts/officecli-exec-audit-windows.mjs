import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const officeCliWindowsExecAuditSchemaVersion = "dascowork-officecli-exec-audit-windows.v1";

const capturedOutputBytes = 16_384;
const defaultTimeoutMs = 45_000;
const helperCleanupGraceMs = 30_000;
const helperDirectory = dirname(fileURLToPath(import.meta.url));
const supportDirectory = join(helperDirectory, "support");
const powershellHelperPath = join(supportDirectory, "officecli-exec-audit-windows.ps1");
const csharpHelperPath = join(supportDirectory, "officecli-exec-audit-windows.cs");
const childProbeSourcePath = join(supportDirectory, "officecli-exec-audit-windows-child-probe.cs");
const childProbeCompilerPath = join(supportDirectory, "officecli-exec-audit-windows-build-child-probe.ps1");
const defaultWindowsSystemRoot = "C:\\Windows";
const childProcessRestrictedExitCode = 23;

export function windowsExecAuditSupportFiles() {
  return {
    powershell: powershellHelperPath,
    csharp: csharpHelperPath,
    childProbe: childProbeSourcePath,
    childProbeCompiler: childProbeCompilerPath,
  };
}

export function buildWindowsExecAuditInvocation(options = {}) {
  const inputJsonPath = resolve(requireNonEmptyString(options.inputJsonPath, "inputJsonPath"));
  const powershellPath = options.powershellPath ?? defaultWindowsPowerShellPath();
  return {
    command: powershellPath,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      powershellHelperPath,
      "-InputJson",
      inputJsonPath,
    ],
  };
}

export async function runWindowsOfficeCliExecAudit(options = {}) {
  if (platform() !== "win32") {
    throw new Error(`Windows OfficeCLI execution audit requires a Windows host; current host is ${platform()}.`);
  }
  return await runWindowsExecAuditUnchecked(options);
}

export async function runWindowsExecAuditUnchecked(options = {}) {
  const executable = resolve(requireNonEmptyString(options.executable, "executable"));
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  const timeoutMs = Number(options.timeoutMs ?? defaultTimeoutMs);
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const input = {
    schemaVersion: officeCliWindowsExecAuditSchemaVersion,
    executable,
    args,
    cwd: options.cwd ? resolve(String(options.cwd)) : dirname(executable),
    env: sanitizeEnvironment(options.env ?? process.env),
    timeoutMs,
    restrictChildProcesses: options.restrictChildProcesses !== false,
    allowedExitCodes,
    name: options.name ?? "officecli-windows-exec-audit",
  };
  const root = await mkdtemp(join(resolve(options.tempParent ?? tmpdir()), "officecli-windows-exec-audit-"));
  const inputJsonPath = join(root, "input.json");
  const helperTemp = join(root, "helper-temp");
  try {
    await mkdir(helperTemp, { recursive: true });
    await writeFile(inputJsonPath, `${JSON.stringify(input, null, 2)}\n`);
    const invocation = buildWindowsExecAuditInvocation({
      inputJsonPath,
      powershellPath: options.powershellPath,
    });
    const raw = await runCappedCommand({
      command: invocation.command,
      args: invocation.args,
      env: windowsSystemEnvironment(helperTemp),
      timeoutMs: timeoutMs + helperCleanupGraceMs,
      allowedExitCodes: [0],
      name: "officecli-windows-exec-audit-helper",
    });
    const receipt = parseReceipt(raw.stdout);
    if (!allowedExitCodes.includes(receipt.command.exitCode)) {
      throw new Error(`${input.name} failed with ${receipt.command.exitCode}: ${receipt.command.stderr || receipt.command.stdout || "no command output"}${helperDiagnosticSuffix(raw.stderr)}`);
    }
    return receipt;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function probeWindowsChildProcessRestriction(options = {}) {
  const probeRoot = await mkdtemp(join(resolve(options.tempParent ?? tmpdir()), "officecli-windows-child-probe-"));
  try {
    const probe = await buildWindowsNativeChildProcessProbe({
      tempParent: probeRoot,
      powershellPath: options.powershellPath,
    });
    const probeTempParent = options.tempParent ?? probeRoot;
    const positive = await runWindowsExecAuditUnchecked({
      executable: probe.executable,
      args: probe.args,
      env: options.env ?? windowsSystemEnvironment(),
      timeoutMs: Number(options.timeoutMs ?? 15_000),
      restrictChildProcesses: false,
      allowedExitCodes: [0],
      name: "officecli-windows-child-process-positive-control",
      tempParent: probeTempParent,
      powershellPath: options.powershellPath,
    });
    const restricted = await runWindowsExecAuditUnchecked({
      executable: probe.executable,
      args: probe.args,
      env: options.env ?? windowsSystemEnvironment(),
      timeoutMs: Number(options.timeoutMs ?? 15_000),
      restrictChildProcesses: true,
      allowedExitCodes: [childProcessRestrictedExitCode],
      name: "officecli-windows-child-process-restricted-control",
      tempParent: probeTempParent,
      powershellPath: options.powershellPath,
    });
    const restrictedOutput = `${restricted.command.stdout}
${restricted.command.stderr}`;
    const passed = positive.command.exitCode === 0
      && /child-started/u.test(positive.command.stdout)
      && restricted.command.exitCode === childProcessRestrictedExitCode
      && /child-blocked win32=367/u.test(restrictedOutput);
    const receipt = {
      schemaVersion: officeCliWindowsExecAuditSchemaVersion,
      probe: "windows-child-process-policy",
      positive,
      restricted,
      passed,
    };
    if (!passed) {
      throw new Error(`Windows child process restriction probe failed: ${JSON.stringify(receipt)}`);
    }
    return receipt;
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export async function buildWindowsNativeChildProcessProbe(options = {}) {
  const outputPath = join(resolve(options.tempParent ?? tmpdir()), "officecli-windows-child-probe.exe");
  const powershellPath = options.powershellPath ?? defaultWindowsPowerShellPath();
  await runCappedCommand({
    command: powershellPath,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      childProbeCompilerPath,
      "-SourcePath",
      childProbeSourcePath,
      "-OutputPath",
      outputPath,
    ],
    env: windowsSystemEnvironment(dirname(outputPath)),
    timeoutMs: Number(options.timeoutMs ?? 30_000),
    allowedExitCodes: [0],
    name: "officecli-windows-child-probe-build",
  });
  return windowsNativeChildProcessProbe(outputPath, options.systemRoot);
}

export function windowsNativeChildProcessProbe(
  executable,
  systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? defaultWindowsSystemRoot,
) {
  const cmdPath = `${systemRoot}\\System32\\cmd.exe`;
  return {
    executable: resolve(requireNonEmptyString(executable, "executable")),
    args: [cmdPath],
  };
}

export async function assertOfficeCliDoesNotExecuteSystemTools(options = {}) {
  const receipt = await runWindowsOfficeCliExecAudit({
    ...options,
    restrictChildProcesses: true,
    allowedExitCodes: options.allowedExitCodes ?? [0],
  });
  return {
    schemaVersion: officeCliWindowsExecAuditSchemaVersion,
    proof: "officecli-process-created-with-child-process-restricted-policy",
    receipt,
    blockedAbsoluteSystemChildProcesses: true,
  };
}

function parseReceipt(stdout) {
  const text = stdout.toString("utf8").trim();
  if (!text) throw new Error("Windows OfficeCLI execution audit helper emitted no JSON receipt.");
  const lastLine = text.split(/\r?\n/u).filter(Boolean).at(-1);
  try {
    const parsed = JSON.parse(lastLine);
    if (parsed?.schemaVersion !== officeCliWindowsExecAuditSchemaVersion) {
      throw new Error(`unexpected schema ${String(parsed?.schemaVersion)}`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Windows OfficeCLI execution audit helper emitted invalid JSON: ${String(error.message ?? error)} output=${text.slice(-500)}`);
  }
}

function helperDiagnosticSuffix(stderr) {
  const diagnostic = stderr.toString("utf8").trim().split(/\r?\n/u)
    .filter((line) => /^\[officecli-exec-audit\] stage=/u.test(line))
    .slice(-12)
    .join("\n");
  return diagnostic ? ` helperStages=${JSON.stringify(diagnostic)}` : "";
}

function sanitizeEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => value !== undefined && key !== "")
      .map(([key, value]) => [String(key), String(value)]),
  );
}

async function runCappedCommand({ command, args, env, timeoutMs, allowedExitCodes, name }) {
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
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
        const overflow = [stdout, stderr].find((captureState) => captureState.truncated);
        if (overflow) {
          rejectCommand(new Error(`${name} exceeded ${overflow.label} output limit ${capturedOutputBytes} bytes (${overflow.bytes} bytes).`));
          return;
        }
        if (!timedOut && allowedExitCodes.includes(exitCode)) {
          resolveCommand({
            stdout: stdout.buffer(),
            stderr: stderr.buffer(),
            exitCode,
            signal,
          });
          return;
        }
        const reason = timedOut ? `timed out after ${timeoutMs}ms` : `failed with ${exitCode ?? signal ?? "unknown"}`;
        rejectCommand(new Error(`${name} ${reason}: ${stderr.buffer().toString("utf8").slice(-500) || stdout.buffer().toString("utf8").slice(-500) || "no command output"}`));
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

function windowsSystemEnvironment(tempRoot) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? defaultWindowsSystemRoot;
  const powershellDirectory = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`;
  const env = {
    SystemRoot: systemRoot,
    WINDIR: process.env.WINDIR ?? systemRoot,
    PATH: `${powershellDirectory};${systemRoot}\\System32;${systemRoot}`,
  };
  if (!tempRoot) return env;
  return {
    ...env,
    TEMP: tempRoot,
    TMP: tempRoot,
    USERPROFILE: tempRoot,
    LOCALAPPDATA: tempRoot,
    APPDATA: tempRoot,
  };
}

function defaultWindowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? defaultWindowsSystemRoot;
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required Windows OfficeCLI execution audit option: ${name}`);
  }
  return value;
}

export async function readWindowsExecAuditHelperSourceForTest() {
  return {
    powershell: await readFile(powershellHelperPath, "utf8"),
    csharp: await readFile(csharpHelperPath, "utf8"),
    childProbe: await readFile(childProbeSourcePath, "utf8"),
    childProbeCompiler: await readFile(childProbeCompilerPath, "utf8"),
  };
}
